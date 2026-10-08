"""把 GPT 出的多姿势参考图转成像素小人

    python3 tools/pixelize_sheet.py 参考图.png 输出目录 \
        --rows 4,3 --names idle,wave,point,think,cheer,shock,doze \
        --char-height 210 --canvas 128x224 --colors 48

参考图要求见《小恶魔参考图需求单》：白底、全身、每行若干个姿势、姿势之间留白。

输出到「输出目录」：
    <名字>.png       每个姿势一张，画布大小，透明底，脚底贴着画布底边（留 2 像素）
    <名字>.txt       同一张图的字符像素表（和 styles/ 里的格式一样）
    palette.json     字符 → 颜色
    sheet.png        所有姿势排一行，纸色底，2 倍放大，方便看
所有姿势用同一个缩放比例和同一套颜色，保证人物大小、配色一致。
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

OUTLINE = (58, 26, 44)
PAPER = (250, 244, 232)
CHARS = "#123456789abcdefhijklmnopqrtuvwxyzABCDFHIJKLMNOPQRTUVXYZ@$%&*+=?!"


def foreground(src):
    """白底抠图：接近白色、并且和图片边缘连通的像素算背景（白色长袜被描边围住，不会被抠掉）。"""
    near_white = (src.min(2) > 232) & ((src.max(2) - src.min(2)) < 18)
    n, lab = cv2.connectedComponents(near_white.astype(np.uint8), connectivity=4)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    bg = np.isin(lab, list(edge)) & near_white
    fg = (~bg).astype(np.uint8)
    return cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8)).astype(bool)


def split_runs(profile, parts, min_gap_frac=0.15):
    """在一维投影里找 parts-1 个切点：取最空的位置，切点之间至少隔开总长的一定比例。"""
    k = np.convolve(profile, np.ones(9) / 9, mode="same")
    n = len(k)
    nz = np.nonzero(profile)[0]
    lo, hi = (nz[0], nz[-1]) if len(nz) else (0, n - 1)
    cuts = []
    order = np.argsort(k[lo:hi]) + lo
    min_gap = (hi - lo) * min_gap_frac
    for x in order:
        if len(cuts) == parts - 1:
            break
        if x - lo < min_gap or hi - x < min_gap or any(abs(x - c) < min_gap for c in cuts):
            continue
        cuts.append(int(x))
    return [0] + sorted(cuts) + [n]


def figure_masks(fg, rows):
    """先按行切；每行里认出 k 个人物身体（连在一起的就在最空的竖线处切开），
    再把魔法球、星星这类分离的小块分给离它最近的身体。"""
    ys = split_runs(fg.sum(1), len(rows), 0.2)
    masks = []
    for (y0, y1), k in zip(zip(ys[:-1], ys[1:]), rows):
        band = np.zeros_like(fg)
        band[y0:y1] = fg[y0:y1]
        n, lab, st, cen = cv2.connectedComponentsWithStats(
            cv2.dilate(band.astype(np.uint8), np.ones((3, 3), np.uint8)), connectivity=8)
        lab = lab * band
        comps = list(range(1, n))
        big = max(st[i, cv2.CC_STAT_AREA] for i in comps)
        bodies = [lab == i for i in comps if st[i, cv2.CC_STAT_AREA] >= big * 0.25]
        rest = [i for i in comps if st[i, cv2.CC_STAT_AREA] < big * 0.25]
        while len(bodies) < k:      # 两个人挨在一起：在最宽那块里找最空的竖线切开
            bodies.sort(key=lambda b: np.ptp(np.where(b)[1]))
            b = bodies.pop()
            xs = np.where(b.any(0))[0]
            prof = b[:, xs[0]:xs[-1] + 1].sum(0).astype(float)
            cut = xs[0] + split_runs(prof, 2, 0.25)[1]
            left, right = b.copy(), b.copy()
            left[:, cut:] = False
            right[:, :cut] = False
            bodies += [left, right]
        bodies.sort(key=lambda b: b.sum(), reverse=True)
        bodies = sorted(bodies[:k], key=lambda b: np.where(b)[1].mean())
        # 特效逐个归队：每次把离某个人物（含已归入的特效）最近的那一块并进去，
        # 下落线会先挂到魔法球上，再跟着球归到对的人物
        rest = [lab == i for i in rest]
        while rest:
            dist = [cv2.distanceTransform((~b).astype(np.uint8), cv2.DIST_L2, 3) for b in bodies]
            best = min(((dist[j][r].min(), ri, j) for ri, r in enumerate(rest) for j in range(len(bodies))))
            _, ri, j = best
            bodies[j] |= rest.pop(ri)
        masks += bodies
    return masks


def pixelize_one(src, lum, m, scale, canvas):
    ys, xs = np.where(m)
    ya, yb, xa, xb = ys.min(), ys.max(), xs.min(), xs.max()
    cw, ch = canvas
    th, tw = int(np.ceil((yb - ya + 1) * scale)), int(np.ceil((xb - xa + 1) * scale))
    oy, ox = ch - 2 - th, (cw - tw) // 2
    if oy < 1 or ox < 1:
        print(f"  ! 姿势超出画布（需要 {tw}×{th}），会被裁掉一部分，可以调小 --char-height")
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
            # 线稿保留：块里暗线占得多，就取线的颜色，不然取中位色
            c = blk[ll < 120].mean(0) if (ll < 120).mean() > 0.28 else np.median(blk, 0)
            Y, X = oy + ty, ox + tx
            if 0 <= Y < ch and 0 <= X < cw:
                rgb[Y, X], alpha[Y, X] = c, True
    return rgb, alpha


def build_palette(poses, ncol):
    allpx = np.concatenate([r[a] for r, a in poses]).astype(np.uint8)
    # 青色瞳孔在中位切分里容易被冲掉，单独留 3 个色位
    teal = (allpx[:, 1].astype(int) - allpx[:, 0] > 25) & (allpx[:, 2].astype(int) - allpx[:, 0] > 15)
    base = Image.fromarray(allpx[~teal].reshape(-1, 1, 3)).quantize(colors=ncol - 4, method=Image.Quantize.MEDIANCUT)
    pal = [tuple(base.getpalette()[i:i + 3]) for i in range(0, 3 * (ncol - 4), 3)]
    if teal.sum():
        t = allpx[teal].astype(float)
        t = t[np.argsort(t @ np.array([0.299, 0.587, 0.114]))]
        for q in (0.2, 0.5, 0.85):
            pal.append(tuple(np.median(t[: max(1, int(len(t) * q))], 0).astype(int)))
    pal = [OUTLINE] + [p for p in dict.fromkeys(pal) if p != OUTLINE]
    return pal[: len(CHARS)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("out")
    ap.add_argument("--rows", default="4,3")
    ap.add_argument("--names", default="idle,wave,point,think,cheer,shock,doze")
    ap.add_argument("--char-height", type=int, default=210, help="姿势高度的中位数缩放到多少像素")
    ap.add_argument("--canvas", default="128x224")
    ap.add_argument("--colors", type=int, default=48)
    a = ap.parse_args()

    rows = [int(x) for x in a.rows.split(",")]
    names = a.names.split(",")
    canvas = tuple(int(x) for x in a.canvas.split("x"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    src = np.asarray(Image.open(a.image).convert("RGB")).astype(np.float32)
    lum = src @ np.array([0.299, 0.587, 0.114])
    fg = foreground(src)
    masks = figure_masks(fg, rows)
    heights = [np.ptp(np.where(m)[0]) + 1 for m in masks]
    widths = [np.ptp(np.where(m)[1]) + 1 for m in masks]
    scale = a.char_height / float(np.median(heights))
    fit = min((canvas[1] - 4) / max(heights), (canvas[0] - 4) / max(widths))
    if fit < scale:
        print(f"  最高/最宽的姿势放不下，缩放从 {scale:.3f} 降到 {fit:.3f}（要更大就加大 --canvas）")
        scale = fit
    print(f"找到 {len(masks)} 个姿势，缩放 {scale:.3f}")

    poses = [pixelize_one(src, lum, m, scale, canvas) for m in masks]
    pal = build_palette(poses, a.colors)
    pal_arr = np.array(pal, float)
    chars = {c: list(map(int, p)) for c, p in zip(CHARS, pal)}

    cw, ch = canvas
    sheet = Image.new("RGB", ((cw * 2 + 8) * len(poses), ch * 2), PAPER)
    for i, (rgb, alpha) in enumerate(poses):
        name = names[i] if i < len(names) else f"pose{i + 1}"
        idx = np.argmin(((rgb[..., None, :] - pal_arr[None, None]) ** 2).sum(-1), -1)
        # 外描边：人物外面一圈透明像素涂成描边色
        ring = np.zeros_like(alpha)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ring |= np.roll(np.roll(alpha, dy, 0), dx, 1)
        ring &= ~alpha
        idx[ring] = 0
        solid = alpha | ring
        rows_txt = ["".join(CHARS[idx[y, x]] if solid[y, x] else "." for x in range(cw)) for y in range(ch)]
        (out / f"{name}.txt").write_text("\n".join(rows_txt) + "\n")
        img = np.zeros((ch, cw, 4), np.uint8)
        img[solid, :3] = pal_arr[idx[solid]].astype(np.uint8)
        img[solid, 3] = 255
        im = Image.fromarray(img, "RGBA")
        im.save(out / f"{name}.png")
        tile = Image.new("RGBA", im.size, PAPER + (255,))
        tile.alpha_composite(im)
        sheet.paste(tile.convert("RGB").resize((cw * 2, ch * 2), Image.NEAREST), (i * (cw * 2 + 8), 0))
    sheet.save(out / "sheet.png")
    (out / "palette.json").write_text(json.dumps(chars, ensure_ascii=False))
    print(f"输出到 {out}：{len(poses)} 个姿势，{len(pal)} 种颜色")


if __name__ == "__main__":
    main()
