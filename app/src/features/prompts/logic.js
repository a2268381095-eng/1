// 提示词库的纯函数：分组、搜索、变量、排序值、导入去重。不碰界面和数据库，node 里能直接测。
import { VARIABLES } from "../../core/prompts.js";

const KNOWN = new Set(VARIABLES.map((v) => v.name));
const VAR_RE = /\{([^{}\n]{1,12})\}/g;
const str = (v) => (v == null ? "" : String(v));

/** 正文里用到的变量（按出现顺序，不重复）：[{ name, known }] */
export function varsIn(text) {
  const out = [];
  for (const m of str(text).matchAll(VAR_RE)) {
    if (!out.some((v) => v.name === m[1])) out.push({ name: m[1], known: KNOWN.has(m[1]) });
  }
  return out;
}

/** 把正文切成几段，变量单独一段（列表里给变量上色用）：[{ t, v?, known? }] */
export function segments(text) {
  const s = str(text), out = [];
  let last = 0;
  for (const m of s.matchAll(VAR_RE)) {
    if (m.index > last) out.push({ t: s.slice(last, m.index) });
    out.push({ t: m[0], v: m[1], known: KNOWN.has(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: s.slice(last) });
  return out;
}

/** 没起名字时用正文第一行（最多 16 个字） */
export function nameFrom(text) {
  const line = str(text).split("\n").map((l) => l.trim()).find(Boolean) || "";
  const chars = [...line];
  return chars.length ? chars.slice(0, 16).join("") + (chars.length > 16 ? "…" : "") : "未命名提示词";
}

/** 搜索：名字、分组、正文里有这几个字就算 */
export function matches(p, q) {
  q = str(q).trim().toLowerCase();
  if (!q) return true;
  return [p.name, p.group, p.text].map((x) => str(x).toLowerCase()).some((x) => x.includes(q));
}

const collator = typeof Intl !== "undefined" ? new Intl.Collator("zh-Hans-CN") : null;
const cmp = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

/** 出现过的分组名（按拼音排，「未分组」放最后） */
export function groupsOf(list) {
  const names = [...new Set(list.map((p) => str(p.group)))];
  return names.sort((a, b) => (a === "" ? 1 : b === "" ? -1 : cmp(a, b)));
}

/**
 * 按分组切开。list 用 listPrompts() 的顺序（固定的按手动顺序在前，其余按用得多少）。
 * 返回 [{ group, pinned: [...], auto: [...] }]
 */
export function groupList(list) {
  return groupsOf(list).map((g) => {
    const items = list.filter((p) => str(p.group) === g);
    return { group: g, pinned: items.filter((p) => p.pinned), auto: items.filter((p) => !p.pinned) };
  });
}

/**
 * 调整固定的顺序：ids 是这几条的新顺序。沿用它们原来占的那几个排序值，
 * 这样和别的分组里固定的提示词之间的先后不变。返回改过的行（没变的不返回）。
 */
export function reorderRows(rows, ids) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const vals = rows.map((r) => Number(r.order) || 0).sort((a, b) => a - b);
  for (let i = 1; i < vals.length; i++) if (vals[i] <= vals[i - 1]) vals[i] = vals[i - 1] + 0.001;
  const out = [];
  ids.forEach((id, i) => {
    const r = byId.get(id);
    if (r && r.order !== vals[i]) out.push({ ...r, order: vals[i] });
  });
  return out;
}

/** 把 id 往上 / 往下挪一格，返回新顺序；挪不动返回 null */
export function moveId(ids, id, delta) {
  const i = ids.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const out = ids.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** 新固定的放在所有固定的最后 */
export function nextPinOrder(list) {
  const pinned = list.filter((p) => p.pinned).map((p) => Number(p.order) || 0);
  return pinned.length ? Math.max(...pinned) + 1 : Date.now();
}

/** 复制一份的名字：「名字（副本）」「名字（副本 2）」…… */
export function copyName(name, names) {
  const base = str(name).replace(/（副本(?: \d+)?）$/, "");
  const taken = new Set(names);
  let n = 1, out = base + "（副本）";
  while (taken.has(out)) out = `${base}（副本 ${++n}）`;
  return out;
}

/** 读导入的文件内容。出错时抛出带 code 的错误：json（读不出来）/ shape（里面没有提示词） */
export function parseImport(text) {
  let data;
  try { data = JSON.parse(str(text).replace(/^﻿/, "")); }
  catch (e) { throw Object.assign(new Error(e.message), { code: "json" }); }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.prompts) ? data.prompts : null;
  if (!list) throw Object.assign(new Error("文件里没有 prompts 列表"), { code: "shape" });
  return list;
}

/**
 * 导入前先挑：同名同内容的跳过（文件里自己重复的也只留一条），没有正文的不要。
 * 固定的接在现有固定的后面，保持文件里的先后。
 * 返回 { fresh: [要导入的], skipped: 重复几条, bad: 不能用几条 }
 */
export function planImport(list, have) {
  const key = (p) => str(p.name) + "\u0001" + str(p.text);
  const seen = new Set(have.map(key));
  const fresh = [];
  let skipped = 0, bad = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || typeof raw.text !== "string" || !raw.text.trim()) { bad++; continue; }
    const p = {
      name: str(raw.name).trim().slice(0, 60) || nameFrom(raw.text),
      group: str(raw.group).trim().slice(0, 30),
      text: raw.text,
      feature: str(raw.feature),
      pinned: !!raw.pinned,
      order: Number.isFinite(raw.order) ? raw.order : 0,
    };
    if (seen.has(key(p))) { skipped++; continue; }
    seen.add(key(p));
    fresh.push(p);
  }
  let next = nextPinOrder(have);
  const pinned = fresh.filter((p) => p.pinned).sort((a, b) => a.order - b.order);
  pinned.forEach((p) => { p.order = next++; });
  fresh.forEach((p) => { if (!p.pinned) delete p.order; });
  return { fresh, skipped, bad };
}

/** 导出文件名 */
export function exportName(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `提示词库-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
}
