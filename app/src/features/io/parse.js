// 导入导出用的纯函数：认编码、认章名、拆章、拼导出的文字、备份文件的读写。
// 不碰界面和数据库，node 里能直接测（tests/io.test.cjs）。
import { countWords, chapterLabel, volumeLabel } from "../../core/text.js";

// ---------------- 编码 ----------------
export const ENCODINGS = [
  { id: "utf-8", name: "UTF-8" },
  { id: "gb18030", name: "GBK / GB18030" },
  { id: "utf-16le", name: "UTF-16 LE" },
  { id: "utf-16be", name: "UTF-16 BE" },
  { id: "big5", name: "Big5（繁体）" },
];
export const encodingName = (id) => (ENCODINGS.find((e) => e.id === id) || { name: id }).name;

// 最常用的一些汉字（简体和繁体）。解码对了，正文里这些字占的比例很高；解错了就很低。
const COMMON = new Set(Array.from(
  "的一是了不在有人这我他们来到上个大说中你就也时出要会那地着里没以过看为她和下子可都还去后能好心自想把得么天对起生道然什知年家多小样只事" +
  "儿发作开面所手声前经头己点无于方又现见间当之种如今日成两已长回真再给眼让很别女走身老其气定些话问因行此学情明进将公动外军吗呢吧啊" +
  "這們來個說時會裡沒過為還後麼對樣發開聲經頭點現見間當種兩長給讓別氣話問進將動軍嗎",
));

/** 一段文字像不像正常的中文：han 汉字数，common 常用字在汉字里的占比，bad 坏字符（替换符、控制符、私用区）的占比 */
export function textQuality(text) {
  let han = 0, common = 0, bad = 0, total = 0;
  const n = Math.min(text.length, 300000);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) continue;
    total++;
    if (c >= 0x4e00 && c <= 0x9fff) { han++; if (COMMON.has(text[i])) common++; }
    else if (c === 0xfffd || (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0xe000 && c <= 0xf8ff)) bad++;
  }
  return { han, common: han ? common / han : 0, bad: total ? bad / total : 0 };
}

/** 看起来是不是乱码 */
export function looksGarbled(text) {
  const q = typeof text === "string" ? textQuality(text) : text;
  if (q.bad > 0.01) return true;
  return q.han >= 30 && q.common < 0.12;
}

export function decodeAs(bytes, enc) {
  return new TextDecoder(enc).decode(bytes);
}

/** 没有 BOM 的 UTF-16：每两个字节里高位那个几乎都是 0（英文）、0x4E–0x9F（汉字）或标点区 */
function utf16Guess(b) {
  if (b.length < 4 || b.length % 2) return null;
  const n = Math.min(b.length, 200000) & ~1;
  const ok = (x) => x === 0 || x === 0x20 || x === 0x30 || x === 0xff || (x >= 0x4e && x <= 0x9f);
  let le = 0, be = 0;
  for (let i = 0; i < n; i += 2) { if (ok(b[i + 1])) le++; if (ok(b[i])) be++; }
  const half = n / 2;
  const pick = le >= be ? "utf-16le" : "utf-16be";
  if (Math.max(le, be) / half < 0.9) return null;
  return looksGarbled(decodeAs(b.subarray(0, n), pick)) ? null : pick;
}

/**
 * 认编码：BOM → UTF-8 → UTF-16（没有 BOM）→ GBK / Big5 / 坏了几个字的 UTF-8 里挑最像中文的。
 * 返回 { encoding, bom }
 */
export function detectEncoding(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { encoding: "utf-8", bom: true };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { encoding: "utf-16le", bom: true };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { encoding: "utf-16be", bom: true };
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return { encoding: "utf-8", bom: false }; } catch (_) { /* 不是 UTF-8 */ }
  const u16 = utf16Guess(b);
  if (u16) return { encoding: u16, bom: false };
  const sample = b.subarray(0, 400000);
  let best = null;
  for (const enc of ["gb18030", "big5", "utf-8"]) {
    let q;
    try { q = textQuality(decodeAs(sample, enc)); } catch (_) { continue; }
    const score = q.common - q.bad * 5;
    if (!best || score > best.score) best = { encoding: enc, score };
  }
  return { encoding: best ? best.encoding : "gb18030", bom: false };
}

// ---------------- 章节号 ----------------
const DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9 };
const UNIT = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };

/** 一、十二、一百零五、两千、1、１２、一二三 → 数字；认不出来返回 NaN */
export function parseCnNumber(s) {
  s = String(s || "").trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const cs = Array.from(s);
  if (cs.every((c) => c in DIGIT)) return parseInt(cs.map((c) => DIGIT[c]).join(""), 10);
  let total = 0, section = 0, num = 0;
  for (const c of cs) {
    if (c in DIGIT) num = DIGIT[c];
    else if (c in UNIT) { section += (num || 1) * UNIT[c]; num = 0; }
    else if (c === "万") { total += (section + num || 1) * 10000; section = 0; num = 0; }
    else return NaN;
  }
  return total + section + num;
}

// ---------------- 认章名 ----------------
const NUM = "[0-9０-９零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]{1,12}";
const HEAD_RE = new RegExp(`^(?:正文\\s*)?第\\s*(${NUM})\\s*([章回节卷])(.*)$`, "u");
const SEP_RE = /^[\s:：、.．,，·•\-—–_|｜~～]+/u;
const SPECIAL_RE = /^(序章|序言|楔子|引子|前言|尾声|后记|终章|番外|序)(.*)$/u;
// 「第一回合」「第二节课」这类：单位后面直接跟着这些字，多半是正文
const ATTACH_BAD = { 回: "合来去到答头家事复忆想应声味首报", 节: "课目日奏省约点气制选", 章: "程法" };
const MAX_LINE = 50;

/** 章节标题的种类，界面里显示用 */
export const UNITS = [
  { id: "章", name: "第X章" },
  { id: "回", name: "第X回" },
  { id: "节", name: "第X节" },
  { id: "卷", name: "第X卷（建分卷）" },
  { id: "special", name: "楔子、尾声、番外" },
];

/**
 * 一行是不是章名 / 卷名。md 时先去掉开头的 #。
 * 返回 { type: "chapter"|"volume", unit, num, title, raw } 或 null。title 已经去掉「第X章」。
 */
export function matchHeading(line, { md = false } = {}) {
  let s = String(line).trim();
  if (md) s = s.replace(/^#{1,6}\s+/, "").replace(/\s+#+$/, "").trim();
  if (!s || s.length > MAX_LINE) return null;
  let m = s.match(HEAD_RE);
  if (m) {
    const rest = m[3];
    let title = "";
    if (rest.trim()) {
      const sep = rest.match(SEP_RE);
      if (sep) {
        title = rest.slice(sep[0].length).trim();
        if (title.length > 40) return null;
      } else {
        title = rest.trim();
        if (title.length > 20 || /[，。,；;]/.test(title)) return null;
        if ((ATTACH_BAD[m[2]] || "").includes(title[0])) return null;
      }
    }
    const num = parseCnNumber(m[1]);
    if (!(num >= 0)) return null;
    return { type: m[2] === "卷" ? "volume" : "chapter", unit: m[2], num, title, raw: String(line).trim() };
  }
  m = s.match(SPECIAL_RE);
  if (m) {
    const word = m[1], rest = m[2];
    const sep = rest.match(SEP_RE);
    let title;
    if (!rest) title = word;
    else if (sep) {
      const t = rest.slice(sep[0].length).trim();
      if (t.length > 30 || /[，。,；;]/.test(t)) return null;
      title = t ? word + " " + t : word;
    } else if (word === "番外" && rest.length <= 24 && !/[，。,；;]/.test(rest)) title = word + rest.trim();
    else return null;
    return { type: "chapter", unit: "special", num: null, title, raw: String(line).trim() };
  }
  return null;
}

/** markdown 的 # 标题（指定级别） */
export function matchMdHeading(line, level) {
  if (!level) return null;
  const m = String(line).match(new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`));
  if (!m) return null;
  return { type: "chapter", unit: "md", num: null, title: m[1].trim().slice(0, 60), raw: String(line).trim() };
}

export const normalizeNewlines = (text) => String(text == null ? "" : text).replace(/\r\n?|\u2028|\u2029/g, "\n");

/** 去掉首尾的空行（第一行的缩进留着） */
export function trimBlank(s) {
  return String(s).replace(/^(?:[ \t\u3000]*\n)+/, "").replace(/(?:\n[ \t\u3000]*)+$/, "").replace(/^[ \t\u3000]+$/, "");
}

/** md 开头的 --- 元信息 --- 去掉 */
export function stripFrontMatter(text) {
  const m = text.match(/^---\n[\s\S]{0,4000}?\n---\n/);
  return m ? text.slice(m[0].length) : text;
}

/** 数一数每种标题各有几处。md 另外数各级 # 标题。 */
export function scanHeadings(text, { md = false } = {}) {
  const counts = { 章: 0, 回: 0, 节: 0, 卷: 0, special: 0, md: {} };
  for (const line of normalizeNewlines(text).split("\n")) {
    const hd = matchHeading(line, { md });
    if (hd) counts[hd.unit]++;
    if (md) {
      const m = line.match(/^(#{1,6})\s+\S/);
      if (m) counts.md[m[1].length] = (counts.md[m[1].length] || 0) + 1;
    }
  }
  return counts;
}

/**
 * 默认按哪几种标题拆：章 > 回 > 节 只取一种（有「章」时「节」多半是章里的小节），卷和楔子这类都认。
 * 一个「第X」都没有的 md 文件，用数量最多的那一级 # 标题。返回 { units, mdLevel }
 */
export function defaultUnits(counts, { volumes = true } = {}) {
  const units = [];
  const main = ["章", "回", "节"].find((k) => counts[k] > 0);
  if (main) units.push(main);
  if (counts["卷"] && volumes) units.push("卷");
  if (counts.special) units.push("special");
  let mdLevel = 0;
  if (!main && counts.md) {
    let best = 0;
    for (const [lv, n] of Object.entries(counts.md)) {
      const use = +lv === 1 && n === 1 ? 0 : n;    // 只有一个一级标题，多半是书名
      if (use > best) { best = use; mdLevel = +lv; }
    }
    if (best < 2) mdLevel = 0;
  }
  return { units, mdLevel };
}

/**
 * 按章名拆开。units：认哪几种（"章" "回" "节" "卷" "special"）；md：markdown；mdLevel：再按这一级 # 标题拆。
 * 返回 { preface, items: [{ type, unit, num, title, raw, content }] }。preface 是第一个章名前面的文字。
 * 卷名后面紧跟的文字（卷首语）单独成一章，章名空着。
 */
export function splitText(text, { units = ["章", "回", "节", "卷", "special"], md = false, mdLevel = 0 } = {}) {
  let src = normalizeNewlines(text);
  if (md) src = stripFrontMatter(src);
  const want = new Set(units);
  const items = [];
  let preface = "", buf = [], cur = null;
  const flush = () => {
    const content = trimBlank(buf.join("\n"));
    buf = [];
    if (!cur) { preface = content; return; }
    if (cur.type === "volume") {
      items.push({ ...cur, content: "" });
      if (content.trim()) items.push({ type: "chapter", unit: "intro", num: null, title: "", raw: "", content });
    } else items.push({ ...cur, content });
  };
  for (const line of src.split("\n")) {
    let hd = matchHeading(line, { md });
    if (hd && !want.has(hd.unit)) hd = null;
    if (!hd && md && mdLevel) hd = matchMdHeading(line, mdLevel);
    if (hd) { flush(); cur = hd; } else buf.push(line);
  }
  flush();
  return { preface, items };
}

/** 把第 i 项并到上一章：它的标题行放回正文。上一项是卷名时不能并。 */
export function mergeUp(items, i) {
  if (i <= 0 || i >= items.length) return items;
  const prev = items[i - 1], it = items[i];
  if (prev.type !== "chapter") return items;
  const content = [prev.content, it.raw, it.content].filter((s) => s && s.trim()).join("\n");
  const out = items.slice();
  out.splice(i - 1, 2, { ...prev, content });
  return out;
}

export const canMergeUp = (items, i) => i > 0 && i < items.length && items[i - 1].type === "chapter";

/**
 * 章节号不连续的地方：每种标题各自数，换卷后从 1 重新数也算对。
 * 返回 [{ index, prev, num }]
 */
export function numberGaps(items) {
  const last = {};
  let newVol = false;
  const out = [];
  items.forEach((it, i) => {
    if (it.type === "volume") { newVol = true; return; }
    if (it.num == null || !["章", "回", "节"].includes(it.unit)) return;
    const prev = last[it.unit];
    if (prev != null && it.num !== prev + 1 && !(newVol && it.num === 1)) out.push({ index: i, prev, num: it.num });
    last[it.unit] = it.num;
    newVol = false;
  });
  return out;
}

/**
 * 拼成要建的卷和章。prefaceMode：own 单独一章 / merge 并入第一章 / drop 不导入。
 * 返回 { volumes: [{ title }], chapters: [{ title, content, vol }] }，vol 是 volumes 里的下标或 null。
 * leadIntoFirst：第一卷前面的章（比如楔子）算进第一卷，免得在章节列表里跑到「未分卷」去（新建作品时用；追加时这些章跟着原书最后一卷）。
 */
export function assemble({ preface = "", items = [] }, { prefaceMode = "own", prefaceTitle = "楔子", leadIntoFirst = true } = {}) {
  const volumes = [], chapters = [];
  let vol = null;
  for (const it of items) {
    if (it.type === "volume") { vol = volumes.length; volumes.push({ title: it.title || "" }); continue; }
    chapters.push({ title: it.title || "", content: it.content || "", vol });
  }
  const pre = preface && preface.trim() ? preface : "";
  if (pre) {
    if (!chapters.length) chapters.push({ title: "", content: pre, vol: null });
    else if (prefaceMode === "own") chapters.unshift({ title: prefaceTitle || "", content: pre, vol: null });
    else if (prefaceMode === "merge") chapters[0] = { ...chapters[0], content: [pre, chapters[0].content].filter(Boolean).join("\n") };
  }
  if (volumes.length && leadIntoFirst) chapters.forEach((c) => { if (c.vol == null) c.vol = 0; });
  if (!chapters.length) chapters.push({ title: "", content: "", vol: volumes.length ? volumes.length - 1 : null });
  return { volumes, chapters };
}

// ---------------- 导出 ----------------
/**
 * 要导出的几章 → exportText 用的 parts。章节号按整本书里的位置算（第几章就是第几章），分卷的书在换卷处加卷名。
 * book { numbering, useVolumes, volumes }；chapters 整本书的章（按顺序）；ids 要导出的章
 */
export function exportParts(book, chapters, ids) {
  const want = new Set(ids);
  const vols = book.useVolumes ? book.volumes || [] : [];
  const parts = [];
  let lastVol;
  chapters.forEach((c, i) => {
    if (!want.has(c.id)) return;
    if (vols.length) {
      const vi = vols.findIndex((v) => v.id === c.volumeId);
      const vid = vi >= 0 ? vols[vi].id : null;
      if (vid !== lastVol) {
        lastVol = vid;
        if (vi >= 0) parts.push({ type: "volume", label: volumeLabel(vi + 1, book.numbering), title: vols[vi].title || "" });
      }
    }
    parts.push({ type: "chapter", label: chapterLabel(i + 1, book.numbering), title: c.title || "", content: c.content || "" });
  });
  return parts;
}

/** md 里会被当成格式的行首记号，前面加 \ */
function mdLine(l) {
  return l.replace(/^(\s{0,3})([#>+\-*=])(?=\s|$)/, "$1\\$2").replace(/^(\s{0,3}\d+)([.)])(?=\s|$)/, "$1\\$2");
}
function mdParas(text) {
  return text.split("\n").filter((l) => l.trim()).map(mdLine).join("\n\n");
}

/**
 * 拼导出的文字。
 * parts: [{ type: "volume", label, title } | { type: "chapter", label, title, content }]
 * opts.fmt txt / md；opts.book { title, intro }；opts.header 开头写书名和简介；opts.transform(text) 排版正文
 */
export function exportText(parts, { fmt = "txt", book = null, header = false, transform = null } = {}) {
  const out = [];
  const md = fmt === "md";
  const hasVol = parts.some((p) => p.type === "volume");
  const head = (p) => [p.label, p.title].filter(Boolean).join(" ");
  if (header && book) {
    out.push(md ? "# " + book.title : book.title, "");
    const intro = trimBlank(normalizeNewlines(book.intro || ""));
    if (intro.trim()) out.push(md ? mdParas(intro) : intro, "");
  }
  for (const p of parts) {
    if (p.type === "volume") { out.push(md ? "## " + head(p) : head(p), ""); continue; }
    let body = normalizeNewlines(p.content || "");
    if (transform) body = transform(body);
    body = trimBlank(body);
    out.push(md ? (hasVol ? "### " : "## ") + head(p) : head(p), "");
    if (body.trim()) out.push(md ? mdParas(body) : body, "");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/** 文件名里不能有的字去掉 */
export function safeFileName(name, fallback = "未命名") {
  const s = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^\.+/, "").slice(0, 80).trim();
  return s || fallback;
}

/** 去掉扩展名：风起.txt → 风起，备份.xemo.json → 备份 */
export function baseName(fileName) {
  return String(fileName || "").replace(/\.xemo\.json$/i, "").replace(/\.[^.\\/]{1,10}$/, "").trim();
}

export function extOf(fileName) {
  const n = String(fileName || "").toLowerCase();
  if (n.endsWith(".xemo.json")) return "xemo";
  const m = n.match(/\.([a-z0-9]{1,10})$/);
  return m ? m[1] : "";
}

// ---------------- 整本备份 ----------------
export const BACKUP_APP = "xiaoemo-wenshu";
export const BACKUP_VERSION = 1;

/** list: [{ book, chapters, stats }] → 备份文件内容（对象） */
export function makeBackup(list, at = Date.now()) {
  return {
    app: BACKUP_APP, type: "backup", version: BACKUP_VERSION, exportedAt: at,
    books: list.map(({ book, chapters, stats }) => ({
      book, chapters: [...chapters].sort((a, b) => a.order - b.order), stats: stats || {},
    })),
  };
}

function normalizeBook(entry) {
  if (!entry || typeof entry !== "object" || !entry.book || typeof entry.book !== "object") return null;
  const b = entry.book;
  if (typeof b.id !== "string" || !b.id) return null;
  const volumes = Array.isArray(b.volumes) ? b.volumes.filter((v) => v && typeof v.id === "string").map((v) => ({ id: v.id, title: String(v.title || "") })) : [];
  const volIds = new Set(volumes.map((v) => v.id));
  const seen = new Set();
  const raw = (Array.isArray(entry.chapters) ? entry.chapters : [])
    .filter((c) => c && typeof c === "object" && typeof c.id === "string" && c.id && !seen.has(c.id) && seen.add(c.id));
  raw.sort((x, y) => (Number(x.order) || 0) - (Number(y.order) || 0));
  const chapters = raw.map((c, i) => {
    const content = typeof c.content === "string" ? normalizeNewlines(c.content) : "";
    const points = (Array.isArray(c.points) ? c.points : []).filter((p) => p && typeof p.text === "string")
      .map((p, k) => ({ ...p, id: p.id ? String(p.id) : `p${i}_${k}`, text: p.text, done: !!p.done }));
    return { ...c, bookId: b.id, order: i + 1, title: String(c.title || ""), content, words: countWords(content), points,
      volumeId: volIds.has(c.volumeId) ? c.volumeId : null };
  });
  const ids = new Set(chapters.map((c) => c.id));
  const book = {
    ...b, title: String(b.title || "未命名作品").slice(0, 200), intro: String(b.intro || ""),
    tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
    cover: typeof b.cover === "string" && /^data:image\//.test(b.cover) ? b.cover : "",
    volumes, useVolumes: !!b.useVolumes && volumes.length > 0,
    lastChapterId: ids.has(b.lastChapterId) ? b.lastChapterId : null,
  };
  const stats = {};
  if (entry.stats && typeof entry.stats === "object") {
    for (const [k, v] of Object.entries(entry.stats)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Number(v))) stats[k] = Number(v);
  }
  return { book, chapters, stats };
}

/**
 * 读备份文件。成功 { ok: true, books: [{ book, chapters, stats }], exportedAt }；
 * 失败 { ok: false, reason: "notjson" | "notbackup" | "newer" | "empty" }
 */
export function parseBackup(text) {
  let data;
  try { data = JSON.parse(String(text).replace(/^\uFEFF/, "")); } catch (e) { return { ok: false, reason: "notjson", error: e }; }
  if (!data || data.app !== BACKUP_APP || !Array.isArray(data.books)) return { ok: false, reason: "notbackup" };
  if (Number(data.version) > BACKUP_VERSION) return { ok: false, reason: "newer", version: data.version };
  const books = data.books.map(normalizeBook).filter(Boolean);
  if (!books.length) return { ok: false, reason: "empty" };
  return { ok: true, books, exportedAt: Number(data.exportedAt) || 0 };
}

/** 另存为一本新书：作品和章节都换新 id（makeId(prefix) 生成），章节之间的关系不变 */
export function withNewIds({ book, chapters, stats }, makeId) {
  const bid = makeId("b");
  const map = new Map(chapters.map((c) => [c.id, makeId("c")]));
  return {
    book: { ...book, id: bid, lastChapterId: map.get(book.lastChapterId) || null },
    chapters: chapters.map((c) => ({ ...c, id: map.get(c.id), bookId: bid })),
    stats: { ...(stats || {}) },
  };
}

export const totalWords = (chapters) => chapters.reduce((s, c) => s + (c.words != null ? c.words : countWords(c.content || "")), 0);
