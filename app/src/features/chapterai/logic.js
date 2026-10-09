// 不碰界面的小工具：把 AI 的回复拆成章名候选、拼简介要发的内容。测试和界面都用这里。

const NUM = /^(?:[(（[【]?\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[)）\]】.．、:：]|[①-⑳]|[-*•·+>]+|#+)\s*/;
const CH = /^第\s*[0-9０-９一二三四五六七八九十百千零〇两]+\s*[章回节卷幕话]\s*[:：·.．、\-—\s]*/;
const OPEN = "「『“\"《〈'‘【[";
const CLOSE = "」』”\"》〉'’】]";
const QUOTED = /^[「『“"《〈【]([^」』”"》〉】]{1,40})[」』”"》〉】]/;

/** 一行里的说明文字：「雨夜来客：这一章写……」只留冒号、破折号前面的章名（后面短的当章名的一部分，比如「终章：重逢」） */
function dropNote(s) {
  const m = s.match(/^(.{1,24}?)\s*(?:[:：]|——|--|\s-\s|\s—\s)\s*(.+)$/);
  if (m && [...m[2]].length > 12) return m[1];
  return s;
}

function strip(s) {
  let t = s.replace(/[\s　]+/g, " ").replace(/\*\*|__|`/g, "").trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(NUM, "").replace(CH, "").trim();
    if (t === before) break;
  }
  const q = t.match(QUOTED);
  if (q) t = q[1];
  else t = dropNote(t);
  while (t && OPEN.includes(t[0])) t = t.slice(1);
  while (t && CLOSE.includes(t[t.length - 1])) t = t.slice(0, -1);
  t = t.replace(CH, "").replace(/[。．.，,、;；]+$/, "").trim();
  return t;
}

/**
 * 把模型回的一段文字拆成章名候选：按行拆，去掉序号、引号、「第X章」前缀、句末的句号和小标题。
 * partial：还在流式输出时，最后一行可能没写完，先不算。
 */
export function parseNames(text, { partial = false, max = 12 } = {}) {
  let lines = String(text || "").split(/\r?\n/);
  if (partial) lines = lines.slice(0, -1);
  const all = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const t = strip(raw);
    if (!t) continue;
    if (/[:：]$/.test(raw.trim()) && !QUOTED.test(raw.trim())) continue;   // 「候选章名：」这类小标题
    if (all.includes(t)) continue;
    all.push(t);
  }
  // 有短的就不要长的（长的多半是解释）；全是长的就截到章名的上限
  const short = all.filter((t) => [...t].length <= 30);
  const list = short.length ? short : all.map((t) => [...t].slice(0, 60).join(""));
  return list.slice(0, max);
}

/** 正文开头多少字 */
export const HEAD = 1500;
export const head = (text, n = HEAD) => [...String(text || "").trim()].slice(0, n).join("");

/**
 * 简介要发的内容：每章优先用摘要，没有摘要的用正文开头 1500 字，都没有的跳过。
 * chapters: [{ id, label, summary, text }]（按书里的顺序）
 * 返回 { input, used: [{ id, label, mode: "summary"|"head"|"empty" }], nSummary, nHead, nEmpty, chars }
 */
export function introSource(chapters) {
  const parts = [], used = [];
  let nSummary = 0, nHead = 0, nEmpty = 0;
  for (const c of chapters) {
    const sum = String(c.summary || "").trim();
    const body = String(c.text || "").trim();
    if (sum) { nSummary++; used.push({ id: c.id, label: c.label, mode: "summary" }); parts.push(`【${c.label}】（章节摘要）\n${sum}`); }
    else if (body) { nHead++; used.push({ id: c.id, label: c.label, mode: "head" }); parts.push(`【${c.label}】（正文开头）\n${head(body)}`); }
    else { nEmpty++; used.push({ id: c.id, label: c.label, mode: "empty" }); }
  }
  const input = parts.join("\n\n");
  return { input, used, nSummary, nHead, nEmpty, chars: [...input].length };
}

/** 确认卡里「发送的文字」那一行的说明 */
export function introLabel(src) {
  const bits = [];
  if (src.nSummary) bits.push(`${src.nSummary} 章用摘要`);
  if (src.nHead) bits.push(`${src.nHead} 章用正文开头 ${HEAD} 字`);
  return `${src.nSummary + src.nHead} 章的内容（${bits.join("，")}${src.nEmpty ? `，${src.nEmpty} 章是空的没发` : ""}）`;
}
