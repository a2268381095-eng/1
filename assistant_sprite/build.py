"""写作小助手 —— 像素小人动画生成脚本

sprite.txt 是原画的 1:1 像素表（55×76，一个字符 = 一个像素，'.' 为透明）。
想改哪个像素，直接改对应字符再运行本脚本即可：

    python3 build.py

输出到 out/：复刻图、各动画的 GIF、精灵表 sheet.png 和帧描述 sheet.json。
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
OUT = HERE / "out"

# ---------------- 调色板（全部取自原画） ----------------
PALETTE = {
    "#": (58, 26, 44),     # 描边
    "1": (104, 42, 76),    # 粉紫，由暗到亮 1 → 7
    "2": (146, 58, 104),
    "3": (178, 82, 134),
    "4": (212, 100, 150),
    "5": (238, 132, 176),
    "6": (252, 174, 198),
    "7": (255, 212, 222),
    "s": (238, 186, 178),  # 皮肤暗部
    "S": (255, 236, 228),  # 皮肤亮部
    "W": (255, 255, 255),  # 白（长袜）
    "g": (200, 210, 228),  # 灰蓝亮
    "G": (150, 152, 172),  # 灰蓝暗
    "E": (36, 176, 156),   # 瞳色
}
EMPTY = "."
PAPER = (250, 244, 232)    # 预览用的纸色背景

# 画布四周留白：上浮、发尾拉长、光点都不会出界
PAD_T, PAD_B, PAD_L, PAD_R = 3, 2, 2, 2
SCALE = 6                  # GIF 放大倍数


def load():
    rows = (HERE / "sprite.txt").read_text().split("\n")
    rows = [r for r in rows if r]
    return {(x, y): c for y, r in enumerate(rows) for x, c in enumerate(r) if c != EMPTY}, len(rows[0]), len(rows)


BASE, SRC_W, SRC_H = load()
W, H = SRC_W + PAD_L + PAD_R, SRC_H + PAD_T + PAD_B


def pick(x0, x1, y0, y1, g=BASE):
    return {(x, y) for (x, y) in g if x0 <= x <= x1 and y0 <= y <= y1}


def flood(seed, x0, x1, y0, y1):
    """在矩形范围内，从 seed 出发取相连的非透明像素。"""
    box = pick(x0, x1, y0, y1)
    seen, stack = set(), [seed]
    while stack:
        p = stack.pop()
        if p in seen or p not in box:
            continue
        seen.add(p)
        x, y = p
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return seen


# ---------------- 部件 ----------------
ORB = flood((10, 15), 0, 17, 0, 21)    # 左手上方的光球
TAIL_R = pick(41, 48, 16, 22)          # 右侧发卷末端
TAIL_L = pick(18, 22, 21, 22)          # 左侧发束末端

# 眼睛：E 为瞳孔，周围是睫毛与眼白
EYES = {
    "open": {},
    "half": {(29, 16): "#", (28, 16): "1", (34, 14): "#"},
    "closed": {(28, 16): "#", (29, 16): "#", (29, 17): "S",
               (34, 13): "2", (34, 14): "#", (34, 15): "s", (33, 15): "S"},
    "happy": {(27, 16): "#", (28, 16): "S", (29, 16): "#", (29, 17): "S",   # ^ ^
              (34, 14): "S", (34, 15): "S", (33, 15): "S"},
}
MOUTHS = {
    None: {},
    "small": {(33, 19): "3"},
    "open": {(33, 19): "2", (33, 20): "3"},
}
GLOW = {"1": "2", "2": "3", "3": "4", "4": "5", "5": "6", "6": "7", "7": "W", "s": "S", "S": "W", "g": "W", "G": "g"}

# 光点：相对光球，跟着光球一起浮动
SPARKS = {"a": (4, 8), "b": (19, 11), "c": (3, 19)}


def stretch(g, part, row):
    """把部件 row 行以下整体下移 1 像素、row 行复制一份：发尾被拉长，用作甩动的滞后。"""
    old = {p: g[p] for p in part if p in g}
    for p in old:
        del g[p]
    for (x, y), c in old.items():
        g[(x, y + 1) if y >= row else (x, y)] = c
        if y == row:
            g[(x, y)] = c


def frame(body=0, orb=0, tails=False, eyes="open", mouth=None, glow=0, sparks=()):
    """body/orb：上下位移（负数向上）；glow：光球亮度 0-2；sparks：[(名字, 'small'|'big')]"""
    g = dict(BASE)
    if tails:
        stretch(g, TAIL_R, 16)
        stretch(g, TAIL_L, 21)
    g.update(EYES[eyes])
    g.update(MOUTHS[mouth])

    orb_px = {p: g.pop(p) for p in ORB}
    for _ in range(glow):
        orb_px = {p: GLOW.get(c, c) for p, c in orb_px.items()}

    canvas = {}
    for (x, y), c in g.items():
        canvas[(x + PAD_L, y + PAD_T + body)] = c
    oy = PAD_T + body + orb
    for (x, y), c in orb_px.items():
        canvas[(x + PAD_L, y + oy)] = c
    for name, size in sparks:
        sx, sy = SPARKS[name]
        sx, sy = sx + PAD_L, sy + oy
        if size == "big":
            for d in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                canvas.setdefault((sx + d[0], sy + d[1]), "5")
        canvas[(sx, sy)] = "W" if size == "big" else "5"
    return canvas


def to_image(canvas, bg=None):
    img = Image.new("RGBA", (W, H), (bg + (255,)) if bg else (0, 0, 0, 0))
    px = img.load()
    for (x, y), c in canvas.items():
        if 0 <= x < W and 0 <= y < H:
            px[x, y] = PALETTE[c] + (255,)
    return img


# ---------------- 动画 ----------------
# 漂浮：身体上下 1 像素；发尾在上浮那一刻滞后拉长；光球比身体慢半拍、浮得更高
BOB = [0, 0, -1, -1, -1, -1, 0, 0]
ORB_ABS = [0, -1, -1, -2, -2, -2, -1, 0]
TAILS = [False, False, True, True, False, False, False, False]


def idle(eyes=None, mouths=None):
    eyes = eyes or ["open"] * 8
    mouths = mouths or [None] * 8
    return [frame(BOB[i], ORB_ABS[i] - BOB[i], TAILS[i], eyes[i], mouths[i]) for i in range(8)]


def idea():
    """灵感：光球亮起、冒光点，人跟着一跳，眼睛笑成 ^ ^"""
    spec = [  # body, orb, glow, eyes, mouth, sparks
        (0, 0, 0, "open", None, []),
        (0, -1, 1, "open", None, [("a", "small")]),
        (-1, -1, 2, "happy", "small", [("a", "big"), ("b", "small")]),
        (-2, -1, 2, "happy", "open", [("a", "small"), ("b", "big"), ("c", "small")]),
        (-2, -1, 2, "happy", "open", [("b", "small"), ("c", "big")]),
        (-1, -1, 1, "happy", "small", [("c", "small")]),
        (0, 0, 1, "open", None, []),
        (0, 0, 0, "open", None, []),
    ]
    out = []
    for i, (b, o, gl, e, m, sp) in enumerate(spec):
        out.append(frame(b, o, tails=i in (2, 3), eyes=e, mouth=m, glow=gl, sparks=sp))
    return out


ANIMS = {
    # 名字: (帧, 每帧毫秒)
    "idle": (idle(), 160),
    "blink": (idle(eyes=["open", "open", "open", "half", "closed", "half", "open", "open"]), 160),
    "talk": (idle(mouths=[None, "small", "open", "small", None, "open", "small", None]), 120),
    "idea": (idea(), 110),
}


def save_gif(path, frames, ms, bg=None, scale=SCALE):
    imgs = [to_image(f, bg).resize((W * scale, H * scale), Image.NEAREST) for f in frames]
    durations = ms if isinstance(ms, list) else [ms] * len(imgs)
    if bg:
        pal = [i.convert("RGB").quantize(colors=32, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for i in imgs]
        pal[0].save(path, save_all=True, append_images=pal[1:], duration=durations, loop=0)
        return
    # 透明 GIF：第 0 号色作为透明色
    colors = [(1, 2, 3)] + list(PALETTE.values())
    flat = sum((list(c) for c in colors), []) + [0] * (768 - 3 * len(colors))
    ps = []
    for im in imgs:
        a = np.asarray(im)
        idx = np.zeros(a.shape[:2], np.uint8)
        for i, c in enumerate(colors[1:], 1):
            idx[(a[..., 3] > 0) & (a[..., :3] == c).all(-1)] = i
        p = Image.fromarray(idx, "P")
        p.putpalette(flat)
        ps.append(p)
    ps[0].save(path, save_all=True, append_images=ps[1:], duration=durations, loop=0,
               transparency=0, disposal=2)


def main():
    (OUT / "gif").mkdir(parents=True, exist_ok=True)

    # 复刻静帧
    still = to_image(frame())
    still.save(OUT / "replica.png")
    still.resize((W * 8, H * 8), Image.NEAREST).save(OUT / "replica_8x.png")

    # 精灵表：一行一个动画，每格 W×H
    n = max(len(f) for f, _ in ANIMS.values())
    sheet = Image.new("RGBA", (W * n, H * len(ANIMS)), (0, 0, 0, 0))
    meta = {"frame_w": W, "frame_h": H, "animations": {}}
    for row, (name, (frames, ms)) in enumerate(ANIMS.items()):
        for i, f in enumerate(frames):
            sheet.paste(to_image(f), (i * W, row * H))
        meta["animations"][name] = {"row": row, "frames": len(frames), "ms_per_frame": ms}
        save_gif(OUT / "gif" / f"{name}.gif", frames, ms)
    sheet.save(OUT / "sheet.png")
    sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST).save(OUT / "sheet_4x.png")
    (OUT / "sheet.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

    # 串起来的总预览：待机 → 眨眼 → 待机 → 说话 → 灵感
    seq, durs = [], []
    for name, times in (("idle", 2), ("blink", 1), ("idle", 1), ("talk", 2), ("idle", 1), ("idea", 1), ("idle", 1)):
        frames, ms = ANIMS[name]
        seq += frames * times
        durs += [ms] * (len(frames) * times)
    save_gif(OUT / "preview.gif", seq, durs, bg=PAPER)
    print(f"frame {W}x{H}, {len(ANIMS)} animations -> {OUT}")


if __name__ == "__main__":
    main()
