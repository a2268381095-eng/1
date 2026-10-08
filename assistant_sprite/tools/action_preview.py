"""动作（多姿势动画）的渲染与检查

    python3 tools/action_preview.py styles/<id>/actions/<action>

动作目录里有：
    k1.txt, k2.txt ...   关键姿势，59×81 整帧像素表
    anim.json            帧序列，见 styles/README.md「动作」一节
    draw.py（可选）      生成关键姿势的脚本

输出到动作目录：
    anim.gif      6 倍放大、纸色底的动画，用来看效果
    strip.png     所有帧排成一行（4 倍），每帧下方标出用的哪个关键姿势
    frames.png    原尺寸逐帧横排（透明底），以后拼精灵表用
并在终端打印每个关键姿势的检查结果。
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
from build import PALETTE, PAPER, W, H  # noqa: E402
from style_preview import check  # noqa: E402


def load(adir):
    adir = Path(adir)
    style_dir = adir.parent.parent
    smeta = json.loads((style_dir / "style.json").read_text())
    anim = json.loads((adir / "anim.json").read_text())
    pal = dict(PALETTE)
    pal.update({k: tuple(v) for k, v in smeta.get("colors", {}).items()})
    pal.update({k: tuple(v) for k, v in anim.get("colors", {}).items()})
    keys = {}
    for name in anim["keys"]:
        rows = [r for r in (adir / f"{name}.txt").read_text().split("\n") if r]
        keys[name] = rows
    return anim, keys, pal


def render_frame(rows, kmeta, fr, pal, bg=None):
    g = {(x, y): c for y, r in enumerate(rows) for x, c in enumerate(r) if c != "."}
    eyes = fr.get("eyes", "open")
    for eye in (kmeta.get("eyes") or {}).values():
        (tx, ty), (bx, by) = eye[0], eye[1]
        if eyes in ("half", "closed"):
            g[(tx, ty)] = "#"
        if eyes == "closed":
            g[(bx, by)] = "S"
    mouth = fr.get("mouth")
    if mouth and kmeta.get("mouth"):
        mx, my = kmeta["mouth"]
        g[(mx, my)] = "3" if mouth == "small" else "2"
        if mouth == "open":
            g[(mx, my + 1)] = "3"
    dx, dy = fr.get("dx", 0), fr.get("dy", 0)
    img = Image.new("RGBA", (W, H), (bg + (255,)) if bg else (0, 0, 0, 0))
    px = img.load()
    for (x, y), c in g.items():
        x2, y2 = x + dx, y + dy
        if 0 <= x2 < W and 0 <= y2 < H and c in pal:
            px[x2, y2] = pal[c] + (255,)
    return img


def main(adir):
    adir = Path(adir)
    anim, keys, pal = load(adir)
    ok = True
    for name, rows in keys.items():
        problems = check(rows, {"loose_ok": anim["keys"][name].get("loose_ok", [])}, pal)
        print(f"  {name}: " + ("✓" if not problems else "; ".join(problems)))
        ok = ok and not problems
    frames = anim["frames"]
    imgs = [render_frame(keys[f["key"]], anim["keys"][f["key"]], f, pal) for f in frames]
    papers = [render_frame(keys[f["key"]], anim["keys"][f["key"]], f, pal, PAPER) for f in frames]

    strip = Image.new("RGBA", (W * len(imgs), H), (0, 0, 0, 0))
    for i, im in enumerate(imgs):
        strip.paste(im, (i * W, 0))
    strip.save(adir / "frames.png")

    s = 4
    lab = Image.new("RGB", (W * s * len(papers), H * s + 18), PAPER)
    d = ImageDraw.Draw(lab)
    for i, im in enumerate(papers):
        lab.paste(im.resize((W * s, H * s), Image.NEAREST), (i * W * s, 0))
        d.text((i * W * s + 4, H * s + 3), f"{i + 1}:{frames[i]['key']} {frames[i].get('ms', 120)}ms", fill=(110, 90, 100))
    lab.save(adir / "strip.png")

    big = [im.resize((W * 6, H * 6), Image.NEAREST).convert("RGB") for im in papers]
    q = [b.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for b in big]
    q[0].save(adir / "anim.gif", save_all=True, append_images=q[1:], loop=0,
              duration=[f.get("ms", 120) for f in frames])
    print(f"[{anim.get('action')}] {anim.get('name', '')}：{len(frames)} 帧，{'循环' if anim.get('loop') else '播一遍'}" + ("" if ok else "（有检查问题）"))


if __name__ == "__main__":
    for a in sys.argv[1:]:
        main(a)
