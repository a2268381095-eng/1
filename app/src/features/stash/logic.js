// 暂存盒的纯逻辑：时间分段、筛选、按条件批量删的匹配、标签解析。不碰界面和存储。
import { FEATURES } from "../../core/stash.js";
import { todayKey } from "../../core/text.js";

export const DAY = 86400000;

/** 功能名：FEATURES 里没有的原样显示，空的算「其他」 */
export const featureName = (id) => FEATURES[id] || id || FEATURES.other || "其他";

/** 时间分段（互不重叠，列表分组用）：today 今天 / week 7 天内（不含今天）/ older 更早 */
export function timeBucket(at, now = Date.now()) {
  if (todayKey(new Date(at)) === todayKey(new Date(now))) return "today";
  return now - at < 7 * DAY ? "week" : "older";
}
export const BUCKETS = [["today", "今天"], ["week", "7 天内"], ["older", "更早"]];

/** 时间筛选：today 今天 / week 7 天内（含今天）/ older 更早 / all */
export function inTime(at, when, now = Date.now()) {
  if (!when || when === "all") return true;
  if (when === "today") return timeBucket(at, now) === "today";
  if (when === "week") return now - at < 7 * DAY || timeBucket(at, now) === "today";
  return timeBucket(at, now) === "older";
}

/** 作品筛选值：all 全部 / none 不属于作品 / 某本书的 id */
export const inBook = (row, book) => !book || book === "all" || (book === "none" ? !row.bookId : row.bookId === book);

/** 搜索：正文、标题、提示词、标签（和 core/stash.js 的 q 一致） */
export function matchQ(row, q) {
  q = (q || "").trim().toLowerCase();
  if (!q) return true;
  return [row.text, row.title, row.prompt, (row.tags || []).join(" ")].join("\n").toLowerCase().includes(q);
}

/** f: { book, feature, when, pinnedOnly, tag, q } */
export function applyFilter(rows, f = {}, now = Date.now()) {
  return rows.filter((r) => inBook(r, f.book)
    && (!f.feature || f.feature === "all" || (r.feature || "other") === f.feature)
    && inTime(r.at, f.when, now)
    && (!f.pinnedOnly || r.pinned)
    && (!f.tag || (r.tags || []).includes(f.tag))
    && matchQ(r, f.q));
}

/** 出现过的值和条数：[[值, 条数]]，按条数从多到少 */
export function tally(rows, pick) {
  const m = new Map();
  rows.forEach((r) => { for (const v of [].concat(pick(r))) if (v != null && v !== "") m.set(v, (m.get(v) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * 按条件批量删：cond { days 多少天以前（0 = 不论时间）, book, feature, keepPinned, keepTagged }
 * 返回要删的条目
 */
export function matchCond(rows, cond, now = Date.now()) {
  const days = Math.max(0, Number(cond.days) || 0);
  return rows.filter((r) => (!days || now - r.at >= days * DAY)
    && inBook(r, cond.book)
    && (!cond.feature || cond.feature === "all" || (r.feature || "other") === cond.feature)
    && !(cond.keepPinned && r.pinned)
    && !(cond.keepTagged && (r.tags || []).length));
}

/** 「备选 要改，第二版」→ ["备选", "要改", "第二版"]；每个最多 12 个字，去重 */
export function parseTags(str) {
  const out = [];
  for (const t of String(str || "").split(/[\s,，、;；]+/)) {
    const v = [...t.trim()].slice(0, 12).join("");
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 长内容折叠：超过 140 字或 5 行 */
export const isLong = (text) => !!text && ([...text].length > 140 || text.split("\n").length > 5);

/** 字数（按字符算，给「展开全文（N 字）」用） */
export const charCount = (text) => [...String(text || "").replace(/\s/g, "")].length;
