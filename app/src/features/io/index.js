// 导入、导出、整本备份。
//   导入 txt / md：自动认编码，按「第X章」拆章；先在预览里看一遍（并章、改章名、楔子怎么放、导成新书还是接到已有作品后面），
//     确认后一次建好，算一步撤销（新书撤销时放进回收站）。书架上直接拖文件进来也行。
//   导出 txt / md：整本、本章、选中的几章或自己挑；可选「网文平台排版」（用一键排版的规则和方案，只改导出的文件）。
//   整本备份：一个 .xemo.json 文件（作品信息、章节、要点、码字记录），换电脑后「导入」它；书架上已有同一本时问另存还是覆盖。
// 发出的事件：io:imported { book, count, append }、io:exported { format, count }、io:backup { count }、io:restored { books }
import { db, uid } from "../../core/db.js";
import { DEFAULT_BOOK, listBooks, getBook, listChapters, trashBook, restoreFromTrash, listTrash, getStats } from "../../core/store.js";
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { commands } from "../../core/commands.js";
import { h, icon, modal, toast, notice, choose, prompt, confirm, hasLayers, helpTip } from "../../core/ui.js";
import { chapterLabel, volumeLabel, countWords, fmtTime, todayKey } from "../../core/text.js";
import { label } from "../../core/settings.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { RULES, formatText, getSchemes, saveScheme, getUserSchemes, setUserSchemes, normalizeRules, sameRules, isBuiltinScheme } from "../format/engine.js";
import * as P from "./parse.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 300;             // 预览里一次最多列这么多行，再多点「全部列出」
const DRAFT_KEY = "io:import-draft";
const EXPORT_KEY = "io:export";
const LATER = ["docx", "doc", "epub", "pdf", "mobi", "azw3", "rtf"];
const errText = (e) => (e && (e.stack || e.message)) || String(e || "");
const sizeText = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");

// ---------------- 小工具 ----------------
/** 下载文件：a[download] + Blob */
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

/** 弹出选文件的框；取消了返回 null */
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, hidden: true });
    const done = (f) => { resolve(f); input.remove(); };
    input.addEventListener("change", () => done(input.files[0] || null));
    input.addEventListener("cancel", () => done(null));
    document.body.append(input);
    input.click();
  });
}

/** 一组互斥的按钮（范围、格式） */
function seg(options, value, onPick, ariaLabel) {
  const box = h("div.io-seg", { role: "group", "aria-label": ariaLabel });
  for (const [id, text] of options) {
    const b = h("button", { type: "button", "aria-pressed": String(id === value), "data-v": id }, text);
    b.addEventListener("click", () => onPick(id));
    box.append(b);
  }
  return box;
}

/** 文件内容的指纹（认「是不是同一个文件」，接着上次的草稿用） */
function hashBytes(b) {
  let x = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { x ^= b[i]; x = Math.imul(x, 0x01000193); }
  return (x >>> 0).toString(36);
}

const snippet = (s, n = 24) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** 写作界面正开着这本书：先把没存的正文存进去，再回书架（覆盖、撤销时用，免得编辑器把旧正文存回去） */
async function leaveBook(bookId) {
  if (!ws.book || ws.book.id !== bookId) return;
  try { if (ws.editor) await ws.editor.flush(); } catch (_) { /* 保存失败另有提示 */ }
  await nav.go("/", { replace: true });
}

async function refreshShelf() {
  const c = nav.current();
  if (c && c.name === "shelf") await nav.go("/", { replace: true });
}

async function flushIfOpen(bookId) {
  if (ws.book && ws.book.id === bookId && ws.editor) {
    try { await ws.editor.flush(); } catch (_) { /* 保存失败另有提示，这里用库里的 */ }
  }
}

/** 读一本书现在的样子（作品、章节、码字记录），书不在返回 null */
async function snapshot(bookId) {
  const book = await getBook(bookId);
  if (!book) return null;
  return { book, chapters: await listChapters(bookId), stats: await getStats(bookId) };
}

/**
 * 一次事务里把几本书换成指定的样子。changes: [{ bookId, now, to, trash, untrash }]
 *   now 现在的快照（会被拿掉）；to 换成的快照（null 就是不留）；trash 拿掉的放进回收站；untrash 顺便删掉这个回收站条目
 * 返回 { [bookId]: 新回收站条目 id }
 */
async function swapBooks(changes) {
  const t = Date.now();
  const made = {};
  await db.tx(["books", "chapters", "trash", "kv"], (s) => {
    for (const c of changes) {
      if (c.now) {
        c.now.chapters.forEach((ch) => s.chapters.delete(ch.id));
        s.books.delete(c.bookId);
        if (c.trash) {
          const e = { id: uid("t"), kind: "book", bookId: c.bookId, title: c.now.book.title, data: { book: c.now.book, chapters: c.now.chapters }, deletedAt: t };
          s.trash.put(e);
          made[c.bookId] = e.id;
        }
      }
      if (c.untrash) s.trash.delete(c.untrash);
      if (c.to) {
        s.books.put(c.to.book);
        c.to.chapters.forEach((ch) => s.chapters.put(ch));
        s.kv.put({ key: "stats:" + c.bookId, value: c.to.stats || {} });
      }
    }
  });
  return made;
}

function chapterRow(bookId, order, c, volumeId, t) {
  return { id: uid("c"), bookId, order, volumeId, title: (c.title || "").slice(0, 60), content: c.content || "", points: [],
    words: countWords(c.content || ""), createdAt: t, updatedAt: t };
}

// ---------------- 导入：开始 ----------------
let startDlg = null;

/** 导入弹窗：选文件或拖进来。opts.restore 只认备份文件；opts.bookId 默认追加到这本 */
function openImport(opts = {}) {
  if (startDlg) startDlg.close(true);
  const restore = !!opts.restore;
  const accept = restore ? ".json,.xemo.json" : ".txt,.text,.md,.markdown,.json,.docx,.doc,.epub";
  const zone = h("button.io-drop", { type: "button" }, icon("upload"),
    h("b", {}, restore ? "选备份文件" : "选一个文件"), h("span", {}, "也可以直接拖到这里"));
  const fmts = h("ul.io-fmts", {},
    restore ? null : h("li", {}, h("b", {}, "txt、md"), h("span", {}, "按「第X章」自动拆章，导入前先预览")),
    h("li", {}, h("b", {}, ".xemo.json"), h("span", {}, "整本备份，章节、要点、码字记录原样回来")),
    restore ? null : h("li.later", {}, h("b", {}, "docx、epub"), h("span", {}, "下一版支持。现在可以先在 Word 里另存为 txt")));
  const m = modal({ title: restore ? "从备份恢复" : "导入", body: h("div.io-start", {}, zone, fmts), onClose: () => { if (startDlg === m) startDlg = null; } });
  startDlg = m;
  const go = (f) => { if (!f) return; m.close(true); handleFile(f, opts); };
  zone.addEventListener("click", async () => go(await pickFile(accept)));
  zone.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; zone.classList.add("over"); } });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("over");
    go(e.dataTransfer.files[0]);
  });
}

const hasFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"));

async function handleFile(file, opts = {}) {
  const ext = P.extOf(file.name);
  if (ext === "xemo" || ext === "json") return restoreFile(file);
  if (LATER.includes(ext)) return laterFormat(ext);
  if (file.size > MAX_BYTES) {
    notice({ what: `「${file.name}」有 ${sizeText(file.size)}，太大了，这一版导不进来。`, why: "一本小说的 txt 一般在 20 MB 以内。这个文件可能不是纯文字，或者是好几本合在一起。",
      actions: [{ label: "换一个文件", primary: true, run: () => openImport(opts) }] });
    return;
  }
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch (e) { readError(file, e, opts); return; }
  if (!bytes.length) {
    notice({ what: `「${file.name}」是空的。`, why: "文件里没有文字，或者保存的时候出了问题。", actions: [{ label: "换一个文件", primary: true, run: () => openImport(opts) }] });
    return;
  }
  openPreview({ name: file.name, size: file.size, bytes, md: ext === "md" || ext === "markdown" }, opts);
}

function readError(file, e, opts) {
  notice({
    what: `「${file.name}」读不出来。`,
    why: "文件可能被移走了、正被别的程序占用，或者没有读取权限。",
    detail: errText(e),
    actions: [{ label: "重新选文件", primary: true, run: () => openImport(opts) }],
  });
}

async function laterFormat(ext) {
  const name = ext.toUpperCase();
  const r = await choose({
    title: `${name} 下一版支持`,
    body: `这一版能导入 txt 和 md。可以先把它另存为纯文本（.txt，编码选 UTF-8），再导进来。`,
    buttons: [{ id: "pick", label: "换一个文件", primary: true }, { id: "ok", label: "知道了" }],
  });
  if (r === "pick") openImport();
}

// ---------------- 导入：预览 ----------------
let preview = null;

async function openPreview(src, opts = {}) {
  if (preview && !(await preview.close())) return;
  const books = await listBooks();
  const sig = [src.name, src.size, hashBytes(src.bytes)].join("|");
  let draft = null;
  try { draft = await db.getKV(DRAFT_KEY, null); } catch (_) { /* 读不到草稿就重新认 */ }
  if (draft && draft.sig !== sig) draft = null;
  const detected = P.detectEncoding(src.bytes);
  const wantBook = opts.bookId && books.some((b) => b.id === opts.bookId) ? opts.bookId : "new";
  const st = {
    enc: draft && P.ENCODINGS.some((e) => e.id === draft.enc) ? draft.enc : detected.encoding, text: "", garbled: false, counts: null,
    units: [], mdLevel: 0, preface: "", items: [], prefaceMode: "own", prefaceTitle: "楔子",
    title: P.baseName(src.name) || "导入的作品", target: wantBook,
    history: [], touched: false, busy: false, done: false, showAll: false, fromDraft: false,
  };
  const words = new WeakMap();
  const wordsOf = (it) => { if (!words.has(it)) words.set(it, countWords(it.content || "")); return words.get(it); };
  let preCache = [null, 0];
  const preWords = () => { if (preCache[0] !== st.preface) preCache = [st.preface, countWords(st.preface || "")]; return preCache[1]; };
  const chCount = new Map();     // 追加时那本书已经有几章（章节号接着数）
  const loadCount = async (id) => { if (id !== "new" && !chCount.has(id)) chCount.set(id, (await listChapters(id)).length); };
  const targetBook = () => books.find((b) => b.id === st.target) || null;
  const volumesOk = () => st.target === "new" || !!(targetBook() && targetBook().useVolumes);

  function decode() {
    try { st.text = P.decodeAs(src.bytes, st.enc).replace(/^\uFEFF/, ""); }
    catch (_) { st.enc = "gb18030"; st.text = P.decodeAs(src.bytes, st.enc); }
    st.garbled = P.looksGarbled(st.text);
    st.counts = P.scanHeadings(st.text, { md: src.md });
  }
  function split(keepUnits) {
    if (!keepUnits) Object.assign(st, P.defaultUnits(st.counts, { volumes: volumesOk() }));
    const r = P.splitText(st.text, { units: st.units, md: src.md, mdLevel: st.mdLevel });
    st.preface = r.preface;
    st.items = r.items;
  }
  decode();
  if (draft) {
    Object.assign(st, { units: draft.units, mdLevel: draft.mdLevel, items: draft.items, preface: draft.preface, prefaceMode: draft.prefaceMode,
      prefaceTitle: draft.prefaceTitle, title: draft.title, fromDraft: true, touched: true });
    if (draft.target === "new" || books.some((b) => b.id === draft.target)) st.target = draft.target;
  } else split(false);

  // ---- 界面 ----
  const encSel = h("select.select.io-enc", { "aria-label": "文字编码" },
    ...P.ENCODINGS.map((e) => h("option", { value: e.id }, e.name + (e.id === detected.encoding ? "（认出来的）" : ""))));
  const srcLine = h("div.io-src", {}, h("span.io-file", { title: src.name }, src.name), h("span.muted", {}, sizeText(src.size)),
    h("label.io-enc-l", {}, h("span.muted", {}, "编码"), encSel));
  const warnBox = h("div.io-warn", { role: "alert" });
  const draftBox = h("div.io-note");
  const titleIn = h("input.input", { maxlength: "60", "aria-label": "书名" });
  const targetSel = h("select.select", { "aria-label": "导入到" });
  const titleField = h("label.field", {}, h("span", {}, "书名"), titleIn);
  const fields = h("div.io-fields", {}, titleField, h("label.field", {}, h("span", {}, "导入到"), targetSel));
  const unitBox = h("div.io-units", { role: "group", "aria-label": "按哪种标题分章" });
  const preBox = h("div.io-pre");
  const sum = h("div.io-sum", { role: "status", "aria-live": "polite" });
  const undoBtn = h("button.btn.small.ghost", { type: "button", disabled: true }, icon("undo"), "撤销上一步");
  const list = h("div.io-list", { role: "list", "aria-label": "认出的章节" });
  const body = h("div.io-pv", {}, srcLine, warnBox, draftBox, fields, unitBox, preBox, h("div.io-listbar", {}, sum, undoBtn), list);

  const m = modal({
    title: "导入预览", body, wide: true,
    isDirty: () => st.touched && !st.done,
    onKeepDraft: () => saveDraft(),
    onClose: () => { if (preview === api) preview = null; },
    actions: [
      { label: "导入", primary: true, onClick: () => commit() },
      { label: "取消", onClick: (layer) => layer.close() },
    ],
  });
  m.el.classList.add("io-modal");
  const okBtn = m.foot.querySelector(".btn.primary");

  encSel.value = st.enc;
  encSel.addEventListener("change", () => {
    st.enc = encSel.value;
    st.touched = true;
    st.history = [];
    decode();
    split(false);
    renderAll();
  });
  titleIn.value = st.title;
  titleIn.addEventListener("input", () => { st.title = titleIn.value; st.touched = true; });
  targetSel.addEventListener("change", async () => {
    await loadCount(targetSel.value);
    st.target = targetSel.value;
    st.touched = true;
    if (!volumesOk() && st.units.includes("卷")) { pushHistory(); st.units = st.units.filter((u) => u !== "卷"); split(true); }
    renderAll();
  });
  undoBtn.addEventListener("click", () => {
    const s = st.history.pop();
    if (!s) return;
    Object.assign(st, s);
    renderAll();
  });

  function pushHistory() {
    st.history.push({ items: st.items, units: st.units, mdLevel: st.mdLevel, preface: st.preface, prefaceMode: st.prefaceMode });
    if (st.history.length > 50) st.history.shift();
  }

  async function saveDraft() {
    try {
      await db.setKV(DRAFT_KEY, { sig, enc: st.enc, units: st.units, mdLevel: st.mdLevel, items: st.items, preface: st.preface,
        prefaceMode: st.prefaceMode, prefaceTitle: st.prefaceTitle, title: st.title, target: st.target, at: Date.now() });
      toast("调整先留着，下次导入同一个文件时接着用");
    } catch (_) { toast("草稿没能存上"); }
  }

  function renderTop() {
    warnBox.replaceChildren();
    warnBox.hidden = !st.garbled;
    if (st.garbled) {
      const others = P.ENCODINGS.filter((e) => e.id !== st.enc).slice(0, 3);
      warnBox.append(h("span", {}, "看起来像乱码，换个编码试试："),
        ...others.map((e) => h("button.btn.small", { type: "button", onclick: () => { encSel.value = e.id; encSel.dispatchEvent(new Event("change")); } }, e.name)));
    }
    draftBox.replaceChildren();
    draftBox.hidden = !st.fromDraft;
    if (st.fromDraft) {
      draftBox.append(h("span", {}, "接着上次没导完的调整。"),
        h("button.btn.small.ghost", { type: "button", onclick: () => {
          st.fromDraft = false; st.history = []; st.touched = false;
          st.prefaceMode = "own"; st.prefaceTitle = "楔子"; st.title = P.baseName(src.name) || "导入的作品";
          titleIn.value = st.title;
          db.setKV(DRAFT_KEY, null).catch(() => {});
          split(false);
          renderAll();
        } }, "重新识别"));
    }
    targetSel.replaceChildren(h("option", { value: "new" }, "新作品"),
      ...[...books].sort((a, b) => (ws.book && a.id === ws.book.id ? -1 : ws.book && b.id === ws.book.id ? 1 : 0))
        .map((b) => h("option", { value: b.id }, "追加到《" + b.title + "》" + (ws.book && ws.book.id === b.id ? "（正在写）" : ""))));
    targetSel.value = st.target;
    titleField.hidden = st.target !== "new";
  }

  function renderUnits() {
    unitBox.replaceChildren();
    const c = st.counts;
    const any = P.UNITS.some((u) => c[u.id]);
    if (!any && !st.mdLevel) {
      unitBox.append(h("p.io-none", {}, "没认出「第X章」这样的章名，整篇会放进一章。导入以后可以在作品里再拆。"));
      return;
    }
    unitBox.append(h("span.io-label", {}, "按这些分章"));
    for (const u of P.UNITS) {
      if (!c[u.id]) continue;
      const blocked = u.id === "卷" && !volumesOk();
      const cb = h("input", { type: "checkbox", "data-unit": u.id, disabled: blocked });
      cb.checked = st.units.includes(u.id);
      cb.addEventListener("change", () => {
        pushHistory();
        st.units = cb.checked ? [...st.units, u.id] : st.units.filter((x) => x !== u.id);
        st.touched = true;
        split(true);
        renderAll();
      });
      unitBox.append(h("label.check.io-unit", { title: blocked ? "这本书没开分卷，卷名留在正文里" : "" }, cb, `${u.name} ${c[u.id]} 处`));
    }
    if (st.mdLevel) {
      const cb = h("input", { type: "checkbox", "data-unit": "md" });
      cb.checked = true;
      cb.addEventListener("change", () => {
        pushHistory();
        st.mdLevel = cb.checked ? P.defaultUnits(st.counts).mdLevel : 0;
        st.touched = true;
        split(true);
        renderAll();
      });
      unitBox.append(h("label.check.io-unit", {}, cb, `${"#".repeat(st.mdLevel)} 标题 ${c.md[st.mdLevel]} 处`));
    }
    if (c["卷"] && !volumesOk()) unitBox.append(h("span.io-hint", {}, "这本书没开分卷，卷名留在正文里。"));
  }

  function renderPreface() {
    preBox.replaceChildren();
    const pre = st.preface && st.preface.trim() ? st.preface : "";
    const hasCh = st.items.some((it) => it.type === "chapter");
    preBox.hidden = !pre || !hasCh;
    if (preBox.hidden) return;
    const radio = (v, text) => {
      const rb = h("input", { type: "radio", name: "io-pre", value: v });
      rb.checked = st.prefaceMode === v;
      rb.addEventListener("change", () => { if (!rb.checked) return; pushHistory(); st.prefaceMode = v; st.touched = true; renderAll(); });
      return h("label.check", {}, rb, text);
    };
    const ptitle = h("input.input.io-ptitle", { value: st.prefaceTitle, maxlength: "30", "aria-label": "单独一章时的章名", disabled: st.prefaceMode !== "own" });
    ptitle.addEventListener("input", () => { st.prefaceTitle = ptitle.value; st.touched = true; renderList(); renderSum(); });
    preBox.append(
      h("p.io-pre-t", {}, `第一个章名前面有 ${preWords().toLocaleString()} 字：`, h("span.muted", {}, "「" + snippet(pre, 30) + "」")),
      h("div.io-pre-opts", { role: "radiogroup", "aria-label": "开头这段怎么放" },
        h("span.io-own", {}, radio("own", "单独一章，章名"), ptitle), radio("merge", "并入第一章"), radio("drop", "不导入")));
  }

  function plan() {
    return P.assemble({ preface: st.preface, items: st.items }, { prefaceMode: st.prefaceMode, prefaceTitle: st.prefaceTitle.trim(), leadIntoFirst: st.target === "new" });
  }

  function renderSum() {
    const p = plan();
    const hasCh = st.items.some((it) => it.type === "chapter");
    const total = st.items.reduce((s, it) => s + (it.type === "chapter" ? wordsOf(it) : 0), 0) + (st.prefaceMode !== "drop" || !hasCh ? preWords() : 0);
    const gaps = P.numberGaps(st.items);
    sum.replaceChildren(h("span", {}, `共 ${p.chapters.length} 章` + (p.volumes.length && volumesOk() ? ` · ${p.volumes.length} 卷` : "") + ` · ${total.toLocaleString()} 字`),
      gaps.length ? h("span.io-gapsum", {}, `有 ${gaps.length} 处章节号不连续，看看是不是把正文当成了章名`) : null);
    undoBtn.disabled = !st.history.length;
    okBtn.disabled = st.busy;
  }

  function renderList() {
    const tb = st.target === "new" ? null : targetBook();
    const numbering = tb ? tb.numbering : "zh";
    let n = tb ? chCount.get(tb.id) || 0 : 0;
    let v = tb && tb.useVolumes ? (tb.volumes || []).length : 0;
    const gaps = new Map(P.numberGaps(st.items).map((g) => [g.index, g]));
    const pre = st.preface && st.preface.trim() && st.items.some((it) => it.type === "chapter");
    list.replaceChildren();
    if (pre && st.prefaceMode === "own") {
      n++;
      list.append(h("div.io-row.pre", { role: "listitem" }, h("span.io-no", {}, chapterLabel(n, numbering)),
        h("span.io-title.io-fixed", {}, st.prefaceTitle.trim() || "（没有章名）"), h("span.io-snip", {}, snippet(st.preface)),
        h("span.io-words", {}, preWords().toLocaleString() + " 字")));
    }
    const shown = st.showAll ? st.items.length : Math.min(st.items.length, MAX_ROWS);
    for (let i = 0; i < st.items.length; i++) {
      const it = st.items[i];
      if (it.type === "volume") v++; else n++;
      if (i >= shown) continue;
      const isVol = it.type === "volume";
      const no = isVol ? volumeLabel(v, numbering) : chapterLabel(n, numbering);
      const tIn = h("input.input.io-title", { value: it.title, maxlength: "60", placeholder: isVol ? "卷名" : (it.unit === "intro" ? "卷首的文字" : "没有章名"), "aria-label": no + " 的名字" });
      tIn.addEventListener("input", () => { it.title = tIn.value; st.touched = true; });
      const g = gaps.get(i);
      const merge = h("button.btn.small.ghost.io-merge", { type: "button", disabled: !P.canMergeUp(st.items, i),
        title: i === 0 ? "前面没有章了" : st.items[i - 1].type !== "chapter" ? "上面是卷名，不能并" : "把这一行当正文，接到上一章后面" }, "并到上一章");
      merge.addEventListener("click", () => {
        pushHistory();
        st.items = P.mergeUp(st.items, i);
        st.touched = true;
        renderAll();
        const next = list.querySelector(`.io-row[data-i="${Math.max(0, i - 1)}"] .io-merge`);
        if (next) next.focus();
      });
      list.append(h("div.io-row" + (isVol ? ".vol" : ""), { role: "listitem", "data-i": String(i) },
        h("span.io-no", { title: it.raw ? "原文：" + it.raw : "" }, no),
        tIn,
        isVol ? h("span.io-snip", {}, "分卷") : h("span.io-snip", {}, snippet(it.content) || "（空的）"),
        isVol ? null : h("span.io-words", {}, wordsOf(it).toLocaleString() + " 字"),
        g ? h("span.io-gap", { title: `上一个是第 ${g.prev} ${it.unit}` }, "号不连续") : null,
        merge));
    }
    if (shown < st.items.length) {
      list.append(h("div.io-more", {}, h("span.muted", {}, `还有 ${st.items.length - shown} 行没列出来，导入时一起建。`),
        h("button.btn.small", { type: "button", onclick: () => { st.showAll = true; renderList(); } }, "全部列出")));
    }
  }

  function renderAll() {
    renderTop();
    renderUnits();
    renderPreface();
    renderSum();
    renderList();
  }

  async function commit() {
    if (st.busy) return;
    st.busy = true;
    okBtn.disabled = true;
    const p = plan();
    try {
      if (st.target === "new") await importNew(p, st.title.trim() || P.baseName(src.name) || "导入的作品");
      else await importAppend(p, st.target);
    } catch (e) {
      st.busy = false;
      okBtn.disabled = false;
      notice({
        what: "导入没成功，书架上没有多出东西。",
        why: "本地存储出错，可能磁盘满了，或者浏览器限制了存储。也可能要追加的那本书刚被删掉。",
        detail: errText(e),
        actions: [{ label: "再试一次", primary: true, run: () => commit() }],
      });
      return;
    }
    st.done = true;
    db.setKV(DRAFT_KEY, null).catch(() => {});
    m.close(true);
  }

  await loadCount(st.target);
  const api = { close: () => m.close() };
  preview = api;
  renderAll();
  setTimeout(() => titleIn.focus(), 0);
  tip("io-import", "我按「第X章」把章节拆好了。认错的行点「并到上一章」，章名也能直接改，确认了再导入。");
}

async function importNew(plan, title) {
  const t = Date.now();
  const volumes = plan.volumes.map((v) => ({ id: uid("v"), title: v.title }));
  const book = { ...DEFAULT_BOOK, title, tags: [], cover: "", volumes, useVolumes: volumes.length > 0, id: uid("b"), createdAt: t, updatedAt: t, openedAt: t };
  const chapters = plan.chapters.map((c, i) => chapterRow(book.id, i + 1, c, c.vol != null && volumes[c.vol] ? volumes[c.vol].id : null, t));
  book.lastChapterId = chapters[0].id;
  await db.tx(["books", "chapters"], (s) => { s.books.put(book); chapters.forEach((c) => s.chapters.put(c)); });
  bus.emit("book:created", { book, imported: true });
  bus.emit("io:imported", { book, count: chapters.length, append: false });
  let tid = null;
  const entry = appUndo.push({
    label: `导入《${title}》`,
    undo: async () => { await leaveBook(book.id); tid = (await getBook(book.id)) ? await trashBook(book.id) : null; await refreshShelf(); },
    redo: async () => { if (tid) await restoreFromTrash(tid); tid = null; await refreshShelf(); },
  });
  await nav.go("/book/" + book.id);
  toast(`已导入《${title}》，${chapters.length} 章`, { action: { label: "撤销", run: async () => {
    if (!(await appUndo.undoEntry(entry))) return;
    toast(`《${title}》放进${label("回收站")}了`, { action: { label: "恢复", run: () => appUndo.redo() } });
  } } });
}

async function importAppend(plan, bookId) {
  await flushIfOpen(bookId);
  const book = await getBook(bookId);
  if (!book) throw new Error("要追加的作品不在了");
  const existing = await listChapters(bookId);
  const t = Date.now();
  const newVols = book.useVolumes ? plan.volumes.map((v) => ({ id: uid("v"), title: v.title })) : [];
  const newVolIds = new Set(newVols.map((v) => v.id));
  const last = existing[existing.length - 1];
  const tailVol = book.useVolumes ? (last && last.volumeId) || ((book.volumes || [])[(book.volumes || []).length - 1] || {}).id || null : null;
  const base = last ? last.order : 0;
  const chapters = plan.chapters.map((c, i) => chapterRow(bookId, base + i + 1, c, c.vol != null && newVols[c.vol] ? newVols[c.vol].id : tailVol, t));
  const ids = new Set(chapters.map((c) => c.id));
  await db.tx(["books", "chapters"], (s) => {
    s.books.put({ ...book, volumes: [...(book.volumes || []), ...newVols], updatedAt: t });
    chapters.forEach((c) => s.chapters.put(c));
  });
  let saved = chapters;   // 撤销时记下当时的样子（导入以后又改过的也留着），重做用
  const entry = appUndo.push({
    label: `导入 ${chapters.length} 章`,
    undo: async () => {
      await flushIfOpen(bookId);
      const b = await getBook(bookId);
      if (!b) return;
      saved = (await listChapters(bookId)).filter((c) => ids.has(c.id));
      await db.tx(["books", "chapters"], (s) => {
        s.books.put({ ...b, volumes: (b.volumes || []).filter((v) => !newVolIds.has(v.id)), updatedAt: Date.now() });
        ids.forEach((id) => s.chapters.delete(id));
      });
      await syncWorkspace(bookId, ids);
    },
    redo: async () => {
      const b = await getBook(bookId);
      if (!b) return;
      await db.tx(["books", "chapters"], (s) => {
        s.books.put({ ...b, volumes: [...(b.volumes || []).filter((v) => !newVolIds.has(v.id)), ...newVols], updatedAt: Date.now() });
        saved.forEach((c) => s.chapters.put(c));
      });
      await syncWorkspace(bookId);
    },
  });
  const fresh = await getBook(bookId);
  bus.emit("io:imported", { book: fresh, count: chapters.length, append: true });
  bus.emit("book:updated", { book: fresh });
  if (ws.book && ws.book.id === bookId && ws.els()) {
    await syncWorkspace(bookId);
    await ws.openChapter(chapters[0].id);
  } else await nav.go(`/book/${bookId}/${chapters[0].id}`);
  toast(`已追加 ${chapters.length} 章到《${book.title}》`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
}

/** 章节被加上、拿掉以后，正开着这本书就让写作界面跟着变 */
async function syncWorkspace(bookId, removed = new Set()) {
  if (!ws.book || ws.book.id !== bookId || !ws.els()) return refreshShelf();
  const curGone = !!(ws.current && removed.has(ws.current.id));
  if (curGone) ws.editor.close();
  removed.forEach((id) => { ws.editor.forget(id); ws.selected.delete(id); });
  await ws.reloadBook();
  await ws.refresh();
  if (curGone && ws.chapters.length) await ws.openChapter(ws.chapters[ws.chapters.length - 1].id);
}

// ---------------- 导出 ----------------
let exportDlg = null;

async function openExport(arg) {
  if (exportDlg) exportDlg.close(true);
  const books = await listBooks();
  if (!books.length) { toast("书架上还没有作品"); return; }
  const o = arg && typeof arg === "object" ? arg : {};
  let bookId = typeof arg === "string" ? arg : o.bookId || (ws.book && ws.book.id) || null;
  if (!books.some((b) => b.id === bookId)) bookId = books[0].id;
  let last = {};
  try { last = (await db.getKV(EXPORT_KEY, null)) || {}; } catch (_) { /* 记不住上次的选择不要紧 */ }
  const schemes = await getSchemes();
  const platformScheme = schemes.find((s) => s.name === "网文平台") || schemes[0];
  const st = {
    bookId, book: null, chapters: [], scope: "book", picked: new Set(),
    fmt: o.fmt || (["txt", "md"].includes(last.fmt) ? last.fmt : "txt"),
    header: last.header !== false, platform: !!last.platform,
    scheme: last.scheme != null ? last.scheme : platformScheme.name,
    rules: last.rules ? normalizeRules(last.rules) : normalizeRules(platformScheme.rules),
    schemes, name: "", nameEdited: false, allBooks: !!o.allBooks && books.length > 1, busy: false,
  };

  const bookSel = h("select.select", { "aria-label": "作品" }, ...books.map((b) => h("option", { value: b.id }, "《" + b.title + "》")));
  const bookRow = h("div.io-ex-row", {}, h("span.io-label", {}, "作品"), bookSel);
  const fmtRow = h("div.io-ex-row");
  const scopeRow = h("div.io-ex-row");
  const pickBox = h("div.io-pick");
  const optBox = h("div.io-opts");
  const nameIn = h("input.input.io-name-in", { "aria-label": "文件名" });
  const extSpan = h("span.io-ext");
  const nameRow = h("div.io-ex-row", {}, h("span.io-label", {}, "文件名"), h("div.io-name", {}, nameIn, extSpan));
  const outBox = h("div.io-out-wrap");
  const body = h("div.io-ex", {}, bookRow, fmtRow, scopeRow, pickBox, optBox, nameRow, outBox);
  const m = modal({
    title: "导出", body, wide: true,
    onClose: () => { if (exportDlg === m) exportDlg = null; },
    actions: [
      { label: "导出", primary: true, onClick: () => run() },
      { label: "取消", onClick: (layer) => layer.close() },
    ],
  });
  m.el.classList.add("io-modal");
  exportDlg = m;
  const okBtn = m.foot.querySelector(".btn.primary");
  bookSel.value = st.bookId;
  bookRow.hidden = books.length < 2;
  bookSel.addEventListener("change", async () => { await loadBook(bookSel.value); render(); });
  nameIn.addEventListener("input", () => { st.nameEdited = true; st.name = nameIn.value; updateOk(); });

  const inWs = () => !!(ws.book && ws.book.id === st.bookId);
  async function loadBook(id) {
    st.bookId = id;
    await flushIfOpen(id);
    st.book = await getBook(id);
    st.chapters = await listChapters(id);
    const sel = inWs() ? ws.selectedIds() : [];
    st.scope = sel.length >= 2 ? "selected" : "book";
    st.picked = new Set(sel.length ? sel : st.chapters.map((c) => c.id));
    st.nameEdited = false;
  }

  function idsFor() {
    if (st.scope === "current" && inWs() && ws.current) return [ws.current.id];
    if (st.scope === "selected" && inWs() && ws.selectedIds().length) return ws.selectedIds();
    if (st.scope === "pick") return st.chapters.filter((c) => st.picked.has(c.id)).map((c) => c.id);
    return st.chapters.map((c) => c.id);
  }

  function defaultName() {
    const title = st.book ? st.book.title : "作品";
    if (st.fmt === "backup") return st.allBooks ? `小恶魔文书备份 ${todayKey()}` : title;
    const ids = idsFor();
    if (ids.length === st.chapters.length || !ids.length) return title;
    const idx = ids.map((id) => st.chapters.findIndex((c) => c.id === id) + 1);
    const lab = (i) => chapterLabel(i, st.book.numbering);
    if (ids.length === 1) { const c = st.chapters[idx[0] - 1]; return [title, lab(idx[0]), c.title].filter(Boolean).join(" "); }
    const contiguous = idx.every((v, k) => k === 0 || v === idx[k - 1] + 1);
    return contiguous ? `${title} ${lab(idx[0])}至${lab(idx[idx.length - 1])}` : `${title}（${ids.length} 章）`;
  }

  function render() {
    fmtRow.replaceChildren(h("span.io-label", {}, "格式"),
      seg([["txt", "txt"], ["md", "md"], ["backup", "整本备份"]], st.fmt, (v) => { st.fmt = v; render(); }, "格式"),
      h("span.io-hint", {}, "docx、epub、pdf 下一版支持"));
    const isBackup = st.fmt === "backup";
    bookRow.hidden = books.length < 2 || (isBackup && st.allBooks);
    // 范围
    if (isBackup) {
      scopeRow.hidden = books.length < 2;
      scopeRow.replaceChildren(h("span.io-label", {}, "范围"),
        seg([["one", "这一本"], ["all", `书架上全部 ${books.length} 本`]], st.allBooks ? "all" : "one", (v) => { st.allBooks = v === "all"; st.nameEdited = false; render(); }, "备份范围"));
    } else {
      scopeRow.hidden = false;
      const n = inWs() ? ws.selectedIds().length : 0;
      if (st.scope === "selected" && n < 2) st.scope = "book";
      if (st.scope === "current" && !(inWs() && ws.current)) st.scope = "book";
      const opts = [["book", `整本 ${st.chapters.length} 章`], inWs() && ws.current ? ["current", "本章"] : null,
        n >= 2 ? ["selected", `选中的 ${n} 章`] : null, ["pick", "自己挑"]].filter(Boolean);
      scopeRow.replaceChildren(h("span.io-label", {}, "范围"),
        seg(opts, st.scope, (v) => { st.scope = v; if (!st.nameEdited) st.name = ""; render(); }, "导出范围"));
    }
    renderPick();
    renderOpts();
    if (!st.nameEdited) st.name = defaultName();
    nameIn.value = st.name;
    extSpan.textContent = isBackup ? ".xemo.json" : "." + st.fmt;
    renderOut();
    updateOk();
  }

  function renderPick() {
    pickBox.replaceChildren();
    pickBox.hidden = st.fmt === "backup" || st.scope !== "pick";
    if (pickBox.hidden) return;
    const all = h("button.btn.small.ghost", { type: "button", onclick: () => { st.picked = new Set(st.chapters.map((c) => c.id)); render(); } }, "全选");
    const none = h("button.btn.small.ghost", { type: "button", onclick: () => { st.picked.clear(); render(); } }, "全不选");
    const listEl = h("div.io-pick-list", { role: "group", "aria-label": "挑要导出的章" });
    st.chapters.forEach((c, i) => {
      const cb = h("input", { type: "checkbox", "data-id": c.id });
      cb.checked = st.picked.has(c.id);
      cb.addEventListener("change", () => { if (cb.checked) st.picked.add(c.id); else st.picked.delete(c.id); if (!st.nameEdited) st.name = defaultName(); nameIn.value = st.name; renderOut(); updateOk(); countEl.textContent = `已挑 ${st.picked.size} 章`; });
      listEl.append(h("label.check.io-pick-item", {}, cb, h("span", {}, chapterLabel(i + 1, st.book.numbering) + (c.title ? " " + c.title : "")),
        h("span.muted", {}, (c.words || 0).toLocaleString())));
    });
    const countEl = h("span.muted", {}, `已挑 ${st.picked.size} 章`);
    pickBox.append(h("div.row", {}, countEl, h("span.spacer"), all, none), listEl);
  }

  function renderOpts() {
    optBox.replaceChildren();
    if (st.fmt === "backup") {
      optBox.append(h("p.io-hint.io-bk", {}, "作品信息、章节、要点、码字记录都在这个文件里。换电脑后在书架点「导入」，选它就行。"));
      return;
    }
    const header = h("input", { type: "checkbox", "data-opt": "header" });
    header.checked = st.header;
    header.addEventListener("change", () => { st.header = header.checked; renderOut(); });
    const plat = h("input", { type: "checkbox", "data-opt": "platform" });
    plat.checked = st.platform;
    plat.addEventListener("change", () => { st.platform = plat.checked; renderOpts(); renderOut(); });
    optBox.append(h("div.io-ex-row", {},
      h("label.check", {}, header, "开头写书名和简介"),
      h("label.check", {}, plat, "网文平台排版"),
      helpTip("段首空两格、段间空一行、去掉多余空行、统一标点。只改导出的文件，作品里的正文不动。")));
    if (!st.platform) return;
    // 方案和规则
    const match = st.schemes.find((s) => s.name === st.scheme && sameRules(effective(s), st.rules)) || st.schemes.find((s) => sameRules(effective(s), st.rules));
    st.scheme = match ? match.name : "";
    const sel = h("select.select.io-scheme", { "aria-label": "排版方案" },
      ...(match ? [] : [h("option", { value: "" }, "自定义")]),
      ...st.schemes.map((s) => h("option", { value: s.name }, s.name)));
    sel.value = st.scheme;
    sel.addEventListener("change", () => {
      const s = st.schemes.find((x) => x.name === sel.value);
      if (!s) return;
      st.scheme = s.name;
      st.rules = effective(s);
      renderOpts();
      renderOut();
    });
    const saveBtn = h("button.btn.small", { type: "button" }, "存为方案");
    saveBtn.addEventListener("click", () => saveAsScheme(sel));
    const grid = h("div.io-rules-grid");
    for (const r of RULES) {
      const cb = h("input", { type: "checkbox", "data-rule": r.id });
      cb.checked = !!st.rules[r.id];
      cb.addEventListener("change", () => { st.rules[r.id] = cb.checked; renderOpts(); renderOut(); });
      const item = h("div.io-rule", {}, h("label.check", { title: r.desc }, cb, r.name));
      if (r.id === "gap") {
        const radio = (v, text) => {
          const rb = h("input", { type: "radio", name: "io-gap", value: String(v), disabled: !st.rules.gap });
          rb.checked = st.rules.paraGap === v;
          rb.addEventListener("change", () => { if (rb.checked) { st.rules.paraGap = v; renderOpts(); renderOut(); } });
          return h("label.check", {}, rb, text);
        };
        item.append(h("span.io-gaps", { role: "radiogroup", "aria-label": "段与段之间" }, radio(0, "不空行"), radio(1, "空一行")));
      }
      grid.append(item);
    }
    const on = RULES.filter((r) => st.rules[r.id]).length;
    optBox.append(h("div.io-ex-row", {}, h("span.io-label", {}, "方案"), sel, saveBtn),
      h("details.io-rules", {}, h("summary", {}, `规则 · 开着 ${on} 条`), grid));
  }

  /** 方案实际用的规则：「默认」的段间空行跟着作品设置走（和一键排版一样） */
  function effective(s) {
    const r = normalizeRules(s.rules);
    if (s.builtin && s.name === "默认") r.paraGap = st.book && st.book.paraGap ? 1 : 0;
    return r;
  }

  async function saveAsScheme(sel) {
    sel.focus();
    const input = await prompt("存为排版方案", st.scheme && !isBuiltinScheme(st.scheme) ? st.scheme : "", "方案名，比如：投稿用");
    if (input == null) return;
    const name = input.trim();
    if (!name) { toast("方案名不能空着"); return; }
    if (isBuiltinScheme(name)) { toast(`「${name}」是自带的方案，换个名字吧`); return; }
    const before = await getUserSchemes();
    if (before.some((s) => s.name === name) && !(await confirm(`已经有「${name}」了`, "用现在的规则覆盖它吗？", "覆盖"))) return;
    try { await saveScheme(name, st.rules); }
    catch (e) { notice({ what: "方案没能存上。", why: "本地存储出错，可能磁盘满了或者浏览器限制了存储。现在的规则还在，照样能导出。", detail: errText(e) }); return; }
    const after = await getUserSchemes();
    const reload = async () => { st.schemes = await getSchemes(); if (exportDlg === m) { renderOpts(); renderOut(); } };
    const entry = appUndo.push({
      label: "保存排版方案",
      undo: async () => { await setUserSchemes(before); await reload(); },
      redo: async () => { await setUserSchemes(after); await reload(); },
    });
    st.scheme = name;
    await reload();
    toast(`已存为方案「${name}」`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
  }

  function transform() {
    if (!st.platform) return null;
    const rules = { ...st.rules };
    return (t) => formatText(t, rules);
  }

  function build(ids) {
    return P.exportText(P.exportParts(st.book, st.chapters, ids), { fmt: st.fmt, book: st.book, header: st.header, transform: transform() });
  }

  function renderOut() {
    outBox.replaceChildren();
    if (st.fmt === "backup") {
      const list = st.allBooks ? books : [st.book];
      outBox.append(h("p.io-hint", {}, st.allBooks ? `${list.length} 本作品。` : `《${st.book.title}》${st.chapters.length} 章，${P.totalWords(st.chapters).toLocaleString()} 字。`));
      return;
    }
    const ids = idsFor();
    if (!ids.length) { outBox.append(h("p.io-hint", {}, "至少挑一章。")); return; }
    // 只拼开头几章看看样子
    const head = [];
    let len = 0;
    for (const id of ids) { head.push(id); len += (st.chapters.find((c) => c.id === id) || {}).content.length || 0; if (len > 1500 || head.length >= 3) break; }
    let text;
    try { text = build(head); } catch (e) { text = "（预览出错：" + (e.message || e) + "）"; }
    const words = ids.reduce((s, id) => s + ((st.chapters.find((c) => c.id === id) || {}).words || 0), 0);
    outBox.append(h("div.io-out-h", {}, h("span", {}, "开头的样子"), h("span.muted", {}, `${ids.length} 章 · ${words.toLocaleString()} 字`)),
      h("pre.io-out", {}, text.length > 1200 ? text.slice(0, 1200) + "\n……" : text));
  }

  function updateOk() {
    okBtn.disabled = st.busy || (st.fmt !== "backup" && !idsFor().length);
  }

  async function run() {
    if (st.busy) return;
    st.busy = true;
    updateOk();
    const file = P.safeFileName(nameIn.value || defaultName(), "导出") + (st.fmt === "backup" ? ".xemo.json" : "." + st.fmt);
    try {
      if (st.fmt === "backup") {
        const list = await backupBooks(st.allBooks ? books.map((b) => b.id) : [st.bookId], file);
        toast(st.allBooks ? `已备份 ${list.length} 本作品` : `已备份《${st.book.title}》`);
      } else {
        await flushIfOpen(st.bookId);
        st.chapters = await listChapters(st.bookId);
        const ids = idsFor();
        const text = build(ids);
        download(file, text, st.fmt === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8");
        db.setKV(EXPORT_KEY, { fmt: st.fmt, header: st.header, platform: st.platform, scheme: st.scheme, rules: st.rules }).catch(() => {});
        toast(`已导出「${file}」`);
        bus.emit("io:exported", { format: st.fmt, count: ids.length, bookId: st.bookId, platform: st.platform });
      }
    } catch (e) {
      st.busy = false;
      updateOk();
      notice({
        what: "导出没成功。",
        why: "排版出错，或者浏览器拦下了下载。作品里的内容没有变。",
        detail: errText(e),
        actions: [{ label: "再试一次", primary: true, run: () => run() }],
      });
      return;
    }
    m.close(true);
  }

  await loadBook(st.bookId);
  render();
  tip("io-export", "导出能挑整本或几章。勾上「网文平台排版」，段首空格和空行都会整理好，作品里的正文不动。");
}

// ---------------- 整本备份 ----------------
async function backupBooks(ids, fileName) {
  const list = [];
  for (const id of ids) {
    await flushIfOpen(id);
    const s = await snapshot(id);
    if (s) list.push(s);
  }
  if (!list.length) throw new Error("没有能备份的作品");
  download(fileName, JSON.stringify(P.makeBackup(list)), "application/json");
  bus.emit("io:backup", { count: list.length, books: list.map((x) => x.book) });
  tip("io-backup", "备份文件里有章节、要点和码字记录。换了电脑，在书架点「导入」选它就回来了。");
  return list;
}

/** 一键整本备份：在作品里直接下载这本；在书架上让作者选这一本还是全部 */
async function backupCmd(arg) {
  const id = typeof arg === "string" ? arg : ws.book ? ws.book.id : null;
  if (!id) return openExport({ fmt: "backup", allBooks: true });
  const book = await getBook(id);
  if (!book) { toast("这本书找不到了"); return; }
  try {
    await backupBooks([id], P.safeFileName(book.title, "作品") + ".xemo.json");
    toast(`已备份《${book.title}》`);
  } catch (e) {
    notice({ what: "备份没成功。", why: "本地数据读不出来，或者浏览器拦下了下载。", detail: errText(e), actions: [{ label: "再试一次", primary: true, run: () => backupCmd(id) }] });
  }
}

// ---------------- 从备份恢复 ----------------
async function restoreFile(file) {
  let text;
  try { text = await file.text(); }
  catch (e) { readError(file, e, { restore: true }); return; }
  const r = P.parseBackup(text);
  if (!r.ok) {
    const again = [{ label: "换一个文件", primary: true, run: () => openImport({ restore: true }) }];
    if (r.reason === "newer") notice({ what: "这个备份是新版小恶魔文书做的，这一版读不了。", why: "做备份的那台电脑上的软件比这里新。把这里的软件也换成新版再导入。" });
    else if (r.reason === "empty") notice({ what: "这个备份里没有作品。", why: "备份的时候可能还没选作品，或者文件不完整。", actions: again });
    else notice({ what: `「${file.name}」不是小恶魔文书的备份。`, why: "可能选错了文件，或者文件在拷贝时损坏了。备份文件的名字一般是「书名.xemo.json」。", detail: r.error ? errText(r.error) : "", actions: again });
    return;
  }
  const shelf = new Map((await listBooks()).map((b) => [b.id, b]));
  const trashed = new Set((await listTrash()).map((t) => t.bookId));
  const plans = r.books.map((d) => ({ data: d, old: shelf.get(d.book.id) || null, inTrash: trashed.has(d.book.id), mode: shelf.has(d.book.id) ? "copy" : "add", on: true }));
  if (plans.length === 1 && !plans[0].old) return applyRestore(plans);
  if (plans.length === 1) {
    const p = plans[0];
    const oldCh = await listChapters(p.old.id);
    const choice = await choose({
      title: `书架上已经有《${p.old.title}》`,
      body: `备份里 ${p.data.chapters.length} 章、${P.totalWords(p.data.chapters).toLocaleString()} 字（${fmtTime(r.exportedAt || Date.now())} 备份）；` +
        `书架上 ${oldCh.length} 章、${P.totalWords(oldCh).toLocaleString()} 字（${fmtTime(p.old.updatedAt)} 改过）。覆盖的话，书架上这本先放进${label("回收站")}。`,
      buttons: [{ id: "copy", label: "另存为一本新书", primary: true }, { id: "over", label: "覆盖", danger: true }, { id: "cancel", label: "取消" }],
    });
    if (choice !== "copy" && choice !== "over") return;
    p.mode = choice;
    return applyRestore(plans);
  }
  restorePicker(plans, r);
}

/** 备份里有好几本：一本一本看，已有的选另存还是覆盖 */
function restorePicker(plans, r) {
  const listEl = h("div.io-rs-list");
  for (const p of plans) {
    const cb = h("input", { type: "checkbox", "aria-label": "恢复《" + p.data.book.title + "》" });
    cb.checked = p.on;
    cb.addEventListener("change", () => { p.on = cb.checked; okBtn.disabled = !plans.some((x) => x.on); });
    let choice = h("span.muted.io-rs-st", {}, "书架上没有，直接放上去");
    if (p.old) {
      const sel = h("select.select.io-rs-mode", { "aria-label": "《" + p.data.book.title + "》怎么恢复" },
        h("option", { value: "copy" }, "另存为一本新书"), h("option", { value: "over" }, "覆盖书架上的（旧的放进" + label("回收站") + "）"));
      sel.value = p.mode;
      sel.addEventListener("change", () => { p.mode = sel.value; });
      choice = h("span.io-rs-st", {}, h("span.io-warn-t", {}, "书架上已经有这本"), sel);
    }
    listEl.append(h("div.io-rs-row", {}, h("label.check", {}, cb, h("b", {}, "《" + p.data.book.title + "》")),
      h("span.muted", {}, `${p.data.chapters.length} 章 · ${P.totalWords(p.data.chapters).toLocaleString()} 字`), choice));
  }
  const m = modal({
    title: "从备份恢复", wide: true,
    body: h("div.io-rs", {}, h("p.io-hint", {}, `备份时间：${fmtTime(r.exportedAt || Date.now())} · ${plans.length} 本`), listEl),
    actions: [
      { label: "恢复", primary: true, onClick: () => { m.close(true); applyRestore(plans); } },
      { label: "取消", onClick: (layer) => layer.close() },
    ],
  });
  m.el.classList.add("io-modal");
  const okBtn = m.foot.querySelector(".btn.primary");
}

async function applyRestore(all) {
  const plans = all.filter((p) => p.on);
  if (!plans.length) return;
  for (const p of plans) if (p.mode === "over") await leaveBook(p.data.book.id);
  const t = Date.now();
  // 每一本：before 恢复前书架上的样子（覆盖时），after 恢复进来的样子
  const ops = [];
  for (const p of plans) {
    let d = p.data;
    // 另存为新书；或者回收站里还有同一本（以后从回收站恢复会撞上），也换成新 id
    if (p.mode === "copy" || (p.mode === "add" && p.inTrash)) d = P.withNewIds(d, uid);
    const book = { ...d.book, openedAt: t, title: p.mode === "copy" ? d.book.title + "（备份）" : d.book.title };
    const after = { book, chapters: d.chapters, stats: d.stats };
    ops.push({ id: book.id, before: p.mode === "over" ? await snapshot(book.id) : null, after, tid: null });
  }
  try {
    const made = await swapBooks(ops.map((op) => ({ bookId: op.id, now: op.before, to: op.after, trash: !!op.before })));
    ops.forEach((op) => { op.tid = made[op.id] || null; });
  } catch (e) {
    notice({ what: "没能恢复，书架上没有变。", why: "本地存储出错，可能磁盘满了，或者浏览器限制了存储。", detail: errText(e),
      actions: [{ label: "再试一次", primary: true, run: () => applyRestore(all) }] });
    return;
  }
  const entry = appUndo.push({
    label: "从备份恢复",
    undo: async () => {
      for (const op of ops) await leaveBook(op.id);
      const changes = [];
      for (const op of ops) {
        const now = await snapshot(op.id);
        if (now) op.after = now;   // 恢复以后又改过的，重做时还是改过的样子
        // 新放上去的放进回收站；覆盖的把旧的拿回来
        changes.push(op.before ? { bookId: op.id, now, to: op.before, untrash: op.tid } : { bookId: op.id, now, to: null, trash: true });
      }
      const made = await swapBooks(changes);
      ops.forEach((op) => { if (!op.before) op.tid = made[op.id] || null; });
      await refreshShelf();
    },
    redo: async () => {
      for (const op of ops) await leaveBook(op.id);
      const changes = [];
      for (const op of ops) {
        const now = await snapshot(op.id);
        if (op.before) { op.before = now || op.before; changes.push({ bookId: op.id, now, to: op.after, trash: !!now }); }
        else changes.push({ bookId: op.id, now, to: op.after, untrash: op.tid });
      }
      const made = await swapBooks(changes);
      ops.forEach((op) => { if (op.before) op.tid = made[op.id] || null; });
      await refreshShelf();
    },
  });
  ops.forEach((op) => bus.emit("book:created", { book: op.after.book, imported: true }));
  bus.emit("io:restored", { books: ops.map((op) => op.after.book) });
  await refreshShelf();
  const msg = ops.length === 1 ? `已恢复《${ops[0].after.book.title}》` : `已恢复 ${ops.length} 本作品`;
  toast(msg, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
}

// ---------------- 书架上拖文件进来 ----------------
function wireDrop() {
  let depth = 0, mask = null;
  const onShelf = () => { const c = nav.current(); return !!(c && c.name === "shelf"); };
  const inEditor = (e) => !!(e.target && e.target.closest && e.target.closest(".cm-editor"));
  const show = () => {
    if (mask) return;
    mask = h("div.io-dropmask", { "aria-hidden": "true" },
      h("div.io-dropmask-in", {}, icon("upload"), h("b", {}, "松手就导入"), h("span", {}, "txt、md，或者 .xemo.json 备份")));
    document.body.append(mask);
  };
  const hide = () => { depth = 0; if (mask) { mask.remove(); mask = null; } };
  document.addEventListener("dragenter", (e) => { if (hasFiles(e) && onShelf() && !hasLayers()) { depth++; show(); } });
  document.addEventListener("dragleave", () => { if (mask && --depth <= 0) hide(); });
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e) || e.defaultPrevented || inEditor(e)) return;
    // 拖到别的地方松手，浏览器会直接打开这个文件、离开软件；这里拦下来
    e.preventDefault();
    e.dataTransfer.dropEffect = onShelf() && !hasLayers() ? "copy" : "none";
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e) || e.defaultPrevented || inEditor(e)) { hide(); return; }
    e.preventDefault();
    hide();
    if (!onShelf() || hasLayers()) return;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  window.addEventListener("blur", hide);
}

// ---------------- 写作界面顶栏放一个「导出」 ----------------
function addWorkspaceButton() {
  const bar = document.querySelector(".ws .topbar");
  if (!bar || bar.querySelector('[data-cmd="io.export"]')) return;
  const b = h("button.tool-btn", { type: "button", title: "导出 txt、md 或整本备份", "data-cmd": "io.export" }, icon("download"), h("span.tb-t", {}, "导出"));
  b.addEventListener("click", () => commands.run("io.export"));
  const after = bar.querySelector('[data-cmd="versions.open"]') || bar.querySelector('[data-cmd="format.open"]');
  if (after) after.after(b); else bar.append(b);
}

// ---------------- 注册 ----------------
export async function register() {
  commands.register({
    id: "io.import", title: "导入作品",
    keywords: "导入 打开 读取 txt md markdown docx epub 文件 小说 拆章 分章 识别章节 编码 乱码 gbk utf-8 追加 拖进来",
    hint: "txt、md 按「第X章」拆章，先预览再导入",
    run: (o) => openImport(o && typeof o === "object" && !(o instanceof Event) ? o : {}),
  });
  commands.register({
    id: "io.export", title: "导出",
    keywords: "导出 下载 保存到电脑 另存 txt md markdown 网文 平台 排版 投稿 发布 上传 选中的章",
    hint: "整本或几章导成 txt、md，可选网文平台排版",
    run: (a) => openExport(typeof a === "string" || (a && typeof a === "object" && !(a instanceof Event)) ? a : undefined),
  });
  commands.register({
    id: "io.backup", title: "整本备份",
    keywords: "备份 打包 换电脑 存档 迁移 保存 xemo json 全部作品",
    hint: "打包成一个文件，换电脑后直接导入",
    run: (a) => backupCmd(typeof a === "string" ? a : undefined),
  });
  commands.register({
    id: "io.restore", title: "从备份恢复",
    keywords: "恢复 备份 导入备份 换电脑 迁移 还原 xemo json",
    hint: "选 .xemo.json 备份文件",
    run: () => openImport({ restore: true }),
  });
  wireDrop();
  bus.on("route", ({ name }) => { if (name === "book") addWorkspaceButton(); });
}
