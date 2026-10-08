"""魔法少女风格（正常比例）的动作动画

    cd assistant_sprite && python3 styles/magical/anim.py [动作名 ...]

姿势来自 poses/（由 refs/magical_sheet.webp 经 tools/pixelize_sheet.py 转出），
这里只在姿势上做移动、弯曲、转动、换色和小特效，结果写到 actions/<动作>/。
"""
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent.parent / "tools"))
from anim_kit import (GLYPHS, GLYPH_COLORS, bend, blink, brighten, export, find_eyes,  # noqa: E402
                      load_pose, rect_mask, rotate_region, shift, spin_disk, stamp)

SKIN = (254, 237, 234)


def pose(name):
    return load_pose(HERE / "poses" / f"{name}.png")


def eye_boxes(img, face):
    """瞳孔外框往上扩 2 行盖住睫毛，左右各扩 1 列。"""
    return [(x0 - 1, y0 - 2, x1 + 1, y1) for x0, y0, x1, y1 in find_eyes(img, face)]


def wave_sin(i, n, amp, phase=0.0):
    return int(round(amp * math.sin(2 * math.pi * (i / n) + phase)))


# ---------------- 待机 ----------------
def idle(with_blink=False):
    base = pose("idle")
    eyes = eye_boxes(base, (50, 58, 80, 75))
    n = 12
    frames, ms = [], []
    for i in range(n):
        f = base
        # 魔法球：漩涡转一圈，亮度起伏
        f = spin_disk(f, (33, 74), 11, -30 * i)
        f = brighten(f, rect_mask(f, 22, 63, 44, 85), 0.12 * (1 + math.sin(2 * math.pi * i / n)) / 2)
        # 尾巴尖和右边发卷：比身体慢半拍
        f = bend(f, rect_mask(f, 90, 137, 107, 160), anchor=90, length=17, amp=wave_sin(i, n, 2, -1.2))
        f = bend(f, rect_mask(f, 85, 60, 98, 82), anchor=62, length=20, amp=wave_sin(i, n, 1, -1.0), axis="x")
        if with_blink and i in (6, 7, 8):
            f = blink(f, eyes, "closed" if i == 7 else "half", SKIN)
        # 身体浮动
        f = shift(f, dy=-1 - wave_sin(i, n, 1.5))
        frames.append(f)
        ms.append(130)
    return frames, ms


# ---------------- 打招呼 ----------------
def wave():
    base = pose("wave")
    n = 12
    # 举起的前臂绕肘部左右摆，两个来回
    angles = [0, 7, 12, 7, 0, -6, -10, -6, 0, 7, 10, 0]
    frames, ms = [], []
    for i in range(n):
        f = base
        f = rotate_region(f, rect_mask(f, 20, 6, 50, 42), pivot=(41, 44), degrees=angles[i])
        # 另一只手上的魔法球转动、发光
        f = spin_disk(f, (90, 79), 9, 40 * i)
        f = brighten(f, rect_mask(f, 80, 68, 100, 90), 0.15 * (i % 4 in (1, 2)))
        # 尾巴跟着挥手甩
        f = bend(f, rect_mask(f, 92, 135, 112, 165), anchor=92, length=20, amp=wave_sin(i, 6, 2))
        f = shift(f, dy=-1 if i % 6 in (2, 3) else 0)
        frames.append(f)
        ms.append(110)
    return frames, ms


ACTIONS = {
    "idle": (lambda: idle(False), "待机", True),
    "blink": (lambda: idle(True), "待机·眨眼", True),
    "wave": (wave, "打招呼", False),
}

if __name__ == "__main__":
    for key in sys.argv[1:] or ACTIONS:
        fn, name, loop = ACTIONS[key]
        frames, ms = fn()
        export(frames, ms, HERE / "actions" / key, key, name, loop)
        print(f"{key}: {len(frames)} 帧")
