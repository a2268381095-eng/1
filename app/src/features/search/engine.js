// 查找替换的纯逻辑：不碰界面，node 里也能直接跑（测试用）。
import DiffMatchPatch from "diff-match-patch";

export const MAX_HITS = 5000;     // 一次最多找这么多处，再多就请作者缩小范围
const WORD = /[A-Za-z0-9_]/;      // 全字匹配只管英文字母和数字，中文没有词的边界

export function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * 把查找条件变成正则。
 * 返回 { re }；空查找返回 { re: null }；正则写错返回 { error: 中文说明, detail: 英文原文 }，不抛异常。
 */
export function buildMatcher(query, { regex = false, caseSensitive = false } = {}) {
  if (!query) return { re: null };
  const flags = "gm" + (caseSensitive ? "" : "i");
  if (!regex) return { re: new RegExp(escapeRegExp(query), flags + "u") };
  try { return { re: new RegExp(query, flags + "u") }; } catch (_) { /* 有些写法只在非 u 模式下合法，再试一次 */ }
  try { return { re: new RegExp(query, flags) }; } catch (e) { return { error: regexError(e), detail: String(e && e.message || e) }; }
}

const ERRORS = [
  [/Unterminated group/i, "括号没配对：有「(」没有「)」。"],
  [/Unmatched '\)'/i, "多了一个「)」，前面没有对应的「(」。"],
  [/Unterminated character class/i, "方括号没配对：有「[」没有「]」。"],
  [/Lone quantifier brackets/i, "「{」「}」要成对写。想找这个符号本身，写成「\\{」。"],
  [/Nothing to repeat/i, "「*」「+」「?」前面要有要重复的内容。想找这个符号本身，前面加「\\」。"],
  [/Range out of order/i, "方括号里的范围写反了，比如 [z-a] 要写成 [a-z]。"],
  [/numbers out of order/i, "{} 里前面的数要比后面的小。"],
  [/\\ at end of pattern/i, "最后多了一个「\\」。想找反斜杠本身，写成「\\\\」。"],
  [/Incomplete quantifier/i, "{} 写得不完整。"],
  [/capture group name|named reference|named capture/i, "命名分组 (?<名字>…) 的写法不对，或者名字重复了。"],
  [/Invalid group/i, "「(?」后面的写法不对。"],
  [/Invalid (unicode )?escape|Invalid property name/i, "「\\」后面跟的字符不认识。"],
  [/Invalid character class/i, "方括号里的写法不对。"],
  [/too large/i, "正则太长了，拆成几次找。"],
];

/** 正则报错翻成中文 */
export function regexError(e) {
  const msg = String((e && e.message) || e || "");
  for (const [re, zh] of ERRORS) if (re.test(msg)) return zh;
  return "正则表达式的写法不对。";
}

/** 全字匹配：开头、结尾是英文字母或数字时，外面紧挨着的不能也是字母或数字 */
export function atBoundary(text, from, to) {
  const w = (ch) => !!ch && WORD.test(ch);
  if (w(text[from]) && w(text[from - 1])) return false;
  if (w(text[to - 1]) && w(text[to])) return false;
  return true;
}

/**
 * 在几章里找。list: [{ id, text }]，re 带 g 标志。返回 { groups: [{ id, hits }], total, truncated }。
 * hits: [{ from, to, m: [整段, 分组…], named }]，互不重叠，跳过空匹配；超过 limit 处时 truncated 为 true。
 * 这个函数不引用外面的任何变量：正则模式下把它的源码放进单独的线程里跑（回溯太多时能停下来）。
 */
export function scan(list, re, wholeWord, limit) {
  // 全字匹配只管英文字母和数字，中文没有词的边界
  const isWord = (ch) => !!ch && /[A-Za-z0-9_]/.test(ch);
  const groups = [];
  let total = 0, truncated = false;
  for (const c of list) {
    const text = c.text || "";
    const hits = [];
    re.lastIndex = 0;
    let m;
    while (text && (m = re.exec(text))) {
      const from = m.index, s = m[0], to = from + s.length;
      if (!s || (wholeWord && ((isWord(text[from]) && isWord(text[from - 1])) || (isWord(text[to - 1]) && isWord(text[to]))))) {
        re.lastIndex = from + (text.codePointAt(from) > 0xffff ? 2 : 1);
        if (re.lastIndex > text.length) break;
        continue;
      }
      if (total + hits.length >= limit) { truncated = true; break; }
      hits.push({ from, to, m: [...m], named: m.groups ? { ...m.groups } : null });
    }
    re.lastIndex = 0;
    if (hits.length) { groups.push({ id: c.id, hits }); total += hits.length; }
    if (truncated) break;
  }
  return { groups, total, truncated };
}

/** 在一段文字里找出所有命中 */
export function findAll(text, re, { wholeWord = false, limit = MAX_HITS } = {}) {
  if (!re || !text || limit <= 0) return [];
  const g = scan([{ id: "", text }], re, wholeWord, limit).groups[0];
  return g ? g.hits : [];
}

/** 在几章里找。list: [{ id, text }] */
export function searchChapters(list, re, { wholeWord = false, limit = MAX_HITS } = {}) {
  if (!re) return { groups: [], total: 0, truncated: false };
  return scan(list, re, wholeWord, limit);
}

/**
 * 替换文字里的 $1 $& $<名字> $$（只在正则模式下展开；普通模式原样替换）。
 * hit 是 findAll 的一项。
 */
export function expandReplacement(tpl, hit, { regex = false } = {}) {
  if (!regex || tpl.indexOf("$") < 0) return tpl;
  const m = hit.m || [];
  return tpl.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (all, k, name) => {
    if (k === "$") return "$";
    if (k === "&") return m[0] ?? "";
    if (name !== undefined) return hit.named && name in hit.named ? hit.named[name] ?? "" : all;
    const n = parseInt(k, 10);
    if (n >= 1 && n < m.length) return m[n] ?? "";
    if (k.length === 2) {
      const n1 = parseInt(k[0], 10);
      if (n1 >= 1 && n1 < m.length) return (m[n1] ?? "") + k[1];
    }
    return all;
  });
}

/**
 * 把选中的几处换掉，返回新文字。hits 不要求排好序，重叠的后一处跳过。
 * 传了 edits 数组时，把每一处改动记进去 { from, to, len }（旧位置，len 是新文字的长度），换算位置用。
 */
export function replaceHits(text, hits, tpl, opts = {}, edits = null) {
  let out = "", pos = 0;
  for (const hit of [...hits].sort((a, b) => a.from - b.from)) {
    if (hit.from < pos) continue;
    const rep = expandReplacement(tpl, hit, opts);
    out += text.slice(pos, hit.from) + rep;
    if (edits) edits.push({ from: hit.from, to: hit.to, len: rep.length });
    pos = hit.to;
  }
  return out + text.slice(pos);
}

/** 上下文：同一段里前后各 n 个字，段首缩进去掉，截断处加省略号。只看命中附近，超长的一段也不用整段扫 */
export function contextOf(text, from, to, n = 14) {
  const lo = Math.max(0, from - n), hi = Math.min(text.length, to + n);
  const w0 = Math.max(0, lo - 1);
  const i = text.slice(w0, from).lastIndexOf("\n");
  const ls = i >= 0 ? w0 + i + 1 : lo === 0 ? 0 : -1;        // -1：段首在更前面
  const j = text.slice(to, hi + 1).indexOf("\n");
  const le = j >= 0 ? to + j : hi === text.length ? hi : -1;  // -1：段尾在更后面
  let a = ls >= 0 ? Math.max(ls, lo) : lo;
  let b = le >= 0 ? Math.min(le, hi) : hi;
  const cutA = a > ls, cutB = le < 0 || b < le;
  if (cutA && /[\uDC00-\uDFFF]/.test(text[a] || "")) a++;
  if (cutB && /[\uD800-\uDBFF]/.test(text[b - 1] || "")) b++;
  let before = text.slice(a, from);
  before = cutA ? "…" + before : before.replace(/^[\s　]+/, "");
  const after = text.slice(to, b) + (cutB ? "…" : "");
  return { before, match: text.slice(from, to), after };
}

// ---------------- 章节筛选 ----------------
export const EMPTY_FILTER = { pointsOpen: false, wordsOn: false, maxWords: 2000 };

export function filterActive(f) { return !!f && (!!f.pointsOpen || (!!f.wordsOn && Number(f.maxWords) > 0)); }

/** 这一章符不符合筛选条件。words 是这一章当前的字数 */
export function chapterPasses(ch, f, words) {
  if (!filterActive(f)) return true;
  if (f.pointsOpen && !(ch.points || []).some((p) => !p.done)) return false;
  if (f.wordsOn && Number(f.maxWords) > 0 && !(words < Number(f.maxWords))) return false;
  return true;
}

/**
 * 查找范围里有哪些章（保持全书顺序）。
 * scope: "cur" 当前章 | "sel" 选中的几章 | "book" 全书 | "vol:<卷id>"（"vol:" 是未分卷）
 */
export function chaptersInScope(chapters, scope, { currentId = null, selectedIds = [], volumeIds = null } = {}) {
  if (scope === "cur") return chapters.filter((c) => c.id === currentId);
  if (scope === "sel") { const s = new Set(selectedIds); return chapters.filter((c) => s.has(c.id)); }
  if (scope && scope.startsWith("vol:")) {
    const v = scope.slice(4) || null;
    // 未分卷：没有卷的章，加上卷已经不在了的章（章节列表里也放在「未分卷」下面）
    const known = volumeIds ? new Set(volumeIds) : null;
    return chapters.filter((c) => { const cv = c.volumeId || null; return v ? cv === v : cv === null || (!!known && !known.has(cv)); });
  }
  return chapters.slice();
}

/** 条件的简短说明（存常用筛选时的默认名字） */
export function describe(cond) {
  const parts = [];
  if (cond.query) parts.push("「" + (cond.query.length > 10 ? cond.query.slice(0, 10) + "…" : cond.query) + "」");
  if (cond.filter && cond.filter.pointsOpen) parts.push("要点没打完");
  if (cond.filter && cond.filter.wordsOn && Number(cond.filter.maxWords) > 0) parts.push("少于 " + Number(cond.filter.maxWords) + " 字");
  return parts.join(" + ") || "筛选";
}

// ---------------- 改动后位置换算 ----------------
let dmp = null;
/**
 * 正文改了以后，旧位置对应到新位置（勾选状态、当前条跟着走）。
 * 改动很多的长章比对起来慢，最多比 0.15 秒，超时的那一段位置是估的。
 */
export function makeMapper(oldText, newText) {
  if (oldText === newText) return (p) => p;
  if (!dmp) { dmp = new DiffMatchPatch(); dmp.Diff_Timeout = 0.15; }
  const diffs = dmp.diff_main(oldText, newText);
  return (p) => dmp.diff_xIndex(diffs, p);
}

/**
 * 已经知道改了哪几段时的位置换算（替换、撤销替换用，准确又快）。
 * edits: [{ from, to, len }]，旧位置，互不重叠；落在被换掉那段里的位置对到新文字的开头。
 */
export function editMapper(edits) {
  const list = [...edits].sort((a, b) => a.from - b.from);
  const shift = [];
  let d = 0;
  for (const e of list) { shift.push(d); d += e.len - (e.to - e.from); }
  return (p) => {
    let lo = 0, hi = list.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].from <= p) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    if (k < 0) return p;
    const e = list[k];
    if (p < e.to) return e.from + shift[k];
    return p + shift[k] + e.len - (e.to - e.from);
  };
}

/** 反过来的改动（撤销替换时用）：新位置上的新文字换回原来的长度 */
export function invertEdits(edits) {
  let d = 0;
  return [...edits].sort((a, b) => a.from - b.from).map((e) => {
    const x = { from: e.from + d, to: e.from + d + e.len, len: e.to - e.from };
    d += e.len - (e.to - e.from);
    return x;
  });
}
