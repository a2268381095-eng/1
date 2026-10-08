// 提示词库：软件不内置任何提示词，全是作者自己写的。支持分组、排序、复制、导入导出和变量。
// 变量写成 {选中文本} 这样，发送时自动填入；没有的变量在确认卡里标出来。
import { db, uid } from "./db.js";
import { bus } from "./bus.js";

/** 能用的变量（各功能按需提供值） */
export const VARIABLES = [
  { name: "选中文本", desc: "正文里选中的文字" },
  { name: "本章正文", desc: "当前这一章的全文（比较长，注意花费）" },
  { name: "本章要点", desc: "右侧栏的本章要点" },
  { name: "前一章摘要", desc: "上一章的摘要（写在章节摘要里）" },
  { name: "章名", desc: "当前章的章名" },
  { name: "书名", desc: "作品名" },
  { name: "简介", desc: "作品简介" },
  { name: "相关角色卡", desc: "选中文字里出现的角色设定（第三版设定库做好后可用）" },
];

export async function listPrompts() {
  const all = await db.all("prompts");
  // 手动固定的排最前（按 order），其余按用得多少排
  return all.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.pinned && b.pinned ? a.order - b.order : (b.uses || 0) - (a.uses || 0)) || a.name.localeCompare(b.name));
}

export async function savePrompt(p) {
  const row = { id: p.id || uid("pr"), name: p.name || "未命名提示词", group: p.group || "", text: p.text || "", feature: p.feature || "",
    order: p.order ?? Date.now(), uses: p.uses || 0, pinned: !!p.pinned, createdAt: p.createdAt || Date.now(), updatedAt: Date.now() };
  await db.put("prompts", row);
  bus.emit("prompts:changed", {});
  return row;
}

export async function deletePrompt(id) { await db.del("prompts", id); bus.emit("prompts:changed", {}); }

export async function notePromptUse(id) {
  const p = await db.get("prompts", id);
  if (p) { p.uses = (p.uses || 0) + 1; p.lastUsed = Date.now(); await db.put("prompts", p); }
}

/** 填变量。返回 { text, missing: [没有值的变量名], used: [用到的变量名] } */
export function fillPrompt(text, vars = {}) {
  const missing = [], used = [];
  const out = String(text || "").replace(/\{([^{}\n]{1,12})\}/g, (m, name) => {
    if (!used.includes(name)) used.push(name);
    if (vars[name] == null || vars[name] === "") { if (!missing.includes(name)) missing.push(name); return m; }
    return String(vars[name]);
  });
  return { text: out, missing, used };
}

export async function exportPrompts() {
  return { app: "xiaoemo", kind: "prompts", version: 1, prompts: await listPrompts() };
}

/** 导入：同名同分组的跳过，返回导入了几条 */
export async function importPrompts(data) {
  const list = (data && data.prompts) || [];
  const have = await listPrompts();
  let n = 0;
  for (const p of list) {
    if (!p || !p.text) continue;
    if (have.some((h) => h.name === p.name && h.group === p.group && h.text === p.text)) continue;
    await savePrompt({ ...p, id: undefined, uses: 0 });
    n++;
  }
  return n;
}
