"""给清晰版角色加长双马尾：在角色后面一层画两束长发，再把原图盖在上面。"""
import sys
import numpy as np
from PIL import Image, ImageDraw

SS = 4  # 超采样倍数，画完再缩小，边缘更平滑
OUT = (92, 18, 74)
BASE = (236, 122, 174)
SHADE = (198, 62, 134)
LIGHT = (255, 176, 198)


def catmull(pts, n=24):
    pts = [pts[0]] + pts + [pts[-1]]
    res = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = map(np.array, pts[i - 1:i + 3])
        for t in np.linspace(0, 1, n, endpoint=False):
            res.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    res.append(np.array(pts[-2], float))
    return np.array(res)


def ribbon(center, w0, w1, offset=0.0, scale=1.0):
    """沿中心线生成带状多边形；offset 把带子往一侧偏移（-1 左，1 右）"""
    c = center
    tang = np.gradient(c, axis=0)
    tang /= np.linalg.norm(tang, axis=1, keepdims=True)
    nrm = np.stack([-tang[:, 1], tang[:, 0]], 1)
    t = np.linspace(0, 1, len(c))
    # 扎起处略收、中段蓬起、末端收尖
    w = (w0 * (1 + 0.35 * np.sin(np.pi * t)) * (1 - t ** 2.2) + w1 * t) * scale
    mid = c + nrm * (w * offset)[:, None]
    left = mid + nrm * w[:, None] / 2
    right = mid - nrm * w[:, None] / 2
    return [tuple(p) for p in left] + [tuple(p) for p in right[::-1]]


def draw_tail(d, pts, w0, side):
    c = catmull([(x * SS, y * SS) for x, y in pts])
    w0 *= SS
    n = len(c)
    # 发尾分叉：在后 30% 处分出两小束
    tang = c[-1] - c[int(n * 0.7)]
    nrm = np.array([-tang[1], tang[0]]) / np.linalg.norm(tang)
    forks = []
    for k, (spread, ln) in enumerate(((1.0, 0.85), (-1.0, 0.75))):
        f = c[int(n * 0.55):].copy()
        tt = np.linspace(0, 1, len(f))[:, None]
        f = f + nrm * spread * w0 * 0.55 * tt ** 1.5
        forks.append((f[: int(len(f) * ln)], w0 * 0.45))
    parts = [(c, w0)] + forks
    for cc, ww in parts:
        d.polygon(ribbon(cc, ww + 7 * SS, 3 * SS), fill=OUT)   # 描边
    for cc, ww in parts:
        d.polygon(ribbon(cc, ww, 0.5 * SS), fill=BASE)         # 底色
    for cc, ww in parts:
        d.polygon(ribbon(cc, ww * 0.38, 0.3 * SS, offset=0.7 * side), fill=SHADE)    # 背光一侧
        d.polygon(ribbon(cc, ww * 0.16, 0.2 * SS, offset=-0.75 * side), fill=LIGHT)  # 受光一侧
    # 发丝线
    tang_all = np.gradient(c, axis=0)
    tang_all /= np.linalg.norm(tang_all, axis=1, keepdims=True)
    nn = np.stack([-tang_all[:, 1], tang_all[:, 0]], 1)
    t = np.linspace(0, 1, n)
    w = w0 * (1 + 0.35 * np.sin(np.pi * t)) * (1 - t ** 2.2)
    for off, end in ((-0.2, 0.8), (0.05, 0.9), (0.28, 0.7)):
        m = int(n * end)
        line = c[:m] + nn[:m] * (w[:m] * off)[:, None]
        d.line([tuple(p) for p in line], fill=SHADE, width=int(1.6 * SS))


def main(src, dst):
    im = Image.open(src).convert("RGBA")
    W, H = im.size
    hair = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(hair)
    # 左马尾：从卷曲发尾后面穿过手臂，向左下飘
    draw_tail(d, [(246, 172), (220, 232), (182, 288), (140, 336), (98, 380), (62, 418)], 46, 1)
    # 右马尾：沿右臂外侧垂到大腿
    draw_tail(d, [(484, 170), (500, 245), (516, 325), (514, 405), (524, 465), (546, 512)], 56, -1)
    hair = hair.resize((W, H), Image.LANCZOS)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.alpha_composite(hair)
    out.alpha_composite(im)
    out.save(dst)
    bg = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    bg.alpha_composite(out)
    bg.save(dst.replace(".png", "_white.png"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
