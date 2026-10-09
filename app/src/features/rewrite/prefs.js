// 选中调用的几个开关和草稿，存在 kv 里：
//   rewrite:auto   选中文字时自动弹出工具栏（默认开）
//   rewrite:marks  AI 改过的段落留淡色标记（默认开）
//   rewrite:view   上次用的对比方式
//   rewrite:drafts 没做完的对比 { [chapterId]: 草稿 }
import { db } from "../../core/db.js";

export const prefs = { auto: true, marks: true, view: null };
let drafts = {};

export async function loadPrefs() {
  try {
    prefs.auto = (await db.getKV("rewrite:auto", true)) !== false;
    prefs.marks = (await db.getKV("rewrite:marks", true)) !== false;
    prefs.view = await db.getKV("rewrite:view", null);
    drafts = (await db.getKV("rewrite:drafts", {})) || {};
  } catch (_) { /* 读不到就用默认 */ }
  return prefs;
}

export async function setPref(name, value) {
  prefs[name] = value;
  await db.setKV("rewrite:" + name, value);
}

export const draftOf = (chapterId) => (chapterId && drafts[chapterId]) || null;
export async function saveDraft(chapterId, d) {
  drafts = { ...drafts, [chapterId]: d };
  await db.setKV("rewrite:drafts", drafts);
}
export async function dropDraft(chapterId) {
  if (!drafts[chapterId]) return;
  const next = { ...drafts };
  delete next[chapterId];
  drafts = next;
  await db.setKV("rewrite:drafts", drafts);
}
