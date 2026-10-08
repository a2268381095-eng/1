// 历史版本的存法和合并规则（纯函数：不碰数据库和界面，node 里能直接测）。
//
// 一章的版本按时间排成一条链，每一行 { id, chapterId, ts, kind, data, words, len, note? }：
//   kind "full"  data 是全文
//   kind "patch" data 是相对上一版的改动：[保留 n 字, -删掉 n 字, "加上的字", …]（n 按 JS 字符串长度算）
// 每 20 版至少存一份全文，还原任何一版最多从全文往后套 19 个补丁。
// 合并规则：24 小时内的全留；一周内每小时留最后一份；更早的每天留最后一份。删掉中间版本后，补丁按新的前后关系重算。
import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 2;

export const FULL_EVERY = 20;
export const MIN_GAP = 60000;          // 同一章两次自动记录至少隔 1 分钟
export const HOUR = 3600000;
export const DAY = 86400000;

// ---------------- 补丁 ----------------
/** a → b 的改动 */
export function makeDelta(a, b) {
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupEfficiency(diffs);
  const ops = [];
  for (const [op, s] of diffs) {
    if (!s) continue;
    if (op === 0) ops.push(s.length);
    else if (op < 0) ops.push(-s.length);
    else ops.push(s);
  }
  return ops;
}

/** 把改动套到 base 上。和 base 对不上（数据坏了）就报错，不会悄悄还原出错的字 */
export function applyDelta(base, ops) {
  if (typeof base !== "string" || !Array.isArray(ops)) throw new Error("补丁格式不对");
  const out = [];
  let pos = 0;
  for (const op of ops) {
    if (typeof op === "string") out.push(op);
    else if (typeof op === "number" && op > 0) {
      if (pos + op > base.length) throw new Error("补丁和上一版对不上");
      out.push(base.slice(pos, pos + op));
      pos += op;
    } else if (typeof op === "number" && op < 0) {
      pos -= op;
      if (pos > base.length) throw new Error("补丁和上一版对不上");
    } else throw new Error("补丁格式不对");
  }
  if (pos !== base.length) throw new Error("补丁和上一版对不上");
  return out.join("");
}

/**
 * 新的一版怎么存。prevText 是上一版的全文（没有或读不出来时给 null），sinceFull 是上一版离最近的全文隔了几个补丁。
 * 返回 { kind, data }
 */
export function encode(prevText, text, sinceFull = 0) {
  if (prevText == null || sinceFull >= FULL_EVERY - 1) return { kind: "full", data: text };
  const ops = makeDelta(prevText, text);
  if (JSON.stringify(ops).length >= text.length) return { kind: "full", data: text };   // 改得太多，不如直接存全文
  return { kind: "patch", data: ops };
}

/** 还原一行：全文直接用，补丁套在上一版上；存了长度的顺便核对 */
export function decodeRow(row, prevText) {
  let text;
  if (row.kind === "full") {
    if (typeof row.data !== "string") throw new Error("全文格式不对");
    text = row.data;
  } else {
    if (prevText == null) throw new Error("前面的版本读不出来");
    text = applyDelta(prevText, row.data);
  }
  if (row.len != null && row.len !== text.length) throw new Error("还原出来的长度不对");
  return text;
}

/** 按时间排好（时间一样按 id） */
export function sortRows(rows) {
  return rows.slice().sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 第 i 版的全文（rows 已排好）。读不出来会报错 */
export function textAt(rows, i) {
  let f = i;
  while (f >= 0 && rows[f].kind !== "full") f--;
  if (f < 0) throw new Error("找不到全文");
  let text = rows[f].data;
  if (typeof text !== "string") throw new Error("全文格式不对");
  for (let j = f; j <= i; j++) text = decodeRow(rows[j], text);
  return text;
}

/** 链尾的状态：{ text, ts, sinceFull }；最后一版读不出来时 text 为 null（下一版就存全文） */
export function chainState(rows) {
  if (!rows.length) return null;
  const last = rows.length - 1;
  let f = last;
  while (f >= 0 && rows[f].kind !== "full") f--;
  let text = null;
  try { text = textAt(rows, last); } catch (_) { text = null; }
  return { text, ts: rows[last].ts, sinceFull: f < 0 ? FULL_EVERY : last - f };
}

// ---------------- 合并 ----------------
const pad = (n) => String(n).padStart(2, "0");
export function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function hourKey(ts) { return dayKey(ts) + " " + pad(new Date(ts).getHours()); }

/** 这一版归哪个桶：24 小时内不归桶（全留），一周内按小时，更早按天 */
export function bucketOf(ts, now) {
  const age = now - ts;
  if (age < DAY) return null;
  if (age < 7 * DAY) return "h" + hourKey(ts);
  return "d" + dayKey(ts);
}

/** 哪些留下：每个桶留时间最晚的那份。rows 已排好，返回和 rows 对应的 true/false */
export function planKeep(rows, now) {
  const keep = new Array(rows.length).fill(false);
  const seen = new Set();
  for (let i = rows.length - 1; i >= 0; i--) {
    const b = bucketOf(rows[i].ts, now);
    if (b == null) keep[i] = true;
    else if (!seen.has(b)) { seen.add(b); keep[i] = true; }
  }
  return keep;
}

/**
 * 合并一章的版本。rows 已排好。返回 { puts, dels }：要改写的行和要删掉的 id；没什么可删返回 null。
 * 链上有读不出来的版本时报错（交给调用方跳过这一章，不在坏数据上再动手）。
 */
export function compactChain(rows, now) {
  const keep = planKeep(rows, now);
  if (keep.every(Boolean)) return null;
  const puts = [], dels = [];
  let cur = null, prevKept = null, prevKeptIdx = -1, sinceFull = 0;
  rows.forEach((row, i) => {
    const text = decodeRow(row, cur);
    cur = text;
    if (!keep[i]) { dels.push(row.id); return; }
    if (row.kind === "full") sinceFull = 0;
    else if (prevKeptIdx === i - 1 && prevKept != null && sinceFull < FULL_EVERY - 1) sinceFull++;   // 前一版还在，补丁不用动
    else {
      const enc = encode(prevKept, text, sinceFull);
      puts.push({ ...row, kind: enc.kind, data: enc.data, len: text.length });
      sinceFull = enc.kind === "full" ? 0 : sinceFull + 1;
    }
    prevKept = text;
    prevKeptIdx = i;
  });
  return { puts, dels };
}

// ---------------- 对比 ----------------
function splitLines(s) { return s.match(/[^\n]*\n|[^\n]+$/g) || []; }

/**
 * 左右对比用：按段对齐。返回行的列表：
 *   { same: true, text }               两边一样的一段（带结尾的换行）
 *   { same: false, l: parts, r: parts } 改过的一块；parts = [{ t: 0 一样 | -1 只在左边 | 1 只在右边, s }]
 */
export function alignRows(a, b) {
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  const rows = [];
  let A = "", B = "";
  const flush = () => {
    if (!A && !B) return;
    const d = dmp.diff_main(A, B);
    dmp.diff_cleanupSemantic(d);
    const l = [], r = [];
    for (const [op, s] of d) {
      if (!s) continue;
      if (op <= 0) l.push({ t: op, s });
      if (op >= 0) r.push({ t: op, s });
    }
    rows.push({ same: false, l, r });
    A = B = "";
  };
  for (const [op, s] of diffs) {
    if (op === 0) { flush(); for (const line of splitLines(s)) rows.push({ same: true, text: line }); }
    else if (op < 0) A += s;
    else B += s;
  }
  flush();
  return rows;
}

/** 只看改动处：改动前后各留 ctx 段，中间没改的折起来。返回 [{ row } | { fold: [rows] }] */
export function foldRows(rows, ctx = 1) {
  const near = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.same) return;
    for (let j = Math.max(0, i - ctx); j <= Math.min(rows.length - 1, i + ctx); j++) near[j] = true;
  });
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) out.push({ row: run[0] });   // 只折一段不划算，直接显示
    else out.push({ fold: run });
    run = [];
  };
  rows.forEach((r, i) => {
    if (near[i]) { flush(); out.push({ row: r }); }
    else run.push(r);
  });
  flush();
  return out;
}

// ---------------- 显示 ----------------
export const hm = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const WEEK = "日一二三四五六";

/** 按天分组的标题：今天 / 昨天 / 10月6日 周一 / 2025年3月2日 */
export function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts), n = new Date(now);
  if (dayKey(ts) === dayKey(now)) return "今天";
  const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (dayKey(ts) === dayKey(y.getTime())) return "昨天";
  const md = (d.getMonth() + 1) + "月" + d.getDate() + "日";
  return d.getFullYear() === n.getFullYear() ? md + " 周" + WEEK[d.getDay()] : d.getFullYear() + "年" + md;
}

/** 列表里的一版说成「今天 14:32」「10月6日 14:32」 */
export function whenLabel(ts, now = Date.now()) {
  const day = dayLabel(ts, now).replace(/ 周.$/, "");
  return day + " " + hm(ts);
}
