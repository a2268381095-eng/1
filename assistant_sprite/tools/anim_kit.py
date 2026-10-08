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


def _cheek_below(c, al, box):
    """眼睛正下方 2–4 行应该大多是脸颊的肤色（暖色、亮），披帛、纱带下面不是。"""
    x0, y0, x1, y1 = box[:4]
    H = c.shape[0]
    patch = c[min(H - 1, y1 + 2):min(H, y1 + 5), x0:x1 + 1].reshape(-1, 3)
    ok = al[min(H - 1, y1 + 2):min(H, y1 + 5), x0:x1 + 1].reshape(-1)
    if not ok.any():
        return False
    p = patch[ok]
    skin = (p[:, 0] > 215) & (p[:, 1] > 170) & (p[:, 0] >= p[:, 2]) & (p[:, 1] >= p[:, 2] - 12)
    return skin.mean() >= 0.5


def find_eyes(img, box=None):
    """找一对青色瞳孔，返回 [(x0, y0, x1, y1) 左眼, 右眼]；找不准就返回 []（宁可不眨眼，也不画错）。
    只在人物上 40% 里找；从所有青色小块里挑高低差不超过 7、左右相隔 4–20 像素的一对。
    浅青色的披帛、纱带亮度高、块又大，会被排除。"""
    c = img[..., :3].astype(int)
    al = solid(img)
    teal = (c[..., 1] - c[..., 0] > 25) & (c[..., 2] - c[..., 0] > 15) & (c.max(-1) < 215) & al
    ys_all = np.where(al.any(1))[0]
    if not len(ys_all):
        return []
    top, bottom = ys_all[0], ys_all[-1]
    teal[top + int((bottom - top) * 0.4):] = False
    if box:
        x0, y0, x1, y1 = box
        m = np.zeros_like(teal)
        m[y0:y1 + 1, x0:x1 + 1] = True
        teal &= m
    import cv2
    n, lab, st, _ = cv2.connectedComponentsWithStats(teal.astype(np.uint8), connectivity=8)
    blobs = []
    for i in range(1, n):
        x, y, w, h, area = st[i]
        if w <= 7 and h <= 6 and area >= 2:
            blobs.append((x, y, x + w - 1, y + h - 1, area))
    best = None
    for i in range(len(blobs)):
        for j in range(len(blobs)):
            a, b = blobs[i], blobs[j]
            if a[0] >= b[0]:
                continue
            gap = b[0] - a[2]
            dy = abs(a[1] - b[1])
            if 4 <= gap <= 20 and dy <= 7 and _cheek_below(c, al, a) and _cheek_below(c, al, b):
                score = dy * 2 + abs(gap - 9) - (a[4] + b[4]) * 0.3
                if best is None or score < best[0]:
                    best = (score, a[:4], b[:4])
    return [best[1], best[2]] if best else []


def blink(img, eyes, level, skin=None, lash=None):
    """level: "half" 半闭 / "closed" 闭上。eyes 是 [(x0, y0, x1, y1), ...]。
    只换掉眼睛本身的像素（青色瞳孔、白色眼白和高光、深色睫毛），头发一个不碰；
    换上去的颜色逐列取眼睛正下方的脸颊色，和原来的脸色、阴影接得上。skin 参数保留不用。"""
    out = img.copy()
    lash = OUTLINE if lash is None else np.array(list(lash) + [255], np.uint8)
    H, W = img.shape[:2]
    c = img[..., :3].astype(int)
    lum = c @ np.array([0.299, 0.587, 0.114])
    teal = (c[..., 1] - c[..., 0] > 25) & (c[..., 2] - c[..., 0] > 15)
    eyeish = teal | (lum < 95) | ((c.min(-1) > 236) & (c.max(-1) - c.min(-1) < 14))
    for x0, y0, x1, y1 in eyes:
        top = y0 if level == "closed" else (y0 + y1) // 2
        for x in range(max(0, x0), min(W, x1 + 1)):
            # 往下找第一个不是眼睛的像素，当作这一列的脸颊色
            yy = y1 + 1
            while yy < min(H, y1 + 5) and eyeish[yy, x]:
                yy += 1
            cheek = img[min(yy, H - 1), x].copy()
            for y in range(max(0, top), min(H, y1 + 1)):
                if eyeish[y, x]:
                    out[y, x] = cheek
        line_y = y1 if level == "closed" else min(H - 1, (y0 + y1) // 2 + 1)
        for x in range(max(0, x0), min(W, x1 + 1)):
            out[line_y, x] = lash
        if level == "closed" and x1 - x0 >= 2:      # 两端往上翘一格，是闭着的弧线
            out[line_y, x0] = img[line_y, x0] if not eyeish[line_y, x0] else out[line_y, x0]
            out[line_y - 1, x0] = lash
            out[line_y - 1, x1] = lash
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


# ---------------- 互动动效用的小工具 ----------------
def effects_split(img, max_area=160):
    """把散在身边的小爱心、星星、蝙蝠（和身体不连着的小块）单独拿出来，让它们自己飘、自己闪。"""
    import cv2
    a = solid(img).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(a, connectivity=8)
    if n <= 1:
        return img, np.zeros_like(img)
    main = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    m = np.zeros(img.shape[:2], bool)
    for i in range(1, n):
        if i != main and st[i, cv2.CC_STAT_AREA] < max_area:
            m |= lab == i
    body = img.copy()
    body[m] = 0
    fx = np.zeros_like(img)
    fx[m] = img[m]
    return body, fx


def overlay(base, layer):
    out = base.copy()
    put = layer[..., 3] > 0
    out[put] = layer[put]
    return out


def head_anchor(img):
    """头顶位置：(头顶中心 x, 头顶 y, 头的大致半宽)。取人物最上面 30 行里像素最集中的那一段。"""
    al = solid(img)
    rows = np.where(al.any(1))[0]
    if not len(rows):
        return img.shape[1] // 2, 0, 10
    top = rows[0]
    band = al[top:top + 30]
    xs = np.where(band.any(0))[0]
    weights = band.sum(0)[xs]
    cx = int(round((xs * weights).sum() / max(weights.sum(), 1)))
    return cx, int(top), max(8, (xs.max() - xs.min()) // 4)


ICONS = {
    # 字符：# 描边  r 桃红  p 粉  w 白  b 浅蓝  y 黄  v 蓝紫  . 透明
    "bang": [".####.", "#rrrr#", "#rrrr#", "#rrrr#", ".#rr#.", ".#rr#.", ".#rr#.", "..##..", "......",
             ".####.", "#rrrr#", "#rrrr#", ".####."],
    "ques": ["..####..", ".#pppp#.", "#pp##pp#", "#p#..#p#", ".#...#p#", "....#pp#", "...#pp#.", "...#p#..",
             "...###..", "........", "...###..", "...#p#..", "...###.."],
    "dot": [".##.", "#ww#", "#ww#", ".##."],
    "sweat": ["...#...", "..#b#..", "..#b#..", ".#bbb#.", "#bbbbb#", "#wbbbb#", "#wbbbb#", ".#bbb#.", "..###.."],
    "heart": [".##...##.", "#rr#.#rr#", "#wrrrrrr#", "#rrrrrrr#", ".#rrrrr#.", "..#rrr#..", "...#r#...", "....#...."],
    "heart_s": [".#.#.", "#r#r#", "#rrr#", ".#r#.", "..#.."],
    "spark_l": ["...#...", "..#y#..", ".#yyy#.", "#yywyy#", ".#yyy#.", "..#y#..", "...#..."],
    "spark_s": ["..#..", ".#y#.", "#ywy#", ".#y#.", "..#.."],
    "twinkle": [".y.", "ywy", ".y."],
    "z_s": ["vvvv", "..v.", ".v..", "vvvv"],
    "z_m": ["vvvvv", "...v.", "..v..", ".v...", "vvvvv"],
    "z_l": ["vvvvvvv", ".....v.", "....v..", "...v...", "..v....", ".v.....", "vvvvvvv"],
    "tick_l": ["#..", ".#.", "..#"],
    "tick_r": ["..#", ".#.", "#.."],
    "tick_u": ["#", "#", "#"],
    "arc_l": ["..#..#", ".#..#.", "#..#..", "#..#..", ".#..#.", "..#..#"],
    "arc_r": ["#..#..", ".#..#.", "..#..#", "..#..#", ".#..#.", "#..#.."],
}
ICON_COLORS = {"#": (58, 26, 44), "r": (236, 72, 112), "p": (247, 150, 186), "w": (255, 255, 255),
               "b": (150, 206, 240), "y": (255, 214, 102), "v": (120, 110, 200)}


def icon_size(name):
    rows = ICONS[name]
    return len(rows[0]), len(rows)


def icon(img, name, x, y):
    """把小图标印到 (x, y) 左上角，超出画布的部分裁掉。"""
    return stamp(img, ICONS[name], ICON_COLORS, x, y)
