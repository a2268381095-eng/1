from PIL import Image, ImageDraw

W, H = 64, 88
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# palette
OUT   = (92, 38, 78, 255)      # 描边（深紫红）
SKIN  = (255, 226, 208, 255)
SKIN2 = (240, 190, 175, 255)
HAIR  = (250, 150, 190, 255)
HAIR2 = (222, 104, 156, 255)
HAIR3 = (255, 196, 220, 255)
EYE   = (60, 200, 190, 255)
EYE2  = (30, 120, 130, 255)
WHITE = (255, 255, 255, 255)
GREY  = (214, 206, 226, 255)
DRESS = (255, 120, 170, 255)
DRESS2= (214, 78, 134, 255)
DRESS3= (255, 170, 205, 255)
BOOT  = (176, 70, 130, 255)
BOOT2 = (130, 44, 98, 255)
GOLD  = (255, 224, 110, 255)
BLUSH = (255, 150, 160, 255)
TAIL  = (150, 70, 150, 255)    # 恶魔尾巴/暗紫


def px(x, y, c):
    if 0 <= x < W and 0 <= y < H:
        img.putpixel((x, y), c)


def rect(x0, y0, x1, y1, c):
    d.rectangle([x0, y0, x1, y1], fill=c)


def poly(pts, c):
    d.polygon(pts, fill=c)


def ell(x0, y0, x1, y1, c):
    d.ellipse([x0, y0, x1, y1], fill=c)


def outline():
    """给所有不透明区域外圈加描边"""
    src = img.copy()
    for y in range(H):
        for x in range(W):
            if src.getpixel((x, y))[3] == 0:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and src.getpixel((nx, ny))[3] > 0:
                        img.putpixel((x, y), OUT)
                        break


# ---------- 双马尾（后层） ----------
# 左马尾
poly([(21, 14), (14, 18), (9, 28), (8, 40), (11, 47), (14, 40), (16, 30), (22, 22)], HAIR)
poly([(14, 24), (10, 32), (10, 42), (11, 46), (14, 40), (15, 30)], HAIR2)
# 右马尾
poly([(43, 14), (50, 18), (55, 28), (56, 40), (53, 47), (50, 40), (48, 30), (42, 22)], HAIR)
poly([(50, 24), (54, 32), (54, 42), (53, 46), (50, 40), (49, 30)], HAIR2)

# 后发
ell(20, 8, 44, 34, HAIR2)

# ---------- 身体 ----------
# 腿（白长筒袜），右腿站直，左腿抬起弯曲
# 右腿(画面右)
rect(35, 56, 39, 74, WHITE)
rect(35, 66, 36, 74, GREY)
# 左腿(画面左)弯曲后踢
rect(25, 56, 29, 66, WHITE)
poly([(25, 64), (29, 64), (24, 74), (20, 72)], WHITE)
# 袜口粉边
rect(35, 66, 39, 66, DRESS3)
# 靴子
poly([(34, 74), (40, 74), (42, 80), (33, 80)], BOOT)
rect(33, 79, 42, 80, BOOT2)
poly([(19, 72), (24, 74), (25, 79), (17, 77)], BOOT)
rect(17, 77, 25, 78, BOOT2)

# 恶魔小尾巴（左后）
poly([(26, 52), (22, 52), (16, 56), (14, 62), (17, 64), (18, 59), (23, 56)], TAIL)
ell(13, 61, 18, 66, TAIL)

# 裙子
poly([(26, 42), (38, 42), (45, 58), (19, 58)], DRESS)
poly([(32, 44), (38, 42), (45, 58), (36, 58)], DRESS2)
# 裙摆蕾丝
for x in range(19, 46):
    px(x, 58, WHITE if x % 2 == 0 else DRESS3)
    px(x, 59, DRESS3 if x % 2 == 0 else WHITE)

# 上身
rect(28, 33, 36, 43, DRESS)
rect(34, 34, 36, 43, DRESS2)
# 胸前蝴蝶结
poly([(32, 36), (27, 34), (27, 39)], DRESS3)
poly([(32, 36), (37, 34), (37, 39)], DRESS3)
rect(31, 35, 33, 37, GOLD)
# 腰带
rect(27, 42, 37, 43, WHITE)

# 脖子
rect(30, 31, 34, 33, SKIN2)

# 分离袖：左手上举挥手，右手叉腰
# 左臂（画面左）下垂，手贴在裙侧
poly([(28, 34), (24, 36), (21, 46), (25, 48), (28, 40)], DRESS)
rect(21, 45, 25, 47, WHITE)
rect(21, 48, 24, 51, SKIN)
# 右臂
poly([(36, 34), (39, 36), (46, 44), (43, 47), (37, 41)], DRESS)
poly([(43, 45), (46, 44), (48, 49), (45, 51)], WHITE)
rect(44, 49, 46, 52, SKIN)

# ---------- 头 ----------
ell(21, 11, 43, 32, SKIN)
rect(23, 28, 41, 31, SKIN)
# 腮红
rect(24, 25, 26, 26, BLUSH)
rect(38, 25, 40, 26, BLUSH)

# 眼睛
for ex in (24, 35):
    rect(ex, 20, ex + 4, 25, EYE)
    rect(ex, 20, ex + 4, 21, EYE2)
    rect(ex, 19, ex + 4, 19, OUT)
    px(ex, 20, OUT) if ex == 24 else px(ex + 4, 20, OUT)
    rect(ex + 1, 22, ex + 2, 23, WHITE)
    px(ex + 3, 25, WHITE)
    px(ex + 1, 24, EYE2)
# 嘴
px(31, 28, SKIN2)
px(32, 28, DRESS2)
px(33, 28, SKIN2)

# 刘海
poly([(20, 18), (21, 8), (28, 4), (36, 4), (43, 8), (44, 18), (40, 19), (38, 13), (34, 18),
      (30, 13), (26, 19), (24, 14), (22, 20)], HAIR)
poly([(30, 5), (36, 5), (40, 9), (34, 12)], HAIR3)  # 高光
# 侧发（遮耳）
rect(20, 18, 22, 28, HAIR)
rect(42, 18, 44, 28, HAIR)

# 发饰：星星发夹 + 发圈
for cx in (20, 44):
    rect(cx - 2, 10, cx + 2, 15, WHITE)
    px(cx, 9, WHITE)
    rect(cx - 1, 12, cx + 1, 13, GOLD)
    px(cx, 11, GOLD)
    px(cx, 14, GOLD)
# 头顶小星
px(32, 3, GOLD); px(31, 4, GOLD); px(33, 4, GOLD); px(32, 5, GOLD)

# 魔法球（右手上方）
ell(47, 40, 55, 48, (255, 210, 235, 255))
ell(49, 42, 52, 45, WHITE)
px(46, 39, GOLD); px(56, 39, GOLD); px(51, 37, GOLD); px(51, 50, GOLD)

outline()

img.save("/home/user/1/chibi_pixel_small.png")
big = img.resize((W * 10, H * 10), Image.NEAREST)
big.save("/home/user/1/chibi_pixel_transparent.png")
bg = Image.new("RGBA", big.size, (236, 160, 98, 255))
bg.alpha_composite(big)
bg.save("/home/user/1/chibi_pixel_preview.png")
