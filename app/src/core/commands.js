// 命令表：每个功能把自己能做的事登记在这里。
// 小恶魔的「你想做什么？」面板、快捷键都从这里取，作者找不到功能时搜一下就能直接点。
//
// commands.register({
//   id: "format.run",            唯一 id
//   title: "一键排版",            面板里显示的名字
//   keywords: "排版 缩进 空行",    搜索用的别名
//   hint: "整理段首空格和标点",     一句说明
//   key: "Mod-Shift-l",          默认快捷键（可选，Mod = Ctrl / ⌘）
//   when: () => true,            什么时候能用（比如必须打开了一章）
//   run: () => {},
// })

const list = new Map();

export const commands = {
  register(cmd) { list.set(cmd.id, cmd); return () => list.delete(cmd.id); },
  get: (id) => list.get(id),
  all: () => [...list.values()],
  available: () => [...list.values()].filter((c) => !c.when || c.when()),
  run(id, ...args) {
    const c = list.get(id);
    if (c && (!c.when || c.when())) return c.run(...args);
    return undefined;
  },
  /** 按名字、别名、说明模糊搜索 */
  search(q) {
    const items = commands.available();
    q = (q || "").trim().toLowerCase();
    if (!q) return items;
    const score = (c) => {
      const hay = [c.title, c.keywords || "", c.hint || ""].join(" ").toLowerCase();
      if (c.title.toLowerCase().includes(q)) return 3;
      if (hay.includes(q)) return 2;
      return [...q].every((ch) => hay.includes(ch)) ? 1 : 0;
    };
    return items.map((c) => [score(c), c]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, c]) => c);
  },
};

// ---------------- 快捷键 ----------------
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export function keyName(e) {
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let k = e.key;
  if (k.length === 1) k = k.toLowerCase();
  parts.push(k);
  return parts.join("-");
}

export function prettyKey(key) {
  if (!key) return "";
  return key.split("-").map((p) => ({ Mod: isMac ? "⌘" : "Ctrl", Shift: "Shift", Alt: isMac ? "⌥" : "Alt" }[p] || (p.length === 1 ? p.toUpperCase() : p))).join("+");
}

let custom = {}; // { commandId: key }，设置里可改
export function setCustomKeys(map) { custom = map || {}; }
export function keyOf(cmd) { return cmd.id in custom ? custom[cmd.id] || "" : cmd.key || ""; }

window.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const k = keyName(e);
  for (const c of commands.available()) {
    if (keyOf(c) && keyOf(c) === k) {
      e.preventDefault();
      c.run();
      return;
    }
  }
});
