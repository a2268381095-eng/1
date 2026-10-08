"""检查台词：禁用句式、长度、空项

    python3 tools/check_lines.py styles/*/persona.json
"""
import json
import re
import sys

BANNED = [
    (r"不是.{0,14}而是", "不是……而是……"),
    (r"不是[^，。！？~…]{1,14}[，,]\s*是", "不是A，是B"),
    (r"并非.{0,14}而是", "并非……而是……"),
    (r"一字一顿", "一字一顿"),
    (r"不像.{0,14}倒像", "不像……倒像……"),
    (r"指尖泛白", "指尖泛白"),
    (r"仿佛|宛如|好似|犹如", "比喻词"),
    (r"[（(].*[)）]", "动作括号"),
]
MAX = 30
EVENTS = ["open", "start", "idle", "goal", "chapter", "delete", "ai_wait", "ai_error", "lost", "late",
          "foreshadow", "format", "poke", "poke_many", "save", "back"]


def check(path):
    d = json.load(open(path))
    bad = []
    for k in ("self", "call", "tagline", "catchphrase", "lines"):
        if not d.get(k):
            bad.append(f"缺少 {k}")
    for ev in EVENTS:
        lines = d.get("lines", {}).get(ev, [])
        if len(lines) < 3:
            bad.append(f"{ev}: 只有 {len(lines)} 句")
        for t in lines:
            if len(t) > MAX:
                bad.append(f"{ev}: 太长({len(t)}) {t}")
            for pat, name in BANNED:
                if re.search(pat, t):
                    bad.append(f"{ev}: {name} {t}")
            if re.search(r"[\U0001F300-\U0001FAFF]", t):
                bad.append(f"{ev}: emoji {t}")
    return bad


if __name__ == "__main__":
    total = 0
    for p in sys.argv[1:]:
        bad = check(p)
        total += len(bad)
        print(p, "OK" if not bad else "")
        for b in bad:
            print("  ", b)
    sys.exit(1 if total else 0)
