// 选中调用的对比：切句、原文和几版 AI 结果按句对齐、逐字改动、选中一段对回原文、重排后保留已经挑好的。
// 纯函数，不碰界面。所有切分都不丢字：一段文字切开再拼回去和原来一字不差。
import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 0.6;

const END = /[。！？!?…；;]/;
const CLOSE = /[」』”’"'）)》〉】〕\]]/;
const WS = /\s/;

/** 切句：句末带着引号和换行，段首缩进算下一句的 */
export function tokenize(text) {
  const out = [];
  const ch = Array.from(text || "");
  let buf = "", i = 0;
  while (i < ch.length) {
    const c = ch[i++];
    buf += c;
    if (c === "\n") {
      while (i < ch.length && ch[i] === "\n") buf += ch[i++];
      out.push(buf); buf = "";
      continue;
    }
    if (!END.test(c)) continue;
    while (i < ch.length && (END.test(ch[i]) || CLOSE.test(ch[i]))) buf += ch[i++];
    // 句后的空白：到最后一个换行为止都算这一句的，换行后面的缩进留给下一句
    let j = i, last = -1;
    while (j < ch.length && WS.test(ch[j])) { if (ch[j] === "\n") last = j; j++; }
    if (last >= 0) { buf += ch.slice(i, last + 1).join(""); i = last + 1; }
    out.push(buf); buf = "";
  }
  if (buf) out.push(buf);
  return out;
}

// ---------------- 两句像不像：去掉空白标点后，共有的字占多少 ----------------
const SKIP = /[\s\p{P}\p{S}]/u;
function bag(s) {
  const m = new Map();
  let n = 0;
  for (const c of s) { if (SKIP.test(c)) continue; m.set(c, (m.get(c) || 0) + 1); n++; }
  return { m, n };
}
function joinBags(a, b) {
  const m = new Map(a.m);
  for (const [c, k] of b.m) m.set(c, (m.get(c) || 0) + k);
  return { m, n: a.n + b.n };
}
function sim(a, b) {
  if (!a.n && !b.n) return 1;
  if (!a.n || !b.n) return 0;
  const [x, y] = a.m.size < b.m.size ? [a, b] : [b, a];
  let common = 0;
  for (const [c, k] of x.m) { const k2 = y.m.get(c); if (k2) common += Math.min(k, k2); }
  return (2 * common) / (a.n + b.n);
}

/** 一段改动里，原文几句和新的几句怎么配：一对一、一句拆两句、两句并一句、删掉、新加 */
function alignBlock(A, B, i0, i1, j0, j1) {
  const n = i1 - i0, m = j1 - j0;
  if (!n && !m) return [];
  if (!m) return Array.from({ length: n }, (_, k) => ({ a0: i0 + k, a1: i0 + k + 1, b0: j0, b1: j0 }));
  if (!n) return [{ a0: i0, a1: i0, b0: j0, b1: j1 }];
  if (n * m > 160000) {
    // 太长了：按顺序一对一，多出来的并到最后一组
    const out = [];
    const k = Math.min(n, m);
    for (let t = 0; t < k; t++) out.push({ a0: i0 + t, a1: i0 + t + 1, b0: j0 + t, b1: j0 + t + 1 });
    const last = out[out.length - 1];
    last.a1 = i1; last.b1 = j1;
    return out;
  }
  const ba = [], bb = [], ba2 = [], bb2 = [];
  for (let k = 0; k < n; k++) ba.push(bag(A[i0 + k]));
  for (let k = 0; k < m; k++) bb.push(bag(B[j0 + k]));
  for (let k = 0; k + 1 < n; k++) ba2.push(joinBags(ba[k], ba[k + 1]));
  for (let k = 0; k + 1 < m; k++) bb2.push(joinBags(bb[k], bb[k + 1]));
  const gap = (b) => (b.n ? 0.75 : 0.2);
  const W = m + 1;
  const cost = new Float64Array((n + 1) * W).fill(Infinity);
  const back = new Uint8Array((n + 1) * W);
  cost[0] = 0;
  const relax = (from, x, y, add, code) => {
    const idx = x * W + y, v = cost[from] + add;
    if (v < cost[idx]) { cost[idx] = v; back[idx] = code; }
  };
  for (let x = 0; x <= n; x++) {
    for (let y = 0; y <= m; y++) {
      const here = x * W + y;
      if (cost[here] === Infinity) continue;
      if (x < n && y < m) relax(here, x + 1, y + 1, 1 - sim(ba[x], bb[y]), 1);
      if (x < n) relax(here, x + 1, y, gap(ba[x]), 2);
      if (y < m) relax(here, x, y + 1, gap(bb[y]), 3);
      if (x + 1 < n && y < m) relax(here, x + 2, y + 1, 1.12 - sim(ba2[x], bb[y]), 4);
      if (x < n && y + 1 < m) relax(here, x + 1, y + 2, 1.12 - sim(ba[x], bb2[y]), 5);
    }
  }
  const STEP = { 1: [1, 1], 2: [1, 0], 3: [0, 1], 4: [2, 1], 5: [1, 2] };
  const out = [];
  let x = n, y = m;
  while (x > 0 || y > 0) {
    const [dx, dy] = STEP[back[x * W + y]];
    out.push({ a0: i0 + x - dx, a1: i0 + x, b0: j0 + y - dy, b1: j0 + y });
    x -= dx; y -= dy;
  }
  out.reverse();
  // 连着几句新加的并成一组
  const merged = [];
  for (const g of out) {
    const p = merged[merged.length - 1];
    if (p && p.a0 === p.a1 && g.a0 === g.a1) p.b1 = g.b1;
    else merged.push(g);
  }
  return merged;
}

/** 原文的句子 A 和新版的句子 B 对齐，返回按顺序铺满两边的分组 [{ a0, a1, b0, b1 }] */
export function alignPair(A, B) {
  const ids = new Map();
  const enc = (t) => {
    let k = ids.get(t);
    if (k == null) { k = ids.size + 1; ids.set(t, k); }
    return String.fromCharCode(k < 0xd800 ? k : k + 0x800);
  };
  if (A.length + B.length > 50000) return alignBlock(A, B, 0, A.length, 0, B.length);
  const sa = A.map(enc).join(""), sb = B.map(enc).join("");
  const groups = [];
  let i = 0, j = 0, di = 0, dj = 0;
  const flush = () => { if (i > di || j > dj) groups.push(...alignBlock(A, B, di, i, dj, j)); };
  for (const [op, s] of dmp.diff_main(sa, sb, false)) {
    const n = s.length;
    if (op === 0) {
      flush();
      for (let k = 0; k < n; k++) groups.push({ a0: i + k, a1: i + k + 1, b0: j + k, b1: j + k + 1 });
      i += n; j += n; di = i; dj = j;
    } else if (op < 0) i += n;
    else j += n;
  }
  flush();
  return groups;
}

/**
 * 原文和几版一起对齐，切成大家都能对上的小段（一般是一句）。
 * 返回 [{ oa, ob（原文第几句到第几句）, orig, alts: [每一版对应的文字], origOff, altOff: [每一版里的起点] }]
 */
export function segmentAll(origText, versionTexts) {
  const O = tokenize(origText);
  const Vs = versionTexts.map(tokenize);
  const n = O.length;
  let segs;
  if (!n) {
    segs = [{ oa: 0, ob: 0, orig: "", alts: versionTexts.slice() }];
  } else {
    const groupsList = Vs.map((V) => alignPair(O, V));
    let cuts = null;
    for (const gs of groupsList) {
      const c = new Set();
      for (const g of gs) { c.add(g.a0); c.add(g.a1); }
      cuts = cuts ? new Set([...cuts].filter((x) => c.has(x))) : c;
    }
    const inner = cuts ? [...cuts].filter((x) => x > 0 && x < n).sort((a, b) => a - b) : Array.from({ length: n - 1 }, (_, k) => k + 1);
    const bounds = [0, ...inner, n];
    segs = [];
    const segOf = new Int32Array(n);
    for (let k = 0; k + 1 < bounds.length; k++) {
      const oa = bounds[k], ob = bounds[k + 1];
      for (let t = oa; t < ob; t++) segOf[t] = k;
      segs.push({ oa, ob, orig: O.slice(oa, ob).join(""), alts: Vs.map(() => "") });
    }
    groupsList.forEach((gs, v) => {
      for (const g of gs) {
        const text = Vs[v].slice(g.b0, g.b1).join("");
        if (!text) continue;
        const k = g.a1 > g.a0 ? segOf[g.a0] : g.a0 > 0 ? segOf[g.a0 - 1] : 0;
        segs[k].alts[v] += text;
      }
    });
  }
  let o = 0;
  const vo = versionTexts.map(() => 0);
  for (const s of segs) {
    s.origOff = o; o += s.orig.length;
    s.altOff = s.alts.map((a, v) => { const at = vo[v]; vo[v] += a.length; return at; });
  }
  return segs;
}

/** 某一小段选了什么：-1 原文，0.. 第几版，{ c } 自己拼的 */
export function pickText(seg, p) {
  if (p && typeof p === "object") return p.c;
  if (p == null || p < 0) return seg.orig;
  return seg.alts[p] ?? seg.orig;
}

/** 逐字改动（显示用），[[op, text]]，op：0 不变、-1 删掉、1 加上 */
export function charDiff(a, b) {
  const d = dmp.diff_main(a || "", b || "");
  dmp.diff_cleanupSemantic(d);
  return d;
}

/** 版本 V 里选中的 [s, e) 对应原文 O 的哪一段：碰到改动就把那处改动整个算进来 */
export function mapRange(O, V, s, e) {
  const d = charDiff(O, V);
  let o = 0, v = 0, os = null, oe = null, k = 0;
  while (k < d.length) {
    if (d[k][0] === 0) {
      const len = d[k][1].length;
      if (os == null && s >= v && s < v + len) os = o + (s - v);
      if (oe == null && e > v && e <= v + len) oe = o + (e - v);
      o += len; v += len; k++;
      continue;
    }
    let oLen = 0, vLen = 0;
    while (k < d.length && d[k][0] !== 0) { if (d[k][0] < 0) oLen += d[k][1].length; else vLen += d[k][1].length; k++; }
    if (os == null && s >= v && s < v + vLen) os = o;
    if (oe == null && e > v && e <= v + vLen) oe = o + oLen;
    o += oLen; v += vLen;
  }
  if (os == null) os = o;
  if (oe == null) oe = o;
  return [os, Math.max(os, oe)];
}

/**
 * 重新对齐以后，把已经挑好的搬过去。
 * opts.origChanged：原文被改过（按原文文字认），opts.edited：刚改过的是哪一边（-1 原文，0.. 第几版）
 */
export function remapPicks(oldSegs, oldPicks, newSegs, { origChanged = false, edited = null } = {}) {
  if (!oldSegs.length) return newSegs.map(() => (edited != null ? edited : -1));
  if (origChanged) {
    let ptr = 0;
    return newSegs.map((ns) => {
      for (let k = ptr; k < oldSegs.length; k++) {
        if (oldSegs[k].orig === ns.orig && ns.orig) { ptr = k + 1; return oldPicks[k]; }
      }
      return edited != null ? edited : -1;
    });
  }
  return newSegs.map((ns) => {
    const olds = [];
    oldSegs.forEach((os, k) => { if (os.oa < Math.max(ns.ob, ns.oa + 1) && Math.max(os.ob, os.oa + 1) > ns.oa) olds.push(k); });
    if (!olds.length) return edited != null ? edited : -1;
    const first = oldSegs[olds[0]], last = oldSegs[olds[olds.length - 1]];
    const ps = olds.map((k) => oldPicks[k]);
    const tiles = first.oa === ns.oa && last.ob === ns.ob;
    // 作者在某一版里改过的句子，就用那一版（不然改了也进不了结果）
    if (tiles && edited != null && edited >= 0 && olds.map((k) => oldSegs[k].alts[edited]).join("") !== ns.alts[edited]) return edited;
    if (olds.length === 1 && tiles) return ps[0];
    if (ps.every((p) => typeof p === "number" && p === ps[0])) return ps[0];
    if (edited != null && ps.includes(edited)) return edited;
    if (tiles) return { c: olds.map((k) => pickText(oldSegs[k], oldPicks[k])).join("") };
    const p0 = ps[0];
    if (typeof p0 === "number") return p0;
    return first.oa === ns.oa ? p0 : { c: "" };
  });
}

/** AI 回来的文字按原文的格式收拾一下：去掉首尾空行，段首缩进、空行跟原文一致 */
export function fitFormat(ai, orig, defIndent = "　　") {
  let t = String(ai || "").replace(/\r\n?/g, "\n");
  t = t.replace(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/, "$1");
  t = t.replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (!t) return t;
  const indentOf = (l) => (l.match(/^[ \t　]*/) || [""])[0];
  const lead = (orig.match(/^\s*\n/) || [""])[0];
  const tail = (orig.match(/\s*$/) || [""])[0];
  const oLines = orig.slice(lead.length).split("\n");
  const firstIndent = indentOf(oLines[0] || "");
  const others = oLines.slice(1).filter((l) => l.trim());
  const count = new Map();
  others.forEach((l) => { const k = indentOf(l); count.set(k, (count.get(k) || 0) + 1); });
  const bodyIndent = others.length ? [...count.entries()].sort((a, b) => b[1] - a[1])[0][0] : (firstIndent || defIndent);
  if (!/\n[ \t　]*\n/.test(orig)) t = t.replace(/\n[ \t　]*\n+/g, "\n");
  t = t.split("\n").map((l, i) => {
    if (!l.trim()) return l;
    const want = i === 0 ? firstIndent : bodyIndent;
    return want + l.replace(/^[ \t　]+/, "");
  }).join("\n");
  return lead + t + (tail.includes("\n") ? tail.slice(tail.indexOf("\n")) : "");
}
