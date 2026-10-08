"""生成「小恶魔衣橱」预览页 wardrobe.html

    python3 tools/make_wardrobe_page.py

读取 styles/<id>/actions/<动作>/anim.json 和 frames.png，以及 styles/<id>/persona.json（台词），把清单内嵌进页面。
页面引用的图片路径是 styles/<id>/actions/<动作>/frames.png，发布时把这些文件一起带上。
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STYLES = [
    ("magical", "原稿·小恶魔魔法少女", ["通用", "奇幻", "轻小说"]),
    ("sailor", "水手服·元气同桌", ["校园", "青春", "都市日常", "恋爱"]),
    ("hanfu", "古风·执笔仙子", ["仙侠", "玄幻", "古言", "武侠", "历史"]),
    ("gothic", "哥特·暗夜魔典", ["西幻", "魔幻", "暗黑"]),
    ("detective", "侦探·推理少女", ["悬疑", "推理", "刑侦", "惊悚"]),
    ("adventurer", "异世界·见习冒险者", ["异世界", "穿越", "冒险", "游戏", "种田"]),
]
ORDER = ["idle", "blink", "wave", "point", "think", "cheer", "shock", "doze"]


def manifest():
    out = []
    for sid, name, genres in STYLES:
        acts = []
        for key in ORDER:
            meta = ROOT / "styles" / sid / "actions" / key / "anim.json"
            if not meta.exists():
                continue
            m = json.loads(meta.read_text())
            acts.append({"key": key, "name": m["name"], "frames": m["frames"], "ms": m["ms"],
                         "loop": m["loop"], "kind": m.get("kind", "basic"),
                         "src": f"styles/{sid}/actions/{key}/frames.png"})
        pf = ROOT / "styles" / sid / "persona.json"
        persona = json.loads(pf.read_text()) if pf.exists() else None
        out.append({"id": sid, "name": name, "genres": genres, "w": 128, "h": 224, "actions": acts, "persona": persona})
    return out


def files():
    return {f"styles/{s['id']}/actions/{a['key']}/frames.png": f"assistant_sprite/styles/{s['id']}/actions/{a['key']}/frames.png"
            for s in manifest() for a in s["actions"]}


if __name__ == "__main__":
    data = json.dumps({"styles": manifest()}, ensure_ascii=False)
    tpl = (ROOT / "tools" / "wardrobe.tpl.html").read_text()
    (ROOT / "wardrobe.html").write_text(tpl.replace("__DATA__", data.replace("</", "<\\/")))
    (ROOT / "wardrobe.files.json").write_text(json.dumps(files(), ensure_ascii=False, indent=1))
    print("wardrobe.html", len(files()), "个图片文件")
