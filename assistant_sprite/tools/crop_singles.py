"""把参考图里的每个姿势单独裁成一张图（原图分辨率、白底），方便上传给 GPT 当参考。

    python3 tools/crop_singles.py refs/sailor_sheet.webp 输出目录 [--rows 4,3] [--names ...]

分人的方法和 pixelize_sheet.py 一样（从相连最细的地方切开）。
"""
import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from pixelize_sheet import figure_masks, foreground  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("out")
    ap.add_argument("--rows", default="4,3")
    ap.add_argument("--names", default="idle,wave,point,think,cheer,shock,doze")
    ap.add_argument("--pad", type=int, default=40)
    ap.add_argument("--canvas", default="", help="例如 768x1152：把人物原大放到这么大的白底画布正中间")
    a = ap.parse_args()
    src8 = np.asarray(Image.open(a.image).convert("RGB"))
    src = src8.astype(np.float32)
    masks = figure_masks(foreground(src), [int(x) for x in a.rows.split(",")], src)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(a.image).stem.replace("_sheet", "")
    for name, m in zip(a.names.split(","), masks):
        keep = cv2.dilate(m.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)   # 带上线稿外侧的抗锯齿
        img = np.full_like(src8, 255)
        img[keep] = src8[keep]
        ys, xs = np.where(m)
        y0, y1 = max(0, ys.min() - a.pad), min(src8.shape[0], ys.max() + a.pad + 1)
        x0, x1 = max(0, xs.min() - a.pad), min(src8.shape[1], xs.max() + a.pad + 1)
        piece = Image.fromarray(img[y0:y1, x0:x1])
        if a.canvas:
            cw, ch = (int(v) for v in a.canvas.split("x"))
            board = Image.new("RGB", (cw, ch), (255, 255, 255))
            px = (cw - piece.width) // 2
            py = max(0, (ch - piece.height) // 2)
            board.paste(piece, (px, py))
            piece = board
        piece.save(out / f"{stem}_{name}.png")
        print(f"{stem}_{name}.png", piece.width, piece.height)


if __name__ == "__main__":
    main()
