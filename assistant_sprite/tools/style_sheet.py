"""给风格静帧做通用预览动画：漂浮、眨眼、说话（每段 8 帧）

    python3 tools/style_sheet.py styles/<id> [styles/<id2> ...]

输出到该目录的 sheet.png（3 行 × 8 帧，每格 59×81），行顺序 idle / blink / talk。
用的是 style.json 里的 eyes 和 mouth 坐标。正式动画以后按风格单独精修。
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from build import PALETTE, W, H  # noqa: E402

BOB = [0, 0, -1, -1, -1, -1, 0, 0]
BLINK = ["open", "open", "open", "half", "closed", "half", "open", "open"]
TALK = [None, "small", "open", "small", None, "open", "small", None]


def load(d):
    rows = [r for r in (d / "sprite.txt").read_text().split("\n") if r]
    meta = json.loads((d / "style.json").read_text())
    pal = dict(PALETTE)
    pal.update({k: tuple(v) for k, v in meta.get("colors", {}).items()})
    grid = {(x, y): c for y, r in enumerate(rows) for x, c in enumerate(r) if c != "."}
    return grid, meta, pal


def frame(grid, meta, pal, dy=0, eyes="open", mouth=None):
    g = dict(grid)
    for eye in meta.get("eyes", {}).values():
        (tx, ty), (bx, by) = eye[0], eye[1]
        if eyes in ("half", "closed"):
            g[(tx, ty)] = "#"
        if eyes == "closed":
            g[(bx, by)] = "S"
    if mouth and meta.get("mouth"):
        mx, my = meta["mouth"]
        g[(mx, my)] = "3" if mouth == "small" else "2"
        if mouth == "open":
            g[(mx, my + 1)] = "3"
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = img.load()
    for (x, y), c in g.items():
        y2 = y + dy
        if 0 <= x < W and 0 <= y2 < H and c in pal:
            px[x, y2] = pal[c] + (255,)
    return img


def main(dirs):
    for d in map(Path, dirs):
        grid, meta, pal = load(d)
        sheet = Image.new("RGBA", (W * 8, H * 3), (0, 0, 0, 0))
        for i in range(8):
            sheet.paste(frame(grid, meta, pal, BOB[i]), (i * W, 0))
            sheet.paste(frame(grid, meta, pal, BOB[i], eyes=BLINK[i]), (i * W, H))
            sheet.paste(frame(grid, meta, pal, BOB[i], mouth=TALK[i]), (i * W, H * 2))
        sheet.save(d / "sheet.png")
        print(f"{d.name}: sheet.png")


if __name__ == "__main__":
    main(sys.argv[1:])
