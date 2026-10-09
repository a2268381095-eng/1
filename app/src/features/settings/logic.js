// 设置界面用到的纯函数（不碰界面和数据库，node 里能直接测）。

// 字体：id 存在设置里（uiFont / textFont），main.js 的 applyLook 用 fontStack 取 CSS 字体栈；
// 自己上传的字体 id 就是 CSS 里的字体名。
// 带 file 的打包在 dist/fonts/ 里（@font-face 在 src/styles/fonts.css），不联网、桌面版都能用。
// 「kai」原来是联网的「楷体」，现在换成打包的霞鹜文楷，id 不变，旧设置照样认。
const SANS = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
const SERIF = '"Noto Serif SC", "Songti SC", "SimSun", serif';
export const FONT_CHOICES = [
  { id: "system", name: "跟随系统", stack: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' },
  { id: "serif", name: "宋体", stack: SERIF },
  { id: "sans", name: "黑体", stack: SANS },
  { id: "kai", name: "霞鹜文楷", family: "LXGW WenKai", file: "lxgw-wenkai.woff2", stack: '"LXGW WenKai", "LXGW WenKai TC", "KaiTi", "STKaiti", serif' },
  { id: "yozai", name: "悠哉字体", family: "Yozai", file: "yozai.woff2", stack: '"Yozai", "KaiTi", "STKaiti", ' + SANS },
  { id: "xiaolai", name: "小赖字体", family: "Xiaolai SC", file: "xiaolai-sc.woff2", stack: '"Xiaolai SC", ' + SANS },
  { id: "xiaowei", name: "站酷小薇", family: "ZCOOL XiaoWei", file: "zcool-xiaowei.woff2", stack: '"ZCOOL XiaoWei", ' + SERIF },
  { id: "kuaile", name: "快乐体", stack: '"ZCOOL KuaiLe", ' + SANS },
];

/** 可选的字体：内置的 + 自己上传的 */
export function fontOptions(customFonts = []) {
  return [
    ...FONT_CHOICES,
    ...(customFonts || []).map((f) => ({ id: f.id, name: f.name, stack: `"${f.id}", ${SERIF}`, custom: true })),
  ];
}

/** 字体 id → CSS 字体栈；不认识的 id 当作上传的字体名 */
export function fontStack(id) {
  const f = FONT_CHOICES.find((o) => o.id === id);
  return f ? f.stack : `"${id}", ${SERIF}`;
}

export const FONT_EXTS = ["ttf", "otf", "woff", "woff2"];

/** 文件名 → { ok, ext, name }；name 去掉扩展名，留作显示 */
export function fontFileInfo(filename) {
  const m = /^(.*?)\.([A-Za-z0-9]+)$/.exec(String(filename || "").trim());
  const ext = m ? m[2].toLowerCase() : "";
  const base = (m ? m[1] : String(filename || "")).replace(/[_]+/g, " ").trim();
  return { ok: FONT_EXTS.includes(ext), ext, name: (base || "我的字体").slice(0, 40) };
}

/** 重名时加编号：楷书 → 楷书 2 */
export function uniqueName(name, taken = []) {
  if (!taken.includes(name)) return name;
  let i = 2;
  while (taken.includes(name + " " + i)) i++;
  return name + " " + i;
}

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// ---------------- 设置分组 ----------------
export const GROUPS = {
  look: ["theme", "palette", "pixelBg", "sceneBg", "sceneDither", "sceneVeil", "sceneCycle", "sceneNav", "paperRest", "motion", "clickFx", "uiFont", "textFont", "textSize", "lineHeight", "textWidth"],
  demon: ["demonOn", "demonScale", "demonPos", "demonStyle", "demonChatty", "idleMinutes", "demonPulse"],
  shelf: ["hoverDelay"],
  keys: ["keys"],
  names: ["themeNames"],
};
export const BOOK_KEYS = ["numbering", "useVolumes", "autoIndent", "paraGap", "dailyGoal", "demonStyle"];

/** 取出几项（对象、数组复制一份，撤销时不会被后来的改动带跑） */
export function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = clone(obj ? obj[k] : undefined);
  return out;
}

export function clone(v) {
  if (v == null || typeof v !== "object") return v;
  return JSON.parse(JSON.stringify(v));
}

export function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 某一组恢复默认要写进去的值 */
export function resetPatch(group, defaults) {
  return pick(defaults, GROUPS[group] || []);
}

/** 数字限定在范围里，按步长取整 */
export function clampNum(v, min, max, step = 1) {
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  n = Math.min(max, Math.max(min, n));
  const k = Math.round((n - min) / step);
  return Math.round((min + k * step) * 1000) / 1000;
}

// ---------------- 快捷键 ----------------
const MODS = ["Mod", "Alt", "Shift"];
const PURE_MODS = ["Control", "Shift", "Alt", "Meta", "CapsLock", "OS", "Fn"];

/** "Mod-Shift-f" → { mods: ["Mod","Shift"], key: "f" }（减号键写成 "Mod--"） */
export function parseKey(k) {
  const s = String(k || "");
  const parts = s.split("-");
  if (s === "-") return { mods: [], key: "-" };
  if (s.endsWith("--")) return { mods: parts.slice(0, -2), key: "-" };
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] || "" };
}

/** 新快捷键能不能用。能用返回 ""，不能用返回原因 */
export function checkKey(k) {
  const { mods, key } = parseKey(k);
  if (!key || PURE_MODS.includes(key)) return "还要再按一个键";
  if (key === "Escape") return "Esc 留给关闭窗口用";
  if (key === " ") return "空格常用来切换输入法，换一个";
  if (key === "-") return "减号键用不了，换一个";
  if (key === "Process" || key === "Unidentified" || key === "Dead") return "这个键认不出来，先切成英文输入再按";
  const fn = /^F([1-9]|1[0-2])$/.test(key);
  const strong = mods.includes("Mod") || mods.includes("Alt");
  if (!strong && !fn) return "要带上 Ctrl 或 Alt，不然打字时会误触";
  if (!mods.every((m) => MODS.includes(m))) return "这个组合认不出来，换一个";
  return "";
}

/**
 * 找冲突：同一个键给了两个命令，并且它们能在同一个地方用。
 * items: [{ id, key, area }]，area 是 "global"（哪里都能用）或者某个界面。
 * 返回 { id: [和它冲突的 id, ...] }
 */
export function findConflicts(items) {
  const out = {};
  const byKey = new Map();
  for (const it of items) {
    if (!it.key) continue;
    if (!byKey.has(it.key)) byKey.set(it.key, []);
    byKey.get(it.key).push(it);
  }
  for (const list of byKey.values()) {
    for (const a of list) {
      const hits = list.filter((b) => b !== a && (a.area === "global" || b.area === "global" || a.area === b.area)).map((b) => b.id);
      if (hits.length) out[a.id] = hits;
    }
  }
  return out;
}

/** 改一个命令的快捷键后的新表：和默认一样就不用记 */
export function withKey(custom, id, key, defaultKey) {
  const next = { ...(custom || {}) };
  if (!key || key === defaultKey) delete next[id];
  else next[id] = key;
  return next;
}

// 命令属于哪个界面（判断冲突用）
const BOOK_AREA = ["edit", "chapter", "volume", "focus", "panel", "book", "search", "replace", "format", "versions", "points", "ai"];
export function areaOf(id, hasWhen) {
  if (!hasWhen) return "global";
  const prefix = String(id).split(".")[0];
  return BOOK_AREA.includes(prefix) ? "book" : prefix;
}

// ---------------- 报错记录 ----------------
const sig = (e) => e.at + "|" + e.what;

/** 撤销「清空」：把清掉的放回去，清空之后新记的也留着，按时间排 */
export function mergeLog(current = [], restored = []) {
  const seen = new Set(current.map(sig));
  return [...current, ...restored.filter((e) => !seen.has(sig(e)))].sort((a, b) => b.at - a.at);
}

/** 重做「清空」：只去掉当时清掉的那些 */
export function removeLog(current = [], removed = []) {
  const gone = new Set(removed.map(sig));
  return current.filter((e) => !gone.has(sig(e)));
}

/** 报错记录整理成纯文本（复制给别人看） */
export function logText(log = [], fmt = (t) => new Date(t).toLocaleString()) {
  return log.map((e) => [
    fmt(e.at) + "  " + e.what,
    e.why ? "可能的原因：" + e.why : "",
    e.detail ? "详细信息：\n" + e.detail : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}
