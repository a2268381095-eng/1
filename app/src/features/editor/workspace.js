// 写作界面：左边章节列表，中间正文，右边侧栏（默认是本章要点，查找、历史等面板也在这里打开），底部状态栏。
// 其他功能通过 ws（export 的 workspace 对象）拿到当前作品、章节、编辑器，往右侧栏放自己的面板。
import { getBook, updateBook, listChapters, getChapter, createChapter, updateChapter, saveContent, moveChapter, setOrder,
  trashChapter, restoreFromTrash, listTrash, todayWords } from "../../core/store.js";
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { h, icon, toast, confirm, notice, pushLayer, prompt } from "../../core/ui.js";
import { commands } from "../../core/commands.js";
import { getSettings, label } from "../../core/settings.js";
import { chapterLabel, volumeLabel, countWords, fmtTime } from "../../core/text.js";
import { uid } from "../../core/db.js";
import { createEditor } from "./editor.js";
import { renderPoints } from "./points.js";
import { setDemonBook, setDemonVisible, tip } from "../demon/demon.js";
import { bookForm } from "../shelf/shelf.js";

// ---------------- 对外接口 ----------------
export const ws = {
  book: null,
  chapters: [],          // 当前作品的章节（按顺序）
  current: null,         // 当前章
  editor: null,
  selected: new Set(),   // 章节列表里多选的章（批量排版、导出用）
  /** 第几章（从 1 数）和显示用的「第一章」 */
  indexOf(id) { return ws.chapters.findIndex((c) => c.id === id) + 1; },
  labelOf(c) { return chapterLabel(ws.indexOf(c.id), ws.book ? ws.book.numbering : "zh"); },
  fullTitle(c) { return ws.labelOf(c) + (c.title ? " " + c.title : ""); },
  isOpen: () => !!ws.book,
  openChapter: (id, restore) => openChapter(id, restore),
  refresh: () => refreshList(),
  /** 当前章最新的正文（编辑器里还没保存的也算） */
  textOf(id) { return id === (ws.current && ws.current.id) ? ws.editor.getText() : (ws.chapters.find((c) => c.id === id) || {}).content || ""; },
  /** 右侧栏放一个面板。返回 { body, close }。同一时间只放一个，关掉后回到要点。 */
  openPanel: (o) => openPanel(o),
  closePanel: () => closePanel(),
  /**
   * 批量改写几章的正文，算一步，可以整体撤销。
   * changes: [{ chapterId, after }]；label：撤销提示里显示的名字。
   */
  applyBatch: (lbl, changes) => applyBatch(lbl, changes),
  selectedIds() { return ws.chapters.filter((c) => ws.selected.has(c.id)).map((c) => c.id); },
};

let els = null;            // 界面元素
let panelLayer = null;     // 当前打开的右侧面板
let rightHidden = false;
let focusLayer = null;
let saving = null;         // 正在进行的保存
let unsaved = new Map();   // 保存失败时暂存在内存里的正文 id → text
let liveWords = 0;

// ---------------- 进入作品 ----------------
async function renderBook(params, restore) {
  const app = document.getElementById("app");
  const book = await getBook(params.bookId);
  if (!book) { toast("这本书找不到了，可能已经删进" + label("回收站")); return nav.go("/", { replace: true }); }
  ws.book = book;
  await updateBook(book.id, { openedAt: Date.now() });
  setDemonBook(book);
  ws.chapters = await listChapters(book.id);
  if (!ws.chapters.length) ws.chapters = [await createChapter(book.id, {})];
  ws.selected.clear();
  buildLayout(app);
  const want = params.chapterId || book.lastChapterId;
  const ch = ws.chapters.find((c) => c.id === want) || ws.chapters[0];
  await openChapter(ch.id, restore && restore[ch.id], { replace: true });
  if (restore && restore.listScroll != null) els.list.scrollTop = restore.listScroll;
  nav.onLeave(() => {
    if (!ws.current || !ws.editor) return {};
    ws.editor.flush();
    return { [ws.current.id]: ws.editor.position(), listScroll: els ? els.list.scrollTop : 0 };
  });
  tip("editor-first", "左边是章节，右边记本章要点。停手 1 秒就自动保存，不用按保存。找不到功能就点我旁边的「?」。");
}

function buildLayout(app) {
  const back = h("button.icon-btn", { type: "button", title: "返回书架（Alt+←）", "aria-label": "返回" }, icon("back"));
  back.addEventListener("click", () => { leaveBook(); nav.back(); });
  const bookTitle = h("button.book-name", { type: "button", title: "作品信息" }, ws.book.title);
  bookTitle.addEventListener("click", editBookInfo);
  const tb = (ico, text, cmd, title) => {
    const b = h("button.tool-btn", { type: "button", title: title || text, "data-cmd": cmd }, icon(ico), h("span.tb-t", {}, text));
    b.addEventListener("click", () => commands.run(cmd));
    return b;
  };
  const undoBtn = h("button.icon-btn", { type: "button", title: "撤销（Ctrl+Z）", "aria-label": "撤销" }, icon("undo"));
  const redoBtn = h("button.icon-btn", { type: "button", title: "重做（Ctrl+Shift+Z）", "aria-label": "重做" }, icon("redo"));
  undoBtn.addEventListener("click", () => smartUndo());
  redoBtn.addEventListener("click", () => smartRedo());
  const pointsBtn = h("button.icon-btn", { type: "button", title: "显示 / 隐藏右侧栏", "aria-label": "右侧栏", "aria-pressed": String(!rightHidden) }, icon("flag"));
  pointsBtn.addEventListener("click", () => toggleRight());

  const topbar = h("header.topbar", {}, back, bookTitle, h("span.spacer"), undoBtn, redoBtn, h("span.tb-sep"),
    tb("search", "查找", "search.open", "查找替换（Ctrl+F）"), tb("format", "排版", "format.open", "一键排版"),
    tb("history", "历史", "versions.open", "本章历史版本"), tb("focus", "专注", "focus.toggle", "专注模式（F11）"),
    h("span.tb-sep"), pointsBtn,
    h("button.icon-btn", { type: "button", title: label("设置"), "aria-label": label("设置"), onclick: () => nav.go("/settings") }, icon("gear")));

  const list = h("div.ch-list", { role: "listbox", "aria-label": "章节", "aria-multiselectable": "true" });
  const newBtn = h("button.icon-btn", { type: "button", title: "新建章节（Ctrl+Enter）", "aria-label": "新建章节" }, icon("plus"));
  newBtn.addEventListener("click", () => newChapter());
  const sideMore = h("button.icon-btn", { type: "button", title: "更多", "aria-label": "章节更多操作" }, icon("more"));
  sideMore.addEventListener("click", () => listMenu(sideMore));
  const selBar = h("div.sel-bar", { hidden: true });
  const left = h("aside.panel.side-left", { "aria-label": "章节列表" },
    h("div.panel-head", {}, h("h3", {}, "章节"), newBtn, sideMore), selBar, list);

  const chNo = h("span.ch-no");
  const chTitle = h("input.ch-title", { placeholder: "章名（可以先空着）", "aria-label": "章名", maxlength: "60" });
  let titleTimer = 0;
  chTitle.addEventListener("input", () => {
    clearTimeout(titleTimer);
    const id = ws.current.id, v = chTitle.value;
    titleTimer = setTimeout(async () => { await updateChapter(id, { title: v.trim() }); const c = ws.chapters.find((x) => x.id === id); if (c) c.title = v.trim(); renderList(); }, 400);
  });
  chTitle.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); ws.editor.focus(); } });
  const edHost = h("div.ed-host");
  const center = h("main.center", {}, h("div.ch-head", {}, chNo, chTitle), edHost);

  const right = h("aside.panel.side-right", { "aria-label": "侧栏" });

  const sWords = h("span"), sToday = h("span"), sSave = h("span"), sTotal = h("span");
  const status = h("footer.statusbar", {}, sWords, sToday, sTotal, h("span.spacer"), sSave);
  const body = h("div.ws-body", {}, left, center, right);
  const view = h("div.view.ws" + (rightHidden ? ".no-right" : ""), {}, topbar, body, status);
  app.replaceChildren(view);
  els = { view, list, selBar, chNo, chTitle, edHost, right, sWords, sToday, sSave, sTotal, pointsBtn, undoBtn, redoBtn, left };

  ws.editor = createEditor({
    parent: edHost,
    getBook: () => ws.book,
    onSave: saveNow,
    onDocChange: (id, text) => { liveWords = countWords(text); updateStatus(); markDirty(); setItemWords(id, liveWords); },
    beforeUndo: batchUndoFor,
  });
  renderList();
  showPoints();
}

function leaveBook() {
  if (ws.editor) ws.editor.flush();
}

// ---------------- 章节列表 ----------------
function renderList() {
  if (!els) return;
  const list = els.list;
  const scroll = list.scrollTop;
  list.textContent = "";
  const book = ws.book;
  const vols = book.useVolumes ? book.volumes || [] : [];
  const groups = book.useVolumes ? [...vols.map((v) => ({ v, items: [] })), { v: null, items: [] }] : [{ v: null, items: [] }];
  ws.chapters.forEach((c) => {
    const g = (book.useVolumes && groups.find((x) => x.v && x.v.id === c.volumeId)) || groups[groups.length - 1];
    g.items.push(c);
  });
  groups.forEach((g, gi) => {
    if (book.useVolumes && (g.v || g.items.length)) {
      const head = h("div.vol-head", {}, g.v ? volumeLabel(gi + 1, book.numbering) + (g.v.title ? " " + g.v.title : "") : "未分卷");
      if (g.v) head.addEventListener("dblclick", () => renameVolume(g.v));
      head.addEventListener("dragover", (e) => { e.preventDefault(); head.classList.add("drop"); });
      head.addEventListener("dragleave", () => head.classList.remove("drop"));
      head.addEventListener("drop", (e) => { e.preventDefault(); head.classList.remove("drop"); dropOn(null, g.v ? g.v.id : null); });
      list.append(head);
    }
    g.items.forEach((c) => list.append(chapterItem(c)));
  });
  list.scrollTop = scroll;
  renderSelBar();
}

function chapterItem(c) {
  const open = c.points ? c.points.filter((p) => !p.done).length : 0;
  const cur = ws.current && ws.current.id === c.id;
  const sel = ws.selected.has(c.id);
  const item = h("div.ch-item" + (cur ? ".cur" : "") + (sel ? ".sel" : ""), {
    role: "option", tabindex: cur ? "0" : "-1", draggable: "true", "aria-selected": String(sel || cur), "data-id": c.id,
  },
  h("span.ch-item-no", {}, ws.labelOf(c)),
  h("span.ch-item-t", {}, c.title || (cur ? "" : "")),
  open ? h("span.pt-badge", { title: `还有 ${open} 条要点没打勾` }, open) : null,
  h("span.ch-item-w", {}, (c.id === (ws.current && ws.current.id) ? liveWords : c.words || 0).toLocaleString()));
  item.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey) { toggleSel(c.id); return; }
    if (e.shiftKey && ws.current) { rangeSel(c.id); return; }
    if (ws.selected.size) { ws.selected.clear(); }
    openChapter(c.id);
  });
  item.addEventListener("dblclick", () => renameChapter(c));
  item.addEventListener("contextmenu", (e) => { e.preventDefault(); chapterMenu(c, e.clientX, e.clientY); });
  item.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = ws.chapters.findIndex((x) => x.id === c.id) + (e.key === "ArrowDown" ? 1 : -1);
      if (ws.chapters[i]) openChapter(ws.chapters[i].id).then(() => focusItem(ws.chapters[i].id));
    } else if (e.key === "Enter") ws.editor.focus();
    else if (e.key === "Delete") deleteChapter(c);
    else if (e.key === "F2") renameChapter(c);
  });
  // 拖动排序
  item.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; dragId = c.id; item.classList.add("dragging"); });
  item.addEventListener("dragend", () => { item.classList.remove("dragging"); dragId = null; });
  item.addEventListener("dragover", (e) => {
    if (!dragId || dragId === c.id) return;
    e.preventDefault();
    const r = item.getBoundingClientRect();
    item.classList.toggle("drop-before", e.clientY < r.top + r.height / 2);
    item.classList.toggle("drop-after", e.clientY >= r.top + r.height / 2);
  });
  item.addEventListener("dragleave", () => item.classList.remove("drop-before", "drop-after"));
  item.addEventListener("drop", (e) => {
    e.preventDefault();
    const after = item.classList.contains("drop-after");
    item.classList.remove("drop-before", "drop-after");
    dropOn(c.id, c.volumeId || null, after);
  });
  return item;
}

let dragId = null;
async function dropOn(targetId, volumeId, after = false) {
  const id = dragId;
  if (!id) return;
  const beforeIds = ws.chapters.map((c) => c.id);
  const beforeVol = ws.chapters.find((c) => c.id === id).volumeId || null;
  let idx;
  const rest = ws.chapters.filter((c) => c.id !== id);
  if (targetId) idx = rest.findIndex((c) => c.id === targetId) + (after ? 1 : 0);
  else {
    // 拖到卷标题上：放到那一卷的最后
    const inVol = rest.filter((c) => (c.volumeId || null) === volumeId);
    idx = inVol.length ? rest.indexOf(inVol[inVol.length - 1]) + 1 : rest.length;
  }
  await moveChapter(id, idx, ws.book.useVolumes ? volumeId : undefined);
  await refreshList();
  const afterIds = ws.chapters.map((c) => c.id);
  const ch = ws.chapters.find((c) => c.id === id);
  appUndo.push({
    label: "移动章节",
    undo: async () => { await setOrder(ws.book.id, beforeIds, { [id]: beforeVol }); await refreshList(); },
    redo: async () => { await setOrder(ws.book.id, afterIds, { [id]: ch.volumeId || null }); await refreshList(); },
  });
  toast(`已把${ws.labelOf(ch)}移到这里`, { action: { label: "撤销", run: () => appUndo.undo() } });
}

function setItemWords(id, n) {
  const el = els && els.list.querySelector(`[data-id="${id}"] .ch-item-w`);
  if (el) el.textContent = n.toLocaleString();
}

function focusItem(id) { const el = els.list.querySelector(`[data-id="${id}"]`); if (el) el.focus(); }

function toggleSel(id) {
  if (!ws.selected.size && ws.current) ws.selected.add(ws.current.id);
  ws.selected.has(id) ? ws.selected.delete(id) : ws.selected.add(id);
  renderList();
}
function rangeSel(id) {
  const a = ws.chapters.findIndex((c) => c.id === ws.current.id), b = ws.chapters.findIndex((c) => c.id === id);
  ws.selected.clear();
  ws.chapters.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((c) => ws.selected.add(c.id));
  renderList();
}
function renderSelBar() {
  const n = ws.selected.size;
  els.selBar.hidden = n < 2;
  if (n < 2) return;
  els.selBar.replaceChildren(h("span", {}, `已选 ${n} 章`), h("span.spacer"),
    h("button.btn.small", { type: "button", onclick: () => commands.run("format.open") }, "排版这几章"),
    h("button.btn.small.ghost", { type: "button", onclick: () => { ws.selected.clear(); renderList(); } }, "取消选择"));
}

async function refreshList() {
  if (!ws.book) return;
  ws.chapters = await listChapters(ws.book.id);
  if (ws.current) {
    const c = ws.chapters.find((x) => x.id === ws.current.id);
    if (c) ws.current = c;
  }
  for (const id of [...ws.selected]) if (!ws.chapters.some((c) => c.id === id)) ws.selected.delete(id);
  renderList();
  updateHead();
  updateStatus();
}

// ---------------- 打开 / 新建 / 改名 / 删除章节 ----------------
async function openChapter(id, restore, { replace = false } = {}) {
  if (ws.current && ws.current.id !== id && ws.editor) await ws.editor.flush();
  const ch = await getChapter(id);
  if (!ch) return;
  const i = ws.chapters.findIndex((c) => c.id === id);
  if (i >= 0) ws.chapters[i] = ch;
  ws.current = ch;
  liveWords = ch.words || countWords(ch.content);
  await ws.editor.open(ch, restore);
  updateHead();
  renderList();
  showPoints();
  updateStatus();
  updateBook(ws.book.id, { lastChapterId: id });
  const path = `/book/${ws.book.id}/${id}`;
  if (location.hash !== "#" + path) history.replaceState(history.state, "", "#" + path);
  bus.emit("chapter:opened", { chapter: ch });
  if (!restore) ws.editor.focus();
}

function updateHead() {
  if (!ws.current) return;
  els.chNo.textContent = ws.labelOf(ws.current);
  if (document.activeElement !== els.chTitle) els.chTitle.value = ws.current.title || "";
}

async function newChapter(afterId) {
  await ws.editor.flush();
  const after = afterId || (ws.current ? ws.current.id : null);
  const ch = await createChapter(ws.book.id, { afterId: after });
  await refreshList();
  await openChapter(ch.id);
  els.chTitle.focus();
  appUndo.push({
    label: "新建章节",
    undo: async () => { await trashChapter(ch.id); await afterRemove(ch.id); },
    redo: async () => {
      const e = (await listTrash(ws.book.id)).find((x) => x.data.chapter && x.data.chapter.id === ch.id);
      if (e) await restoreFromTrash(e.id);
      await refreshList();
    },
  });
}

async function renameChapter(c) {
  if (ws.current && ws.current.id === c.id) { els.chTitle.focus(); els.chTitle.select(); return; }
  const v = await prompt(ws.labelOf(c) + " 的章名", c.title || "", "章名");
  if (v == null) return;
  await updateChapter(c.id, { title: v.trim() });
  await refreshList();
}

async function deleteChapter(c) {
  const text = ws.textOf(c.id);
  if (countWords(text) > 0) {
    bus.emit("chapter:delete-ask", { chapter: c });
    const ok = await confirm(`删除${ws.fullTitle(c)}？`, `这一章有 ${countWords(text).toLocaleString()} 字，会放进${label("回收站")}，30 天内能找回；删完马上点「撤销」也行。`, "删除", true);
    if (!ok) return;
  }
  if (ws.current && ws.current.id === c.id) await ws.editor.flush();
  const idx = ws.chapters.findIndex((x) => x.id === c.id);
  const name = ws.fullTitle(c);
  const tid = await trashChapter(c.id);
  await afterRemove(c.id, idx);
  const entry = appUndo.push({
    label: "删除章节",
    undo: async () => { await restoreFromTrash(tid); await refreshList(); await openChapter(c.id); },
    redo: async () => { await trashChapter(c.id); await afterRemove(c.id); },
  });
  toast(`已删除${name}`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
}

async function afterRemove(id, idx) {
  ws.editor.forget(id);
  ws.selected.delete(id);
  const wasCurrent = ws.current && ws.current.id === id;
  ws.chapters = await listChapters(ws.book.id);
  if (!ws.chapters.length) ws.chapters = [await createChapter(ws.book.id, {})];
  if (wasCurrent) {
    ws.current = null;
    const next = ws.chapters[Math.min(idx != null ? idx : 0, ws.chapters.length - 1)];
    ws.editor.close();
    await openChapter(next.id);
  } else renderList();
}

function chapterMenu(c, x, y) {
  const items = [
    ["打开", () => openChapter(c.id)],
    ["在后面插入新章", () => newChapter(c.id)],
    ["改章名", () => renameChapter(c)],
    ws.book.useVolumes ? ["移到卷…", () => moveToVolume(c)] : null,
    ["sep"],
    ["删除这一章", () => deleteChapter(c), true],
  ];
  popupMenu(items.filter(Boolean), x, y);
}

function listMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  popupMenu([
    ["新建章节", () => newChapter()],
    ws.book.useVolumes ? ["新建一卷", () => newVolume()] : null,
    [ws.book.useVolumes ? "不分卷" : "分卷", () => toggleVolumes()],
    [ws.book.numbering === "zh" ? "章节号改成 第1章" : "章节号改成 第一章", async () => {
      ws.book = await updateBook(ws.book.id, { numbering: ws.book.numbering === "zh" ? "num" : "zh" }); renderList(); updateHead();
    }],
    ["sep"],
    [label("回收站") + "（本书）", () => nav.go("/trash/" + ws.book.id)],
  ].filter(Boolean), r.left, r.bottom + 4);
}

function popupMenu(items, x, y) {
  const menu = h("div.menu", { role: "menu" });
  items.forEach(([text, fn, danger]) => {
    if (text === "sep") { menu.append(h("div.menu-sep")); return; }
    const b = h("button.menu-item" + (danger ? ".danger" : ""), { type: "button", role: "menuitem" }, text);
    b.addEventListener("click", () => { layer.close(); fn(); });
    menu.append(b);
  });
  document.body.append(menu);
  menu.style.left = Math.min(x, innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = Math.min(y, innerHeight - menu.offsetHeight - 8) + "px";
  const off = (e) => { if (!menu.contains(e.target)) layer.close(); };
  const layer = pushLayer({ onClose: () => { menu.remove(); document.removeEventListener("mousedown", off, true); } });
  setTimeout(() => document.addEventListener("mousedown", off, true), 0);
  const first = menu.querySelector("button");
  if (first) first.focus();
}

// ---------------- 分卷 ----------------
async function toggleVolumes() {
  const on = !ws.book.useVolumes;
  let volumes = ws.book.volumes || [];
  if (on && !volumes.length) volumes = [{ id: uid("v"), title: "" }];
  ws.book = await updateBook(ws.book.id, { useVolumes: on, volumes });
  if (on) {
    const first = volumes[0].id;
    for (const c of ws.chapters) if (!c.volumeId) await updateChapter(c.id, { volumeId: first });
  }
  await refreshList();
}
async function newVolume() {
  const title = await prompt("新的一卷", "", "卷名（可以空着）");
  if (title == null) return;
  const volumes = [...(ws.book.volumes || []), { id: uid("v"), title: title.trim() }];
  ws.book = await updateBook(ws.book.id, { volumes });
  renderList();
}
async function renameVolume(v) {
  const title = await prompt("卷名", v.title || "");
  if (title == null) return;
  const volumes = ws.book.volumes.map((x) => (x.id === v.id ? { ...x, title: title.trim() } : x));
  ws.book = await updateBook(ws.book.id, { volumes });
  renderList();
}
async function moveToVolume(c) {
  const vols = ws.book.volumes || [];
  popupMenu(vols.map((v, i) => [volumeLabel(i + 1, ws.book.numbering) + (v.title ? " " + v.title : ""), async () => {
    const lastInVol = ws.chapters.filter((x) => x.volumeId === v.id && x.id !== c.id).pop();
    const rest = ws.chapters.filter((x) => x.id !== c.id);
    await moveChapter(c.id, lastInVol ? rest.indexOf(lastInVol) + 1 : rest.length, v.id);
    await refreshList();
  }]), innerWidth / 2 - 90, innerHeight / 3);
}

// ---------------- 保存 ----------------
function markDirty() { els.sSave.textContent = "正在写…"; els.sSave.className = ""; }

async function saveNow(id, text) {
  const run = async () => {
    try {
      const ch = await saveContent(id, text);
      unsaved.delete(id);
      const c = ws.chapters.find((x) => x.id === id);
      if (c && ch) { c.content = ch.content; c.words = ch.words; c.updatedAt = ch.updatedAt; }
      if (els) { els.sSave.textContent = "已自动保存 " + fmtTime(Date.now()).replace("今天 ", ""); els.sSave.className = ""; }
      updateStatus();
    } catch (e) {
      unsaved.set(id, text);
      if (els) { els.sSave.textContent = "保存失败，正文还在内存里"; els.sSave.className = "save-err"; }
      bus.emit("save:failed", { error: e });
      notice({
        what: "这一章没能存进本地。",
        why: "磁盘空间不足、浏览器存储被清理或被限制。正文还在编辑器里，没有丢。",
        detail: e && (e.stack || e.message || e),
        actions: [
          { label: "另存到其他位置", primary: true, run: () => downloadText(ws.fullTitle(ws.current) + ".txt", text) },
          { label: "重试保存", run: () => saveNow(id, text) },
        ],
      });
    }
  };
  saving = (saving || Promise.resolve()).then(run);
  return saving;
}

export function downloadText(name, text) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

window.addEventListener("beforeunload", (e) => {
  if (ws.editor) ws.editor.flush();
  if (unsaved.size) { e.preventDefault(); e.returnValue = ""; }
});

// ---------------- 状态栏 ----------------
let todayCache = { at: 0, n: 0 };
async function updateStatus() {
  if (!els || !ws.book) return;
  els.sWords.textContent = `本章 ${liveWords.toLocaleString()} 字`;
  const total = ws.chapters.reduce((s, c) => s + (c.id === (ws.current && ws.current.id) ? liveWords : c.words || 0), 0);
  els.sTotal.textContent = `全书 ${total.toLocaleString()} 字`;
  if (Date.now() - todayCache.at > 1500) todayCache = { at: Date.now(), n: await todayWords(ws.book.id) };
  const goal = ws.book.dailyGoal;
  els.sToday.textContent = goal ? `今天 ${todayCache.n.toLocaleString()} / ${goal.toLocaleString()}` : `今天 ${todayCache.n.toLocaleString()} 字`;
  els.sToday.className = goal && todayCache.n >= goal ? "goal-done" : "";
  els.undoBtn.disabled = false;
}
bus.on("content:saved", () => { todayCache.at = 0; });

// ---------------- 右侧栏 ----------------
function showPoints() {
  if (!els || panelLayer) return;
  els.right.replaceChildren();
  if (ws.current) renderPoints(els.right, ws.current, async (points) => {
    const before = ws.current.points || [];
    await updateChapter(ws.current.id, { points });
    ws.current.points = points;
    const c = ws.chapters.find((x) => x.id === ws.current.id);
    if (c) c.points = points;
    renderList();
    if (points.length && points.every((p) => p.done) && !(before.length && before.every((p) => p.done))) bus.emit("points:all-done", { chapter: ws.current });
  });
}

function openPanel({ title, render, onClose, isDirty, wide }) {
  if (panelLayer) panelLayer.close(true);
  if (rightHidden) toggleRight(true);
  const body = h("div.panel-body");
  const x = h("button.icon-btn", { type: "button", "aria-label": "关闭", title: "关闭（Esc）" }, icon("close"));
  els.right.replaceChildren(h("div.panel-head", {}, h("h3", {}, title), x), body);
  els.view.classList.toggle("wide-right", !!wide);
  const layer = pushLayer({
    isDirty,
    onClose: () => { panelLayer = null; els.view.classList.remove("wide-right"); onClose && onClose(); showPoints(); },
  });
  x.addEventListener("click", () => layer.close());
  panelLayer = layer;
  render && render(body);
  return { body, close: (force) => layer.close(force), layer };
}
function closePanel() { if (panelLayer) panelLayer.close(); }

function toggleRight(force) {
  rightHidden = force === true ? false : !rightHidden;
  els.view.classList.toggle("no-right", rightHidden);
  els.pointsBtn.setAttribute("aria-pressed", String(!rightHidden));
}

// ---------------- 撤销 ----------------
/** 编辑器里按 Ctrl+Z：如果最近一步是包含这一章的批量操作，并且之后没再打字，就整体撤销 */
function batchUndoFor(chapterId, depth) {
  const top = appUndo.peek();
  if (top && top.chapters && top.chapters[chapterId] === depth) { appUndo.undo(); return true; }
  return false;
}
function smartUndo() {
  const top = appUndo.peek();
  if (ws.editor && ws.current && top && top.chapters && top.chapters[ws.current.id] === ws.editor.depth()) return appUndo.undo();
  if (top && !top.chapters && (!ws.editor || !ws.editor.hasFocus())) return appUndo.undo();
  if (ws.editor) { ws.editor.undo(); ws.editor.focus(); }
}
function smartRedo() {
  if (appUndo.canRedo() && (!ws.editor || !ws.editor.hasFocus())) return appUndo.redo();
  if (ws.editor) { ws.editor.redo(); ws.editor.focus(); }
}

async function applyBatch(lbl, changes) {
  if (!changes.length) return null;
  await ws.editor.flush();
  const befores = new Map();
  for (const ch of changes) befores.set(ch.chapterId, ws.textOf(ch.chapterId));
  const write = async (pick) => {
    const depths = {};
    for (const ch of changes) {
      const text = pick(ch);
      const d = ws.editor.applyText(ch.chapterId, text);
      if (d >= 0) depths[ch.chapterId] = d;
      await saveContent(ch.chapterId, text);
      const c = ws.chapters.find((x) => x.id === ch.chapterId);
      if (c) { c.content = text; c.words = countWords(text); }
    }
    if (ws.current) liveWords = countWords(ws.editor.getText());
    renderList();
    updateStatus();
    return depths;
  };
  const entry = { label: lbl, chapters: await write((c) => c.after) };
  entry.undo = async () => { entry.chapters = await write((c) => befores.get(c.chapterId)); };
  entry.redo = async () => { entry.chapters = await write((c) => c.after); };
  // 撤销以后编辑器里的深度变了，Ctrl+Z 判断用的是最新的
  appUndo.push(entry);
  return entry;
}

// ---------------- 作品信息 ----------------
async function editBookInfo() {
  const data = await bookForm(ws.book);
  if (!data) return;
  ws.book = await updateBook(ws.book.id, data);
  els.view.querySelector(".book-name").textContent = ws.book.title;
  setDemonBook(ws.book);
}

// ---------------- 专注模式 ----------------
function toggleFocus() {
  if (focusLayer) { focusLayer.close(); return; }
  els.view.classList.add("focus");
  setDemonVisible(false);
  focusLayer = pushLayer({ onClose: () => { focusLayer = null; els.view.classList.remove("focus"); setDemonVisible(true); } });
  toast("专注模式：按 Esc 或 F11 退出");
  ws.editor.focus();
}

// ---------------- 注册 ----------------
export function registerWorkspace() {
  nav.route("book", "/book/:bookId/:chapterId?", (params, restore) => renderBook(params, restore));
  bus.on("route", ({ name }) => { if (name !== "book") { ws.book = null; ws.current = null; els = null; if (panelLayer) panelLayer.close(true); } });
  bus.on("settings:changed", () => { if (ws.editor && ws.book) ws.editor.refreshTheme(); });
  const inBook = () => !!ws.book;
  commands.register({ id: "chapter.new", title: "新建章节", keywords: "加一章 下一章 插入章节", hint: "插在当前章后面", key: "Mod-Enter", when: inBook, run: () => newChapter() });
  commands.register({ id: "chapter.delete", title: "删除当前章", keywords: "删章 删除章节", hint: "放进" + label("回收站") + "，可以撤销", when: inBook, run: () => deleteChapter(ws.current) });
  commands.register({ id: "chapter.rename", title: "改章名", keywords: "章节名 标题 重命名", when: inBook, run: () => { els.chTitle.focus(); els.chTitle.select(); } });
  commands.register({ id: "chapter.prev", title: "上一章", keywords: "前一章", key: "Mod-PageUp", when: inBook, run: () => { const i = ws.indexOf(ws.current.id) - 2; if (ws.chapters[i]) openChapter(ws.chapters[i].id); } });
  commands.register({ id: "chapter.next", title: "下一章", keywords: "后一章", key: "Mod-PageDown", when: inBook, run: () => { const i = ws.indexOf(ws.current.id); if (ws.chapters[i]) openChapter(ws.chapters[i].id); } });
  commands.register({ id: "volume.toggle", title: "分卷 / 不分卷", keywords: "卷 分卷 第一卷", when: inBook, run: toggleVolumes });
  commands.register({ id: "focus.toggle", title: "专注模式", keywords: "全屏 隐藏面板 只看正文", hint: "隐藏所有面板，只剩正文", key: "F11", when: inBook, run: toggleFocus });
  commands.register({ id: "panel.right", title: "显示 / 隐藏右侧栏", keywords: "要点 侧栏", when: inBook, run: () => toggleRight() });
  commands.register({ id: "book.info", title: "修改作品信息", keywords: "书名 简介 封面 标签 类型", when: inBook, run: editBookInfo });
  commands.register({ id: "edit.undo", title: "撤销", keywords: "撤回 后悔", key: "Mod-z", when: () => inBook() && !(ws.editor && ws.editor.hasFocus()) && document.activeElement && !/INPUT|TEXTAREA/.test(document.activeElement.tagName), run: smartUndo });
  commands.register({ id: "edit.redo", title: "重做", key: "Mod-Shift-z", when: () => inBook() && !(ws.editor && ws.editor.hasFocus()) && document.activeElement && !/INPUT|TEXTAREA/.test(document.activeElement.tagName), run: smartRedo });
}
