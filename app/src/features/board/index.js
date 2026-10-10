// 主线分镜看板：主线一句话 → 大段落（卷 / 幕）→ 分镜卡 → 章节。整页 #/board/<书id>，写作界面顶栏「分镜」进去。
// 写正文时右侧栏最上面显示这一章挂的分镜卡（目标、冲突、转折、透露、谁出场），没挂的话可以就地挂一张。
// 命令：board.open（{ bookId?, cardId? }）、board.attach（把这一章挂到某张卡）
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { h, icon, toast } from "../../core/ui.js";
import { undo as appUndo } from "../../core/undo.js";
import { getBook, getChapter } from "../../core/store.js";
import { readMeta, listCards, catOf } from "../../core/lore.js";
import { getBoard, edit, cardOfChapter, indexOf, FIELDS, newCard, newAct } from "../../core/board.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { mountBoard } from "./view.js";

const TIP = "一段（卷 / 幕）一列，列里是分镜卡。按住卡拖动换顺序，点开能挂章节，卡上的目标、冲突会变成那一章的要点。";
let page = null;   // { api, undoBtn, redoBtn, bookId }
const onPage = () => { const c = nav.current(); return !!(c && c.name === "board" && page); };
const isBoardEntry = (e) => !!(e && e.board);

async function renderPage(params) {
  const book = await getBook(params.bookId);
  if (!book) { toast("这本书找不到了"); return nav.go("/", { replace: true }); }
  if (page) { page.api.destroy(); page = null; }
  const back = h("button.icon-btn", { type: "button", title: "返回（Alt+←）", "aria-label": "返回" }, icon("back"));
  back.addEventListener("click", () => nav.back());
  const undoBtn = h("button.icon-btn", { type: "button", "aria-label": "撤销", title: "撤销（Ctrl+Z）" }, icon("undo"));
  const redoBtn = h("button.icon-btn", { type: "button", "aria-label": "重做", title: "重做（Ctrl+Shift+Z）" }, icon("redo"));
  undoBtn.addEventListener("click", () => runUndo());
  redoBtn.addEventListener("click", () => runRedo());
  const toBook = h("button.tool-btn", { type: "button", title: "回到正文" }, icon("book"), h("span.tb-t", {}, "写正文"));
  toBook.addEventListener("click", () => nav.go("/book/" + book.id));
  const main = h("main.bd-page-main");
  const view = h("div.view.bd-page", {},
    h("header.topbar", {}, back, h("span.title.bd-page-title", {}, "分镜看板 · 《" + book.title + "》"), h("span.spacer"), undoBtn, redoBtn, h("span.tb-sep"), toBook),
    main);
  document.getElementById("app").replaceChildren(view);
  const api = mountBoard(main, { bookId: book.id, book });
  page = { api, undoBtn, redoBtn, bookId: book.id };
  updateUndo();
  await api.ready;
  if (params.cardId) api.openCard(params.cardId);
  tip("board", TIP);
}
function updateUndo() {
  if (!page) return;
  page.undoBtn.disabled = !isBoardEntry(appUndo.peek());
  page.redoBtn.disabled = !appUndo.canRedo();
}
async function runUndo() { if (isBoardEntry(appUndo.peek())) { const e = await appUndo.undo(); if (e) toast("撤销了：" + e.label); } updateUndo(); }
async function runRedo() { if (appUndo.canRedo()) { const e = await appUndo.redo(); if (e) toast("重做了：" + e.label); } updateUndo(); }

function openBoard(o = {}) {
  const bookId = (o && o.bookId) || (ws.book && ws.book.id);
  if (!bookId) { toast("先打开一本书"); return; }
  nav.go("/board/" + bookId + (o && o.cardId ? "/" + o.cardId : ""));
}

// ---------------- 写作界面：顶栏入口、右侧栏的分镜卡 ----------------
function addTopbarButton() {
  const bar = document.querySelector(".ws .topbar");
  if (!bar || bar.querySelector('[data-cmd="board.open"]')) return;
  const b = h("button.tool-btn.bd-tb", { type: "button", title: "主线分镜看板：主线、分段、分镜卡、挂章节", "data-cmd": "board.open" }, icon("board"), h("span.tb-t", {}, "分镜"));
  b.addEventListener("click", () => openBoard());
  const after = bar.querySelector('[data-cmd="lore.open"]');
  if (after) after.after(b); else bar.querySelector(".spacer")?.after(b);
}

let people = null;   // 设定库里的名字和颜色（侧栏用），设定库变了清掉
async function peopleOf(bookId) {
  if (people && people.bookId === bookId) return people.list;
  const meta = await readMeta(bookId);
  const list = (await listCards(bookId)).map((c) => { const cat = catOf(meta, c); return { id: c.id, name: c.name, color: cat.color, thumb: c.img ? c.img.thumb : null }; });
  people = { bookId, list };
  return list;
}

/** 右侧栏最上面：这一章挂的分镜卡；没挂就给一个「挂到……」 */
function sideBlock(right, chapter) {
  const box = h("section.bd-side", { "aria-label": "这一章的分镜卡" });
  right.prepend(box);
  const bookId = ws.book && ws.book.id;
  if (!bookId) return;
  (async () => {
    const board = await getBoard(bookId);
    if (!box.isConnected || !ws.current || ws.current.id !== chapter.id) return;
    const at = cardOfChapter(board, chapter.id);
    if (!at) {
      if (!board.acts.length) {
        const go = h("button.bd-side-link", { type: "button" }, "主线分镜看板");
        go.addEventListener("click", () => openBoard());
        box.classList.add("empty");
        box.replaceChildren(h("p.bd-side-none", {}, "还没排分镜。想先排好主线和每段要写什么，去", go, "。"));
        return;
      }
      const sel = h("select.select.bd-side-sel", { "aria-label": "把这一章挂到哪张分镜卡" }, h("option", { value: "" }, "挂到哪张分镜卡……"));
      board.acts.forEach((a) => {
        const g = h("optgroup", { label: a.title || "未命名的一段" });
        a.cards.forEach((id) => { const c = board.cards[id]; if (c) g.append(h("option", { value: id }, `${indexOf(board, id)}. ${c.title || "没有标题"}`)); });
        if (a.cards.length) sel.append(g);
      });
      sel.append(h("option", { value: "__new" }, "＋ 新建一张卡挂上"));
      sel.addEventListener("change", () => attach(chapter.id, sel.value));
      box.classList.add("empty");
      box.replaceChildren(h("div.bd-side-head", {}, h("span.bd-side-k", {}, "分镜卡"), h("span.bd-side-none", {}, "这一章还没挂")), sel);
      return;
    }
    const { card, act, index } = at;
    const list = await peopleOf(bookId);
    const cast = (card.cast || []).map((id) => list.find((p) => p.id === id)).filter(Boolean);
    const openB = h("button.icon-btn.bd-side-open", { type: "button", title: "在看板里打开这张卡", "aria-label": "打开分镜卡" }, icon("board"));
    openB.addEventListener("click", () => openBoard({ cardId: card.id }));
    const offB = h("button.bd-side-link", { type: "button", title: "这一章不挂这张卡了（卡上来的、没打勾的要点会拿掉）" }, "不挂了");
    offB.addEventListener("click", () => attach(chapter.id, ""));
    box.dataset.n = String(index);
    box.replaceChildren(
      h("div.bd-side-head", {}, h("span.bd-side-k", {}, "分镜卡 " + index), h("b.bd-side-t", {}, card.title || "没有标题"), openB),
      act && (act.title || act.goal) ? h("p.bd-side-act", {}, (act.title || "") + (act.goal ? "：" + act.goal : "")) : null,
      board.line ? h("p.bd-side-line", { title: "主线" }, "主线：" + board.line) : null,
      ...FIELDS.filter((f) => String(card[f.id] || "").trim()).map((f) => h("p.bd-side-f", {}, h("b", {}, f.name), " ", card[f.id])),
      cast.length ? h("div.bd-side-cast", {}, ...cast.map((p) => h("span.bd-c-p", { style: "--c:" + p.color }, p.thumb ? h("img", { src: p.thumb, alt: "" }) : null, p.name))) : null,
      h("div.bd-side-foot", {}, h("span.bd-side-hint", {}, "卡上的目标、冲突……已经放进下面的要点"), offB),
    );
  })();
}

/** 把这一章挂到某张卡（"" 是不挂了，"__new" 是新建一张挂上） */
async function attach(chapterId, cardId) {
  const bookId = ws.book && ws.book.id;
  if (!bookId) return;
  const ch = ws.chapters.find((c) => c.id === chapterId);
  const label = ch && ch.title ? "「" + ch.title + "」" : "这一章";
  const { result, entry } = await edit(bookId, cardId ? `把${label}挂到分镜卡` : `${label}不挂分镜卡了`, (b) => {
    for (const c of Object.values(b.cards)) c.chapters = (c.chapters || []).filter((x) => x !== chapterId);
    if (!cardId) return null;
    if (cardId === "__new") {
      if (!b.acts.length) b.acts.push(newAct("第一卷", ""));
      const c = newCard({ title: ch && ch.title ? ch.title : "", chapters: [chapterId] });
      b.cards[c.id] = c;
      b.acts[b.acts.length - 1].cards.push(c.id);
      return c;
    }
    const c = b.cards[cardId];
    if (c) c.chapters = [...(c.chapters || []), chapterId];
    return c;
  });
  if (!entry) return;
  toast(cardId ? (cardId === "__new" ? "新建了一张分镜卡，挂上了。去看板里填目标、冲突" : "挂上了，卡上的内容放进了本章要点") : "不挂了", {
    actions: [{ label: "撤销", run: () => appUndo.undoEntry(entry) }, ...(cardId === "__new" && result ? [{ label: "去填", run: () => openBoard({ cardId: result.id }) }] : [])],
  });
}

/** 看板改了：这一章的要点、侧栏跟着刷新 */
async function syncCurrent(d) {
  if (!ws.book || d.bookId !== ws.book.id) return;
  for (const id of d.chapters || []) {
    const fresh = await getChapter(id);
    if (!fresh) continue;
    const c = ws.chapters.find((x) => x.id === id);
    if (c) c.points = fresh.points;
    if (ws.current && ws.current.id === id) ws.current.points = fresh.points;
  }
  ws.refreshSide();
}

export async function register() {
  nav.route("board", "/board/:bookId/:cardId?", (params) => renderPage(params));
  nav.onLeave(() => { if (page && !onPage()) { page.api.destroy(); page = null; } return {}; });
  bus.on("route", () => { if (page && !onPage()) { page.api.destroy(); page = null; } if (ws.book) setTimeout(addTopbarButton, 0); });
  bus.on("chapter:opened", () => addTopbarButton());
  bus.on("undo:changed", updateUndo);
  bus.on("board:changed", syncCurrent);
  bus.on("lore:changed", () => { people = null; ws.refreshSide(); });
  ws.addSideBlock(sideBlock);
  commands.register({ id: "board.open", title: "主线分镜看板", keywords: "分镜 看板 主线 大纲 卷 幕 情节 节点 剧情 结构 三幕 起承转合", hint: "主线一句话、分段、分镜卡，章节挂到卡下", when: () => !!ws.book || onPage(), run: (o) => openBoard(o) });
  commands.register({ id: "board.attach", title: "把这一章挂到分镜卡", keywords: "分镜 挂 章节 情节节点", hint: "卡上的目标、冲突会变成本章要点", when: () => !!(ws.book && ws.current),
    run: async (o) => { if (o && o.cardId != null) return attach(ws.current.id, o.cardId); ws.refreshSide(); const s = document.querySelector(".bd-side-sel"); if (s) { s.focus(); s.showPicker && s.showPicker(); } } });
  commands.register({ id: "board.undo", title: "撤销", keywords: "撤回 后悔", key: "Mod-z", when: () => onPage() && isBoardEntry(appUndo.peek()) && !/INPUT|TEXTAREA/.test((document.activeElement || {}).tagName), run: runUndo });
  commands.register({ id: "board.redo", title: "重做", keywords: "重做", key: "Mod-Shift-z", when: () => onPage() && appUndo.canRedo() && !/INPUT|TEXTAREA/.test((document.activeElement || {}).tagName), run: runRedo });
}
