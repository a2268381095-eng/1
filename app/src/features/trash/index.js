// 回收站：删掉的作品、章节（以后还有设定、图片）先放这里 30 天，过了自动清理（启动时 purgeOldTrash）。
// 独立界面：#/trash 看全部，#/trash/<bookId> 只看这本书的。
// 恢复、彻底删除、清空都能撤销，一次操作算一步。界面里的叫法都走 label("回收站")（主题彩蛋会变成「地狱」）。
// 发出的事件：trash:restored { entries }、trash:purged { count, all }
import { getBook, listBooks, listChapters, getChapter, listTrash, restoreFromTrash } from "../../core/store.js";
import { db } from "../../core/db.js";
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { commands } from "../../core/commands.js";
import { label } from "../../core/settings.js";
import { fmtTime } from "../../core/text.js";
import { h, icon, modal, toast, confirm, notice, hasLayers } from "../../core/ui.js";
import { ws, downloadText } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { KEEP_DAYS, describe, leftText, isSoon, filterKind, kindsIn, kindLabel, restoreBlock } from "./logic.js";

const L = () => label("回收站");

// 界面状态
const S = {
  view: null, main: null, listEl: null, barEl: null, titleEl: null, undoBtn: null, redoBtn: null, emptyBtn: null,
  bookId: null,      // 只看这本书（地址里带的）
  fromBook: null,    // 从哪本书进来的（切到「全部」后还能切回去）
  kind: "all",
  list: [],          // 当前范围内的条目
  books: {},         // bookId → { book, live, chapters }
  loading: null,
};

const onTrash = () => { const c = nav.current(); return !!(c && c.name === "trash" && S.view && S.view.isConnected); };

// ---------------- 数据 ----------------
async function load() {
  const list = await listTrash(S.bookId || undefined);
  const books = {};
  for (const id of new Set(list.map((t) => t.bookId).concat(S.bookId ? [S.bookId] : []))) {
    if (!id) continue;
    const b = await getBook(id);
    if (b) { books[id] = { book: b, live: true, chapters: await listChapters(id) }; continue; }
    const be = list.find((t) => t.kind === "book" && t.bookId === id) || (await listTrash(id)).find((t) => t.kind === "book");
    books[id] = be ? { book: be.data.book, live: false, chapters: be.data.chapters || [] } : { book: null, live: false, chapters: [] };
  }
  S.list = list;
  S.books = books;
}

/** 编辑器里正开着这一章 / 这本书时，先把没存的正文存进去 */
async function flushIfOpen(bookId, chapterId) {
  if (!ws.book || !ws.editor || ws.book.id !== bookId) return;
  if (chapterId && (!ws.current || ws.current.id !== chapterId)) return;
  await ws.editor.flush();
}

/**
 * 把恢复出来的东西再放回回收站（撤销「恢复」用）。条目 id 和删除时间不变，30 天照旧算。
 * 正文用现在的（恢复以后改过的也留着），位置用 snap 里记的。
 */
async function putBack(snap) {
  if (snap.kind === "chapter") {
    const was = snap.data.chapter;
    await flushIfOpen(snap.bookId, was.id);
    const cur = await getChapter(was.id);
    if (!cur) return false;
    const chapter = { ...cur, bookId: was.bookId, order: was.order, volumeId: was.volumeId ?? null };
    const entry = { ...snap, title: cur.title, data: { ...snap.data, chapter } };
    await db.tx(["chapters", "trash"], (s) => { s.chapters.delete(cur.id); s.trash.put(entry); });
    bus.emit("chapter:deleted", { chapter: cur, undo: true });
    return true;
  }
  if (snap.kind === "book") {
    await flushIfOpen(snap.bookId);
    const book = await getBook(snap.bookId);
    if (!book) return false;
    const chapters = await listChapters(book.id);
    const entry = { ...snap, title: book.title, data: { ...snap.data, book, chapters } };
    await db.tx(["books", "chapters", "trash"], (s) => {
      s.books.delete(book.id);
      chapters.forEach((c) => s.chapters.delete(c.id));
      s.trash.put(entry);
    });
    bus.emit("book:deleted", { book, undo: true });
    return true;
  }
  return false;
}

const putEntries = (entries) => db.tx(["trash"], (s) => entries.forEach((e) => s.trash.put(e)));
const delEntries = (entries) => db.tx(["trash"], (s) => entries.forEach((e) => s.trash.delete(e.id)));

/** 数据变了以后：在回收站就重画；在写作界面、书架上就让它们跟着变 */
async function afterChange(affect = {}) {
  if (onTrash()) return refresh();
  const cur = nav.current();
  if (ws.book && (affect.bookIds || []).includes(ws.book.id)) {
    if ((affect.goneBooks || []).includes(ws.book.id)) return nav.go("/", { replace: true });
    if (ws.current && (affect.goneChapters || []).includes(ws.current.id)) return nav.go("/book/" + ws.book.id, { replace: true });
    return ws.refresh();
  }
  if (cur && cur.name === "shelf") return nav.go("/", { replace: true });
}

// ---------------- 撤销 ----------------
const mine = new WeakSet();     // 回收站推进撤销栈的条目
const myUndone = [];            // 在这里撤销掉、还能重做的（只要别处没动过撤销栈）
let selfOp = false;

function pushUndo(entry) {
  mine.add(entry);
  return appUndo.push(entry);
}

/** 撤销：不给 target 就撤最近一步（必须是回收站的）；给了就撤到它为止 */
async function runUndo(target) {
  if (target && !mine.has(appUndo.peek())) { myUndone.length = 0; await appUndo.undoEntry(target); return; }
  selfOp = true;
  try {
    while (mine.has(appUndo.peek())) {
      const e = await appUndo.undo();
      myUndone.push(e);
      if (!target || e === target) break;
    }
  } finally { selfOp = false; updateUndoBtns(); }
}

async function runRedo() {
  if (!myUndone.length || !appUndo.canRedo()) return;
  selfOp = true;
  try { const e = await appUndo.redo(); if (e === myUndone[myUndone.length - 1]) myUndone.pop(); else myUndone.length = 0; }
  finally { selfOp = false; updateUndoBtns(); }
}

const canUndoHere = () => mine.has(appUndo.peek());
const canRedoHere = () => myUndone.length > 0 && appUndo.canRedo();

function updateUndoBtns() {
  if (!S.undoBtn) return;
  S.undoBtn.disabled = !canUndoHere();
  S.redoBtn.disabled = !canRedoHere();
  const top = appUndo.peek();
  S.undoBtn.title = canUndoHere() ? `撤销「${top.label}」（Ctrl+Z）` : "撤销（Ctrl+Z）";
}

/** 出错时统一说明 */
function failed(what, e, retry) {
  notice({
    what,
    why: "浏览器存储被限制、被清理，或者另一个窗口刚改过这里。",
    detail: e && (e.stack || e.message || e),
    actions: retry ? [{ label: "重试", primary: true, run: retry }] : [],
  });
}

/** 撤销 / 重做里出错不往外抛（撤销栈会乱），只说明 */
const guard = (what, fn) => async () => { try { await fn(); } catch (e) { failed(what, e); } };

/** 提示条：第一个按钮走 toast 自带的，其余的补在后面 */
function toastActs(msg, actions) {
  const [first, ...rest] = actions;
  const t = toast(msg, { action: first, timeout: 9000 });
  const el = document.querySelector(".toasts .toast:last-child");
  if (el) {
    const x = el.querySelector(".toast-x");
    rest.forEach((a) => {
      const b = h("button.toast-act", { type: "button" }, a.label);
      b.addEventListener("click", async () => { t.close(); await a.run(); });
      el.insertBefore(b, x);
    });
  }
  return t;
}

// ---------------- 恢复 ----------------
const nameOf = (entry) => describe(entry, S.books).title;

function openEntry(entry) {
  const info = describe(entry, S.books);
  if (entry.kind === "chapter") return nav.go(`/book/${entry.bookId}/${info.chapterId}`);
  return nav.go("/book/" + entry.bookId);
}

/** 恢复几项（按顺序：先作品后章节），算一步 */
async function restoreEntries(entries, { what } = {}) {
  const snaps = entries.map((e) => structuredClone(e));
  const done = [];
  try {
    for (const e of snaps) {
      const res = await restoreFromTrash(e.id);
      if (!res) {
        if (done.length) await undoRestore(done);
        await refresh();
        return notGone(e);
      }
      done.push(e);
    }
  } catch (err) {
    try { if (done.length) await undoRestore(done); } catch (_) { /* 尽量还原 */ }
    await refresh();
    return failed("没能恢复" + nameOf(snaps[snaps.length - 1]) + "。", err, () => restoreEntries(entries, { what }));
  }
  const affect = { bookIds: [...new Set(snaps.map((e) => e.bookId))] };
  const title = what || nameOf(snaps[snaps.length - 1]);
  const u = pushUndo({
    label: "恢复" + title,
    undo: guard("没能撤销恢复。", async () => { await undoRestore(done); await afterChange(goneOf(snaps)); }),
    redo: guard("没能重做恢复。", async () => { for (const e of snaps) await restoreFromTrash(e.id); await afterChange(affect); }),
  });
  bus.emit("trash:restored", { entries: snaps });
  await refresh();
  const last = snaps[snaps.length - 1];
  toastActs("已恢复" + title, [
    { label: "打开", run: () => openEntry(last) },
    { label: "撤销", run: () => runUndo(u) },
  ]);
  return u;
}

async function undoRestore(snaps) {
  for (const e of [...snaps].reverse()) await putBack(e);
}

function goneOf(snaps) {
  return {
    bookIds: [...new Set(snaps.map((e) => e.bookId))],
    goneBooks: snaps.filter((e) => e.kind === "book").map((e) => e.bookId),
    goneChapters: snaps.filter((e) => e.kind === "chapter").map((e) => e.data.chapter.id),
  };
}

async function restore(entry) {
  const block = restoreBlock(entry, S.books);
  if (block === "book-trashed") {
    const ctx = S.books[entry.bookId];
    const bookEntry = (await listTrash(entry.bookId)).find((t) => t.kind === "book");
    if (bookEntry) {
      return notice({
        what: `这一章所在的《${ctx.book.title}》也在${L()}里。`,
        why: "章节要放回作品里，作品得先回到书架上。",
        actions: [{ label: "先恢复作品", primary: true, run: () => restoreEntries([bookEntry, entry], { what: `《${ctx.book.title}》和${nameOf(entry)}` }) }],
      });
    }
  }
  if (block !== "ok") return bookGone(entry);
  if (!["book", "chapter"].includes(entry.kind)) {
    return notice({ what: `「${kindLabel(entry.kind)}」还不能在这里恢复。`, why: "管这类内容的功能还没做好。它会一直留到自动清理那天。", actions: [] });
  }
  return restoreEntries([entry]);
}

function notGone(entry) {
  notice({
    what: nameOf(entry) + `已经不在${L()}里了。`,
    why: "可能在另一个窗口里恢复或删除了，或者放满 30 天被清理了。",
    actions: [{ label: "刷新列表", primary: true, run: refresh }],
  });
}

/** 一章原来的作品已经彻底删除：放进别的作品，或者另存成 txt */
async function bookGone(entry) {
  const books = await listBooks();
  const ch = entry.data.chapter;
  const name = nameOf(entry);
  notice({
    what: `${name}原来所在的作品已经彻底删除了。`,
    why: `作品在${L()}里放满 ${KEEP_DAYS} 天被清理了，或者被彻底删除了。这一章的正文还在。`,
    actions: [
      books.length ? { label: "放进别的作品", primary: true, run: () => moveToBook(entry, books) } : null,
      { label: "另存成 txt", primary: !books.length, run: () => downloadText((ch.title || "找回的章节") + ".txt", (ch.title ? ch.title + "\n\n" : "") + (ch.content || "")) },
    ].filter(Boolean),
  });
}

function pickBook(books) {
  return new Promise((resolve) => {
    let result = null;
    const listEl = h("div.trash-pick");
    books.forEach((b) => {
      const btn = h("button.trash-pick-item", { type: "button" }, h("span.grow", {}, "《" + b.title + "》"), icon("back"));
      btn.addEventListener("click", () => { result = b; m.close(true); });
      listEl.append(btn);
    });
    const m = modal({ title: "放进哪本书？", body: h("div", {}, h("p.modal-text.muted", {}, "放在这本书的最后一章后面。"), listEl), onClose: () => resolve(result) });
  });
}

async function moveToBook(entry, books) {
  const target = await pickBook(books);
  if (!target) return;
  const snap = structuredClone(entry);
  const place = async () => {
    const list = await listChapters(target.id);
    const last = list[list.length - 1];
    const moved = structuredClone(snap);
    moved.bookId = target.id;
    Object.assign(moved.data.chapter, { bookId: target.id, order: last ? last.order + 1 : 1, volumeId: target.useVolumes && last ? last.volumeId || null : null });
    await db.put("trash", moved);
    return restoreFromTrash(moved.id);
  };
  try { await place(); }
  catch (e) { await refresh(); return failed("没能把这一章放进《" + target.title + "》。", e, () => moveToBook(entry, books)); }
  const affect = { bookIds: [target.id] };
  const title = nameOf(snap);
  const u = pushUndo({
    label: "把" + title + "放进《" + target.title + "》",
    undo: guard("没能撤销。", async () => { await putBack(snap); await afterChange({ ...affect, goneChapters: [snap.data.chapter.id] }); }),
    redo: guard("没能重做。", async () => { await place(); await afterChange(affect); }),
  });
  bus.emit("trash:restored", { entries: [snap], into: target.id });
  await refresh();
  toastActs(`已把${title}放进《${target.title}》`, [
    { label: "打开", run: () => nav.go(`/book/${target.id}/${snap.data.chapter.id}`) },
    { label: "撤销", run: () => runUndo(u) },
  ]);
}

// ---------------- 彻底删除 / 清空 ----------------
async function purge(entries, { all = false } = {}) {
  if (!entries.length) return;
  const snaps = entries.map((e) => structuredClone(e));
  try { await delEntries(snaps); }
  catch (e) { await refresh(); return failed("没能删除。", e, () => purge(entries, { all })); }
  const what = all ? (S.bookId ? "清空本书的" + L() : "清空" + L()) : "彻底删除" + nameOf(snaps[0]);
  const u = pushUndo({
    label: what,
    undo: guard("没能撤销删除。", async () => { await putEntries(snaps); await afterChange({}); }),
    redo: guard("没能重做删除。", async () => { await delEntries(snaps); await afterChange({}); }),
  });
  bus.emit("trash:purged", { count: snaps.length, all });
  await refresh();
  toast(all ? `已清空 ${snaps.length} 项` : "已删除" + nameOf(snaps[0]), { action: { label: "撤销", run: () => runUndo(u) }, timeout: 9000 });
  return u;
}

async function purgeOne(entry) {
  const info = describe(entry, S.books);
  const extra = entry.kind === "book" ? `连同 ${info.chapters} 章一起删掉。` : "";
  const ok = await confirm(`彻底删除${info.title}？`, `${extra}删掉后${L()}里也没有了。删完马上点「撤销」还能找回，关掉软件后就找不回了。`, "彻底删除", true);
  if (ok) await purge([entry]);
}

async function emptyAll() {
  const entries = await listTrash(S.bookId || undefined);
  if (!entries.length) { toast(L() + "已经是空的"); return; }
  const counts = kindsIn(entries).map((k) => `${kindLabel(k)} ${entries.filter((e) => e.kind === k).length}`).join("、");
  const scope = S.bookId ? "本书在" + L() + "里的" : L() + "里的";
  const ok = await confirm(`清空${S.bookId ? "本书的" : ""}${L()}？`,
    `${scope} ${entries.length} 项（${counts}）会彻底删除。删完马上点「撤销」还能找回，关掉软件后就找不回了。`, "清空", true);
  if (ok) await purge(entries, { all: true });
}

// ---------------- 看内容 ----------------
function preview(entry) {
  const info = describe(entry, S.books);
  let body;
  if (entry.kind === "chapter") {
    const ch = entry.data.chapter;
    body = h("div.trash-read", {}, ch.content ? ch.content : h("span.muted", {}, "这一章没有正文。"));
  } else if (entry.kind === "book") {
    const { book, chapters = [] } = entry.data;
    const sorted = [...chapters].sort((a, b) => a.order - b.order);
    body = h("div.trash-read-book", {},
      book.intro ? h("p.trash-read-intro", {}, book.intro) : null,
      h("ol.trash-read-list", {}, ...sorted.map((c, i) => h("li", {},
        h("span.grow", {}, describe({ kind: "chapter", bookId: entry.bookId, data: { chapter: c } }, { [entry.bookId]: { book, live: false, chapters: sorted } }).title || `第${i + 1}章`),
        h("span.muted", {}, (c.words || 0).toLocaleString() + " 字")))));
  } else {
    body = h("p.muted", {}, "这类内容还不能在这里预览。");
  }
  const m = modal({
    title: info.title,
    body, wide: true,
    actions: [
      { label: "恢复", primary: true, onClick: () => { m.close(true); restore(entry); } },
      { label: "关闭", onClick: () => m.close() },
    ],
  });
}

// ---------------- 界面 ----------------
async function renderTrash(params, restoreState, prev) {
  S.bookId = params.bookId || null;
  if (S.bookId) S.fromBook = S.bookId;
  else if (!prev || prev.name !== "trash") S.fromBook = null;
  if (!prev || prev.name !== "trash") S.kind = "all";

  const back = h("button.icon-btn", { type: "button", title: "返回（Alt+←）", "aria-label": "返回" }, icon("back"));
  back.addEventListener("click", () => nav.back());
  S.titleEl = h("span.title.trash-title-bar", {}, L());
  S.undoBtn = h("button.icon-btn", { type: "button", "aria-label": "撤销", title: "撤销（Ctrl+Z）" }, icon("undo"));
  S.redoBtn = h("button.icon-btn", { type: "button", "aria-label": "重做", title: "重做（Ctrl+Shift+Z）" }, icon("redo"));
  S.undoBtn.addEventListener("click", () => runUndo());
  S.redoBtn.addEventListener("click", () => runRedo());
  S.emptyBtn = h("button.tool-btn.trash-empty-btn", { type: "button", title: "全部彻底删除" }, icon("trash"), h("span", {}, "清空"));
  S.emptyBtn.addEventListener("click", emptyAll);
  S.barEl = h("div.trash-bar");
  S.listEl = h("div.trash-list", { role: "list" });
  S.main = h("main.trash-main", {}, h("div.trash-wrap", {}, S.barEl, S.listEl));
  S.view = h("div.view.trash", {},
    h("header.topbar", {}, back, S.titleEl, h("span.spacer"), S.undoBtn, S.redoBtn, h("span.tb-sep"), S.emptyBtn),
    S.main);
  document.getElementById("app").replaceChildren(S.view);
  updateUndoBtns();
  await refresh();
  if (restoreState && restoreState.trashScroll) S.main.scrollTop = restoreState.trashScroll;
  tip("trash-first", `删掉的作品和章节在这里放 ${KEEP_DAYS} 天，过了自动清理。点「恢复」放回原处，恢复了也能撤销。`);
}

async function refresh() {
  if (!onTrash()) return;
  const scroll = S.main.scrollTop;
  try { await load(); }
  catch (e) {
    S.listEl.replaceChildren(h("div.empty", {}, L() + "没读出来。"));
    return failed(L() + "读不出来。", e, refresh);
  }
  const scopeBook = S.bookId && S.books[S.bookId] && S.books[S.bookId].book;
  S.titleEl.textContent = L() + (scopeBook ? " · 《" + scopeBook.title + "》" : "");
  document.title = L() + " · 小恶魔文书";
  renderBar();
  renderList();
  S.main.scrollTop = scroll;
  updateUndoBtns();
}

function seg(items, cur, onPick, cls = "") {
  const box = h("div.trash-seg" + cls, { role: "group" });
  items.forEach(([id, text]) => {
    const b = h("button", { type: "button", "aria-pressed": String(id === cur), "data-v": id }, text);
    b.addEventListener("click", () => { if (id !== cur) onPick(id); });
    box.append(b);
  });
  return box;
}

function renderBar() {
  const parts = [];
  if (S.fromBook) {
    const ctx = S.books[S.fromBook];
    const live = ctx ? ctx.live : true;
    const name = ctx && ctx.book ? "《" + ctx.book.title + "》" : "本书";
    if (live || S.bookId) {
      parts.push(seg([["book", name], ["all", "全部"]], S.bookId ? "book" : "all",
        (v) => nav.go(v === "book" ? "/trash/" + S.fromBook : "/trash", { replace: true }), ".trash-scope"));
    }
  }
  const kinds = kindsIn(S.list);
  if (kinds.length > 1) parts.push(seg([["all", "全部类型"], ...kinds.map((k) => [k, kindLabel(k)])], S.kind, (v) => { S.kind = v; renderBar(); renderList(); }, ".trash-kinds"));
  else S.kind = "all";
  const n = filterKind(S.list, S.kind).length;
  parts.push(h("span.trash-count.muted", {}, S.list.length ? `${n} 项 · 放 ${KEEP_DAYS} 天后自动清理` : ""));
  S.barEl.replaceChildren(...parts);
  S.emptyBtn.disabled = !S.list.length;
}

function renderList() {
  const items = filterKind(S.list, S.kind);
  if (!S.list.length) {
    const scoped = !!S.bookId;
    S.listEl.replaceChildren(h("div.trash-none", {},
      h("p.trash-none-t", {}, scoped ? "这本书没有删掉的东西" : L() + "是空的"),
      h("p.muted", {}, `删掉的作品和章节会在这里放 ${KEEP_DAYS} 天，这期间随时能恢复。`),
      scoped ? h("button.btn", { type: "button", onclick: () => nav.go("/trash", { replace: true }) }, "看全部") : null));
    return;
  }
  const now = Date.now();
  S.listEl.replaceChildren(...items.map((e) => itemEl(e, now)));
}

function itemEl(entry, now) {
  const info = describe(entry, S.books);
  const bookLine = entry.kind === "book"
    ? `${info.chapters} 章`
    : info.bookState === "live" ? `《${info.bookTitle}》`
      : info.bookState === "trashed" ? `《${info.bookTitle}》（作品也在${L()}里）`
        : "原作品已经彻底删除";
  const soon = isSoon(entry.deletedAt, now);
  const meta = h("p.trash-meta", {},
    h("span", {}, bookLine),
    h("span", {}, (info.words || 0).toLocaleString() + " 字"),
    h("span", { title: new Date(entry.deletedAt).toLocaleString() }, "删除于 " + fmtTime(entry.deletedAt)),
    h("span.trash-left" + (soon ? ".soon" : ""), {}, leftText(entry.deletedAt, now)));
  const act = (text, cls, fn, title) => {
    const b = h("button.btn.small" + cls, { type: "button", title: title || text }, text);
    b.addEventListener("click", fn);
    return b;
  };
  return h("article.trash-item", { role: "listitem", "data-id": entry.id, "data-kind": entry.kind },
    h("div.trash-info", {},
      h("div.trash-head", {},
        h("span.trash-kind.k-" + entry.kind, {}, info.kindText),
        h("h3.trash-name", {}, info.title),
        info.sub ? h("span.trash-sub.muted", {}, info.sub) : null),
      meta,
      info.excerpt ? h("p.trash-excerpt", {}, info.excerpt) : null),
    h("div.trash-acts", {},
      act("看内容", ".ghost.trash-peek", () => preview(entry)),
      act("恢复", ".primary.trash-restore", () => restore(entry), "放回原处"),
      act("彻底删除", ".ghost.trash-purge", () => purgeOne(entry))));
}

// ---------------- 注册 ----------------
export async function register() {
  nav.route("trash", "/trash/:bookId?", (params, restoreState, prev) => renderTrash(params, restoreState, prev));
  nav.onLeave(() => (onTrash() ? { trashScroll: S.main.scrollTop } : {}));
  bus.on("route", ({ name }) => { if (name !== "trash") { S.view = null; S.undoBtn = S.redoBtn = null; } });
  bus.on("undo", () => { if (!selfOp) myUndone.length = 0; });
  bus.on("redo", () => { if (!selfOp) myUndone.length = 0; });
  bus.on("undo:changed", () => { if (!appUndo.canRedo()) myUndone.length = 0; updateUndoBtns(); });
  bus.on("settings:changed", ({ patch }) => { if (patch && "themeNames" in patch && onTrash()) refresh(); });

  commands.register({
    id: "nav.trash",
    get title() { return label("回收站"); },
    keywords: "回收站 地狱 删除 删掉 误删 找回 恢复 撤销删除 清空 彻底删除",
    hint: `删掉的作品和章节放 ${KEEP_DAYS} 天，随时能恢复`,
    run: () => nav.go(ws.book ? "/trash/" + ws.book.id : "/trash"),
  });
  const here = () => onTrash() && !hasLayers();
  const typing = () => document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  commands.register({
    id: "trash.empty",
    get title() { return "清空" + label("回收站"); },
    keywords: "清空 全部删除 彻底删除 回收站",
    hint: "彻底删除这里的全部内容，删完能撤销",
    when: onTrash,
    run: emptyAll,
  });
  commands.register({ id: "trash.undo", title: "撤销", keywords: "撤回 后悔 恢复错了", hint: "撤销刚才在这里的恢复、删除", key: "Mod-z", when: () => here() && !typing() && canUndoHere(), run: () => runUndo() });
  commands.register({ id: "trash.redo", title: "重做", keywords: "重做 撤销错了", key: "Mod-Shift-z", when: () => here() && !typing() && canRedoHere(), run: () => runRedo() });
}
