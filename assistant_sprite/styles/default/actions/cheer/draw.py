"""原稿 · 欢呼（cheer）关键姿势生成脚本

    cd assistant_sprite && python3 styles/default/actions/cheer/draw.py

头部（头发 + 脸 + 角 + 双侧卷发）直接从 styles/default/sprite.txt 抄，只整体平移；
身体（连衣裙、分离袖、灰蓝袖口、白长袜、粉鞋、尾巴）按姿势重画；魔法球抄原稿、按 build.GLOW 提亮。
输出 k1.txt … 和 anim.json 到本目录。
"""
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT))
from build import GLOW, SPADE, bezier, pixel_path  # noqa: E402

W, H = 59, 81
SRC = [r for r in (ROOT / "styles/default/sprite.txt").read_text().split("\n") if r]
BASE = {(x, y): c for y, r in enumerate(SRC) for x, c in enumerate(r) if c != "."}
STYLE = json.loads((ROOT / "styles/default/style.json").read_text())

# ---------------- 从原稿抠出的部件 ----------------
ORB = {p: c for p, c in BASE.items() if p[0] < 20 and p[1] <= 24}          # 魔法球
HEAD = {p: c for p, c in BASE.items() if p[0] >= 20 and p[1] <= 25}         # 头发 + 脸 + 角
# 头底下原来是旧身体的描边，换新身体后会变成横在脖子上的黑线，去掉
for p in ((32, 26),):
    HEAD.pop(p, None)
R_CURL = {p for p in HEAD if p[0] >= 42 and 13 <= p[1]}                     # 右侧卷发（甩动用）
L_LOCK = {p for p in HEAD if p[0] <= 25 and 17 <= p[1]}                     # 左侧发束

EYE_L, EYE_R = STYLE["eyes"]["left"], STYLE["eyes"]["right"]
MOUTH = STYLE["mouth"]

# 表情：坐标是原稿头部位置，跟着头一起平移
FACE = {
    "open": {},
    "closed": {(30, 19): "#", (31, 19): "#", (31, 20): "S",
               (36, 16): "2", (36, 17): "#", (36, 18): "s", (35, 18): "S"},
    "happy": {(29, 19): "#", (30, 19): "S", (31, 19): "#", (31, 20): "S", (30, 20): "S",   # ^ ^
              (36, 17): "S", (36, 18): "S", (35, 18): "S", (35, 17): "#", (37, 17): "#"},
    "squeeze": {(29, 19): "#", (30, 19): "#", (31, 19): "S", (31, 20): "#", (30, 20): "S",  # > <
                (35, 17): "S", (36, 17): "#", (37, 17): "#", (35, 18): "#", (36, 18): "S"},
}
MOUTH_PX = {
    None: {},
    "smile": {(34, 22): "3", (35, 22): "4"},
    "small": {(35, 22): "3"},
    "open": {(34, 22): "1", (35, 22): "2", (34, 23): "3", (35, 23): "4"},
    "wide": {(33, 22): "1", (34, 22): "1", (35, 22): "2", (33, 23): "3", (34, 23): "4", (35, 23): "4"},
}

# ---------------- 几何小工具 ----------------
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))


def in_poly(px, py, pts):
    inside = False
    n = len(pts)
    for i in range(n):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            if px < x1 + (py - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
    return inside


def poly(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return {(x, y) for y in range(math.floor(min(ys)), math.ceil(max(ys)) + 1)
            for x in range(math.floor(min(xs)), math.ceil(max(xs)) + 1) if in_poly(x + .5, y + .5, pts)}


def seg_t(px, py, a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy or 1
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
    cx, cy = ax + t * dx, ay + t * dy
    return t, math.hypot(px - cx, py - cy), (px - cx) * (-dy) + (py - cy) * dx


def limb(a, b, r0, r1):
    """锥形圆柱，返回 {像素: (t 沿长度 0-1, s 横向 -1..1，正数=朝左上受光那侧)}"""
    (ax, ay), (bx, by) = a, b
    L = math.hypot(bx - ax, by - ay)
    nx, ny = -(by - ay) / L, (bx - ax) / L          # 垂直方向
    if nx * -1 + ny * -1 < 0:                        # 让 n 指向左上
        nx, ny = -nx, -ny
    out = {}
    r = max(r0, r1) + 1
    for y in range(math.floor(min(ay, by) - r), math.ceil(max(ay, by) + r) + 1):
        for x in range(math.floor(min(ax, bx) - r), math.ceil(max(ax, bx) + r) + 1):
            t, d, _ = seg_t(x + .5, y + .5, a, b)
            rr = r0 + (r1 - r0) * t
            if d <= rr:
                s = ((x + .5 - (ax + t * (bx - ax))) * nx + (y + .5 - (ay + t * (by - ay))) * ny) / max(rr, .5)
                out[(x, y)] = (t, s)
    return out


def ellipse(cx, cy, rx, ry):
    return {(x, y) for y in range(math.floor(cy - ry) - 1, math.ceil(cy + ry) + 2)
            for x in range(math.floor(cx - rx) - 1, math.ceil(cx + rx) + 2)
            if ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2 <= 1}


def outline_of(mask):
    return {(x + dx, y + dy) for x, y in mask for dx, dy in N4} - set(mask)


# ---------------- 画布 ----------------
class Canvas:
    def __init__(self):
        self.px = {}

    def sticker(self, part, line=True):
        """部件连同自己的 1 像素描边贴到最上层（后贴的在前面）"""
        if line:
            for q in outline_of(part):
                self.px[q] = "#"
        self.px.update(part)

    def behind(self, part, line=True):
        """部件塞到已有像素后面"""
        if line:
            for q in outline_of(part):
                self.px.setdefault(q, "#")
        for p, c in part.items():
            self.px.setdefault(p, c)

    def rows(self):
        return ["".join(self.px.get((x, y), ".") for x in range(W)) for y in range(H)]


def shift(d, dx, dy):
    return {(x + dx, y + dy): c for (x, y), c in d.items()}


# ---------------- 部件画法 ----------------
def ramp(s, lit, mid, dark, cut=(.35, -.35)):
    return lit if s > cut[0] else dark if s < cut[1] else mid


def arm(shoulder, hand, fist=True, sleeve=(.14, .62), cuff=(.62, .78)):
    """分离式袖子：肩膀皮肤 → 粉色泡泡袖 → 灰蓝喇叭袖口 → 手。"""
    a, b = shoulder, hand
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L

    def at(t):
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

    out = {}
    for p, (t, s) in limb(a, at(sleeve[0] + .05), 1.9, 1.7).items():       # 光着的上臂
        out[p] = "S" if s > -.3 else "s"
    for p, (t, s) in limb(at(sleeve[0]), at(sleeve[1]), 2.2, 2.6).items():  # 泡泡袖
        out[p] = "6" if s > .4 else "4" if s < -.45 else "5"
    for p, (t, s) in limb(at(cuff[0]), at(cuff[1]), 2.0, 3.0).items():      # 喇叭袖口
        out[p] = "W" if s > .5 else "G" if s < -.4 else "g"
    hc = at(cuff[1] + (1 - cuff[1]) * .55)
    hand_px = ellipse(hc[0], hc[1], 2.1, 2.1) if fist else ellipse(hc[0], hc[1], 1.8, 2.4)
    hand_px -= set(out)
    for x, y in hand_px:
        lit = ((x - 1, y) not in hand_px) + ((x, y - 1) not in hand_px)
        dark = ((x + 1, y) not in hand_px) + ((x, y + 1) not in hand_px)
        out[(x, y)] = "S" if lit >= dark else "s"
    return out


def tail(p0, p1, p2, p3, thick_root=.25):
    """小恶魔尾巴：细尾 + 桃心尾尖（同 build.devil_tail 的画法，控制点可调）"""
    path = pixel_path(bezier(p0, p1, p2, p3))
    inner = set()
    for i, (x, y) in enumerate(path):
        r = range(-1, 2) if i < len(path) * thick_root else range(0, 2)
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


def leg(hip, knee, ankle, foot_dir=(0, 1), r=2.2):
    """白长筒袜 + 粉鞋。返回带颜色的像素。"""
    out = {}
    for seg in ((hip, knee, r, r - .2), (knee, ankle, r - .2, r - .6)):
        for p, (t, s) in limb(*seg).items():
            out[p] = "W" if s > -.1 else "g" if s > -.6 else "G"
    # 鞋：沿 foot_dir 伸出去的小椭圆
    fx, fy = ankle[0] + foot_dir[0] * 1.6, ankle[1] + foot_dir[1] * 1.6
    shoe = limb(ankle, (fx + foot_dir[0] * 1.4, fy + foot_dir[1] * 1.4), 1.9, 1.5)
    for p, (t, s) in shoe.items():
        if t > .25 or s < 0:
            out[p] = "6" if s > .5 else "4" if s > -.3 else "2"
    return out


def dress(top_y, waist_y, hem_y, top_l, top_r, waist_l, waist_r, hem_l, hem_r,
          hem_curve=1.5, scallop=4, folds=(.3, .55, .8), frill=True):
    """连衣裙：上身 + 喇叭裙，一个整体（内部结构线用暗一级的粉色）。
    hem_curve：下摆中间比两边低多少（负数=中间被风掀起）；scallop：下摆波浪个数。"""
    out = {}
    bod = poly([(top_l, top_y), (top_r + 1, top_y), (waist_r + 1, waist_y + 1), (waist_l, waist_y + 1)])
    for x, y in bod:
        v = (y - top_y) / max(1, waist_y - top_y)
        l = top_l + (waist_l - top_l) * v
        r = top_r + 1 + (waist_r + 1 - top_r - 1) * v
        u = (x + .5 - l) / max(1, r - l)
        out[(x, y)] = "7" if u < .22 else "6" if u < .55 else "5" if u < .8 else "3"
    for x, y in list(out):                         # 领口一条亮边
        if y == top_y:
            out[(x, y)] = "7" if out[(x, y)] in "67" else "6"
    # 裙子
    def hem_at(x):
        u = (x + .5 - hem_l) / max(1, hem_r + 1 - hem_l)
        base = hem_y + hem_curve * math.sin(math.pi * u)
        return base + (.8 * abs(math.sin(math.pi * u * scallop)) if scallop else 0)
    edge_l = [(waist_l, waist_y + 1)] + [(hem_l + (waist_l - hem_l) * (1 - k / 6) ** 1.6, waist_y + 1 + (hem_y - waist_y - 1) * k / 6) for k in range(1, 7)]
    edge_r = [(waist_r + 1, waist_y + 1)] + [(hem_r + 1 + (waist_r - hem_r) * (1 - k / 6) ** 1.6, waist_y + 1 + (hem_y - waist_y - 1) * k / 6) for k in range(1, 7)]
    bottom = [(x + .5, hem_at(x) + 1) for x in range(math.floor(hem_l), math.ceil(hem_r) + 1)]
    sk = poly(edge_l + bottom + edge_r[::-1])
    for x, y in sk:
        if y <= waist_y:
            continue
        v = (y - waist_y) / max(1, hem_y - waist_y)
        l = min(px for px, py in sk if py == y)
        r = max(px for px, py in sk if py == y) + 1
        u = (x + .5 - l) / max(1, r - l)
        c = "6" if u < .2 else "5" if u < .5 else "4" if u < .78 else "3"
        if u > .92:
            c = "2"
        for f in folds:                              # 褶子：一条暗线，往下散开
            fx = l + f * (r - l)
            if v > .2 and abs(x + .5 - fx) < .55:
                c = {"6": "5", "5": "4", "4": "3", "3": "2", "2": "2"}[c]
            elif v > .35 and 0 < fx - (x + .5) < 1.5 and c in "45":
                c = "6" if c == "5" else "5"
        out[(x, y)] = c
    for x, y in list(out):                           # 腰线
        if y == waist_y + 1 and (x, y) in sk:
            out[(x, y)] = "4" if out[(x, y)] in "567" else "2"
    if frill:                                        # 下摆白色衬裙花边
        for x, y in list(sk):
            if (x, y + 1) not in sk and y > waist_y + 2:
                out[(x, y + 1)] = "W" if x < (hem_l + hem_r) / 2 else "g"
                if (x - 1, y + 1) not in out and (x - 1, y) in sk:
                    pass
    return out


# ---------------- 关键姿势 ----------------
def head(dx=0, dy=0, eyes="open", mouth=None, curl=0):
    """curl：右侧卷发和左侧发束的滞后，正数=往下拉长，负数=往上收（像素）"""
    g = dict(HEAD)
    g.update(FACE[eyes])
    g.update(MOUTH_PX[mouth])
    if curl:
        g = lag_hair(g, curl)
    return shift(g, dx, dy)


def lag_hair(g, n):
    """发梢滞后：右卷发 18 行以下、左发束 22 行以下整体上下挪 n 像素，空出来的地方补一行。"""
    out = dict(g)
    for part, row in ((R_CURL, 19), (L_LOCK, 22)):
        pix = {p: g[p] for p in part if p in g and p[1] >= row}
        for p in pix:
            out.pop(p, None)
        for (x, y), c in pix.items():
            out[(x, y + n)] = c
        if n > 0:   # 往下拉：row 行复制填空
            for (x, y), c in pix.items():
                if y == row:
                    for k in range(n):
                        out[(x, y + k)] = c
    return out


def orb(dx, dy, glow=0):
    o = dict(ORB)
    for _ in range(glow):
        o = {p: GLOW.get(c, c) for p, c in o.items()}
    return shift(o, dx, dy)


SPARK_SMALL = {(0, 0): "W", (1, 0): "x", (-1, 0): "x", (0, 1): "x", (0, -1): "x"}
SPARK_BIG = {(0, 0): "W", (1, 0): "W", (-1, 0): "W", (0, 1): "W", (0, -1): "W",
             (2, 0): "x", (-2, 0): "x", (0, 2): "x", (0, -2): "x"}
SPARK_DOT = {(0, 0): "x"}


def sparks(cv, items):
    loose = []
    for (x, y), kind in items:
        shape = {"small": SPARK_SMALL, "big": SPARK_BIG, "dot": SPARK_DOT}[kind]
        for (sx, sy), c in shape.items():
            p = (x + sx, y + sy)
            if p not in cv.px:
                cv.px[p] = c
                loose.append(p)
    return loose


def pose_apex(spark_set=0, arms_front=True):
    dy = -1
    cv = Canvas()
    cv.sticker(tail((38.5, 52.5), (47, 56), (54, 48), (52, 37)), line=False)       # 尾巴竖起来
    # 腿：大字跳，膝盖微弯、脚尖往外
    cv.sticker(leg((30, 52 + dy), (26, 61 + dy), (21, 68 + dy), foot_dir=(-.6, .8)))
    cv.sticker(leg((36, 52 + dy), (41, 60 + dy), (46, 66 + dy), foot_dir=(.7, .7)))
    cv.sticker(dress(top_y=29 + dy, waist_y=37 + dy, hem_y=52 + dy, top_l=27, top_r=39, waist_l=28, waist_r=38,
                     hem_l=19, hem_r=47, hem_curve=-1.5))
    # 肩膀和脖子的皮肤
    neck = poly([(30, 24 + dy), (36, 24 + dy), (37, 27 + dy), (40, 28 + dy), (40, 30 + dy), (26, 30 + dy), (26, 28 + dy), (29, 27 + dy)])
    cv.behind({p: ("S" if p[0] < 35 else "s") for p in neck})
    arms = [arm((27.5, 28.5 + dy), (15, 9 + dy)), arm((39, 28 + dy), (51, 8 + dy))]
    if not arms_front:
        for a in arms:
            cv.sticker(a)
    cv.sticker(head(0, dy, "happy", "wide"), line=False)
    if arms_front:
        for a in arms:
            cv.sticker(a)
    cv.behind(orb(-6, -11 + dy, glow=2), line=False)
    loose = sparks(cv, [((25, 3), "small"), ((55, 22), "big"), ((10, 27), "small")] if spark_set == 0 else
                   [((25, 3), "big"), ((55, 22), "small"), ((10, 27), "big")])
    return cv, dy, loose


COLORS = {"x": [255, 236, 150]}   # 光点的暖黄

KEYS = {}


def save(name, cv, dy, loose=(), dx=0, eyes_hidden=False, face=""):
    rows = cv.rows()
    (HERE / f"{name}.txt").write_text("\n".join(rows) + "\n")
    KEYS[name] = {
        "eyes": {"left": [[x + dx, y + dy] for x, y in EYE_L], "right": [[x + dx, y + dy] for x, y in EYE_R]},
        "mouth": [MOUTH[0] + dx, MOUTH[1] + dy],
        "loose_ok": sorted([list(p) for p in loose]),
        "face": face,
    }


def main():
    cv, dy, loose = pose_apex(0)
    save("k4", cv, dy, loose, face="笑眼 ^ ^，嘴巴张大")
    cv, dy, loose = pose_apex(1, arms_front=False)
    save("k5", cv, dy, loose, face="笑眼 ^ ^，嘴巴张大")
    frames = [{"key": "k4", "ms": 200}, {"key": "k5", "ms": 160}]
    anim = {"action": "cheer", "name": "欢呼", "loop": False, "colors": COLORS, "keys": KEYS, "frames": frames}
    (HERE / "anim.json").write_text(json.dumps(anim, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
