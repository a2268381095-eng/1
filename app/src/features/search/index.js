// 查找、替换、筛选：右侧栏里的统一搜索面板，不挡正文。
// 范围：本章 / 选中的几章 / 某一卷 / 全书。普通文字，可选全字匹配、区分大小写；高级里有正则。
// 替换前列出每一处，可以逐条勾选；全部替换算一步，能整体撤销。筛选按要点、字数挑章，常用条件按作品存起来。
import { ws } from "../editor/workspace.js";
import { bus } from "../../core/bus.js";
import { nav } from "../../core/nav.js";
import { db, uid } from "../../core/db.js";
import { undo as appUndo } from "../../core/undo.js";
import { commands, keyOf, prettyKey } from "../../core/commands.js";
import { h, icon, toast, notice, prompt, helpTip } from "../../core/ui.js";
import { countWords, volumeLabel } from "../../core/text.js";
import { tip } from "../demon/demon.js";
import * as E from "./engine.js";

const RENDER_LIMIT = 1000;   // 列表里最多画这么多条，再多用「下一处」逐个看
const DEBOUNCE = 200;

// ---------------- 状态 ----------------
const freshState = (bookId) => ({
  bookId, query: "", replace: "", regex: false, caseSensitive: false, wholeWord: false,
  advanced: false, showReplace: false, showFilter: false, scope: "cur",
  filter: { ...E.EMPTY_FILTER }, unchecked: new Set(), pristine: false,
});
let S = freshState(null);
let P = null;              // 打开着的面板和里面的元素
let R = { mode: "idle" };  // 最近一次的结果
let flat = [];             // 所有命中，按全书顺序 [{ chapterId, from, to, m, named }]
let cur = -1;              // 当前这一条
let snap = new Map();      // 查找时每章的正文（判断结果是不是过期了）
let lastSig = "";          // 上次的查找条件（条件变了勾选状态清空）
let lastDone = "";         // 上次发 search:done 的条件
let timer = 0, busy = false;
let seq = 0;               // 第几次查找（正则在单独的线程里找，回来时条件可能已经变了）
let keepDraft = false, forced = false;
let presets = [];
const marked = new Set();  // 标过高亮的章

const key = (cid, from) => cid + ":" + from;
const sigOf = () => JSON.stringify([S.query, S.regex, S.caseSensitive, S.wholeWord]);
const chapterById = (id) => ws.chapters.find((c) => c.id === id);
const cidOf = (k) => k.slice(0, k.lastIndexOf(":"));
const posOf = (k) => +k.slice(k.lastIndexOf(":") + 1);
const scopeOpts = () => ({ currentId: ws.current && ws.current.id, selectedIds: ws.selectedIds(), volumeIds: ((ws.book && ws.book.volumes) || []).map((v) => v.id) });
const wsView = () => { const e = ws.els(); return e && e.center ? e.center.closest(".ws") : null; };
const vis = (s) => String(s).replace(/\n/g, "↵");
const short = (s) => (s.length > 12 ? s.slice(0, 12) + "…" : s);

function arrow(dir) {
  const s = h("span.ico", { "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${dir === "up" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"}"/></svg>`;
  return s;
}

// ---------------- 存储（按作品） ----------------
const draftKey = (bookId) => "search:draft:" + bookId;
const presetKey = (bookId) => "search:presets:" + bookId;

// 草稿在面板正常关掉（没有要留的）或选「丢弃」时才删；打开时不删，开着面板刷新也不丢
async function loadDraft(bookId) {
  try {
    const d = await db.getKV(draftKey(bookId), null);
    if (!d || S.bookId !== bookId) return;
    const { sig, snaps, ...rest } = d;
    Object.assign(S, rest, { filter: { ...E.EMPTY_FILTER, ...(d.filter || {}) }, unchecked: new Set(d.unchecked || []), bookId });
    // 取消勾选的位置是按当时的正文记的：把当时的正文也放回来，正文改过的话按改动换算
    lastSig = sig || "";
    snap = new Map(Object.entries(snaps || {}));
  } catch (_) { /* 草稿读不出来就从头开始 */ }
}

async function saveDraft() {
  const snaps = {};
  for (const k of S.unchecked) { const cid = cidOf(k); if (snap.has(cid)) snaps[cid] = snap.get(cid); }
  const d = { query: S.query, replace: S.replace, regex: S.regex, caseSensitive: S.caseSensitive, wholeWord: S.wholeWord, advanced: S.advanced,
    showReplace: S.showReplace, showFilter: S.showFilter, scope: S.scope === "sel" ? "cur" : S.scope, filter: { ...S.filter },
    unchecked: [...S.unchecked], sig: sigOf(), snaps };
  try { await db.setKV(draftKey(S.bookId), d); } catch (_) { /* 存不进去时草稿还在内存里，这次打开软件期间都在 */ }
}

async function loadPresets(bookId) {
  try { return (await db.getKV(presetKey(bookId), [])) || []; } catch (_) { return []; }
}

async function setPresets(bookId, list) {
  await db.setKV(presetKey(bookId), list);
  if (bookId === S.bookId) { presets = list; if (P) renderPresets(); }
}

// ---------------- 打开 / 关闭 ----------------
async function openSearch(opts = {}) {
  if (!ws.isOpen() || !ws.editor) return;
  // 专注模式下侧栏是藏起来的，先退出专注模式
  const view = wsView();
  if (view && view.classList.contains("focus")) commands.run("focus.toggle");
  const fresh = !P;
  const fromEditor = ws.editor.hasFocus();
  if (S.bookId !== ws.book.id) {
    S = freshState(ws.book.id);
    lastSig = ""; lastDone = ""; flat = []; cur = -1; snap = new Map(); R = { mode: "idle" };
    await loadDraft(ws.book.id);
    presets = await loadPresets(ws.book.id);
  }
  if (opts.scope) S.scope = opts.scope;
  if (opts.replace) S.showReplace = true;
  if (opts.filter) S.showFilter = true;
  if (!ws.isOpen() || ws.book.id !== S.bookId) return;   // 读草稿的工夫里离开了作品
  // 正文里选着一段字：直接拿来找（正则模式下不覆盖写好的表达式）。面板开着时从正文里按也算，选中的是当前这一处就不换
  if ((fresh || fromEditor) && !opts.filter && !S.regex) {
    const sel = selectionText();
    const h0 = flat[cur];
    const isCur = sel && h0 && ws.current && h0.chapterId === ws.current.id && h0.from === sel.from && h0.to === sel.to;
    if (sel && !isCur && sel.text !== S.query) { S.query = sel.text; S.pristine = false; }
  }
  if (!P) buildPanel();
  sync();
  runSearch();
  const target = opts.filter ? P.fPoints : opts.replace && S.query ? P.r : P.q;
  setTimeout(() => { if (!P) return; target.focus(); if (target.select) target.select(); }, 0);
  const k = (id) => prettyKey(keyOf(commands.get(id) || {})) || "";
  tip("search-first", `${k("search.open")} 找本章，${k("search.book")} 找全书。替换前会列出每一处，换完也能撤销。`);
}

function selectionText() {
  const v = ws.editor && ws.editor.view;
  if (!v) return null;
  const r = v.state.selection.main;
  if (r.empty) return null;
  const t = v.state.sliceDoc(r.from, r.to);
  return t.length <= 60 && !t.includes("\n") ? { text: t, from: r.from, to: r.to } : null;
}

/** 替换框里填了字还没用过（没找到也算） */
function isDirty() { return !!P && S.showReplace && S.replace !== "" && !S.pristine; }

function onPanelClose() {
  const dirty = isDirty();
  // 焦点在面板里（或者已经丢了）：关掉后放回正文，接着写
  const right = ws.els() && ws.els().right;
  const a = document.activeElement;
  const refocus = !a || a === document.body || (!!right && right.contains(a));
  // 选了「保留草稿」，或者没来得及问（离开作品、换了别的面板）就留着；选了「丢弃」才清掉
  if (keepDraft || (forced && dirty)) saveDraft();
  else {
    if (dirty) { S.replace = ""; S.unchecked.clear(); }
    db.setKV(draftKey(S.bookId), null).catch(() => {});
  }
  keepDraft = forced = false;
  clearTimeout(timer);
  timer = 0;
  seq++;
  stopWorker();
  if (P && P.unwatch) P.unwatch();
  const view = wsView();
  if (view) view.classList.remove("has-search");
  document.body.classList.remove("search-open");
  clearMarks();
  P = null;
  if (refocus) setTimeout(() => {
    const f = document.activeElement;
    if (ws.isOpen() && ws.editor && (!f || f === document.body)) ws.editor.focus();
  }, 0);
}

function closeSearch(force) { if (P) return P.layer.close(force); }

// ---------------- 面板 ----------------
function buildPanel() {
  const p = ws.openPanel({ title: "查找替换", wide: true, isDirty, onClose: onPanelClose, render: (body) => body.classList.add("sr-body") });
  // 区分「作者选了丢弃」和「被强制关掉」：强制关掉时不丢草稿
  const origClose = p.layer.close;
  p.layer.close = (force) => { forced = !!force; return origClose(force); };
  p.layer.onKeepDraft = () => { keepDraft = true; };
  const view = wsView();
  if (view) view.classList.add("has-search");
  document.body.classList.add("search-open");

  const q = h("input.input.sr-q", { type: "text", placeholder: "查找", "aria-label": "查找内容", spellcheck: "false", autocomplete: "off" });
  const count = h("span.sr-count", { "aria-live": "polite" });
  const prevBtn = h("button.icon-btn", { type: "button", title: "上一处（Shift+Enter）", "aria-label": "上一处" }, arrow("up"));
  const nextBtn = h("button.icon-btn", { type: "button", title: "下一处（Enter）", "aria-label": "下一处" }, arrow("down"));
  const scope = h("div.sr-scope", { role: "group", "aria-label": "查找范围" });

  const opt = (label, k, title) => {
    const b = h("button.tool-btn.sr-opt", { type: "button", title, "data-k": k }, label);
    b.addEventListener("click", () => { S[k] = !S[k]; sync(); changed(0); });
    return b;
  };
  const caseBtn = opt("区分大小写", "caseSensitive", "英文区分大小写");
  const wordBtn = opt("全字匹配", "wholeWord", "英文、数字按整个词找：找 Tom 不会找到 Tomas");
  const regexBtn = opt("正则表达式", "regex", "用正则表达式找");
  const fold = (label, k) => {
    const b = h("button.tool-btn.sr-fold", { type: "button", "data-k": k }, h("span", {}, label), arrow("down"));
    b.addEventListener("click", () => {
      S[k] = !S[k];
      if (k === "advanced" && !S.advanced && S.regex) { S.regex = false; changed(0); }
      if (k === "showReplace") { S.unchecked.clear(); renderResults(); }
      sync();
      if (k === "showReplace" && S.showReplace) P.r.focus();
      if (k === "showFilter" && S.showFilter) P.fPoints.focus();
    });
    return b;
  };
  const advBtn = fold("高级", "advanced");
  const repBtn = fold("替换", "showReplace");
  const filBtn = fold("筛选", "showFilter");
  const advRow = h("div.sr-row.sr-adv", {}, regexBtn,
    helpTip("比如「第.章」能找到第一章、第二章。替换里可以用 $1 代表第一对括号里找到的字。"));
  const err = h("p.sr-err", { role: "alert", hidden: true });

  const r = h("input.input.sr-r", { type: "text", placeholder: "替换成（空着就是删掉）", "aria-label": "替换成", spellcheck: "false", autocomplete: "off" });
  const oneBtn = h("button.btn.small", { type: "button", title: "换掉当前这一处，跳到下一处（Enter）" }, "替换这一处");
  const skipBtn = h("button.btn.small.ghost", { type: "button", title: "这一处不换，看下一处" }, "跳过");
  const allBtn = h("button.btn.small.primary.sr-all", { type: "button" }, "全部替换");
  const repRow = h("div.sr-rep", {}, r, h("div.sr-row", {}, oneBtn, skipBtn, h("span.grow"), allBtn));

  const fPoints = h("input", { type: "checkbox" });
  const fWordsOn = h("input", { type: "checkbox" });
  const fWordsN = h("input.input.sr-num", { type: "number", min: "1", step: "100", inputmode: "numeric", "aria-label": "字数" });
  const filRow = h("div.sr-filter", {},
    h("label.check", {}, fPoints, "要点没打完的章"),
    h("div.sr-row", {}, h("label.check", {}, fWordsOn, "字数少于"), fWordsN, h("span", {}, "字")),
    h("p.sr-note.muted", {}, "不填查找内容时，列出符合条件的章；填了就只在这些章里找。"));
  const presetRow = h("div.sr-presets");

  const top = h("div.sr-top", {}, scope,
    h("div.sr-line", {}, q, count, prevBtn, nextBtn),
    h("div.sr-row.sr-opts", {}, caseBtn, wordBtn, advBtn, h("span.grow"), repBtn, filBtn),
    advRow, err, repRow, filRow, presetRow);
  const sum = h("div.sr-sum");
  const list = h("div.sr-list", { role: "list", "aria-label": "查找结果" });
  const done = h("div.sr-done", { hidden: true });
  const root = h("div.sr-panel", {}, top, done, sum, list);
  p.body.append(root);
  root.addEventListener("focusin", () => syncScope());

  P = { ...p, q, count, scope, caseBtn, wordBtn, regexBtn, advBtn, repBtn, filBtn, advRow, err, r, oneBtn, skipBtn, allBtn, repRow,
    fPoints, fWordsOn, fWordsN, filRow, presetRow, sum, list, done, scopeSig: "", titleSig: "", unwatch: watchChapterList() };

  // 输入时实时找（防抖）；中文输入法拼完再找
  q.addEventListener("input", (e) => { if (e.isComposing) return; S.query = q.value; S.pristine = false; changed(); });
  q.addEventListener("compositionend", () => { S.query = q.value; S.pristine = false; changed(); });
  q.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    e.shiftKey ? prev() : next();
  });
  // 替换框：输入法拼完再更新预览
  const onRep = () => { S.replace = r.value; S.pristine = false; hideDone(); renderResults(); };
  r.addEventListener("input", (e) => { if (!e.isComposing) onRep(); });
  r.addEventListener("compositionend", onRep);
  r.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    replaceOne();
  });
  prevBtn.addEventListener("click", () => prev());
  nextBtn.addEventListener("click", () => next());
  oneBtn.addEventListener("click", () => replaceOne());
  skipBtn.addEventListener("click", () => next());
  allBtn.addEventListener("click", () => replaceAll());
  fPoints.addEventListener("change", () => { S.filter.pointsOpen = fPoints.checked; sync(); changed(0); });
  fWordsOn.addEventListener("change", () => { S.filter.wordsOn = fWordsOn.checked; sync(); changed(0); });
  fWordsN.addEventListener("input", () => {
    const n = parseInt(fWordsN.value, 10);
    S.filter.maxWords = n > 0 ? n : 0;
    if (n > 0 && !S.filter.wordsOn) { S.filter.wordsOn = true; }
    sync(); changed();
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const row = e.target.classList.contains("sr-go") && e.target.closest(".sr-hit");
    if (!row || !flat.length) return;
    e.preventDefault();
    // 从有焦点的这一条往上 / 往下走
    const i = (+row.dataset.i + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length;
    goTo(i).then(() => { const b = P && P.list.querySelector(".sr-hit.cur .sr-go"); if (b) b.focus(); });
  });
}

/** 把状态同步到界面上（打开、套用常用筛选、切换开关之后） */
function sync() {
  if (!P) return;
  if (P.q.value !== S.query) P.q.value = S.query;
  if (P.r.value !== S.replace) P.r.value = S.replace;
  const press = (b, on) => b.setAttribute("aria-pressed", String(!!on));
  press(P.caseBtn, S.caseSensitive); press(P.wordBtn, S.wholeWord); press(P.regexBtn, S.regex);
  P.advBtn.setAttribute("aria-expanded", String(S.advanced)); P.advBtn.classList.toggle("on", S.advanced || S.regex);
  P.repBtn.setAttribute("aria-expanded", String(S.showReplace)); P.repBtn.classList.toggle("on", S.showReplace);
  P.filBtn.setAttribute("aria-expanded", String(S.showFilter));
  const nf = (S.filter.pointsOpen ? 1 : 0) + (S.filter.wordsOn && S.filter.maxWords > 0 ? 1 : 0);
  P.filBtn.firstChild.textContent = nf ? `筛选 · ${nf}` : "筛选";
  P.filBtn.classList.toggle("on", S.showFilter || nf > 0);
  P.advRow.hidden = !(S.advanced || S.regex);
  P.repRow.hidden = !S.showReplace;
  P.filRow.hidden = !S.showFilter;
  P.fPoints.checked = !!S.filter.pointsOpen;
  P.fWordsOn.checked = !!S.filter.wordsOn;
  if (document.activeElement !== P.fWordsN) P.fWordsN.value = S.filter.maxWords > 0 ? String(S.filter.maxWords) : "";
  P.q.placeholder = S.regex ? "正则表达式" : "查找";
  renderScope(true);
  renderPresets();
}

// ---------------- 范围 ----------------
function volumeOptions(book = ws.book) {
  if (!book || !book.useVolumes) return [];
  const out = (book.volumes || []).map((v, i) => ({ value: "vol:" + v.id, label: volumeLabel(i + 1, book.numbering) + (v.title ? " " + v.title : "") }));
  if (ws.chapters.some((c) => !c.volumeId || !(book.volumes || []).some((v) => v.id === c.volumeId))) out.push({ value: "vol:", label: "未分卷" });
  return out;
}

function scopeIds() {
  return E.chaptersInScope(ws.chapters, S.scope, scopeOpts()).map((c) => c.id).join(",");
}

/** 结果里那几章的章名（改了章名要重画） */
function titleSig() {
  return (R.groups || []).map((g) => { const c = chapterById(g.id); return c ? ws.fullTitle(c) : ""; }).join("\n");
}

/** 选中的章、分卷、章名、章节顺序变了以后更新范围按钮；范围里的章变了就重新找 */
function syncScope() {
  if (!P || !ws.isOpen()) return;
  renderScope(false);
  if (R.scopeIds != null && R.scopeIds !== scopeIds()) schedule(0);
  else if (R.mode === "hits" && P.titleSig !== titleSig()) renderResults();
}

/**
 * 章节列表每次重画（删章、移动、多选、改章名、分卷）都会换掉里面的元素，盯着它就知道范围变没变。
 * 这些事发生时 ws.chapters 往往还没更新完，等列表画好再看才准。
 */
function watchChapterList() {
  const e = ws.els();
  if (!e || !e.list || typeof MutationObserver === "undefined") return null;
  let t = 0;
  const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(syncScope, 30); });
  mo.observe(e.list, { childList: true });
  return () => { clearTimeout(t); mo.disconnect(); };
}

function renderScope(forceRender) {
  if (!P || !ws.book) return;
  const sel = ws.selectedIds();
  const vols = volumeOptions();
  if (S.scope === "sel" && !sel.length) S.scope = "cur";
  if (S.scope.startsWith("vol:") && !vols.some((v) => v.value === S.scope)) S.scope = "book";
  const sig = [S.scope, sel.length, vols.map((v) => v.value + v.label).join("|")].join("/");
  if (!forceRender && sig === P.scopeSig) return;
  P.scopeSig = sig;
  const isVol = S.scope.startsWith("vol:");
  const seg = (value, label, on) => {
    const b = h("button.sr-seg", { type: "button", "aria-pressed": String(on) }, label);
    b.addEventListener("click", () => {
      if (value === "vol") {
        if (isVol) return;
        const curVol = ws.current && vols.find((v) => v.value === "vol:" + (ws.current.volumeId || ""));
        S.scope = (curVol || vols[0]).value;
      } else S.scope = value;
      renderScope(true);
      changed(0);
    });
    return b;
  };
  const items = [seg("cur", "本章", S.scope === "cur")];
  if (sel.length) items.push(seg("sel", `选中的 ${sel.length} 章`, S.scope === "sel"));
  if (vols.length) items.push(seg("vol", "某一卷", isVol));
  items.push(seg("book", "全书", S.scope === "book"));
  P.scope.replaceChildren(...items);
  if (isVol) {
    const s = h("select.select.sr-vol", { "aria-label": "哪一卷" }, vols.map((v) => h("option", { value: v.value }, v.label)));
    s.value = S.scope;
    s.addEventListener("change", () => { S.scope = s.value; P.scopeSig = ""; changed(0); });
    P.scope.append(s);
  }
}

// ---------------- 查找 ----------------
/** 作者改了条件：重新找 */
function changed(delay = DEBOUNCE) { hideDone(); schedule(delay); }
/** 正文变了、章节变了：悄悄重新找（不收起「已替换 · 撤销」） */
function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(runSearch, delay);
}
/** 有没找完的、正文改过的：先找完再往下走 */
async function flushPending() {
  for (let i = 0; i < 3; i++) {
    if (timer || stale()) await runSearch();
    else if (running) await running;
    else return;
  }
}

function wordsOf(c) { return ws.current && c.id === ws.current.id ? countWords(ws.editor.getText()) : c.words || 0; }

/** 当前章打过字以后，上次的结果位置就不准了 */
function stale() {
  if (!ws.current || !ws.editor || !snap.has(ws.current.id)) return false;
  return snap.get(ws.current.id) !== ws.editor.getText();
}

let running = null;        // 正在进行的这一次查找
function runSearch() {
  clearTimeout(timer);
  timer = 0;
  const p = doSearch();
  running = p;
  const done = () => { if (running === p) running = null; };
  p.then(done, done);
  return p;
}

async function doSearch() {
  if (!P || !ws.isOpen() || !ws.editor) return;
  const my = ++seq;
  const sig = sigOf();
  const scopeList = E.chaptersInScope(ws.chapters, S.scope, scopeOpts());
  const chapters = E.filterActive(S.filter) ? scopeList.filter((c) => E.chapterPasses(c, S.filter, wordsOf(c))) : scopeList;
  const m = E.buildMatcher(S.query, S);
  const scopeIdStr = scopeList.map((c) => c.id).join(",");

  if (m.error || !m.re) {
    stopWorker();
    lastSig = sig;
    flat = []; cur = -1; snap = new Map();
    const filtering = E.filterActive(S.filter);
    if (m.error) R = { mode: "error", error: m.error, detail: m.detail, scopeIds: scopeIdStr };
    else R = filtering ? { mode: "chapters", chapters: chapters.map((c) => c.id), total: chapters.length, scopeIds: scopeIdStr, of: scopeList.length } : { mode: "idle", scopeIds: scopeIdStr };
    renderResults(); applyMarks();
    if (!m.error && filtering) emitDone(R.total);
    return;
  }

  const texts = chapters.map((c) => ({ id: c.id, text: ws.textOf(c.id) }));
  let res = null;
  if (S.regex) {
    // 正则放进单独的线程里找：写出回溯很多的正则时页面不卡死，找太久就停下来说明
    const pending = scanInWorker(texts, m.re, S.wholeWord);
    if (pending) {
      const note = setTimeout(() => { if (P && my === seq) P.sum.replaceChildren(h("span", {}, "正在找…")); }, 150);
      res = await pending;
      clearTimeout(note);
      if (my !== seq || !P || !ws.isOpen()) return;
      if (res.cancelled) return;
      if (res.timeout) {
        lastSig = sig;
        flat = []; cur = -1; snap = new Map();
        R = { mode: "error", slow: true, error: `找了 ${REGEX_TIMEOUT / 1000} 秒还没找完，已经停下。正则里少用嵌套的 + 和 *，写得具体一点，或者缩小范围再找。`, scopeIds: scopeIdStr };
        renderResults(); applyMarks();
        return;
      }
      if (!res.groups) res = null;   // 线程出了问题，就在这里找
    }
  } else stopWorker();
  if (!res) res = E.searchChapters(texts, m.re, { wholeWord: S.wholeWord });

  const sameQuery = sig === lastSig;
  const oldSnap = snap, oldCur = flat[cur] || null;
  lastSig = sig;
  snap = new Map(texts.map((t) => [t.id, t.text]));
  flat = [];
  for (const g of res.groups) for (const hit of g.hits) flat.push({ chapterId: g.id, ...hit });

  // 正文改过：勾选状态和当前这一条跟着位置走
  const mappers = new Map();
  const mapPos = (cid, pos) => {
    const a = oldSnap.get(cid), b = snap.get(cid);
    if (a == null || b == null || a === b) return pos;
    if (!mappers.has(cid)) mappers.set(cid, E.makeMapper(a, b));
    return mappers.get(cid)(pos);
  };
  if (sameQuery) {
    const keep = new Set();
    for (const k of S.unchecked) { const cid = cidOf(k); keep.add(key(cid, mapPos(cid, posOf(k)))); }
    S.unchecked = keep;
  } else S.unchecked = new Set();
  cur = -1;
  if (sameQuery && oldCur) {
    const pos = mapPos(oldCur.chapterId, oldCur.from);
    cur = flat.findIndex((x) => x.chapterId === oldCur.chapterId && x.from === pos);
  }
  R = { mode: "hits", groups: res.groups, total: res.total, truncated: res.truncated, scopeIds: scopeIdStr, chapters: chapters.length };
  renderResults();
  applyMarks();
  emitDone(res.total);
}

// ---------------- 正则查找线程 ----------------
const REGEX_TIMEOUT = 3000;
let worker = null, workerUrl = "", workerOff = false, job = null, jobSeq = 0;

function startWorker() {
  if (!workerUrl) {
    const src = `const scan = ${E.scan.toString()};
onmessage = (e) => {
  const d = e.data;
  let res;
  try { res = scan(d.list, new RegExp(d.source, d.flags), d.wholeWord, d.limit); } catch (err) { res = { fail: String((err && err.message) || err) }; }
  postMessage({ id: d.id, res });
};`;
    workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  }
  const w = new Worker(workerUrl);
  w.onmessage = (e) => {
    if (!job || !e.data || e.data.id !== job.id) return;
    finishJob(e.data.res);
  };
  // 线程起不来（比如被安全设置挡住）：以后都在页面里找
  w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); workerOff = true; stopWorker({ fallback: true }); };
  return w;
}

function finishJob(res) {
  const j = job;
  job = null;
  if (!j) return;
  clearTimeout(j.timer);
  j.resolve(res);
}

/** 停掉正在找的线程（条件变了、关了面板、找太久） */
function stopWorker(res = { cancelled: true }) {
  if (!job) return;
  if (worker) { worker.terminate(); worker = null; }
  finishJob(res);
}

/** 在线程里找。线程用不了时返回 null，由调用的地方直接找 */
function scanInWorker(list, re, wholeWord) {
  if (workerOff || typeof Worker === "undefined") return null;
  stopWorker();
  try { if (!worker) worker = startWorker(); } catch (_) { workerOff = true; return null; }
  return new Promise((resolve) => {
    const id = ++jobSeq;
    job = { id, resolve, timer: setTimeout(() => stopWorker({ timeout: true }), REGEX_TIMEOUT) };
    worker.postMessage({ id, list, source: re.source, flags: re.flags, wholeWord, limit: E.MAX_HITS });
  });
}

function emitDone(count) {
  const s = JSON.stringify([sigOf(), S.scope, S.filter]);
  if (s === lastDone) return;
  lastDone = s;
  bus.emit("search:done", { count });
}

// ---------------- 结果列表 ----------------
function renderResults() {
  if (!P) return;
  const list = P.list;
  const scroll = list.scrollTop;
  // 重画前记住焦点在哪一条，画完放回去（键盘操作不会断）
  const a = document.activeElement;
  const row = a && list.contains(a) ? a.closest(".sr-hit") : null;
  const focus = row ? { i: row.dataset.i, cb: a.tagName === "INPUT" } : null;
  try { draw(); } finally { list.scrollTop = scroll; }
  if (focus) {
    const el = list.querySelector(`.sr-hit[data-i="${focus.i}"] ${focus.cb ? "input" : ".sr-go"}`) || list.querySelector(".sr-go");
    if (el) el.focus({ preventScroll: true });
  }
  if (P.saveBtn) P.saveBtn.disabled = !(S.query || E.filterActive(S.filter));
}

function draw() {
  const { list, sum, err } = P;
  list.textContent = "";
  sum.textContent = "";
  err.hidden = R.mode !== "error";
  P.q.classList.toggle("bad", R.mode === "error");
  P.q.setAttribute("aria-invalid", String(R.mode === "error"));
  if (R.mode === "error") {
    err.replaceChildren(h("b", {}, R.slow ? "正则太复杂：" : "正则写错了："), R.error, h("span.muted", {}, " 关掉「正则表达式」就按普通文字找。"));
    err.title = R.detail || "";
  }
  updateCount();
  updateReplaceButtons();

  if (R.mode === "idle") {
    list.append(h("div.empty", {}, S.showFilter ? "输入要找的字，或者勾一个筛选条件。" : "输入要找的字，回车跳到下一处。"));
    return;
  }
  if (R.mode === "error") return;
  if (R.mode === "chapters") return renderChapterList();

  if (!R.total) {
    sum.append(h("span", {}, "没找到"));
    list.append(h("div.empty", {}, emptyHint()));
    return;
  }
  sum.append(h("span", {}, `共 ${R.total} 处 · ${R.groups.length} 章`));
  if (S.showReplace) {
    const all = h("button.btn.small.ghost", { type: "button" }, "全选");
    const none = h("button.btn.small.ghost", { type: "button" }, "全不选");
    all.addEventListener("click", () => { S.unchecked.clear(); renderResults(); });
    none.addEventListener("click", () => { S.unchecked = new Set(flat.map((x) => key(x.chapterId, x.from))); renderResults(); });
    sum.append(h("span.grow"), all, none);
  }

  let n = 0, base = 0;
  for (const g of R.groups) {
    const c = chapterById(g.id);
    const text = snap.get(g.id) || "";
    const groupBase = base;
    base += g.hits.length;
    if (!c || n >= RENDER_LIMIT) continue;
    const head = h("div.sr-gh");
    if (S.showReplace) {
      const on = g.hits.filter((x) => !S.unchecked.has(key(g.id, x.from))).length;
      const cb = h("input", { type: "checkbox", "aria-label": "这一章全部替换 / 都不换" });
      cb.checked = on === g.hits.length;
      cb.indeterminate = on > 0 && on < g.hits.length;
      cb.addEventListener("change", () => {
        g.hits.forEach((x) => (cb.checked ? S.unchecked.delete(key(g.id, x.from)) : S.unchecked.add(key(g.id, x.from))));
        renderResults();
      });
      head.append(h("label.check", {}, cb));
    }
    const title = h("button.sr-gt", { type: "button", title: "跳到这一章的第一处" }, ws.fullTitle(c));
    title.addEventListener("click", () => goTo(groupBase));
    head.append(title, h("span.sr-gn", {}, g.hits.length));
    const sec = h("section.sr-group", { role: "listitem" }, head);
    g.hits.forEach((hit, j) => {
      if (n >= RENDER_LIMIT) return;
      n++;
      sec.append(hitRow(g.id, hit, groupBase + j, text));
    });
    list.append(sec);
  }
  if (R.total > n) list.append(h("p.sr-more.muted", {}, `还有 ${R.total - n} 处没列出来，按「下一处」逐个看。` + (S.showReplace ? "「全部替换」会连它们一起换。" : "")));
  if (R.truncated) list.append(h("p.sr-more.muted", {}, `命中太多，只找了前 ${E.MAX_HITS} 处。缩小范围或者多打几个字再找。` + (S.showReplace ? "「全部替换」只换找到的这些。" : "")));
  P.titleSig = titleSig();
}

function hitRow(cid, hit, idx, text) {
  const ctx = E.contextOf(text, hit.from, hit.to, 16);
  const row = h("div.sr-hit" + (idx === cur ? ".cur" : ""), { "data-i": String(idx) });
  if (S.showReplace) {
    const cb = h("input", { type: "checkbox", "aria-label": "替换这一处" });
    cb.checked = !S.unchecked.has(key(cid, hit.from));
    cb.addEventListener("change", () => {
      cb.checked ? S.unchecked.delete(key(cid, hit.from)) : S.unchecked.add(key(cid, hit.from));
      renderGroupBox(row); updateReplaceButtons();
    });
    row.append(h("label.check.sr-cb", {}, cb));
  }
  const rep = S.showReplace ? E.expandReplacement(S.replace, hit, S) : null;
  const go = h("button.sr-go", { type: "button" },
    h("span.sr-b", {}, ctx.before),
    S.showReplace ? h("del.sr-m", {}, vis(ctx.match)) : h("mark.sr-m", {}, vis(ctx.match)),
    S.showReplace && rep ? h("ins.sr-ins", {}, vis(rep)) : null,
    h("span.sr-a", {}, ctx.after));
  go.addEventListener("click", () => goTo(idx));
  row.append(go);
  return row;
}

/** 单条勾选变了，同步这一章标题上的勾 */
function renderGroupBox(row) {
  const sec = row.closest(".sr-group");
  const box = sec && sec.querySelector(".sr-gh input");
  if (!box) return;
  const all = [...sec.querySelectorAll(".sr-cb input")];
  const on = all.filter((x) => x.checked).length;
  box.checked = on === all.length;
  box.indeterminate = on > 0 && on < all.length;
}

function emptyHint() {
  const parts = [];
  if (S.scope === "cur") parts.push("本章没有。试试「全书」。");
  if (S.caseSensitive) parts.push("关掉「区分大小写」再试试。");
  if (S.wholeWord) parts.push("关掉「全字匹配」再试试。");
  if (E.filterActive(S.filter)) parts.push("筛选条件也会挡掉一些章。");
  return parts.join("") || "换个说法试试。";
}

function renderChapterList() {
  const { list, sum } = P;
  sum.append(h("span", {}, `符合条件的章：${R.total} / ${R.of}`));
  if (!R.total) { list.append(h("div.empty", {}, S.scope === "cur" ? "本章不符合筛选条件。试试「全书」。" : "没有符合条件的章。")); return; }
  for (const id of R.chapters) {
    const c = chapterById(id);
    if (!c) continue;
    const open = (c.points || []).filter((p) => !p.done).length;
    const meta = [`${wordsOf(c).toLocaleString()} 字`, open ? `${open} 条要点没打勾` : (c.points || []).length ? "要点都打勾了" : ""].filter(Boolean).join(" · ");
    const b = h("button.sr-ch" + (ws.current && ws.current.id === id ? ".cur" : ""), { type: "button" }, h("span.sr-ch-t", {}, ws.fullTitle(c)), h("span.sr-ch-m", {}, meta));
    b.addEventListener("click", async () => {
      if (!ws.current || ws.current.id !== id) await ws.openChapter(id, { anchor: 0, scroll: 0 });
      if (P) P.list.querySelectorAll(".sr-ch").forEach((x) => x.classList.toggle("cur", x === b));
    });
    list.append(h("div", { role: "listitem" }, b));
  }
}

function updateCount() {
  if (!P) return;
  P.count.textContent = R.mode === "hits" ? (cur >= 0 ? `${cur + 1}/${R.total}` : R.total ? String(R.total) : "0") : "";
}

function checkedHits() { return flat.filter((x) => !S.unchecked.has(key(x.chapterId, x.from))); }

function updateReplaceButtons() {
  if (!P) return;
  const ok = R.mode === "hits" && flat.length > 0;
  const n = ok ? checkedHits().length : 0;
  P.allBtn.textContent = n ? `全部替换（${n}）` : "全部替换";
  P.allBtn.disabled = !n || busy;
  P.oneBtn.disabled = !ok || busy;
  P.skipBtn.disabled = !ok;
}

// ---------------- 跳转和高亮 ----------------
function setCur(i) {
  cur = i;
  if (!P) return;
  P.list.querySelectorAll(".sr-hit.cur").forEach((x) => x.classList.remove("cur"));
  const row = P.list.querySelector(`.sr-hit[data-i="${i}"]`);
  if (row) { row.classList.add("cur"); row.scrollIntoView({ block: "nearest" }); }
  updateCount();
}

async function goTo(i) {
  if (!P) return;
  if (stale()) {
    // 当前章打过字：先重新找，再把要去的那一处换算到新位置
    const old = flat[i];
    const pos = old ? E.makeMapper(snap.get(old.chapterId) || "", ws.textOf(old.chapterId))(old.from) : 0;
    await runSearch();
    if (!P) return;
    if (old) {
      i = flat.findIndex((x) => x.chapterId === old.chapterId && x.from === pos);
      if (i < 0) i = nearestIn(old.chapterId, pos);
    }
  }
  const hit = flat[i];
  if (!hit) return;
  setCur(i);
  if (!ws.current || ws.current.id !== hit.chapterId) await ws.openChapter(hit.chapterId, { anchor: hit.from, head: hit.to });
  if (!P || !ws.current || ws.current.id !== hit.chapterId) return;
  ws.editor.select(hit.from, hit.to);
  applyMarks();
}

function nearestIn(cid, pos) {
  let best = -1;
  flat.forEach((x, i) => { if (x.chapterId === cid && (best < 0 || Math.abs(x.from - pos) < Math.abs(flat[best].from - pos))) best = i; });
  return best;
}

/** 光标后面的第一处（还没选过当前条时，回车从光标处往后找） */
function indexFromCursor(back) {
  if (!flat.length) return -1;
  const order = ws.chapters.map((c) => c.id);
  const ci = ws.current ? order.indexOf(ws.current.id) : -1;
  const head = ws.editor ? ws.editor.view.state.selection.main : { from: 0, to: 0 };
  const rank = (x) => order.indexOf(x.chapterId);
  if (!back) {
    const i = flat.findIndex((x) => rank(x) > ci || (rank(x) === ci && x.from >= head.from));
    return i >= 0 ? i : 0;
  }
  for (let i = flat.length - 1; i >= 0; i--) {
    const x = flat[i];
    if (rank(x) < ci || (rank(x) === ci && x.to <= head.to && x.from < head.from)) return i;
  }
  return flat.length - 1;
}

async function next() {
  await flushPending();
  if (!flat.length) return;
  const i = cur < 0 ? indexFromCursor(false) : (cur + 1) % flat.length;
  await goTo(i);
}
async function prev() {
  await flushPending();
  if (!flat.length) return;
  const i = cur < 0 ? indexFromCursor(true) : (cur - 1 + flat.length) % flat.length;
  await goTo(i);
}

function applyMarks() {
  if (!ws.editor || !ws.current) return;
  const id = ws.current.id;
  if (!P || (snap.has(id) && snap.get(id) !== ws.editor.getText())) {
    if (!P) clearMarks();
    else if (!timer) schedule(300);
    return;
  }
  const ranges = [];
  flat.forEach((x, i) => { if (x.chapterId === id) ranges.push({ from: x.from, to: x.to, cls: i === cur ? "cm-find-cur" : "cm-find" }); });
  ws.editor.mark(ranges);
  if (ranges.length) marked.add(id); else marked.delete(id);
}

function clearMarks() {
  if (!ws.editor || !ws.current) return;
  if (marked.has(ws.current.id)) { ws.editor.mark([]); marked.delete(ws.current.id); }
}

// ---------------- 替换 ----------------
function hideDone() { if (P) { P.done.hidden = true; P.done.textContent = ""; } }

function showDone(text, entry) {
  if (!P) return;
  const b = h("button.btn.small", { type: "button" }, icon("undo"), "撤销");
  b.addEventListener("click", async () => { hideDone(); await appUndo.undoEntry(entry); });
  P.done.replaceChildren(h("span", {}, text), b);
  P.done.hidden = false;
  P.doneEntry = entry;
}

async function applyChanges(label, changes, retry) {
  try {
    return await ws.applyBatch(label, changes);
  } catch (e) {
    notice({
      what: "替换没有全部完成。",
      why: "本地存储写不进去，可能磁盘空间不够，或者浏览器限制了网站存储。有几章可能已经换了，正文都在编辑器里，没有丢。",
      detail: e && (e.stack || e.message || e),
      actions: [{ label: "再试一次", primary: true, run: retry }],
    });
    return null;
  }
}

/** 一章换前、换后的正文和改动（撤销、重做时按改动换算位置） */
function changeInfo(before, after, edits) { return { before, after, fwd: edits, inv: E.invertEdits(edits) }; }

/**
 * 换过的章：上次查找时的正文、勾选、当前条都按改动直接换算到新位置，
 * 接着重新找时不用整篇比对（长章换了几千处也不卡）。dir: "redo" 换上，"undo" 换回。
 */
function shiftSnap(per, dir) {
  const mappers = new Map();
  for (const [cid, x] of per) {
    const from = dir === "undo" ? x.after : x.before;
    if (snap.get(cid) !== from) continue;   // 结果不是按这段正文找的，交给比对
    mappers.set(cid, E.editMapper(dir === "undo" ? x.inv : x.fwd));
    snap.set(cid, dir === "undo" ? x.before : x.after);
  }
  if (!mappers.size) return;
  const mp = (cid, p) => (mappers.has(cid) ? mappers.get(cid)(p) : p);
  S.unchecked = new Set([...S.unchecked].map((k) => key(cidOf(k), mp(cidOf(k), posOf(k)))));
  flat = flat.map((x) => (mappers.has(x.chapterId) ? { ...x, from: mp(x.chapterId, x.from), to: mp(x.chapterId, x.to) } : x));
}

/**
 * 替换的撤销条目：
 * 1. 撤销、重做时按改动换算查找结果的位置；
 * 2. 顶栏撤销、正文里 Ctrl+Z 是看「这一章的撤销深度对不对得上」来决定要不要整体撤销的。
 *    替换时打开着的章不在替换范围里、或者连着撤销两次替换时，深度会对不上，这里补上。
 */
function track(entry, per) {
  const at = new Map([...per].map(([cid, x]) => [cid, x.after]));
  if (ws.current && !at.has(ws.current.id)) at.set(ws.current.id, ws.editor.getText());
  entry.searchAfter = at;
  syncDepths(entry);
  const undo = entry.undo, redo = entry.redo;
  entry.undo = async () => {
    await undo();
    shiftSnap(per, "undo");
    const prev = appUndo.peek();
    if (prev && prev.searchAfter) syncDepths(prev);
  };
  entry.redo = async () => {
    await redo();
    shiftSnap(per, "redo");
    syncDepths(entry);
  };
}

/** 正文还是这条操作刚做完的样子的章：记下现在的撤销深度 */
function syncDepths(entry) {
  if (!ws.editor || !entry.chapters) return;
  for (const [cid, text] of entry.searchAfter) {
    if (ws.textOf(cid) !== text) continue;
    const d = ws.editor.depthOf(cid);
    if (d >= 0) entry.chapters[cid] = d;
  }
}

async function replaceOne() {
  if (busy || !P) return;
  busy = true; updateReplaceButtons();
  try {
    await flushPending();
    if (!P || R.mode !== "hits" || !flat.length) return;
    // 还没选中哪一处：先跳过去让作者看一眼，再按一次才换
    if (cur < 0) { await next(); return; }
    const hit = flat[cur];
    const text = ws.textOf(hit.chapterId);
    if (text.slice(hit.from, hit.to) !== hit.m[0]) { await runSearch(); return; }
    const rep = E.expandReplacement(S.replace, hit, S);
    // 换前换后一样：不动正文，直接看下一处
    if (rep === hit.m[0]) { await goTo((cur + 1) % flat.length); return; }
    const after = text.slice(0, hit.from) + rep + text.slice(hit.to);
    const entry = await applyChanges("替换 1 处", [{ chapterId: hit.chapterId, after }], replaceOne);
    if (!entry) return;
    const per = new Map([[hit.chapterId, changeInfo(text, after, [{ from: hit.from, to: hit.to, len: rep.length }])]]);
    track(entry, per);
    shiftSnap(per, "redo");
    bus.emit("replace:done", { count: 1 });
    if (!P) return;
    await runSearch();
    if (!P) return;
    // 接着从换完的地方往后找
    const order = ws.chapters.map((c) => c.id);
    const at = order.indexOf(hit.chapterId), pos = hit.from + rep.length;
    let i = flat.findIndex((x) => (x.chapterId === hit.chapterId && x.from >= pos) || order.indexOf(x.chapterId) > at);
    if (i < 0 && flat.length) i = 0;
    if (i >= 0) await goTo(i); else setCur(-1);
    if (!flat.length) S.pristine = true;
    showDone("已替换 1 处", entry);
  } finally {
    busy = false;
    updateReplaceButtons();
  }
}

async function replaceAll() {
  if (busy || !P) return;
  busy = true; updateReplaceButtons();
  try {
    await flushPending();
    if (!P || R.mode !== "hits") return;
    const pick = checkedHits();
    if (!pick.length) { toast("没有勾选要替换的地方"); return; }
    const by = new Map();
    for (const x of pick) { if (!by.has(x.chapterId)) by.set(x.chapterId, []); by.get(x.chapterId).push(x); }
    const changes = [], per = new Map();
    let count = 0;
    for (const [cid, hits] of by) {
      const before = ws.textOf(cid);
      if (hits.some((x) => before.slice(x.from, x.to) !== x.m[0])) { await runSearch(); toast("正文刚改过，结果已经更新，请再确认一次"); return; }
      const edits = [];
      const after = E.replaceHits(before, hits, S.replace, S, edits);
      if (after !== before) { changes.push({ chapterId: cid, after }); per.set(cid, changeInfo(before, after, edits)); count += hits.length; }
    }
    if (!changes.length) { toast("替换前后一样，没有要改的"); return; }
    const label = `替换「${short(S.query)}」→「${short(S.replace)}」`;
    const entry = await applyChanges(label, changes, replaceAll);
    if (!entry) return;
    track(entry, per);
    shiftSnap(per, "redo");
    S.unchecked.clear();
    S.pristine = true;
    if (P) { await runSearch(); showDone(`已替换 ${count} 处（${changes.length} 章）`, entry); }
    bus.emit("replace:done", { count });
    toast(`已替换 ${count} 处`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
  } finally {
    busy = false;
    updateReplaceButtons();
  }
}

// ---------------- 常用筛选 ----------------
function currentCond() {
  return { query: S.query, regex: S.regex, caseSensitive: S.caseSensitive, wholeWord: S.wholeWord,
    scope: S.scope === "sel" ? "book" : S.scope, filter: { ...S.filter } };
}

function renderPresets() {
  if (!P) return;
  const row = P.presetRow;
  row.hidden = !(presets.length || S.showFilter);
  if (row.hidden) { row.textContent = ""; P.saveBtn = null; return; }
  const items = presets.map((p) => {
    const b = h("button.sr-chip-b", { type: "button", title: E.describe(p.cond) }, p.name);
    b.addEventListener("click", () => applyPreset(p));
    const x = h("button.sr-chip-x", { type: "button", "aria-label": `删掉常用筛选「${p.name}」`, title: "删掉" }, icon("close"));
    x.addEventListener("click", () => deletePreset(p));
    return h("span.sr-chip", {}, b, x);
  });
  const can = !!S.query || E.filterActive(S.filter);
  const save = h("button.btn.small.ghost.sr-save", { type: "button", disabled: !can, title: "把现在的条件存起来，下次一点就用" }, icon("plus"), "存为常用");
  save.addEventListener("click", savePreset);
  P.saveBtn = save;
  row.replaceChildren(h("span.sr-lab.muted", {}, "常用"), ...items, save);
}

function applyPreset(p) {
  const c = p.cond || {};
  Object.assign(S, { query: c.query || "", regex: !!c.regex, caseSensitive: !!c.caseSensitive, wholeWord: !!c.wholeWord,
    scope: c.scope || "book", filter: { ...E.EMPTY_FILTER, ...(c.filter || {}) } });
  if (S.regex) S.advanced = true;
  if (E.filterActive(S.filter)) S.showFilter = true;
  sync();
  changed(0);
  P.q.focus();
}

async function savePreset() {
  const bookId = S.bookId;
  const cond = currentCond();
  const name = await prompt("给这组条件起个名字", E.describe(cond), "名字");
  if (name == null) return;
  const item = { id: uid("f"), name: name.trim() || E.describe(cond), cond };
  const before = presets.slice();
  try { await setPresets(bookId, [...before, item]); } catch (e) { return presetError(e, "常用筛选没存上。", savePreset); }
  const entry = appUndo.push({
    label: "存常用筛选",
    undo: () => setPresets(bookId, before),
    redo: () => setPresets(bookId, [...before, item]),
  });
  toast(`已存为常用：${item.name}`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
}

async function deletePreset(p) {
  const bookId = S.bookId;
  const before = presets.slice();
  try { await setPresets(bookId, before.filter((x) => x.id !== p.id)); } catch (e) { return presetError(e, `常用筛选「${p.name}」没删掉。`, () => deletePreset(p)); }
  const entry = appUndo.push({
    label: "删除常用筛选",
    undo: () => setPresets(bookId, before),
    redo: () => setPresets(bookId, before.filter((x) => x.id !== p.id)),
  });
  toast(`已删除「${p.name}」`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
}

function presetError(e, what, retry) {
  notice({
    what,
    why: "本地存储写不进去，可能磁盘空间不够，或者浏览器限制了网站存储。",
    detail: e && (e.stack || e.message || e),
    actions: [{ label: "再试一次", primary: true, run: retry }],
  });
}

// ---------------- 注册 ----------------
export async function register() {
  const inBook = () => ws.isOpen() && !!ws.editor;
  const open = () => !!P;
  commands.register({ id: "search.open", title: "查找", keywords: "找字 搜索 查找 搜一下 定位 在哪", hint: "在本章里找字，点结果跳过去", key: "Mod-f", when: inBook, run: () => openSearch({ scope: "cur" }) });
  commands.register({ id: "search.book", title: "在全书里查找", keywords: "全书 所有章节 搜索 找字 查找", hint: "按章节列出全书里每一处", key: "Mod-Shift-f", when: inBook, run: () => openSearch({ scope: "book" }) });
  commands.register({ id: "search.replace", title: "替换", keywords: "替换 改字 批量替换 全书替换 改名 换成", hint: "先列出每一处，可以挑着换，能整体撤销", key: "Mod-h", when: inBook, run: () => openSearch({ replace: true }) });
  commands.register({ id: "search.filter", title: "筛选章节", keywords: "筛选 过滤 要点没打完 没写完 字数少 短的章", hint: "按要点、字数挑出章节，条件能存起来", when: inBook, run: () => openSearch({ filter: true, scope: P ? undefined : "book" }) });
  commands.register({ id: "search.next", title: "下一处", keywords: "查找 下一个 找下一个", hint: "查找面板开着时，跳到下一处", key: "F3", when: open, run: () => next() });
  commands.register({ id: "search.prev", title: "上一处", keywords: "查找 上一个 找上一个", hint: "查找面板开着时，跳到上一处", key: "Shift-F3", when: open, run: () => prev() });

  // 离开作品前先关掉面板（草稿留着）
  nav.onLeave(() => { if (P) closeSearch(true); return {}; });

  bus.on("content:saved", ({ chapter }) => {
    if (!P || !chapter) return;
    if (snap.has(chapter.id) || (R.scopeIds || "").split(",").includes(chapter.id)) schedule(300);
  });
  // 撤销、重做以后重新找；面板里的「已替换 · 撤销」对应的那一步已经撤掉了，就收起来
  const afterUndo = () => {
    if (!P) return;
    schedule(50);
    if (P.doneEntry && appUndo.peek() !== P.doneEntry) hideDone();
  };
  bus.on("undo", afterUndo);
  bus.on("redo", afterUndo);
  // 章节增删、移动、分卷：范围按钮和范围里的章变了才重画、重新找（打开某章也会改作品信息，不用每次都画）
  const later = () => { if (P) setTimeout(syncScope, 0); };
  for (const t of ["chapter:created", "chapter:deleted", "chapter:moved", "book:updated"]) bus.on(t, later);
  bus.on("chapter:opened", ({ chapter }) => {
    if (P) { if (S.scope === "cur") schedule(0); else applyMarks(); return; }
    if (chapter && marked.has(chapter.id) && ws.editor) { ws.editor.mark([]); marked.delete(chapter.id); }
  });
}
