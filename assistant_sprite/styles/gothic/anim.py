"""哥特·暗夜魔典 的动作动画

    cd assistant_sprite && python3 styles/gothic/anim.py [动作名 ...]

姿势来自 poses/（refs/gothic_sheet.webp 转出），这里只做移动、弯曲、转动、换色和小特效。
"""
import math
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent.parent / "tools"))
from anim_kit import (OUTLINE, bend, blink, brighten, export, find_eyes, load_pose,  # noqa: E402
                      rect_mask, rotate_region, shift, solid)

SKIN = (254, 237, 234)
PAPER = (248, 238, 232)
PAPER_SHADE = (222, 204, 206)


def pose(name):
    return load_pose(HERE / "poses" / f"{name}.png")


def sine(i, n, amp, phase=0.0):
    return int(round(amp * math.sin(2 * math.pi * i / n + phase)))


def page(img, spine, length, height, angle):
    """画一张正在翻的书页：从书脊 spine=(x, y) 伸出去，angle 0° 平放在右边、180° 翻到左边，
    中间往上拱起。纸页只是一个带描边的四边形，颜色取书页的米白。"""
    out = img.copy()
    sx, sy = spine
    a = math.radians(angle)
    tip_x = sx + length * math.cos(a)
    lift = 7 * math.sin(a)                       # 翻到一半时拱得最高
    pts = np.array([[sx, sy], [tip_x, sy - lift], [tip_x, sy - lift - height], [sx, sy - height]], np.float32)
    mask = np.zeros(img.shape[:2], np.uint8)
    cv2.fillPoly(mask, [np.round(pts).astype(np.int32)], 1)
    m = mask.astype(bool)
    if not m.any():
        return out
    color = PAPER if math.cos(a) > 0 else PAPER_SHADE    # 翻过去以后看到的是纸背，稍暗
    out[m, :3] = color
    out[m, 3] = 255
    edge = m & ~cv2.erode(mask, np.ones((3, 3), np.uint8)).astype(bool)
    out[edge] = OUTLINE
    return out


def flap(img, rect, pivot, deg):
    return rotate_region(img, rect_mask(img, *rect), pivot, deg)


# ---------------- 待机：看魔典，隔一会儿翻一页 ----------------
def idle():
    base = pose("idle")
    eyes = [(x0 - 1, y0 - 2, x1 + 1, y1) for x0, y0, x1, y1 in find_eyes(base)]
    n = 24
    flip = {12: 15, 13: 50, 14: 90, 15: 130, 16: 165}     # 第 12–16 帧翻一页
    frames, ms = [], []
    for i in range(n):
        f = base
        w = sine(i, 12, 5)                                  # 翅膀慢慢扇
        f = flap(f, (18, 80, 41, 108), (42, 96), -w)
        f = flap(f, (88, 82, 106, 110), (86, 96), w)
        f = bend(f, rect_mask(f, 90, 168, 106, 186), anchor=90, length=16, amp=sine(i, 12, 2, -1.0))
        if i in flip:
            f = page(f, (59, 104), 21, 8, flip[i])
        if i in (6, 7, 8):
            f = blink(f, eyes, "closed" if i == 7 else "half", SKIN)
        f = shift(f, dy=-1 - sine(i, 24, 1.5))
        frames.append(f)
        ms.append(120)
    return frames, ms


# ---------------- 欢呼：爱心从书里一颗颗飘上来，翅膀用力扇 ----------------
def hearts_mask(img):
    """左上角那几颗分开的小爱心（独立的小块）。"""
    a = solid(img).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(a, connectivity=8)
    m = np.zeros(img.shape[:2], bool)
    for i in range(1, n):
        x, y, w, h, area = st[i]
        if x + w < 48 and y + h < 48 and area < 120:
            m |= lab == i
    return m


def cheer():
    base = pose("cheer")
    hm = hearts_mask(base)
    body = base.copy()
    body[hm] = 0
    hearts = np.zeros_like(base)
    hearts[hm] = base[hm]
    n = 16
    hop = [0, 1, 0, -2, -4, -5, -5, -4, -2, 0, 1, 0, 0, 0, 0, 0]
    frames, ms = [], []
    for i in range(n):
        f = body
        f = flap(f, (88, 48, 124, 80), (88, 64), 10 * math.sin(2 * math.pi * i / 8))
        f = flap(f, (2, 36, 30, 64), (36, 58), -10 * math.sin(2 * math.pi * i / 8))
        f = rotate_region(f, rect_mask(f, 76, 14, 112, 50), (80, 52), 6 * math.sin(2 * math.pi * i / 8))
        f = bend(f, rect_mask(f, 86, 140, 110, 172), anchor=140, length=30, amp=sine(i, 8, 2), axis="x")
        f = shift(f, dy=hop[i])
        # 爱心：一路往上飘，边飘边闪
        layer = shift(hearts, dy=-(i // 2) - 1, dx=sine(i, 8, 1))
        layer = brighten(layer, solid(layer), 0.3 if i % 4 < 2 else 0.0)
        put = layer[..., 3] > 0
        f = f.copy()
        f[put] = layer[put]
        frames.append(f)
        ms.append(100 if hop[i] else 120)
    return frames, ms


ACTIONS = {"idle": (idle, "待机", True), "cheer": (cheer, "欢呼", False)}

if __name__ == "__main__":
    import json
    for key in sys.argv[1:] or ACTIONS:
        fn, name, loop = ACTIONS[key]
        frames, ms = fn()
        out = export(frames, ms, HERE / "actions" / key, key, name, loop)
        meta = json.loads((out / "anim.json").read_text())
        meta["kind"] = "custom"
        (out / "anim.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
        print(f"{key}: {len(frames)} 帧")
