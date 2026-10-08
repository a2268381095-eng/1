"""把 GPT 出的「同一个动作的连续几帧」转成像素关键帧，和已有姿势对齐

    python3 tools/keyframes.py 关键帧图.png styles/<id> <动作> --ref 2 [--rows 3] [--frames 3]

关键帧图：白底，一行（或几行）排着同一个动作的几个瞬间，从左到右按时间顺序。
--ref 指出哪一帧和 poses/<动作>.png 是同一个姿势（从 1 数），用它来定缩放和位置：
  · 缩放：让这一帧的人物高度等于已有姿势的高度
  · 上下：所有帧共用同一条地面（图里最低的脚底），对到已有姿势的脚底
  · 左右：每帧按自己身体躯干的中线，对到已有姿势躯干的中线
颜色一律映射到这套风格已有的调色板（poses/palette.json），和其他动作的配色一致。
输出到 styles/<id>/keys/<动作>_k1.png …，再加一张 <动作>_keys.png 预览（和已有姿势叠在一起看）。
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from pixelize_sheet import CHARS, OUTLINE, PAPER, figure_masks, foreground  # noqa: E402


def torso_x(mask_or_alpha):
    """躯干中线：人物高度 35%–60% 那一段像素的 x 中位数（举起的手、甩出去的头发影响不大）。"""
    ys, xs = np.where(mask_or_alpha)
    y0, y1 = ys.min(), ys.max()
    band = (ys >= y0 + 0.35 * (y1 - y0)) & (ys <= y0 + 0.6 * (y1 - y0))
    return float(np.median(xs[band]))


def pixelize_at(src, lum, m, scale, canvas, oy, ox):
    """和 pixelize_sheet.pixelize_one 一样的取色方法，只是位置由调用方给定。"""
    ys, xs = np.where(m)
    ya, yb, xa, xb = ys.min(), ys.max(), xs.min(), xs.max()
    cw, ch = canvas
    th, tw = int(np.ceil((yb - ya + 1) * scale)), int(np.ceil((xb - xa + 1) * scale))
    rgb = np.zeros((ch, cw, 3))
    alpha = np.zeros((ch, cw), bool)
    step = 1 / scale
    for ty in range(th):
        sy0, sy1 = ya + int(ty * step), min(ya + int((ty + 1) * step), yb + 1)
        for tx in range(tw):
            sx0, sx1 = xa + int(tx * step), min(xa + int((tx + 1) * step), xb + 1)
            if sy1 <= sy0 or sx1 <= sx0:
                continue
            mm = m[sy0:sy1, sx0:sx1]
            if mm.mean() < 0.5:
                continue
            blk = src[sy0:sy1, sx0:sx1][mm]
            ll = lum[sy0:sy1, sx0:sx1][mm]
            c = blk[ll < 120].mean(0) if (ll < 120).mean() > 0.28 else np.median(blk, 0)
            Y, X = oy + ty, ox + tx
            if 0 <= Y < ch and 0 <= X < cw:
                rgb[Y, X], alpha[Y, X] = c, True
    return rgb, alpha


def to_palette(rgb, alpha, pal):
    pal_arr = np.array(pal, float)
    idx = np.argmin(((rgb[..., None, :] - pal_arr[None, None]) ** 2).sum(-1), -1)
    inside = alpha.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        inside &= np.roll(np.roll(alpha, dy, 0), dx, 1)
    idx[alpha & ~inside] = 0
    img = np.zeros(alpha.shape + (4,), np.uint8)
    img[alpha, :3] = pal_arr[idx[alpha]].astype(np.uint8)
    img[alpha, 3] = 255
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("style")
    ap.add_argument("action")
    ap.add_argument("--ref", type=int, default=2, help="和已有姿势相同的那一帧（从 1 数）")
    ap.add_argument("--rows", default="", help="每行几帧，例如 3 或 3,3；默认一行，帧数由 --frames 给")
    ap.add_argument("--frames", type=int, default=3)
    a = ap.parse_args()

    sd = Path(a.style)
    pose = np.array(Image.open(sd / "poses" / f"{a.action}.png").convert("RGBA"))
    pal_json = json.loads((sd / "poses" / "palette.json").read_text())
    pal = [tuple(pal_json[c]) for c in CHARS if c in pal_json]
    pa = pose[..., 3] > 0
    pys = np.where(pa.any(1))[0]
    pose_h, pose_bottom, pose_tx = pys[-1] - pys[0] + 1, int(pys[-1]), torso_x(pa)

    rows = [int(x) for x in a.rows.split(",")] if a.rows else [a.frames]
    src = np.asarray(Image.open(a.image).convert("RGB")).astype(np.float32)
    lum = src @ np.array([0.299, 0.587, 0.114])
    masks = figure_masks(foreground(src), rows, src)
    ref = masks[a.ref - 1]
    rys = np.where(ref.any(1))[0]
    scale = pose_h / float(rys[-1] - rys[0] + 1)
    canvas = (pose.shape[1], pose.shape[0])

    # 每一行有自己的地面：这一行里最低的脚底
    out_dir = sd / "keys"
    out_dir.mkdir(exist_ok=True)
    frames, k = [], 0
    for n in rows:
        row_masks = masks[k:k + n]
        ground = max(np.where(m.any(1))[0][-1] for m in row_masks)
        for m in row_masks:
            ys, xs = np.where(m)
            oy = int(round(pose_bottom + (ys.min() - ground) * scale))
            ox = int(round(pose_tx + (xs.min() - torso_x(m)) * scale))
            rgb, alpha = pixelize_at(src, lum, m, scale, canvas, oy, ox)
            k += 1
            img = to_palette(rgb, alpha, pal)
            Image.fromarray(img, "RGBA").save(out_dir / f"{a.action}_k{k}.png")
            frames.append(img)
    # 预览：每帧和已有姿势（淡红）叠在一起，看对得齐不齐
    S = 2
    W, H = canvas
    sheet = Image.new("RGB", ((W * S + 8) * (len(frames) + 1), H * S), PAPER)
    tiles = [pose] + frames
    for i, f in enumerate(tiles):
        bg = Image.new("RGBA", (W, H), PAPER + (255,))
        if i:
            ghost = pose.copy()
            ghost[..., :3] = (240, 120, 120)
            ghost[..., 3] = np.where(pa, 70, 0)
            bg.alpha_composite(Image.fromarray(ghost, "RGBA"))
        bg.alpha_composite(Image.fromarray(f, "RGBA"))
        sheet.paste(bg.convert("RGB").resize((W * S, H * S), Image.NEAREST), (i * (W * S + 8), 0))
    sheet.save(out_dir / f"{a.action}_keys.png")
    print(f"{a.action}: {len(frames)} 帧，缩放 {scale:.3f}，输出到 {out_dir}")


if __name__ == "__main__":
    main()
