"""原稿 · 打招呼（wave）关键姿势生成脚本

    cd assistant_sprite && python3 styles/default/actions/wave/draw.py
    python3 tools/action_preview.py styles/default/actions/wave

头和脸直接从 styles/default/sprite.txt 抄（第 0–24 行、第 20 列往右），只改眼睛和嘴；
身体、手臂、腿、裙子、尾巴用下面的函数画（左上来光自动分亮/中/暗，外圈自动补 # 描边），
最后用 FIX 里的像素手动修细节。输出 k1.txt … 和 anim.json 到本目录。
"""
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
STYLE = HERE.parent.parent
W, H = 59, 81


def load(path):
    rows = [r for r in path.read_text().split("\n") if r]
    return {(x, y): c for y, r in enumerate(rows) for x, c in enumerate(r) if c != "."}


BASE = load(STYLE / "sprite.txt")


def flood(seed, x0, y0, x1, y1):
    seen, stack = set(), [seed]
    while stack:
        p = stack.pop()
        if p in seen or p not in BASE or not (x0 <= p[0] <= x1 and y0 <= p[1] <= y1):
            continue
        seen.add(p)
        x, y = p
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return seen


HEAD = {p: c for p, c in BASE.items() if p[1] <= 24 and p[0] >= 20}
ORB = {p: BASE[p] for p in flood((12, 18), 2, 3, 19, 24)}

# ---------------- 几何 ----------------
LX, LY = -0.7071, -0.7071          # 左上来光


def seg(px, py, a, b):
    vx, vy = b[0] - a[0], b[1] - a[1]
    l2 = vx * vx + vy * vy
    t = max(0.0, min(1.0, ((px - a[0]) * vx + (py - a[1]) * vy) / l2)) if l2 else 0.0
    qx, qy = a[0] + t * vx, a[1] + t * vy
    return math.hypot(px - qx, py - qy), t, px - qx, py - qy


def limb(a, b, r0, r1, ramp, lit=0.35, dark=-0.3):
    """粗细渐变的圆柱（手臂、腿），按左上光分 ramp=(亮, 中, 暗)"""
    out = {}
    x0, x1 = int(min(a[0], b[0]) - max(r0, r1) - 2), int(max(a[0], b[0]) + max(r0, r1) + 2)
    y0, y1 = int(min(a[1], b[1]) - max(r0, r1) - 2), int(max(a[1], b[1]) + max(r0, r1) + 2)
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            d, t, dx, dy = seg(x + 0.5, y + 0.5, a, b)
            r = r0 + (r1 - r0) * t
            if d <= r:
                s = (dx * LX + dy * LY) / max(r, 0.01)
                out[(x, y)] = ramp[0] if s > lit else ramp[2] if s < dark else ramp[1]
    return out


def inside(x, y, pts):
    c = False
    n = len(pts)
    for i in range(n):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % n]
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            c = not c
    return c


def poly(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return {(x, y) for y in range(int(min(ys)) - 1, int(max(ys)) + 2)
            for x in range(int(min(xs)) - 1, int(max(xs)) + 2) if inside(x + 0.5, y + 0.5, pts)}


def ellipse(cx, cy, rx, ry):
    return {(x, y) for y in range(int(cy - ry) - 1, int(cy + ry) + 2)
            for x in range(int(cx - rx) - 1, int(cx + rx) + 2)
            if ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1}


def shade_rows(mask, ramp, lit=0.3, dark=0.72):
    """按每行左右位置分亮/中/暗（躯干、裙子这类朝向观众的大块面）"""
    rows = {}
    for x, y in mask:
        rows.setdefault(y, []).append(x)
    out = {}
    for x, y in mask:
        a, b = min(rows[y]), max(rows[y])
        t = (x - a) / max(1, b - a)
        out[(x, y)] = ramp[0] if t < lit else ramp[2] if t > dark else ramp[1]
    return out


def bezier(p0, p1, p2, p3, n=300):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append(tuple(u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * d
                         for a, b, c, d in zip(p0, p1, p2, p3)))
    return pts


def pixel_path(pts):
    out = []
    for px, py in pts:
        q = (round(px - 0.5), round(py - 0.5))
        if out and out[-1] == q:
            continue
        while out and max(abs(q[0] - out[-1][0]), abs(q[1] - out[-1][1])) > 1:
            lx, ly = out[-1]
            out.append((lx + (q[0] > lx) - (q[0] < lx), ly + (q[1] > ly) - (q[1] < ly)))
        out.append(q)
    i = 1
    while i < len(out) - 1:
        (ax, ay), (cx, cy) = out[i - 1], out[i + 1]
        if abs(ax - cx) == 1 and abs(ay - cy) == 1:
            out.pop(i)
        else:
            i += 1
    return out


SPADE = [
    "...#...",
    "..#7#..",
    ".#765#.",
    "#76554#",
    "#65543#",
    "#54.43#",
    ".##.##.",
]


def devil_tail(p0, p1, p2, p3):
    """和 build.py 的 devil_tail 同一画法：根部粗、往后变细，尾尖桃心"""
    path = pixel_path(bezier(p0, p1, p2, p3))
    inner = set()
    for i, (x, y) in enumerate(path):
        r = range(-1, 2) if i < len(path) * 0.22 else range(0, 2)
        inner |= {(x + dx, y + dy) for dx in r for dy in r}
    px = {}
    for x, y in inner:
        lit = ((x - 1, y) not in inner) + ((x, y - 1) not in inner) - ((x + 1, y) not in inner) - ((x, y + 1) not in inner)
        px[(x, y)] = "4" if lit > 0 else "2" if lit < 0 else "3"
    for x, y in inner:
        for q in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if q not in inner:
                px[q] = "#"
    ex, ey = path[-1]
    for y, r in enumerate(SPADE):
        for x, c in enumerate(r):
            if c != ".":
                px[(ex - 3 + x, ey - 5 + y)] = c
    return px


def stamp(cv, px, ring=None):
    """把部件贴到画布上；ring 给出部件压在别的部件上时的分界线颜色"""
    if ring:
        for x, y in px:
            for q in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if q not in px and q in cv and cv[q] != "#":
                    cv[q] = ring
    cv.update(px)


def outline(cv):
    add = {}
    for (x, y), c in cv.items():
        if c == "#":
            continue
        for q in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if q not in cv:
                add[q] = "#"
    cv.update(add)


# ---------------- 材质（亮, 中, 暗） ----------------
DRESS = ("6", "5", "4")
SLEEVE = ("6", "5", "3")
SKIN = ("S", "S", "s")
SOCK = ("W", "W", "g")
CUFF = ("W", "g", "G")
SHOE = ("5", "4", "2")


def tpl(rows, anchor):
    """字符模板 → 像素，anchor 是模板里对准挂点的那一格"""
    ax, ay = anchor
    return {(x - ax, y - ay): c for y, r in enumerate(rows) for x, c in enumerate(r) if c != "."}


# 张开的手（手心朝外、拇指在画面右侧），挂点在手腕
HANDS = {
    "up": tpl(["S.S.S.",
               "SSSSS.",
               "SSSSS.",
               "SSSSSS",
               ".SSss.",
               "..ss.."], (2, 5)),
    "left": tpl(["S.S.S..",
                 "SSSSS..",
                 ".SSSSS.",
                 ".SSSSSS",
                 "..SSss.",
                 "...ss.."], (3, 5)),
    "right": tpl(["..S.S.S",
                  ".SSSSSS",
                  "SSSSSS.",
                  "SSSSSS.",
                  ".SSss..",
                  "..ss..."], (2, 5)),
}

ORB_TPL = tpl(["...WW....",
               ".7W77665.",
               "77W776655",
               "777766554",
               "776665544",
               "666655443",
               ".6555443.",
               "..55443..",
               "...443..."], (4, 4))


def ring_ellipse(c, ang, rx, ry, ramp):
    """斜放的椭圆（袖口），ang 是长轴方向"""
    ca, sa = math.cos(ang), math.sin(ang)
    out = {}
    for y in range(int(c[1] - 5), int(c[1] + 6)):
        for x in range(int(c[0] - 5), int(c[0] + 6)):
            dx, dy = x + 0.5 - c[0], y + 0.5 - c[1]
            u, v = dx * ca + dy * sa, -dx * sa + dy * ca
            if (u / rx) ** 2 + (v / ry) ** 2 <= 1:
                s = (dx * LX + dy * LY) / max(rx, ry)
                out[(x, y)] = ramp[0] if s > 0.3 else ramp[2] if s < -0.25 else ramp[1]
    return out


def arm(shoulder, elbow, wrist, hand=None, bare=0.45):
    """分离式袖子：肩到上臂一半是皮肤，往下是粉袖子，手腕灰蓝袖口"""
    px = {}
    mid = (shoulder[0] + (elbow[0] - shoulder[0]) * bare, shoulder[1] + (elbow[1] - shoulder[1]) * bare)
    px.update(limb(shoulder, mid, 2.2, 2.1, SKIN))
    px.update(limb(mid, elbow, 2.4, 2.4, SLEEVE))
    px.update(limb(elbow, wrist, 2.4, 2.6, SLEEVE))
    ang = math.atan2(wrist[1] - elbow[1], wrist[0] - elbow[0]) + math.pi / 2
    px.update(ring_ellipse(wrist, ang, 3.4, 1.5, CUFF))
    if hand:
        name, (hx, hy) = hand
        for (x, y), c in HANDS[name].items():
            px[(x + hx, y + hy)] = c
    return px


def skirt_px(sway=0):
    hem = [(20, 51.5), (22.5, 53.5), (25.5, 52), (28.5, 54), (32, 52.5), (35.5, 54.5),
           (39, 52.5), (42.5, 54), (45.5, 52), (48 + sway, 51)]
    pts = [(29.5, 36.5), (39, 36.5), (43, 41.5), (46.5 + sway * 0.5, 47)] + hem[::-1] + [(22.5, 45), (26, 40.5)]
    mask = poly(pts)
    px = shade_rows(mask, DRESS, 0.3, 0.68)
    # 褶子：从腰往下摆的凹处画暗线，左边贴一条亮线
    for (hx, hy), wx in zip(hem[1::2][:0] or [hem[2], hem[4], hem[6], hem[8]], (31, 33.5, 35.5, 37.5)):
        for p in pixel_path([(wx, 37.5), (hx, hy - 0.5)]):
            if p in mask:
                c = px[p]
                px[p] = {"6": "5", "5": "4", "4": "3"}[c] if c in "654" else c
                q = (p[0] - 1, p[1])
                if q in mask and px[q] in "65":
                    px[q] = {"6": "7", "5": "6"}[px[q]]
    # 裙摆一圈蕾丝
    for x, y in mask:
        if (x, y + 1) not in mask:
            px[(x, y)] = "7" if px[(x, y)] in "67" else "6"
    return px


def body(k):
    cv = {}
    stamp(cv, devil_tail((40.5, 47.5), (44, 61), (52 + k.get("tail", 0), 61), (51 + k.get("tail", 0) * 1.5, 50 - abs(k.get("tail", 0)) * 0.5)))
    # 后腿（画面左，往左后方踢）
    stamp(cv, limb((30.5, 50), (27, 59.5), 3.1, 2.5, SOCK))
    stamp(cv, limb((27, 59.5), (21.5, 66), 2.5, 1.9, SOCK))
    stamp(cv, limb((21.5, 66.5), (18.5, 70.5), 2.0, 1.5, SHOE), ring="#")
    # 前腿（画面右，垂下、脚尖点着）
    stamp(cv, limb((37.5, 50), (38.5, 60.5), 3.1, 2.5, SOCK), ring="G")
    stamp(cv, limb((38.5, 60.5), (37.5, 69.5), 2.5, 1.9, SOCK))
    stamp(cv, limb((37.5, 70), (36.5, 74.5), 2.1, 1.4, SHOE), ring="#")
    stamp(cv, skirt_px(k.get("skirt", 0)), ring="#")
    # 躯干：抹胸上衣 + 露肩
    torso = poly([(29, 28.5), (39.5, 28.5), (40.5, 31), (39.5, 37.5), (29.5, 37.5), (28.5, 31)])
    skin = poly([(31.5, 24.5), (36.5, 24.5), (37, 26.5), (40.5, 27.5), (40.5, 29.5), (28, 29.5), (28, 27.5), (31, 26.5)])
    stamp(cv, {p: ("s" if p[1] <= 25 or p[0] >= 38 else "S") for p in skin})
    stamp(cv, shade_rows(torso, DRESS, 0.3, 0.72))
    for x in range(29, 40):          # 领口一圈荷叶边
        if (x, 28) in cv:
            cv[(x, 28)] = "7" if x < 36 else "6"
    return cv


def compose(k):
    cv = body(k)
    # 托魔法球的手（画面右）：上臂在身体侧面，前臂横到胸前
    stamp(cv, arm((39.5, 29), (42.5, 35.5), (38, 38.5)), ring="2")
    stamp(cv, {(x, y): ("S" if y == 38 else "s") for x in range(33, 37) for y in (38, 39)}, ring="#")
    stamp(cv, HEAD)
    stamp(cv, arm((29, 29), k["elbow"], k["wrist"], hand=(k["hand"], k["hand_at"])), ring="#")
    ox, oy = k["orb"]
    stamp(cv, {(x + ox, y + oy): c for (x, y), c in ORB_TPL.items()}, ring="#")
    outline(cv)
    for p, c in k.get("face", {}).items():
        cv[p] = c
    return cv


HAPPY = {(29, 19): "#", (30, 19): "S", (31, 19): "#", (31, 20): "S",
         (36, 17): "S", (36, 18): "S", (35, 18): "S"}
OPEN_MOUTH = {(35, 22): "2", (35, 23): "3"}

KEYS = {
    "k1": dict(elbow=(22, 27), wrist=(16, 21), hand="left", hand_at=(16, 18), orb=(35, 32), tail=-1,
               face={**HAPPY, **OPEN_MOUTH}),
    "k2": dict(elbow=(22, 27), wrist=(19.5, 20.5), hand="right", hand_at=(19, 17), orb=(35, 32), tail=2,
               face={**HAPPY, **OPEN_MOUTH}),
}


def save(name, cv):
    rows = []
    for y in range(H):
        rows.append("".join(cv.get((x, y), ".") if 0 <= x < W else "." for x in range(W)))
    (HERE / f"{name}.txt").write_text("\n".join(rows) + "\n")


def main():
    for name, k in KEYS.items():
        save(name, compose(k))
    anim = {
        "action": "wave",
        "name": "打招呼",
        "loop": False,
        "colors": {},
        "keys": {name: {"eyes": {"left": [[31, 19], [31, 20]], "right": [[36, 17], [36, 18]]}, "mouth": [35, 22], "loose_ok": []}
                 for name in KEYS},
        "frames": [{"key": name, "ms": 120} for name in KEYS],
    }
    (HERE / "anim.json").write_text(json.dumps(anim, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
