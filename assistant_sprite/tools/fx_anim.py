"""给还没精修的动作做「互动动效」：身体的小动作 + 头边的小图标

    python3 tools/fx_anim.py styles/<id> [styles/<id2> ...] [--only idle,wave] [--check 输出.png]

不画新姿势。身体只做平移、从脚底开始的轻微摇摆（逐行错开）、眨眼；
图标是 anim_kit.ICONS 里的小像素图（! ? … Zzz 星星 爱心 汗滴），放在头边空白处。
  idle  待机：慢慢呼吸，眨眼，身边小星星闪一下，身上原有的小特效自己飘
  wave  打招呼：左右摇摆，头边冒出爱心往上飘
  point 指路：身体往右倾，一颗星星从指尖飞出去
  think 思考：头边一个一个冒出「…」，再变成「?」
  cheer 欢呼：先下蹲再跳起来，头顶炸开一圈星星和爱心
  shock 吓一跳：一跳一抖，头上蹦出「!」，再冒一滴汗
  doze  打瞌睡：慢慢起伏，头边飘出 Zzz
已经是 "custom"（精修）的动作不会被覆盖；这里生成的动作 kind 记为 "fx"。
头的位置自动找（粉色头发最上面那一团 + 眼睛），找得不对就在 styles/<id>/fx.json 里写
{"<动作>": {"head": [x, 头顶y, 半宽], "face": y, "side": 1 或 -1, "tip": [x, y], "drop_fx": true}} 覆盖
（drop_fx：去掉原图自带、会和动效重复的小特效）。
"""
import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from anim_kit import (ICONS, bend, blink, brighten, effects_split, export, find_eyes, icon,  # noqa: E402
                      icon_size, load_pose, overlay, shift, solid)

ACTIONS = [("idle", "待机", True), ("wave", "打招呼", False), ("point", "指路", False), ("think", "思考", True),
           ("cheer", "欢呼", False), ("shock", "吓一跳", False), ("doze", "打瞌睡", True)]


# ---------------- 找头、找指尖、找空白 ----------------
def hair_mask(img):
    c = img[..., :3].astype(float) / 255
    mx, mn = c.max(-1), c.min(-1)
    l = (mx + mn) / 2
    s = (mx - mn) / (1 - np.abs(2 * l - 1) + 1e-6)
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    return solid(img) & (r >= b) & (b > g) & (s > 0.35) & (l > 0.55) & (l < 0.9)


def find_head(body):
    """返回 (头中心 x, 头顶 y, 头半宽, 脸的 y)。头顶取最大一团粉头发的最上沿。"""
    hm = hair_mask(body)
    n, lab, st, _ = cv2.connectedComponentsWithStats(cv2.dilate(hm.astype(np.uint8), np.ones((3, 3), np.uint8)), 8)
    eyes = find_eyes(body)
    if n > 1:
        k = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
        comp = (lab == k) & hm
        ys, xs = np.where(comp)
        top = int(ys.min())
        band = xs[ys < top + 22]
        cx = int(np.median(band))
        hw = int(max(9, min(22, (np.percentile(band, 92) - np.percentile(band, 8)) / 2)))
    else:
        ys = np.where(solid(body).any(1))[0]
        top, cx, hw = int(ys[0]), body.shape[1] // 2, 12
    if eyes:
        cx = int(round((eyes[0][0] + eyes[1][2]) / 2))
        face = int(round((eyes[0][1] + eyes[1][3]) / 2))
    else:
        face = top + 30
    return cx, top, hw, face


def find_tip(body, top):
    """指路时伸得最远的那一点：人物上 60% 里最靠右的像素。"""
    al = solid(body)
    ys = np.where(al.any(1))[0]
    lim = top + int((ys[-1] - top) * 0.6)
    sub = al[top:lim]
    cols = np.where(sub.any(0))[0]
    x = int(cols[-1])
    y = top + int(np.median(np.where(sub[:, x])[0]))
    return x, y


def free_spot(body, name, target, radius=14):
    """在 target 附近给图标找一块不压到人物的空白，返回左上角坐标。"""
    w, h = icon_size(name)
    H, W = body.shape[:2]
    occ = cv2.dilate(solid(body).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(np.int64)
    integ = np.zeros((H + 1, W + 1), np.int64)
    integ[1:, 1:] = occ.cumsum(0).cumsum(1)
    best = None
    tx, ty = target
    for y in range(max(1, ty - radius), min(H - h - 1, ty + radius) + 1):
        for x in range(max(1, tx - radius), min(W - w - 1, tx + radius) + 1):
            hit = integ[y + h, x + w] - integ[y, x + w] - integ[y + h, x] + integ[y, x]
            cost = hit * 40 + math.hypot(x - tx, y - ty)
            if best is None or cost < best[0]:
                best = (cost, x, y)
    if best is None:
        return min(max(1, tx), W - w - 1), min(max(1, ty), H - h - 1)
    return best[1], best[2]


def roomy_side(body, cx, top, hw):
    """头的左右两边，哪边空白多就往哪边放图标：返回 +1（右）或 -1（左）。"""
    al = solid(body)
    rows = al[max(0, top - 4):top + 30]
    W = body.shape[1]
    left = rows[:, :max(1, cx - hw)].sum()
    right = rows[:, min(W - 1, cx + hw):].sum()
    room_l, room_r = cx - hw, W - (cx + hw)
    return 1 if (room_r * 30 - right) >= (room_l * 30 - left) else -1


# ---------------- 身体的小动作 ----------------
FEET = 221


def sway(img, amp):
    """从脚底开始逐行往左右错开，头那一端错开 amp 像素（正数往右）。"""
    if amp == 0:
        return img
    ys = np.where(solid(img).any(1))[0]
    return bend(img, solid(img), anchor=FEET, length=int(ys[0]) - FEET, amp=amp, axis="x")


def sway_at(y, top, amp):
    """sway 之后，第 y 行挪了多少（图标跟着头一起动）。"""
    t = min(max((y - FEET) / float(top - FEET), 0), 1)
    return int(round(amp * t ** 1.6))


class Scene:
    def __init__(self, base, over=None):
        over = over or {}
        self.body, self.fx = effects_split(base)
        if over.get("drop_fx"):                 # 原图里自带的、会和动效重复的小特效（例如画好的 zzz）
            self.fx = np.zeros_like(self.fx)
        cx, top, hw, face = find_head(self.body)
        if "head" in over:
            cx, top, hw = over["head"][:3]
            face = over.get("face", top + 30)
        self.cx, self.top, self.hw, self.face = cx, top, hw, face
        self.eyes = [(x0 - 1, y0 - 2, x1 + 1, y1) for x0, y0, x1, y1 in find_eyes(self.body)]
        self.side = over.get("side", roomy_side(self.body, cx, top, hw))
        self.tip = tuple(over["tip"]) if "tip" in over else find_tip(self.body, top)

    def spot(self, name, dx, dy, radius=14):
        """头边的一个位置：dx 按 side 方向，dy 从头顶算。"""
        w, h = icon_size(name)
        s = self.side
        tx = self.cx + s * (self.hw + dx) - (w if s < 0 else 0)
        return free_spot(self.body, name, (int(tx), int(self.top + dy)), radius)

    def frame(self, dy=0, dx=0, amp=0, blink_level=None, fx_dy=0, fx_glow=0.0):
        f = self.body
        if amp:
            f = sway(f, amp)
        if blink_level and self.eyes:
            f = blink(f, self.eyes, blink_level)
        f = shift(f, dy=dy, dx=dx)
        if self.fx[..., 3].any():
            layer = shift(self.fx, dy=dy + fx_dy, dx=dx)
            if fx_glow:
                layer = brighten(layer, solid(layer), fx_glow)
            f = overlay(f, layer)
        return f


def put(f, name, x, y):
    return icon(f, name, int(round(x)), int(round(y)))


# ---------------- 各个动作 ----------------
def act_idle(sc):
    bob = [0, 0, -1, -1, -1, -2, -2, -2, -2, -1, -1, -1, 0, 0, 0, 0]
    sx, sy = sc.spot("spark_s", 6, 4)
    frames = []
    for i, dy in enumerate(bob):
        bl = {11: "half", 12: "closed", 13: "half"}.get(i)
        f = sc.frame(dy=dy, blink_level=bl, fx_dy=-(1 if (i // 4) % 2 else 0), fx_glow=0.35 if (i // 2) % 4 == 1 else 0)
        if i in (3, 7):
            f = put(f, "twinkle", sx + 1, sy + 1 + dy)
        elif i in (4, 5, 6):
            f = put(f, "spark_s", sx, sy + dy)
        frames.append(f)
    return frames, [130] * len(frames)


def act_wave(sc):
    amps = [0, 1, 2, 3, 2, 1, 0, -1, -2, -3, -2, -1, 0, 1, 1, 0]
    hx, hy = sc.spot("heart", 4, 8)
    ox, oy = sc.spot("spark_s", 2, 30)
    frames = []
    for i, a in enumerate(amps):
        f = sc.frame(amp=a, dy=-1 if 3 <= i <= 11 else 0, fx_glow=0.3 if i % 4 < 2 else 0)
        moved = sway_at(sc.top, sc.top, a)
        if 4 <= i <= 14:
            k = i - 4
            if not (k >= 9 and k % 2):                     # 最后两帧一闪一闪地消失
                name = "heart_s" if k < 2 else "heart"
                f = put(f, name, hx + moved + (1 if k < 2 else 0), hy - k)
        if i in (1, 2, 9, 10):
            f = put(f, "spark_s" if i in (2, 10) else "twinkle", ox + moved, oy)
        frames.append(f)
    return frames, [110] * len(frames)


def act_point(sc):
    lean = [0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 0]
    tx, ty = sc.tip
    W = sc.body.shape[1]
    frames = []
    for i, a in enumerate(lean):
        f = sc.frame(amp=a, fx_glow=0.3 if i % 4 < 2 else 0)
        moved = sway_at(ty, sc.top, a)
        k = i - 3
        if 0 <= k <= 8:
            x = tx + moved + 3 + k * 4
            if x + 7 < W:
                f = put(f, "spark_l", x, ty - 3 - (k % 2))
                if k >= 1:
                    f = put(f, "spark_s", x - 5, ty - 2)
                if k >= 2:
                    f = put(f, "twinkle", x - 9, ty - 1 + (k % 2))
            else:                                          # 飞到边上就在那里闪
                ex = min(W - 8, tx + moved + 3 + 4 * 2)
                f = put(f, "spark_l" if k % 2 else "spark_s", ex + (0 if k % 2 else 1), ty - 4)
        if i in (12, 13):
            f = put(f, "twinkle", min(W - 4, tx + moved + 2), ty - 7)
        frames.append(f)
    return frames, [100] * len(frames)


def act_think(sc):
    bob = [0, 0, 0, -1, -1, -1, -1, 0, 0, 0, 0, 0, -1, -1, -1, -1, 0, 0, 0, 0]
    dots = [sc.spot("dot", 2, 14, 8), sc.spot("dot", 7, 8, 8), sc.spot("dot", 12, 2, 8)]
    qx, qy = sc.spot("ques", 6, -2, 12)
    frames = []
    for i, dy in enumerate(bob):
        bl = {15: "half", 16: "closed", 17: "half"}.get(i)
        f = sc.frame(dy=dy, blink_level=bl, fx_glow=0.3 if (i // 3) % 2 else 0)
        if i < 11:
            for n, (x, y) in enumerate(dots):
                if i >= 2 + n * 3:
                    f = put(f, "dot", x, y + dy)
        else:
            hop = {11: 3, 12: -2, 13: 0, 14: -1}.get(i, 0)
            f = put(f, "ques", qx, qy + hop + dy)
        frames.append(f)
    return frames, [140] * len(frames)


def act_cheer(sc):
    hop = [0, 1, 2, 1, -2, -5, -7, -8, -7, -5, -2, 0, 1, 0, 0, 0]
    cx, cy = sc.cx, sc.top + 10
    parts = []
    names = ["spark_l", "heart", "spark_s", "spark_l", "heart_s", "spark_s", "spark_l"]
    for n, name in enumerate(names):
        ang = math.radians(-180 + n * 180 / (len(names) - 1))     # 从左到右扇形散开
        parts.append((name, ang))
    frames = []
    for i, dy in enumerate(hop):
        f = sc.frame(dy=dy, fx_dy=-(i // 4), fx_glow=0.35 if i % 4 < 2 else 0)
        k = i - 5
        if 0 <= k <= 9:
            r = sc.hw + 4 + k * 3
            for n, (name, ang) in enumerate(parts):
                if k >= 7 and (k + n) % 2:
                    continue
                w, h = icon_size(name)
                x = cx + r * math.cos(ang) - w / 2
                y = cy + r * math.sin(ang) * 0.8 - h / 2 + dy + (k * k) // 12
                f = put(f, name if k < 6 else ("twinkle" if name.startswith("spark") else "heart_s"), x, y)
        frames.append(f)
    return frames, [90 if dy < 0 else 110 for dy in hop]


def act_shock(sc):
    jump = [(0, 0), (-4, 0), (-6, 0), (-4, 1), (-2, -1), (-1, 1), (0, -1), (0, 0), (0, 0), (0, 0),
            (0, 0), (0, 0), (0, 0), (0, 0)]
    bx, by = sc.spot("bang", 4, -4, 12)
    s = sc.side
    sw_x, sw_y = free_spot(sc.body, "sweat", (int(sc.cx - s * (sc.hw + 3) - (7 if s > 0 else 0)), sc.top + 8), 10)
    tl = (sc.cx - sc.hw - 5, sc.top + 2)
    tr = (sc.cx + sc.hw + 3, sc.top + 2)
    frames = []
    for i, (dy, dx) in enumerate(jump):
        f = sc.frame(dy=dy, dx=dx)
        if 1 <= i <= 4:
            f = put(f, "tick_l", tl[0] + dx - (i > 2), tl[1] + dy)
            f = put(f, "tick_r", tr[0] + dx + (i > 2), tr[1] + dy)
            f = put(f, "tick_u", sc.cx + dx, sc.top - 5 + dy)
        if i >= 1:
            pop = {1: 3, 2: -2, 3: 0, 4: -1}.get(i, 0)
            f = put(f, "bang", bx + dx, by + dy + pop)
        if i >= 6:
            f = put(f, "sweat", sw_x, sw_y + (i - 6) // 2)
        frames.append(f)
    return frames, [70, 70, 80, 80, 80, 90, 90] + [120] * 7


def act_doze(sc):
    n = 24
    zs = []
    zx, zy = sc.spot("z_s", 3, 10, 10)
    for start in (0, 8, 16):
        zs.append(start)
    frames = []
    for i in range(n):
        dy = 0 if (i // 6) % 2 == 0 else -1
        f = sc.frame(dy=dy, fx_dy=0, fx_glow=0.25 if (i // 6) % 2 else 0)
        for start in zs:
            age = (i - start) % n
            if age >= 18:
                continue
            name = "z_s" if age < 6 else ("z_m" if age < 12 else "z_l")
            x = zx + sc.side * (age // 3) + (0 if sc.side > 0 else -icon_size(name)[0] + 4)
            y = zy - age - (icon_size(name)[1] - 4)
            if y < 1:
                continue
            f = put(f, name, x, y)
        frames.append(f)
    return frames, [150] * n


ACT = {"idle": act_idle, "wave": act_wave, "point": act_point, "think": act_think,
       "cheer": act_cheer, "shock": act_shock, "doze": act_doze}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("styles", nargs="+")
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true", help="连精修过的也覆盖（慎用）")
    a = ap.parse_args()
    only = set(a.only.split(",")) if a.only else None
    for sd in map(Path, a.styles):
        over_file = sd / "fx.json"
        overs = json.loads(over_file.read_text()) if over_file.exists() else {}
        done = []
        for key, name, loop in ACTIONS:
            if only and key not in only:
                continue
            out = sd / "actions" / key
            meta = out / "anim.json"
            if meta.exists() and not a.force and json.loads(meta.read_text()).get("kind", "basic") == "custom":
                continue
            pose_file = sd / "poses" / f"{key}.png"
            if not pose_file.exists():
                continue
            sc = Scene(load_pose(pose_file), overs.get(key))
            frames, ms = ACT[key](sc)
            export(frames, ms, out, key, name, loop)
            m = json.loads(meta.read_text())
            m["kind"] = "fx"
            meta.write_text(json.dumps(m, ensure_ascii=False, indent=1))
            done.append(f"{key}({len(frames)})")
        print(sd.name, " ".join(done))


if __name__ == "__main__":
    main()
