"""在已有像素姿势上做动画的小工具（不凭空画，只移动、弯曲、转动、换色、叠小特效）

    from anim_kit import *
    base = load_pose("styles/magical/poses/idle.png")
    frames = [shift(base, dy=-1), ...]
    export(frames, [150, ...], "styles/magical/actions/idle", name="待机", loop=True)

所有函数输入输出都是 RGBA 的 numpy 数组（H×W×4，uint8），不改原数组。
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

OUTLINE = np.array([58, 26, 44, 255], np.uint8)
PAPER = (250, 244, 232)


def load_pose(path):
    return np.array(Image.open(path).convert("RGBA"))


def solid(img):
    return img[..., 3] > 0


def shift(img, dy=0, dx=0):
    """整体平移，移出画布的部分丢掉。"""
    out = np.zeros_like(img)
    H, W = img.shape[:2]
    ys, yd = (slice(0, H - dy), slice(dy, H)) if dy >= 0 else (slice(-dy, H), slice(0, H + dy))
    xs, xd = (slice(0, W - dx), slice(dx, W)) if dx >= 0 else (slice(-dx, W), slice(0, W + dx))
    out[yd, xd] = img[ys, xs]
    return out


def rect_mask(img, x0, y0, x1, y1):
    m = np.zeros(img.shape[:2], bool)
    m[y0:y1 + 1, x0:x1 + 1] = True
    return m & solid(img)


def move_region(img, mask, dy=0, dx=0):
    """把 mask 里的像素整块挪动；原位置空出来的地方变透明（落在别的像素上就被盖住）。"""
    out = img.copy()
    out[mask] = 0
    piece = np.zeros_like(img)
    piece[mask] = img[mask]
    piece = shift(piece, dy, dx)
    put = piece[..., 3] > 0
    out[put] = piece[put]
    return out


def bend(img, mask, anchor, length, amp, axis="y"):
    """弯曲：mask 里的像素按离 anchor 的距离逐列（或逐行）平移，越远移得越多，
    用来甩尾巴、晃发卷。axis="y" 表示上下甩（按列平移），"x" 表示左右甩（按行平移）。
    anchor 是不动的那一端坐标（列号或行号），length 是到最远端的距离，可为负。"""
    out = img.copy()
    out[mask] = 0
    ys, xs = np.where(mask)
    t = np.clip(((xs if axis == "y" else ys) - anchor) / float(length), 0, 1)
    off = np.round(amp * t ** 1.6).astype(int)
    ny, nx = (ys + off, xs) if axis == "y" else (ys, xs + off)
    H, W = img.shape[:2]
    ok = (ny >= 0) & (ny < H) & (nx >= 0) & (nx < W)
    # 先画位移小的，再画位移大的，避免远端被近端盖住
    order = np.argsort(np.abs(off[ok]))
    src = img[ys[ok], xs[ok]][order]
    out[ny[ok][order], nx[ok][order]] = src
    return out


def _mode_downsample(big, k):
    H, W = big.shape[0] // k, big.shape[1] // k
    out = np.zeros((H, W, 4), np.uint8)
    blocks = big[: H * k, : W * k].reshape(H, k, W, k, 4).transpose(0, 2, 1, 3, 4).reshape(H, W, k * k, 4)
    for y in range(H):
        for x in range(W):
            b = blocks[y, x]
            b = b[b[:, 3] > 0]
            if len(b) * 2 < k * k:
                continue
            vals, counts = np.unique(b.view(np.uint32).ravel(), return_counts=True)
            out[y, x] = np.frombuffer(np.uint32(vals[counts.argmax()]).tobytes(), np.uint8)
    return out


def rotate_region(img, mask, pivot, degrees, k=4):
    """把 mask 里的像素绕 pivot=(x, y) 转一个角度（正数逆时针）。
    先放大 k 倍再转、再按众数缩回，像素画转起来不会碎。"""
    piece = np.zeros_like(img)
    piece[mask] = img[mask]
    big = np.array(Image.fromarray(piece, "RGBA").resize((img.shape[1] * k, img.shape[0] * k), Image.NEAREST))
    rot = Image.fromarray(big, "RGBA").rotate(degrees, resample=Image.NEAREST,
                                               center=(pivot[0] * k + k / 2, pivot[1] * k + k / 2))
    small = _mode_downsample(np.array(rot), k)
    out = img.copy()
    out[mask] = 0
    put = small[..., 3] > 0
    out[put] = small[put]
    return out


def spin_disk(img, center, radius, degrees):
    """只转圆盘内部（不含最外一圈），魔法球里的漩涡转起来，轮廓不动。"""
    H, W = img.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W]
    inside = ((xx - center[0]) ** 2 + (yy - center[1]) ** 2 <= (radius - 1.2) ** 2) & solid(img)
    a = np.deg2rad(degrees)
    sx = np.round(center[0] + (xx - center[0]) * np.cos(a) - (yy - center[1]) * np.sin(a)).astype(int)
    sy = np.round(center[1] + (xx - center[0]) * np.sin(a) + (yy - center[1]) * np.cos(a)).astype(int)
    sx, sy = np.clip(sx, 0, W - 1), np.clip(sy, 0, H - 1)
    out = img.copy()
    src_ok = inside[sy, sx]
    m = inside & src_ok
    out[m] = img[sy[m], sx[m]]
    return out


def brighten(img, mask, amount):
    """提亮（amount>0）或压暗（<0），描边色不动。amount 是 0–1 之间朝白色/黑色靠拢的比例。"""
    out = img.copy()
    m = mask & solid(img) & ~(img[..., :3] == OUTLINE[:3]).all(-1)
    c = out[m, :3].astype(float)
    c = c + (255 - c) * amount if amount > 0 else c * (1 + amount)
    out[m, :3] = np.clip(c, 0, 255).astype(np.uint8)
    return out


def find_eyes(img, box=None):
    """找青色瞳孔：返回每只眼的外框 (x0, y0, x1, y1)，从左到右。"""
    c = img[..., :3].astype(int)
    teal = (c[..., 1] - c[..., 0] > 25) & (c[..., 2] - c[..., 0] > 15) & solid(img)
    if box:
        x0, y0, x1, y1 = box
        m = np.zeros_like(teal)
        m[y0:y1 + 1, x0:x1 + 1] = True
        teal &= m
    ys, xs = np.where(teal)
    if not len(xs):
        return []
    order = np.argsort(xs)
    xs, ys = xs[order], ys[order]
    gaps = np.where(np.diff(xs) > 3)[0]
    eyes = []
    for part in np.split(np.arange(len(xs)), gaps + 1):
        eyes.append((xs[part].min(), ys[part].min(), xs[part].max(), ys[part].max()))
    return eyes


def blink(img, eyes, level, skin, lash=None):
    """level: "half" 半闭 / "closed" 闭上。
    eyes 是 [(x0, y0, x1, y1), ...]，框住瞳孔和上方睫毛；skin 是肤色 RGB。"""
    out = img.copy()
    lash = OUTLINE if lash is None else np.array(list(lash) + [255], np.uint8)
    for x0, y0, x1, y1 in eyes:
        if level == "half":
            mid = (y0 + y1) // 2
            out[y0:mid + 1, x0:x1 + 1, :3] = skin
            out[y0:mid + 1, x0:x1 + 1, 3] = 255
            out[mid + 1, x0:x1 + 1] = lash
        else:
            out[y0:y1 + 1, x0:x1 + 1, :3] = skin
            out[y0:y1 + 1, x0:x1 + 1, 3] = 255
            out[y1, x0 + 1:x1] = lash          # 闭眼是一道往下弯的弧线
            out[y1 - 1, x0] = lash
            out[y1 - 1, x1] = lash
    return out


def stamp(img, rows, colors, x, y, behind=False):
    """把小图案（字符表）印到 (x, y)。colors: 字符 → RGB。behind=True 只印在空白处。"""
    out = img.copy()
    H, W = img.shape[:2]
    for dy, r in enumerate(rows):
        for dx, ch in enumerate(r):
            if ch == "." or ch == " ":
                continue
            Y, X = y + dy, x + dx
            if 0 <= Y < H and 0 <= X < W and (not behind or out[Y, X, 3] == 0):
                out[Y, X, :3] = colors[ch]
                out[Y, X, 3] = 255
    return out


GLYPHS = {
    "sparkle_s": ["w"],
    "sparkle_m": [".p.", "pwp", ".p."],
    "sparkle_l": ["..p..", "..w..", "pwwwp", "..w..", "..p.."],
    "z_s": ["###", ".#.", "###"],
    "z_m": ["####", "..#.", ".#..", "####"],
    "z_l": ["#####", "...#.", "..#..", ".#...", "#####"],
    "sweat": [".o.", "oko", "oko", ".o."],
    "bang": ["#", "#", "#", ".", "#"],
}
GLYPH_COLORS = {"#": (58, 26, 44), "w": (255, 255, 255), "p": (247, 163, 187),
                "o": (58, 26, 44), "k": (190, 226, 246)}


def export(frames, durations, out_dir, action, name, loop, scale=3):
    """写出 frames.png（原尺寸逐帧横排）、anim.gif（放大、纸色底）、anim.json。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    H, W = frames[0].shape[:2]
    strip = Image.new("RGBA", (W * len(frames), H), (0, 0, 0, 0))
    gif = []
    for i, f in enumerate(frames):
        im = Image.fromarray(f, "RGBA")
        strip.paste(im, (i * W, 0))
        bg = Image.new("RGBA", (W, H), PAPER + (255,))
        bg.alpha_composite(im)
        gif.append(bg.convert("RGB").resize((W * scale, H * scale), Image.NEAREST))
    strip.save(out / "frames.png")
    q = [g.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for g in gif]
    q[0].save(out / "anim.gif", save_all=True, append_images=q[1:], duration=list(durations), loop=0)
    (out / "anim.json").write_text(json.dumps({
        "action": action, "name": name, "loop": loop, "frame_w": W, "frame_h": H,
        "frames": len(frames), "ms": list(durations)}, ensure_ascii=False, indent=1))
    return out
