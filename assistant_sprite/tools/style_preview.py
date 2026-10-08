"""风格像素表的渲染与检查

    python3 tools/style_preview.py styles/<id> [styles/<id2> ...]

每个风格目录里有：
    sprite.txt   59×81 整帧像素表，一个字符一个像素，'.' 透明
    style.json   名字、额外颜色、眼睛/嘴/道具坐标、姿势与性格说明

输出到该目录：
    preview_1x.png    原尺寸透明图
    preview_8x.png    8 倍放大，纸色底 + 每 5 像素一条坐标线，方便对照改像素
    compare.png       左边原稿默认风格，右边本风格，6 倍并排
并在终端打印检查结果：尺寸、未知字符、漏描边的像素。
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from build import PALETTE, PAPER, W, H  # noqa: E402

OUTLINE_LIKE = {"#"}


def load_style(d):
    d = Path(d)
    rows = [r for r in (d / "sprite.txt").read_text().split("\n") if r]
    meta = json.loads((d / "style.json").read_text())
    pal = dict(PALETTE)
    for k, v in meta.get("colors", {}).items():
        pal[k] = tuple(v)
    return rows, meta, pal


def check(rows, meta, pal):
    problems = []
    if len(rows) != H or any(len(r) != W for r in rows):
        problems.append(f"尺寸应为 {W}×{H}，实际 {max(map(len, rows))}×{len(rows)}")
    unknown = sorted({c for r in rows for c in r if c != "." and c not in pal})
    if unknown:
        problems.append("未知字符：" + " ".join(unknown) + "（在 style.json 的 colors 里定义）")
    outline = OUTLINE_LIKE | set(meta.get("outline_chars", []))
    loose = []
    for y, r in enumerate(rows):
        for x, c in enumerate(r):
            if c == "." or c in outline:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if not (0 <= ny < len(rows) and 0 <= nx < len(rows[ny])) or rows[ny][nx] == ".":
                    loose.append((x, y))
                    break
    allowed = {tuple(p) for p in meta.get("loose_ok", [])}
    loose = [p for p in loose if p not in allowed]
    if loose:
        problems.append(f"{len(loose)} 个上色像素直接贴着透明处、没有描边：" + " ".join(f"({x},{y})" for x, y in loose[:30]))
    return problems


def render(rows, pal, bg=None):
    img = Image.new("RGBA", (W, H), (bg + (255,)) if bg else (0, 0, 0, 0))
    px = img.load()
    for y, r in enumerate(rows[:H]):
        for x, c in enumerate(r[:W]):
            if c != "." and c in pal:
                px[x, y] = pal[c] + (255,)
    return img


def grid8(img):
    s = 8
    big = img.resize((W * s, H * s), Image.NEAREST).convert("RGB")
    d = ImageDraw.Draw(big)
    for x in range(0, W + 1, 5):
        d.line([(x * s, 0), (x * s, H * s)], fill=(214, 200, 210))
        d.text((x * s + 2, 2), str(x), fill=(120, 100, 110))
    for y in range(0, H + 1, 5):
        d.line([(0, y * s), (W * s, y * s)], fill=(214, 200, 210))
        d.text((2, y * s + 2), str(y), fill=(120, 100, 110))
    return big


def main(dirs):
    base_rows, _, base_pal = load_style(ROOT / "styles" / "default")
    base_img = render(base_rows, base_pal, PAPER)
    for d in dirs:
        d = Path(d)
        rows, meta, pal = load_style(d)
        problems = check(rows, meta, pal)
        img = render(rows, pal)
        img.save(d / "preview_1x.png")
        grid8(render(rows, pal, PAPER)).save(d / "preview_8x.png")
        s = 6
        cmp_img = Image.new("RGB", (W * s * 2 + 24, H * s), PAPER)
        cmp_img.paste(base_img.resize((W * s, H * s), Image.NEAREST), (0, 0))
        cmp_img.paste(render(rows, pal, PAPER).resize((W * s, H * s), Image.NEAREST), (W * s + 24, 0))
        cmp_img.save(d / "compare.png")
        print(f"[{meta.get('id', d.name)}] {meta.get('name', '')}")
        print("  ✓ 检查通过" if not problems else "\n".join("  ✗ " + p for p in problems))


if __name__ == "__main__":
    main(sys.argv[1:] or [str(ROOT / "styles" / "default")])
