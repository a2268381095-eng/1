"""双马尾小恶魔少女 —— 分层像素角色生成脚本

每个部件画在独立图层上（各自描边、上阴影），最后按前后顺序合成。
后续做动态时，可以单独移动/替换某个图层。
"""
from PIL import Image, ImageDraw
import numpy as np

W, H = 96, 128

# ---------------- 调色板 ----------------
OUT = (46, 22, 48)
# 头发：樱桃粉
HAIR_L = (255, 178, 210)
HAIR = (242, 118, 172)
HAIR_D = (196, 66, 134)
HAIR_DD = (140, 40, 104)
# 皮肤
SKIN = (255, 234, 222)
SKIN_D = (242, 194, 184)
BLUSH = (252, 150, 162)
# 眼睛：玫红
EYE_D = (120, 18, 52)
EYE = (220, 44, 84)
EYE_L = (255, 120, 140)
WHITE = (255, 255, 255)
# 衣服：黑紫 + 红
CLO_L = (104, 80, 128)
CLO = (64, 44, 82)
CLO_D = (38, 24, 52)
RED_L = (255, 96, 116)
RED = (214, 36, 72)
RED_D = (150, 20, 54)
FRILL = (250, 246, 252)
FRILL_D = (206, 198, 222)
# 角、翅膀、尾巴
HORN_L = (150, 126, 170)
HORN = (84, 62, 104)
HORN_D = (52, 36, 70)
WING_L = (150, 92, 168)
WING = (104, 58, 124)
WING_D = (70, 36, 90)
# 书
BOOK = (176, 52, 72)
BOOK_D = (120, 30, 50)
PAPER = (255, 246, 228)
GOLD = (255, 214, 102)


class Layer:
    def __init__(self):
        self.img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    def poly(self, pts, c):
        self.d.polygon(pts, fill=c + (255,))

    def ell(self, box, c):
        self.d.ellipse(box, fill=c + (255,))

    def rect(self, box, c):
        self.d.rectangle(box, fill=c + (255,))

    def line(self, pts, c, w=1):
        self.d.line(pts, fill=c + (255,), width=w)

    def px(self, x, y, c):
        if 0 <= x < W and 0 <= y < H:
            self.img.putpixel((x, y), c + (255,))

    def sprite(self, x0, y0, rows, pal):
        for j, row in enumerate(rows):
            for i, ch in enumerate(row):
                if ch in pal:
                    self.px(x0 + i, y0 + j, pal[ch])

    # 光源在左上：靠右下边缘的像素变暗，靠左上边缘的像素变亮
    def shade(self, base, dark, dx=2, dy=2, light=None, ldx=1, ldy=1):
        a = np.array(self.img)
        alpha = a[..., 3] > 0
        is_base = (a[..., 0] == base[0]) & (a[..., 1] == base[1]) & (a[..., 2] == base[2]) & alpha

        def inside(ox, oy):
            pad = np.zeros((H + 8, W + 8), bool)
            pad[4:4 + H, 4:4 + W] = alpha
            return pad[4 + oy:4 + oy + H, 4 + ox:4 + ox + W]

        dk = is_base & ~inside(dx, dy)
        a[dk, :3] = dark
        if light:
            lt = is_base & ~dk & ~inside(-ldx, -ldy)
            a[lt, :3] = light
        self.img = Image.fromarray(a)
        self.d = ImageDraw.Draw(self.img)

    def outline(self, c=OUT):
        a = np.array(self.img)
        alpha = a[..., 3] > 0
        pad = np.zeros((H + 2, W + 2), bool)
        pad[1:-1, 1:-1] = alpha
        nb = pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]
        edge = nb & ~alpha
        a[edge, :3] = c
        a[edge, 3] = 255
        self.img = Image.fromarray(a)
        self.d = ImageDraw.Draw(self.img)
        return self


layers = {}

# ================= 双马尾（后层） =================
L = Layer()
# 左马尾（画面左）
L.poly([(30, 22), (22, 26), (16, 36), (14, 50), (15, 64), (13, 78), (10, 90), (12, 100),
        (16, 106), (16, 96), (20, 86), (23, 72), (24, 58), (25, 46), (29, 34), (33, 28)], HAIR)
# 右马尾
L.poly([(66, 22), (74, 26), (80, 36), (82, 50), (81, 64), (83, 78), (86, 90), (84, 100),
        (80, 106), (80, 96), (76, 86), (73, 72), (72, 58), (71, 46), (67, 34), (63, 28)], HAIR)
L.shade(HAIR, HAIR_D, 2, 0, light=HAIR_L, ldx=2, ldy=0)
# 发丝线
for pts in ([(23, 30), (19, 44), (18, 60), (17, 76), (14, 92)],
            [(27, 34), (22, 52), (21, 70), (18, 88)],
            [(73, 30), (77, 44), (78, 60), (79, 76), (82, 92)],
            [(69, 34), (74, 52), (75, 70), (78, 88)]):
    L.line(pts, HAIR_D)
layers["tails"] = L.outline()

# ================= 后发 =================
L = Layer()
L.ell((26, 12, 70, 58), HAIR_D)
L.poly([(28, 40), (68, 40), (66, 62), (30, 62)], HAIR_D)
L.shade(HAIR_D, HAIR_DD, 2, 2)
layers["back_hair"] = L.outline()

# ================= 蝙蝠翅膀 =================
L = Layer()
for s in (1, -1):
    cx = 48
    def X(x):
        return cx + s * x
    L.poly([(X(8), 58), (X(14), 50), (X(22), 44), (X(32), 40), (X(38), 42), (X(34), 48),
            (X(36), 56), (X(30), 56), (X(28), 62), (X(22), 60), (X(18), 66), (X(12), 64)], WING)
    # 翼骨
    L.line([(X(10), 58), (X(22), 46), (X(34), 42)], WING_D)
    L.line([(X(22), 46), (X(30), 56)], WING_D)
    L.line([(X(16), 54), (X(22), 60)], WING_D)
L.shade(WING, WING_D, 0, 2, light=WING_L, ldx=0, ldy=1)
layers["wings"] = L.outline()

# ================= 恶魔尾巴 =================
L = Layer()
L.line([(54, 86), (62, 94), (70, 96), (76, 92), (78, 86), (78, 80)], CLO, w=3)
# 爱心尾尖
L.poly([(78, 82), (72, 76), (72, 72), (75, 70), (78, 72), (81, 70), (84, 72), (84, 76)], RED)
L.shade(RED, RED_D, 1, 1, light=RED_L)
L.shade(CLO, CLO_D, 1, 1, light=CLO_L)
layers["tail"] = L.outline()

# ================= 腿 + 靴 =================
L = Layer()
# 大腿（裙下露出的绝对领域）
L.rect((39, 92, 46, 100), SKIN)
L.rect((50, 92, 57, 100), SKIN)
L.shade(SKIN, SKIN_D, 2, 0)
# 黑色过膝袜
L.poly([(39, 99), (46, 99), (46, 116), (40, 116)], CLO)
L.poly([(50, 99), (57, 99), (56, 116), (50, 116)], CLO)
L.shade(CLO, CLO_D, 2, 0, light=CLO_L, ldx=1, ldy=0)
# 袜口红色蝴蝶结线
L.rect((39, 99, 46, 99), RED)
L.rect((50, 99, 57, 99), RED)
# 靴子
L.poly([(39, 115), (46, 115), (47, 122), (36, 122), (36, 120), (39, 118)], HORN)
L.poly([(50, 115), (57, 115), (60, 120), (60, 122), (49, 122)], HORN)
L.shade(HORN, HORN_D, 1, 1, light=HORN_L)
L.rect((36, 123, 47, 123), RED_D)
L.rect((49, 123, 60, 123), RED_D)
layers["legs"] = L.outline()

# ================= 裙子 =================
L = Layer()
L.poly([(38, 76), (58, 76), (64, 90), (66, 94), (30, 94), (32, 90)], CLO)
L.shade(CLO, CLO_D, 2, 1, light=CLO_L, ldx=1, ldy=1)
# 褶皱
for x0, x1 in ((42, 38), (47, 46), (52, 54), (56, 60)):
    L.line([(x0, 78), (x1, 92)], CLO_D)
# 红色内衬 + 白蕾丝
L.rect((31, 93, 65, 94), RED)
for x in range(30, 67):
    L.px(x, 95, FRILL if x % 2 else FRILL_D)
    if x % 3 != 0:
        L.px(x, 96, FRILL)
layers["skirt"] = L.outline()

# ================= 上身 =================
L = Layer()
# 躯干：胸部稍宽，腰收
L.poly([(40, 54), (56, 54), (59, 58), (60, 66), (57, 72), (57, 78), (39, 78), (39, 72),
        (36, 66), (37, 58)], CLO)
L.shade(CLO, CLO_D, 2, 1, light=CLO_L, ldx=1, ldy=1)
# 胸部曲线：下缘阴影 + 上方高光
for x, y in ((40, 66), (41, 67), (42, 67), (43, 67), (44, 67), (45, 66), (46, 65),
             (50, 65), (51, 66), (52, 67), (53, 67), (54, 67), (55, 67), (56, 66)):
    L.px(x, y, CLO_D)
for x, y in ((41, 61), (42, 60), (43, 60), (52, 60), (53, 60), (54, 61)):
    L.px(x, y, CLO_L)
L.px(48, 64, CLO_D); L.px(48, 65, CLO_D)
# 红色束腰 + 系带
L.rect((40, 70, 56, 77), RED)
L.shade(RED, RED_D, 1, 1, light=RED_L)
for y in (71, 73, 75):
    L.px(47, y, FRILL); L.px(49, y, FRILL); L.px(48, y + 1, FRILL)
# 领口：白色荷叶边 + 红蝴蝶结（不露胸）
L.rect((40, 54, 56, 56), FRILL)
for x in range(40, 57, 2):
    L.px(x, 57, FRILL_D)
L.poly([(48, 57), (43, 55), (43, 60)], RED)
L.poly([(48, 57), (53, 55), (53, 60)], RED)
L.rect((47, 56, 49, 58), RED_D)
L.px(46, 61, RED); L.px(50, 61, RED); L.px(45, 62, RED_D); L.px(51, 62, RED_D)
layers["body"] = L.outline()

# ================= 手臂 =================
L = Layer()
# 画面左：叉腰
L.poly([(38, 56), (34, 60), (30, 70), (33, 72), (36, 64), (39, 60)], SKIN)
L.poly([(30, 69), (33, 72), (38, 76), (40, 73), (35, 69)], CLO)  # 黑手套
L.rect((30, 68, 34, 69), RED)
L.shade(SKIN, SKIN_D, 1, 1)
L.shade(CLO, CLO_D, 1, 1, light=CLO_L)
# 画面右：抱着书
L.poly([(58, 56), (62, 60), (64, 70), (61, 72), (59, 64), (57, 60)], SKIN)
L.poly([(61, 70), (64, 70), (65, 78), (61, 78)], CLO)
L.rect((61, 70, 64, 71), RED)
L.shade(SKIN, SKIN_D, 1, 1)
L.shade(CLO, CLO_D, 1, 1, light=CLO_L)
layers["arms"] = L.outline()

# ================= 书 =================
L = Layer()
L.poly([(56, 72), (68, 70), (70, 86), (58, 88)], BOOK)
L.shade(BOOK, BOOK_D, 1, 1)
L.line([(57, 87), (69, 85)], PAPER)  # 书页
L.line([(58, 88), (70, 86)], FRILL_D)
# 封面金色爱心
L.sprite(60, 76, [".g.g.",
                  "ggggg",
                  ".ggg.",
                  "..g.."], {"g": GOLD})
# 抓书的手
L.ell((60, 74, 65, 79), SKIN)
L.px(64, 78, SKIN_D); L.px(63, 79, SKIN_D)
layers["book"] = L.outline()

# ================= 头（脸） =================
L = Layer()
L.rect((45, 50, 51, 55), SKIN_D)  # 脖子
L.ell((32, 20, 64, 52), SKIN)
L.poly([(34, 40), (62, 40), (56, 50), (48, 53), (40, 50)], SKIN)
layers["face"] = L.outline()

# ================= 五官 =================
L = Layer()
EYE_PAL = {"o": OUT, "d": EYE_D, "r": EYE, "l": EYE_L, "W": WHITE, "s": SKIN_D}
eye = ["..oooooo.",
       ".ooooooooo",
       "oodddddoo",
       ".oWWddddo",
       ".oWWrdrro",
       ".orrddrro",
       ".orrddrro",
       ".olrrrrlo",
       "..ollllo.",
       "...oooo.."]
L.sprite(36, 33, eye, EYE_PAL)
L.sprite(51, 33, [row[::-1].rjust(10, ".")[1:] for row in eye], EYE_PAL)
# 坏笑的小眉毛
L.line([(37, 30), (42, 31)], HAIR_DD)
L.line([(54, 31), (59, 30)], HAIR_DD)
# 腮红
for bx in (37, 55):
    L.px(bx, 44, BLUSH); L.px(bx + 2, 44, BLUSH); L.px(bx + 4, 44, BLUSH)
# 嘴：小坏笑 + 小虎牙
L.sprite(45, 46, ["o....o",
                  ".oooo.",
                  "..W..."], {"o": OUT, "W": WHITE})
layers["features"] = L

# ================= 刘海 + 鬓发 =================
L = Layer()
L.poly([(30, 34), (30, 24), (36, 15), (44, 11), (52, 11), (60, 15), (66, 24), (66, 34),
        (63, 30), (62, 36), (59, 28), (56, 33), (54, 26), (50, 32), (48, 24), (46, 32),
        (42, 26), (40, 33), (37, 28), (34, 36), (33, 30)], HAIR)
# 鬓发垂到下巴
L.poly([(30, 30), (34, 32), (34, 46), (32, 52), (29, 48)], HAIR)
L.poly([(66, 30), (62, 32), (62, 46), (64, 52), (67, 48)], HAIR)
L.shade(HAIR, HAIR_D, 1, 2, light=HAIR_L, ldx=1, ldy=1)
# 发丝
for pts in ([(48, 13), (48, 22)], [(42, 15), (40, 24)], [(54, 15), (56, 24)],
            [(37, 20), (35, 28)], [(59, 20), (61, 28)]):
    L.line(pts, HAIR_D)
# 头顶高光
L.line([(40, 17), (44, 15)], HAIR_L)
L.line([(52, 15), (56, 17)], HAIR_L)
L.px(48, 12, HAIR_L)
layers["bangs"] = L.outline()

# ================= 小恶魔角 =================
L = Layer()
L.poly([(38, 18), (35, 12), (34, 6), (37, 9), (41, 14), (42, 17)], HORN)
L.poly([(58, 18), (61, 12), (62, 6), (59, 9), (55, 14), (54, 17)], HORN)
L.shade(HORN, HORN_D, 1, 1, light=HORN_L)
layers["horns"] = L.outline()

# ================= 发圈（红色蝙蝠结） =================
L = Layer()
for cx in (30, 66):
    L.poly([(cx, 24), (cx - 5, 20), (cx - 6, 25), (cx - 4, 28)], RED)
    L.poly([(cx, 24), (cx + 5, 20), (cx + 6, 25), (cx + 4, 28)], RED)
    L.rect((cx - 1, 23, cx + 1, 25), RED_D)
L.shade(RED, RED_D, 1, 1, light=RED_L)
layers["ties"] = L.outline()

ORDER = ["tails", "back_hair", "wings", "tail", "legs", "skirt", "body", "arms",
         "face", "features", "bangs", "horns", "ties", "book"]


def compose(order=ORDER):
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for k in order:
        out.alpha_composite(layers[k].img)
    return out


if __name__ == "__main__":
    import os
    os.makedirs("devil_girl", exist_ok=True)
    os.makedirs("devil_girl/layers", exist_ok=True)
    img = compose()
    img.save("devil_girl/devil_girl_1x.png")
    big = img.resize((W * 6, H * 6), Image.NEAREST)
    big.save("devil_girl/devil_girl_6x.png")
    prev = Image.new("RGBA", big.size, (236, 222, 240, 255))
    prev.alpha_composite(big)
    prev.save("devil_girl/devil_girl_preview.png")
    for k in ORDER:
        layers[k].img.save(f"devil_girl/layers/{ORDER.index(k):02d}_{k}.png")
