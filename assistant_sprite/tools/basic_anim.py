"""给还没做精修动画的姿势生成基础动画：整体轻轻浮动，睁眼的姿势偶尔眨一下眼

    python3 tools/basic_anim.py styles/<id> [styles/<id2> ...]

已经有 anim.json 且 "kind" 不是 "basic" 的动作（精修过的）不会被覆盖。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from anim_kit import blink, export, find_eyes, load_pose, shift  # noqa: E402

ACTIONS = [("idle", "待机", True), ("wave", "打招呼", False), ("point", "指路", False), ("think", "思考", True),
           ("cheer", "欢呼", False), ("shock", "吓一跳", False), ("doze", "打瞌睡", True)]
BOB = [0, -1, -1, -2, -2, -2, -1, -1, 0, 0]
SKIN = (254, 237, 234)


def main(style_dirs):
    for sd in map(Path, style_dirs):
        for key, name, loop in ACTIONS:
            out = sd / "actions" / key
            meta = out / "anim.json"
            if meta.exists() and json.loads(meta.read_text()).get("kind", "basic") != "basic":
                continue
            pose_file = sd / "poses" / f"{key}.png"
            if not pose_file.exists():          # 这个动作的图还没到，先跳过
                continue
            base = load_pose(pose_file)
            eyes = [(x0 - 1, y0 - 2, x1 + 1, y1) for x0, y0, x1, y1 in find_eyes(base)]
            blinks = key not in ("shock", "cheer")     # 睁眼的姿势都眨眼，吓到和欢呼时不眨
            frames = []
            for i, dy in enumerate(BOB):
                f = base
                if eyes and blinks and i in (6, 7):
                    f = blink(f, eyes, "closed" if i == 7 else "half", SKIN)
                frames.append(shift(f, dy=dy))
            export(frames, [140] * len(frames), out, key, name, loop)
            m = json.loads(meta.read_text())
            m["kind"] = "basic"
            meta.write_text(json.dumps(m, ensure_ascii=False, indent=1))
        print(sd.name, "ok")


if __name__ == "__main__":
    main(sys.argv[1:])
