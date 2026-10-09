// 设定库：分类（人物、地点、物品、势力、功法/技能、生物、节日，可以自己加）、设定卡（人物就是角色卡）、晋升阶梯。
// 写作界面里点顶栏「设定」在右侧宽面板里打开，正文还在旁边；也有整页 #/lore/<书id>/<卡id>?，大屏幕用。
// 给别的模块的命令（参数都是一个对象）：
//   cards.list({ bookId, cat? })          → [{ id, name, cat 分类名, catId, kind, color, aliases, role, thumb }]
//   cards.context({ bookId, ids, chapterId? }) → 给 AI 的人物信息（文字），阶梯等级按 chapterId 那一章
//   cards.open({ bookId, id })             就地打开这张卡
//   cards.new({ bookId, cat, name, silent? }) → 新建的卡（cat 可以是分类名、id 或 kind）；不给 silent 时顺手打开
//   lore.terms({ bookId })                 → [{ id, name, aliases, cat, color, kind }]（正文里高亮名字用）
// 改动后发 lore:changed { bookId, ids }。
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { h, icon, toast, hasLayers, topLayer } from "../../core/ui.js";
import { undo as appUndo } from "../../core/undo.js";
import { FEATURES } from "../../core/stash.js";
import { getBook, listChapters } from "../../core/store.js";
import { change, getMeta, readMeta, listCards, catOf, findCat, newCard, contextText, sweepImages, canLoreUndo, canLoreRedo } from "../../core/lore.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { mountLore } from "./view.js";
import { undoToast, typing } from "./bits.js";

const TIP = "人物、地点、物品都记在这里。空着的格子不用急着填，写到哪填到哪。";
let inst = null;        // 开着的设定库 { mode: "panel"|"page", bookId, api, close }
let page = null;        // 整页 { api, main, undoBtn, redoBtn }
let pending = null;     // 跳到整页时要打开的东西

const alive = () => inst && !inst.api.env.destroyed;

// ---------------- 写作界面里：右侧宽面板 ----------------
function openPanel(bookId, start) {
  let api = null;
  const p = ws.openPanel({
    title: "设定库",
    wide: true,
    render: (body) => {
      body.classList.add("lr-panel-body");
      api = mountLore(body, { bookId, mode: "panel", scrollEl: body, start });
    },
    isDirty: () => !!api && api.isDirty(),
    onKeepDraft: () => api && api.keepDraft(),
    onClose: () => { if (api) api.destroy(); if (inst && inst.api === api) inst = null; },
  });
  // 面板头上：整页打开
  const head = p.body.parentElement && p.body.parentElement.querySelector(".panel-head");
  if (head) {
    const full = h("button.icon-btn.lr-full", { type: "button", title: "整页打开（大屏幕看得更全）", "aria-label": "整页打开" }, icon("focus"));
    full.addEventListener("click", async () => {
      const st = api ? api.state() : {};
      if ((await p.close()) === false) return;
      pending = { tab: st.tab, cardId: st.cardId };
      nav.go("/lore/" + bookId);
    });
    head.insertBefore(full, head.lastElementChild);
  }
  inst = { mode: "panel", bookId, api, close: (f) => p.close(f) };
  tip("lore", TIP);
  return inst;
}

/** 打开设定库：在这本书的写作界面里就开面板，不在就去整页 */
function openLore(o = {}) {
  const bookId = o.bookId || (ws.book && ws.book.id);
  if (!bookId) { toast("先打开一本书"); return null; }
  const start = { tab: o.tab || null, cardId: o.cardId || null, quick: !!o.quick, newIn: o.newIn || null, name: o.name || "" };
  const any = start.tab || start.cardId || start.newIn;
  if (alive() && inst.bookId === bookId) {
    // 顶栏「设定」再点一下：收起面板
    if (!any && inst.mode === "panel" && o.toggle) { inst.close(); return null; }
    inst.api.open(start);
    return inst.api;
  }
  if (ws.book && ws.book.id === bookId && ws.els()) return openPanel(bookId, start).api;
  pending = start;
  nav.go("/lore/" + bookId + (start.cardId ? "/" + start.cardId : ""));
  return null;
}

// ---------------- 整页 ----------------
const onPage = () => { const c = nav.current(); return !!(c && c.name === "lore" && page && page.main.isConnected); };

async function renderPage(params, restore) {
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
  const wrap = h("div.lr-page-wrap");
  const main = h("main.lr-page-main", {}, wrap);
  const view = h("div.view.lr-page", {},
    h("header.topbar", {}, back, h("span.title.lr-page-title", {}, "设定库 · 《" + book.title + "》"), h("span.spacer"), undoBtn, redoBtn, h("span.tb-sep"), toBook),
    main);
  document.getElementById("app").replaceChildren(view);
  const start = restore && (restore.loreTab || restore.loreCard)
    ? { tab: restore.loreTab, cardId: restore.loreCard, listScroll: restore.loreScroll }
    : { ...(pending || {}), cardId: (pending && pending.cardId) || params.cardId || null };
  pending = null;
  const api = mountLore(wrap, { bookId: book.id, mode: "page", scrollEl: main, start });
  page = { api, main, undoBtn, redoBtn };
  inst = { mode: "page", bookId: book.id, api, close: () => nav.back() };
  updateUndoBtns();
  await api.ready;
  tip("lore", TIP);
}

function updateUndoBtns() {
  if (!page) return;
  page.undoBtn.disabled = !canLoreUndo();
  page.redoBtn.disabled = !canLoreRedo();
}
async function runUndo() { if (canLoreUndo()) await appUndo.undo(); updateUndoBtns(); }
async function runRedo() { if (canLoreRedo()) await appUndo.redo(); updateUndoBtns(); }

// ---------------- 给别的模块的命令 ----------------
async function chaptersOf(bookId) {
  return ws.book && ws.book.id === bookId ? ws.chapters : listChapters(bookId);
}

async function cardsList(o) {
  const meta = await readMeta(o.bookId);
  let cards = await listCards(o.bookId);
  if (o.cat) { const c = findCat(meta, o.cat); cards = c ? cards.filter((x) => x.cat === c.id) : []; }
  return cards.map((x) => {
    const c = catOf(meta, x);
    return { id: x.id, name: x.name, cat: c.name, catId: c.id, kind: c.kind, color: c.color, aliases: [...(x.aliases || [])], role: x.role || "", thumb: x.img ? x.img.thumb : null };
  });
}

async function cardsContext(o) {
  const ids = o.ids || [];
  if (!ids.length) return "";
  const meta = await readMeta(o.bookId);
  const cards = await listCards(o.bookId);
  const chapters = await chaptersOf(o.bookId);
  const idxOf = (id) => chapters.findIndex((c) => c.id === id) + 1;
  const pick = ids.map((id) => cards.find((c) => c.id === id)).filter(Boolean);
  return contextText(pick, { meta, cards, idxOf, chapterId: o.chapterId || null });
}

async function cardsNew(o = {}) {
  const bookId = o.bookId || (ws.book && ws.book.id);
  if (!bookId) { toast("先打开一本书"); return null; }
  const name = String(o.name || "").trim().slice(0, 40);
  const meta = await getMeta(bookId);
  const cat = findCat(meta, o.cat) || meta.cats.find((c) => c.kind === "person") || meta.cats[0];
  if (!name) {
    if (!o.silent) openLore({ bookId, newIn: cat.id });
    return null;
  }
  const { result, entry } = await change(bookId, `新建设定卡「${name}」`, async (t) => {
    await t.meta();
    return t.add(newCard(bookId, cat, { name, aliases: (o.aliases || []).filter(Boolean) }));
  });
  if (!o.silent) {
    openLore({ bookId, cardId: result.id, quick: true });
    undoToast(`已收进设定库：「${name}」`, entry);
  }
  return result;
}

async function loreTerms(o) {
  const meta = await readMeta(o.bookId);
  return (await listCards(o.bookId)).filter((x) => x.name).map((x) => {
    const c = catOf(meta, x);
    return { id: x.id, name: x.name, aliases: [...(x.aliases || [])], cat: c.name, color: c.color, kind: c.kind };
  });
}

// ---------------- 注册 ----------------
export async function register() {
  FEATURES.cards = "设定卡";
  nav.route("lore", "/lore/:bookId/:cardId?", (params, restore) => renderPage(params, restore));
  nav.onLeave(() => {
    if (!onPage()) return {};
    const st = page.api.state();
    return { loreTab: st.tab, loreCard: st.cardId, loreScroll: st.listScroll };
  });
  bus.on("route", ({ name }) => {
    if (name === "lore") return;
    if (page) { page.api.destroy(); page = null; }
    if (inst && inst.mode === "page") inst = null;
  });
  bus.on("undo:changed", updateUndoBtns);
  bus.on("lore:changed", () => setTimeout(updateUndoBtns, 0));
  setTimeout(() => sweepImages().catch(() => {}), 5000);

  const KW = "设定 设定库 设定集 角色卡 人物卡 人设 人物 角色 地点 物品 势力 功法 技能 生物 节日 世界观 资料";
  commands.register({ id: "lore.open", title: "设定库", keywords: KW, hint: "人物、地点、物品……都记在这里",
    run: (o) => openLore(o && typeof o === "object" ? o : { toggle: true }) });
  commands.register({ id: "lore.page", title: "设定库（整页）", keywords: KW + " 整页 全屏", hint: "大屏幕上整页看",
    run: (o = {}) => { const id = (o && o.bookId) || (ws.book && ws.book.id); if (!id) { toast("先打开一本书"); return; } nav.go("/lore/" + id); } });
  commands.register({ id: "lore.ladders", title: "晋升阶梯", keywords: "晋升 阶梯 境界 等级 爵位 修炼 修仙 骑士 职业等级 体系 根基 斗气 魔力", hint: "境界、爵位、职业等级，一级一级往上",
    run: (o = {}) => openLore({ ...(o || {}), tab: "sys" }) });
  commands.register({ id: "cards.new", title: "新建设定卡", keywords: "新建 人物 角色卡 人设 地点 物品 收入设定库 加进设定库", hint: "人物、地点、物品……",
    run: (o) => cardsNew(o && typeof o === "object" ? o : {}) });
  commands.register({ id: "cards.open", title: "打开设定卡", keywords: "设定卡 角色卡 人物卡 查人设", hint: "就地打开，不离开正文",
    run: (o) => (o && o.id ? openLore({ bookId: o.bookId, cardId: o.id }) : openLore({})) });
  commands.register({ id: "cards.list", title: "设定卡一览", keywords: "设定卡 列表 所有人物", hint: "这本书的全部设定卡",
    run: (o) => (o && o.bookId ? cardsList(o) : openLore({})) });
  commands.register({ id: "cards.context", title: "人物信息（给 AI 带上）", keywords: "人物信息 上下文 AI 带上", hint: "调用 AI 时在确认卡里勾人物",
    run: (o) => (o && o.bookId ? cardsContext(o) : openLore({})) });
  commands.register({ id: "lore.terms", title: "设定库里的名字", keywords: "名字 名词 高亮 人名 地名", hint: "人名、地名、物品名",
    run: (o) => (o && o.bookId ? loreTerms(o) : openLore({})) });
  // 整页上的撤销 / 重做（只撤设定库自己的改动）
  const mineTop = () => { const t = topLayer(); return !hasLayers() || (inst && inst.api.env.layers.has(t)); };
  const here = () => onPage() && mineTop() && !typing();
  commands.register({ id: "lore.undo", title: "撤销", keywords: "撤回 后悔 删错了", hint: "撤销刚才在设定库里的改动", key: "Mod-z", when: () => here() && canLoreUndo(), run: () => runUndo() });
  commands.register({ id: "lore.redo", title: "重做", keywords: "重做 撤销错了", key: "Mod-Shift-z", when: () => here() && canLoreRedo(), run: () => runRedo() });
}
