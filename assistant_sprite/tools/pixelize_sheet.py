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
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8)).astype(bool)
    # 剥掉 GPT 画在人物外面的那圈白边（实测 1–2 像素）：只剥纯白、最多 3 层，
    # 白袜、白袖子这些衣服里面也是纯白，剥深了会缺一块；剩下的一点由最外圈描边盖住
    pale = (src.min(2) > 238) & ((src.max(2) - src.min(2)) < 20)
    for _ in range(3):
        edge = fg & cv2.dilate((~fg).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        peel = edge & pale
        if not peel.any():
            break
        fg &= ~peel
    return fg


def strip_haze(src, fg, layers=40):
    """擦掉人物身后、脚下的淡粉色光晕和爱心地影：从外往里剥淡粉色像素，碰到线稿就停。"""
    c = src.astype(int)
    # 光晕是偏粉紫的淡粉（蓝比绿多）；皮肤偏暖（绿比蓝多），不剥
    haze = (c[..., 0] >= 232) & (c[..., 0] - c[..., 1] >= 14) & (c[..., 1] >= 160) & (c[..., 2] >= c[..., 1] + 4)
    fg = fg.copy()
    for _ in range(layers):
        edge = fg & cv2.dilate((~fg).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        peel = edge & haze
        if not peel.any():
            break
        fg &= ~peel
    return fg


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


def split_body(src, body, parts):
    """把粘在一起的几个人物分开：在身体最厚的地方（躯干）各取一个种子，
    再用分水岭沿着轮廓线把像素分给各自的种子，翅膀、袖子会顺着肩膀归回本人。"""
    dt = cv2.distanceTransform(body.astype(np.uint8), cv2.DIST_L2, 5)
    xs_all = np.where(body.any(0))[0]
    min_sep = (xs_all[-1] - xs_all[0]) / (parts * 2.0)
    seeds = None
    for t in np.linspace(dt.max() * 0.9, 1, 80):
        n, lab, st, cen = cv2.connectedComponentsWithStats((dt > t).astype(np.uint8), connectivity=8)
        good = sorted((i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] > 30),
                      key=lambda i: st[i, cv2.CC_STAT_AREA], reverse=True)
        chosen = []
        for i in good:     # 种子要左右分开：每个人物一个躯干，不在同一个人身上取两个
            if all(abs(cen[i][0] - cen[j][0]) >= min_sep for j in chosen):
                chosen.append(i)
            if len(chosen) == parts:
                break
        if len(chosen) == parts:
            seeds = [lab == i for i in chosen]
            break
    if seeds is None:            # 实在找不到就退回竖线切
        xs = np.where(body.any(0))[0]
        cut = xs[0] + split_runs(body[:, xs[0]:xs[-1] + 1].sum(0).astype(float), 2, 0.25)[1]
        a, b = body.copy(), body.copy()
        a[:, cut:] = False
        b[:, :cut] = False
        return [a, b][:parts]
    # 按「离轮廓多远」从厚到薄往外淹：躯干最厚处先淹，两边在连接最细的地方相遇，
    # 翅膀尖碰到隔壁头发这种情况，就在碰到的那一点切开
    import heapq
    H, W = body.shape
    markers = np.zeros(body.shape, np.int32)
    for i, sd in enumerate(seeds):
        markers[sd & body] = i + 1
    heap = []
    ys, xs = np.nonzero(markers)
    for y, x in zip(ys, xs):
        heap.append((-float(dt[y, x]), int(y), int(x), int(markers[y, x])))
    heapq.heapify(heap)
    while heap:
        _, y, x, lab_ = heapq.heappop(heap)
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < H and 0 <= nx < W and body[ny, nx] and markers[ny, nx] == 0:
                markers[ny, nx] = lab_
                heapq.heappush(heap, (-float(dt[ny, nx]), ny, nx, lab_))
    return [body & (markers == i + 1) for i in range(parts)]


def give_back_strays(bodies):
    """每个人物只留连在一起的主体；分出来的小块如果贴着别人的身体，就是别人的头发、衣角，还给对方。"""
    kernel = np.ones((3, 3), np.uint8)
    for i in range(len(bodies)):
        n, lab, st, _ = cv2.connectedComponentsWithStats(bodies[i].astype(np.uint8), connectivity=8)
        if n <= 2:
            continue
        main = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
        for c in range(1, n):
            if c == main:
                continue
            piece = lab == c
            ring = cv2.dilate(piece.astype(np.uint8), kernel).astype(bool) & ~piece
            touch = [ (ring & bodies[j]).sum() if j != i else 0 for j in range(len(bodies))]
            j = int(np.argmax(touch))
            if touch[j] > 0:
                bodies[i] = bodies[i] & ~piece
                bodies[j] = bodies[j] | piece
    return bodies


def figure_masks(fg, rows, src):
    """认出每个姿势：先找整张图里的人物身体，按身体中心分行；粘在一起的人物用分水岭分开；
    魔法球、星星、毛笔这类分离的小块，逐个并给离它最近的人物（下落线会先挂到球上再跟着走）。"""
    n, lab, st, _ = cv2.connectedComponentsWithStats(
        cv2.dilate(fg.astype(np.uint8), np.ones((3, 3), np.uint8)), connectivity=8)
    lab = lab * fg
    comps = list(range(1, n))
    big = max(st[i, cv2.CC_STAT_AREA] for i in comps)
    body_ids = [i for i in comps if st[i, cv2.CC_STAT_AREA] >= big * 0.15]
    rest = [lab == i for i in comps if i not in body_ids]
    cuts = split_runs(fg.sum(1), len(rows), 0.2)
    by_row = [[] for _ in rows]
    for i in body_ids:
        cy = np.where(lab == i)[0].mean()
        r = max(0, min(len(rows) - 1, int(np.searchsorted(cuts, cy, side="right")) - 1))
        by_row[r].append(lab == i)
    bodies = []
    for k, row_bodies in zip(rows, by_row):
        while len(row_bodies) < k:
            row_bodies.sort(key=lambda b: b.sum())
            merged = row_bodies.pop()
            # 估计这一块里粘了几个人：按宽度和本行平均宽度的比例
            parts = min(k - len(row_bodies), max(2, k - len(row_bodies)))
            row_bodies += split_body(src, merged, parts)
        row_bodies.sort(key=lambda b: b.sum(), reverse=True)
        rest += row_bodies[k:]
        bodies += sorted(row_bodies[:k], key=lambda b: np.where(b)[1].mean())
    bodies = give_back_strays(bodies)
    while rest:
        dist = [cv2.distanceTransform((~b).astype(np.uint8), cv2.DIST_L2, 3) for b in bodies]
        _, ri, j = min(((dist[j][r].min(), ri, j) for ri, r in enumerate(rest) for j in range(len(bodies))))
        bodies[j] |= rest.pop(ri)
    return bodies


def round_cut(alpha, side, depth=4):
    """参考图边框截断的地方，像素版会留下一段竖直平边。把这段平边修圆：两头多削、中间少削，
    像头发自然收拢。只删像素不加像素。"""
    cols = np.where(alpha.any(0))[0]
    if not len(cols):
        return alpha
    a = alpha.copy()
    x_edge = cols.min() if side == "left" else cols.max()
    rows = np.where(a[:, x_edge])[0]
    if not len(rows):
        return a
    for run in np.split(rows, np.where(np.diff(rows) > 1)[0] + 1):
        if len(run) < 8:
            continue
        r0, r1 = run[0], run[-1]
        half, mid = (r1 - r0) / 2.0, (r0 + r1) / 2.0
        d = min(depth, max(2, len(run) // 4))
        for r in run:
            t = (r - mid) / max(half, 1)
            k = int(round(d * (1 - np.sqrt(max(0.0, 1 - t * t))))) + (1 if abs(t) > 0.85 else 0)
            if k <= 0:
                continue
            if side == "left":
                a[r, x_edge:x_edge + k] = False
            else:
                a[r, x_edge - k + 1:x_edge + 1] = False
    return a


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
    ap.add_argument("--no-haze", action="store_true", help="擦掉身后、脚下的淡粉色光晕和爱心地影")
    a = ap.parse_args()

    rows = [int(x) for x in a.rows.split(",")]
    names = a.names.split(",")
    canvas = tuple(int(x) for x in a.canvas.split("x"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    src = np.asarray(Image.open(a.image).convert("RGB")).astype(np.float32)
    lum = src @ np.array([0.299, 0.587, 0.114])
    fg = foreground(src)
    if a.no_haze:
        fg = strip_haze(src, fg)
    masks = figure_masks(fg, rows, src)
    heights = [np.ptp(np.where(m)[0]) + 1 for m in masks]
    widths = [np.ptp(np.where(m)[1]) + 1 for m in masks]
    scale = a.char_height / float(np.median(heights))
    fit = min((canvas[1] - 4) / max(heights), (canvas[0] - 4) / max(widths))
    if fit < scale:
        print(f"  最高/最宽的姿势放不下，缩放从 {scale:.3f} 降到 {fit:.3f}（要更大就加大 --canvas）")
        scale = fit
    print(f"找到 {len(masks)} 个姿势，缩放 {scale:.3f}")

    poses = []
    for m in masks:
        rgb, alpha = pixelize_one(src, lum, m, scale, canvas)
        if m[:, :3].any():                 # 参考图里这个姿势碰到了左边框
            alpha = round_cut(alpha, "left")
        if m[:, -3:].any():
            alpha = round_cut(alpha, "right")
        poses.append((rgb, alpha))
    pal = build_palette(poses, a.colors)
    pal_arr = np.array(pal, float)
    chars = {c: list(map(int, p)) for c, p in zip(CHARS, pal)}

    cw, ch = canvas
    sheet = Image.new("RGB", ((cw * 2 + 8) * len(poses), ch * 2), PAPER)
    for i, (rgb, alpha) in enumerate(poses):
        name = names[i] if i < len(names) else f"pose{i + 1}"
        idx = np.argmin(((rgb[..., None, :] - pal_arr[None, None]) ** 2).sum(-1), -1)
        # 描边：人物最外一圈像素直接涂成描边色，轮廓是干净的 1 像素线
        inside = alpha.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            inside &= np.roll(np.roll(alpha, dy, 0), dx, 1)
        idx[alpha & ~inside] = 0
        solid = alpha
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
