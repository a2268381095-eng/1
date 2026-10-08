"""把 GPT 出的背景插画转成像素画背景

    python3 tools/pixelize_bg.py 原图 输出.png [--size 384x256] [--colors 48] [--dither 0|1] [--sharpen 1]

做法：先轻微锐化（保住动画线稿），按面积平均缩小到目标像素尺寸，
再用中位切分压到有限的颜色数；--dither 1 时加 4×4 有序网点，更像老游戏机。
"""
import argparse

import numpy as np
from PIL import Image, ImageFilter, ImageEnhance

BAYER4 = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16.0 - 0.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--size", default="384x256")
    ap.add_argument("--colors", type=int, default=48)
    ap.add_argument("--dither", type=int, default=0)
    ap.add_argument("--sharpen", type=float, default=1.0)
    ap.add_argument("--saturation", type=float, default=1.08)
    a = ap.parse_args()
    w, h = (int(x) for x in a.size.split("x"))
    im = Image.open(a.src).convert("RGB")
    # 裁成和目标一样的比例
    r = w / h
    if im.width / im.height > r:
        nw = int(im.height * r); im = im.crop(((im.width - nw) // 2, 0, (im.width - nw) // 2 + nw, im.height))
    else:
        nh = int(im.width / r); im = im.crop((0, (im.height - nh) // 2, im.width, (im.height - nh) // 2 + nh))
    if a.sharpen:
        im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=int(80 * a.sharpen), threshold=2))
    im = ImageEnhance.Color(im).enhance(a.saturation)
    small = im.resize((w, h), Image.BOX)
    if a.dither:
        arr = np.asarray(small).astype(float)
        th = np.tile(BAYER4, (h // 4 + 1, w // 4 + 1))[:h, :w]
        arr = np.clip(arr + th[..., None] * 18, 0, 255).astype(np.uint8)
        small = Image.fromarray(arr)
    q = small.quantize(colors=a.colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    q.convert("RGB").save(a.out, optimize=True)
    print(a.out, q.size)


if __name__ == "__main__":
    main()
