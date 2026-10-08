// 一键排版的规则引擎（纯函数，不碰界面）。导出时的「网文平台排版」也用这里。
//   RULES          规则清单 [{ id, name, desc, default: bool, optional: bool }]
//   DEFAULT_RULES  { [ruleId]: bool, paraGap: 0|1 }
//   formatText(text, rules) → 排版后的文字（只动空白和标点，不改文字；对同一段文字再排一次结果不变）
//   getSchemes() / saveScheme(name, rules) / deleteScheme(name)   排版方案（存在 kv "format:schemes"）
//
// 判断「挨着中文」时，左边看已经排好的部分，右边只看汉字、字母、数字（这几样永远不会被改），
// 所以排第二遍时每一处的判断和第一遍一样，结果不变。
import { db } from "../../core/db.js";

export const RULES = [
  { id: "indent", name: "段首空两格", desc: "每段开头统一成两个全角空格", default: true, optional: false },
  { id: "gap", name: "统一段间空行", desc: "段与段之间统一成不空行或空一行", default: true, optional: false },
  { id: "trimEnd", name: "去掉行尾空格", desc: "删掉每行末尾多出来的空格", default: true, optional: false },
  { id: "punct", name: "半角标点改全角", desc: "只改挨着中文的，3.14、网址、英文句子不动", default: true, optional: false },
  { id: "quotes", name: "统一引号", desc: "直引号成对改成“”‘’，「」『』也改", default: true, optional: false },
  { id: "ellipsis", name: "统一省略号", desc: "...、。。。、单个…都改成……", default: true, optional: false },
  { id: "dash", name: "统一破折号", desc: "--、—、── 都改成——", default: true, optional: false },
  { id: "mergeLines", name: "合并断行", desc: "导入的 txt 被硬回车断开的句子接回一段", default: false, optional: true },
  { id: "cjkSpace", name: "中英文之间加空格", desc: "中文和英文、数字之间加一个空格", default: false, optional: true },
];

export const DEFAULT_RULES = { ...Object.fromEntries(RULES.map((r) => [r.id, r.default])), paraGap: 0 };

/** 补齐缺的规则、把值整理成 true/false 和 0/1 */
export function normalizeRules(rules) {
  const r = { ...DEFAULT_RULES };
  if (rules && typeof rules === "object") {
    for (const k of Object.keys(DEFAULT_RULES)) if (k in rules) r[k] = k === "paraGap" ? (Number(rules[k]) ? 1 : 0) : !!rules[k];
  }
  return r;
}

export function sameRules(a, b) {
  const x = normalizeRules(a), y = normalizeRules(b);
  return Object.keys(DEFAULT_RULES).every((k) => x[k] === y[k]);
}

// ---------------- 字符分类 ----------------
const INDENT = "　　";
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
const HAN_RE = new RegExp(`[${CJK}]`, "u");
const WS_RE = /\s/u;
const FW = new Set(Array.from("，。、；：？！…⋯—―“”‘’（）《》〈〉【】「」『』〔〕．"));
const HALF = { ",": "，", "!": "！", "?": "？", ";": "；", ":": "：" };
const DQ = new Set(Array.from("\"＂“”「」"));
const SQ = new Set(Array.from("'＇‘’『』"));
// 合并断行：上一行以这些结尾就算一句说完了；下一行以这些开头就算新的一段（引号、括号、破折号、省略号开头）
const TERMINAL = new Set(Array.from("。．.！!？?…⋯：:\"'＂＇“”‘’「」『』)）】》〉—―─━-－~～·"));
const START_BREAK = new Set(Array.from("\"'＂＇“”‘’「」『』(（【《〈[—―─━-－…⋯.。．·"));
const HEADING = /^\s*(?:第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章节卷回集部篇幕]|序章|楔子|引子|尾声|后记|番外)/u;
const SCENE = /^[\s*＊=＝~～#＃\-－—―─━·•☆★◆◇○●※+＋_]+$/u;
const SP1 = new RegExp(`(?<=[${CJK}])[ \\t]*(?=[A-Za-z0-9])`, "gu");
const SP2 = new RegExp(`(?<=[A-Za-z0-9])[ \\t]*(?=[${CJK}])`, "gu");

const isWs = (c) => !!c && WS_RE.test(c);
const isHan = (c) => !!c && HAN_RE.test(c);
const isCN = (c) => isHan(c) || FW.has(c);
const isAlnum = (c) => !!c && /^[A-Za-z0-9]$/.test(c);
const isBlank = (l) => !/\S/u.test(l);
const DOTS = new Set(Array.from(".．。…⋯·"));
/** out（字符数组）是不是以 s 结尾：两段省略号、破折号之间的空格去掉后合成一个 */
const endsWith = (out, s) => out.length >= s.length && out.slice(-s.length).join("") === s;

/** 分隔线：***、——————、＝＝＝ 这类整行都是符号的，不动 */
function isSceneBreak(s) {
  return SCENE.test(s) && s.replace(/\s/gu, "").length >= 3;
}

// ---------------- 合并断行 ----------------
function lastChar(s) { const a = Array.from(s.replace(/\s+$/u, "")); return a[a.length - 1] || ""; }
function firstChar(s) { for (const c of s) return c; return ""; }

/** 两行能不能接成一段：上一行没说完、下一行没缩进也不像新的一段 */
function canMerge(a, b) {
  if (isBlank(a) || isBlank(b) || isWs(firstChar(b))) return false;
  if (TERMINAL.has(lastChar(a)) || START_BREAK.has(firstChar(b))) return false;
  if (HEADING.test(a) || HEADING.test(b)) return false;
  if (isSceneBreak(a.trim()) || isSceneBreak(b.trim())) return false;
  return true;
}

function mergeBroken(lines) {
  const out = [];
  for (const line of lines) {
    const k = out.length - 1;
    if (k >= 0 && canMerge(out[k], line)) {
      const a = out[k].replace(/\s+$/u, "");
      const glue = /[A-Za-z0-9,;]$/.test(a) && /^[A-Za-z0-9(]/.test(line) ? " " : "";
      out[k] = a + glue + line;
    } else out.push(line);
  }
  return out;
}

// ---------------- 标点 ----------------
function fixPunct(body, r) {
  const cs = Array.from(body);
  const n = cs.length;
  const out = [];
  const lastOut = () => { for (let k = out.length - 1; k >= 0; k--) if (!isWs(out[k])) return out[k]; return ""; };
  const nextFrom = (j) => { while (j < n && isWs(cs[j])) j++; return j < n ? cs[j] : ""; };

  // 半角括号配对：括号里有汉字才改成全角，f(x) 这种不动
  const pairConv = new Map();
  if (r.punct) {
    const st = [];
    for (let k = 0; k < n; k++) {
      if (cs[k] === "(") st.push(k);
      else if (cs[k] === ")" && st.length) {
        const o = st.pop();
        let han = false;
        for (let m = o + 1; m < k && !han; m++) han = isHan(cs[m]);
        pairConv.set(o, han);
        pairConv.set(k, han);
      }
    }
  }

  // 全角标点前后夹着中文的半角空格去掉；collapse：两段省略号、破折号挨在一起时合成一个
  const put = (s, fw, collapse = false) => {
    if (fw && r.punct) {
      let k = out.length;
      while (k > 0 && (out[k - 1] === " " || out[k - 1] === "\t")) k--;
      if (k < out.length && k > 0 && isCN(out[k - 1])) out.length = k;
    }
    if (collapse && endsWith(out, s)) return;
    for (const ch of s) out.push(ch);
  };
  const skipAfter = (j, fw) => {
    if (!fw || !r.punct) return j;
    let k = j;
    while (k < n && (cs[k] === " " || cs[k] === "\t")) k++;
    return k > j && k < n && isCN(cs[k]) ? k : j;
  };

  let dq = 0, sq = 0, i = 0;
  while (i < n) {
    const c = cs[i];
    const L = lastOut();

    // 省略号：...（三个以上点）、。。。、···、单个…、⋯ → ……
    if (r.ellipsis && "…⋯.。·．".includes(c)) {
      let j = i, strong = false;
      for (;;) {
        const x = cs[j];
        if (x === "…" || x === "⋯") { j++; strong = true; continue; }
        if (x === "." || x === "。" || x === "·" || x === "．") {
          // 。和．是全角，夹在中间的半角空格会被去掉，所以「。 。 。」也算连着
          const gapOk = r.punct && (x === "。" || x === "．");
          let k = j, cnt = 0, end = j;
          for (;;) {
            let m = k;
            if (cnt && gapOk) while (cs[m] === " " || cs[m] === "\t") m++;
            if (cs[m] !== x) break;
            cnt++; k = end = m + 1;
          }
          if (cnt >= 3) { if (x !== ".") strong = true; j = end; continue; }
        }
        break;
      }
      if (j > i) {
        // 只有英文的点（Wait...）跟在字母数字后面、后面又不是中文时不动
        const conv = strong || !(isAlnum(L) && !isHan(nextFrom(j)));
        put(conv ? "……" : cs.slice(i, j).join(""), conv, conv);
        i = skipAfter(j, conv);
        continue;
      }
    }

    // 破折号：--、—、―、──、－－ → ——
    if (r.dash && "—―─━-－".includes(c)) {
      let j = i, strong = false;
      for (;;) {
        const x = cs[j];
        if (x === "—" || x === "―" || x === "─" || x === "━") { j++; strong = true; continue; }
        if (x === "-" || x === "－") {
          let k = j;
          while (cs[k] === x) k++;
          if (k - j >= 2) { if (x === "－") strong = true; j = k; continue; }
        }
        break;
      }
      if (j > i) {
        const conv = strong || isCN(L) || isHan(nextFrom(j));
        put(conv ? "——" : cs.slice(i, j).join(""), conv, conv);
        i = skipAfter(j, conv);
        continue;
      }
    }

    // 引号：直引号按前后成对，「」『』直接换
    if (r.quotes && (DQ.has(c) || SQ.has(c))) {
      let q = null;
      if (c === "“" || c === "「") { q = "“"; dq = 1; }
      else if (c === "”" || c === "」") { q = "”"; dq = 0; }
      else if (c === "‘" || c === "『") { q = "‘"; sq = 1; }
      else if (c === "’" || c === "』") { q = "’"; sq = 0; }
      else if (c === "\"" || c === "＂") {
        if (dq) { q = "”"; dq = 0; }
        else if (L && !nextFrom(i + 1)) q = "”";          // 段尾落单的：多段引语的结尾
        else { q = "“"; dq = 1; }
      } else {
        const prev = out.length ? out[out.length - 1] : "";
        if (c === "'" && isAlnum(prev) && isAlnum(cs[i + 1])) q = null;   // don't、it's 里的撇号
        else if (sq) { q = "’"; sq = 0; }
        else if (c === "＇" || isCN(L) || isHan(nextFrom(i + 1))) {
          if (L && !nextFrom(i + 1)) q = "’";
          else { q = "‘"; sq = 1; }
        }
      }
      if (q) { put(q, true); i = skipAfter(i + 1, true); continue; }
      put(c, false);
      i++;
      continue;
    }

    // 半角标点：挨着中文才改
    if (r.punct) {
      let to = null;
      if (HALF[c]) {
        if (isCN(L) || isHan(nextFrom(i + 1))) to = HALF[c];
      } else if (c === ".") {
        // 3.14、www.a.com 不动；挨着别的点、省略号的也不动（免得拼出「。。。」）
        const R = nextFrom(i + 1);
        if (isCN(L) && !isAlnum(R) && !DOTS.has(L) && !DOTS.has(R)) to = "。";
      } else if (c === "(" || c === ")") {
        const conv = pairConv.has(i) ? pairConv.get(i) : c === "(" ? isHan(nextFrom(i + 1)) : isCN(L);
        if (conv) to = c === "(" ? "（" : "）";
      }
      if (to) { put(to, true); i = skipAfter(i + 1, true); continue; }
    }

    const fw = FW.has(c);
    put(c, fw);
    i = skipAfter(i + 1, fw);
  }
  return out.join("");
}

function fixBody(body, r) {
  if (!body) return body;
  const han = HAN_RE.test(body);
  if (!han && /[A-Za-z]/.test(body)) return body;   // 整段英文不动
  if (isSceneBreak(body)) return body;               // 分隔线不动
  if (r.punct || r.quotes || r.ellipsis || r.dash) body = fixPunct(body, r);
  if (r.cjkSpace && han) body = body.replace(SP1, " ").replace(SP2, " ");
  return body;
}

/** 排版。rules 缺的项按默认补齐。 */
export function formatText(text, rules) {
  const r = normalizeRules(rules);
  let lines = String(text == null ? "" : text).replace(/\r\n?|\u2028|\u2029/g, "\n").split("\n");
  if (r.trimEnd) lines = lines.map((l) => l.replace(/\s+$/u, ""));
  if (r.mergeLines) lines = mergeBroken(lines);
  lines = lines.map((l) => {
    if (isBlank(l)) return l;
    const lead = l.match(/^\s*/u)[0];
    return (r.indent ? INDENT : lead) + fixBody(l.slice(lead.length), r);
  });
  if (!r.gap) return lines.join("\n");
  const paras = lines.filter((l) => !isBlank(l));
  let res = "";
  paras.forEach((p, k) => {
    // 不缩进、不空行时，接得上的两段之间留一个空行，不然下次会被当成断行接起来
    if (k) res += r.paraGap || (r.mergeLines && canMerge(paras[k - 1], p)) ? "\n\n" : "\n";
    res += p;
  });
  return res;
}

// ---------------- 排版方案 ----------------
const KEY = "format:schemes";
export const BUILTIN_SCHEMES = [
  { name: "默认", rules: { ...DEFAULT_RULES }, builtin: true },
  { name: "网文平台", rules: { ...DEFAULT_RULES, paraGap: 1 }, builtin: true },
];
export const isBuiltinScheme = (name) => BUILTIN_SCHEMES.some((s) => s.name === name);

/** 作者自己存的方案 [{ name, rules, at }] */
export async function getUserSchemes() {
  try {
    const list = await db.getKV(KEY, []);
    return Array.isArray(list) ? list.filter((s) => s && s.name) : [];
  } catch (_) { return []; }
}

/** 整个替换作者的方案列表（撤销用） */
export async function setUserSchemes(list) { await db.setKV(KEY, Array.isArray(list) ? list : []); }

/** 自带的 + 自己存的，[{ name, rules, builtin? }] */
export async function getSchemes() {
  const own = await getUserSchemes();
  return [
    ...BUILTIN_SCHEMES.map((s) => ({ ...s, rules: { ...s.rules } })),
    ...own.map((s) => ({ name: s.name, rules: normalizeRules(s.rules) })),
  ];
}

/** 存一个方案，同名的覆盖。返回存进去的方案。 */
export async function saveScheme(name, rules) {
  name = String(name || "").trim();
  if (!name) throw new Error("方案名不能空着");
  if (isBuiltinScheme(name)) throw new Error(`「${name}」是自带的方案，换个名字吧`);
  const list = await getUserSchemes();
  const item = { name, rules: normalizeRules(rules), at: Date.now() };
  const i = list.findIndex((s) => s.name === name);
  if (i >= 0) list[i] = item;
  else list.push(item);
  await setUserSchemes(list);
  return item;
}

/** 删掉一个方案，返回删掉的那个（没有就返回 null）。自带的删不掉。 */
export async function deleteScheme(name) {
  if (isBuiltinScheme(name)) return null;
  const list = await getUserSchemes();
  const i = list.findIndex((s) => s.name === name);
  if (i < 0) return null;
  const [gone] = list.splice(i, 1);
  await setUserSchemes(list);
  return gone;
}
