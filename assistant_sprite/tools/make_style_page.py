"""生成「挑风格」预览页 styles.html（数据内嵌，精灵表作为同目录文件发布）

    python3 tools/make_style_page.py [personas.json]

读取 styles/*/style.json 和 styles/*/sheet.png，以及性格台词 personas.json（可选），
写出 assistant_sprite/styles.html，页面里的图片路径为 styles/<id>/sheet.png。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORDER = ["default", "sailor", "hanfu", "gothic", "detective", "adventurer"]
SITUATIONS = [
    ("greet", "打开软件"), ("start_typing", "开始码字"), ("long_pause", "停笔很久"),
    ("daily_goal", "达成日目标"), ("before_delete", "删整章前"), ("after_format", "排版完成"),
    ("ai_confirm", "调用 AI 前"), ("ai_error", "AI 报错"), ("cant_find", "找不到功能"),
    ("late_night", "凌晨还在写"),
]


def main(personas_path=None):
    personas = {}
    if personas_path and Path(personas_path).exists():
        for p in json.loads(Path(personas_path).read_text())["styles"]:
            personas[p["id"]] = p
    styles = []
    for sid in ORDER:
        d = ROOT / "styles" / sid
        if not (d / "style.json").exists() or not (d / "sheet.png").exists():
            continue
        meta = json.loads((d / "style.json").read_text())
        review = {}
        if (d / "review.json").exists():
            review = json.loads((d / "review.json").read_text())
        styles.append({
            "id": sid,
            "name": meta.get("name", sid),
            "genres": meta.get("genres", []),
            "pose": meta.get("pose", ""),
            "personality": meta.get("personality", ""),
            "persona": personas.get(sid, {}),
            "verdict": review.get("verdict", ""),
            "issues": review.get("remaining_issues", []),
            "sheet": f"styles/{sid}/sheet.png",
        })
    tpl = (ROOT / "tools" / "style_page.tpl.html").read_text()
    data = json.dumps({"styles": styles, "situations": SITUATIONS}, ensure_ascii=False)
    (ROOT / "styles.html").write_text(tpl.replace("__DATA__", data.replace("</", "<\\/")))
    print(f"styles.html: {len(styles)} styles")


if __name__ == "__main__":
    main(*sys.argv[1:2])
