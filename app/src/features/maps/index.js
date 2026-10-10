// 分层地图：整页 #/map/<书id>/<地图id>?。写作界面顶栏「地图」、F1、设定库的地点卡都能进。
// 大陆 → 国家 → 边境 → 村庄：在一层上框一块设成入口，点进去画下一层，层数不限。
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { h, icon, toast } from "../../core/ui.js";
import { undo as appUndo } from "../../core/undo.js";
import { getBook } from "../../core/store.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { mountMap } from "./view.js";

const TIP = "左边挑工具：画笔、地形色块、河流道路、文字、图钉。用「入口」框一块，点进去画下一层。滚轮缩放，拖空白处平移。";
let page = null;
const onPage = () => { const c = nav.current(); return !!(c && c.name === "map" && page); };
const isMapEntry = (e) => !!(e && e.map);

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
  const main = h("main.mp-page-main");
  document.getElementById("app").replaceChildren(h("div.view.mp-page", {},
    h("header.topbar", {}, back, h("span.title", {}, "地图 · 《" + book.title + "》"), h("span.spacer"), undoBtn, redoBtn, h("span.tb-sep"), toBook), main));
  const api = mountMap(main, { bookId: book.id, mapId: params.mapId || null, onNav: (id) => history.replaceState(history.state, "", "#/map/" + book.id + "/" + id) });
  page = { api, undoBtn, redoBtn };
  updateUndo();
  await api.ready;
  tip("maps", TIP);
}
function updateUndo() {
  if (!page) return;
  page.undoBtn.disabled = !isMapEntry(appUndo.peek());
  page.redoBtn.disabled = !appUndo.canRedo();
}
async function runUndo() { if (isMapEntry(appUndo.peek())) { const e = await appUndo.undo(); if (e) toast("撤销了：" + e.label); } updateUndo(); }
async function runRedo() { if (appUndo.canRedo()) { const e = await appUndo.redo(); if (e) toast("重做了：" + e.label); } updateUndo(); }

function openMap(o = {}) {
  const bookId = (o && o.bookId) || (ws.book && ws.book.id);
  if (!bookId) { toast("先打开一本书"); return; }
  nav.go("/map/" + bookId + (o && o.mapId ? "/" + o.mapId : ""));
}
function addTopbarButton() {
  const bar = document.querySelector(".ws .topbar");
  if (!bar || bar.querySelector('[data-cmd="map.open"]')) return;
  const b = h("button.tool-btn.mp-tb", { type: "button", title: "分层地图：大陆、国家、边境、村庄一层层画", "data-cmd": "map.open" }, icon("map"), h("span.tb-t", {}, "地图"));
  b.addEventListener("click", () => openMap());
  const after = bar.querySelector('[data-cmd="board.open"]') || bar.querySelector('[data-cmd="lore.open"]');
  if (after) after.after(b); else bar.querySelector(".spacer")?.after(b);
}

export async function register() {
  nav.route("map", "/map/:bookId/:mapId?", (params) => renderPage(params));
  bus.on("route", () => { if (page && !onPage()) { page.api.destroy(); page = null; } if (ws.book) setTimeout(addTopbarButton, 0); });
  bus.on("chapter:opened", () => addTopbarButton());
  bus.on("undo:changed", updateUndo);
  commands.register({ id: "map.open", title: "分层地图", keywords: "地图 大陆 国家 边境 村庄 世界 地理 画地图 图钉 子地图", hint: "一层层画世界地图，图钉连到地点卡", when: () => !!ws.book || onPage(), run: (o) => openMap(o) });
  commands.register({ id: "map.undo", title: "撤销", keywords: "撤回", key: "Mod-z", when: () => onPage() && isMapEntry(appUndo.peek()) && !/INPUT|TEXTAREA/.test((document.activeElement || {}).tagName), run: runUndo });
  commands.register({ id: "map.redo", title: "重做", keywords: "重做", key: "Mod-Shift-z", when: () => onPage() && appUndo.canRedo() && !/INPUT|TEXTAREA/.test((document.activeElement || {}).tagName), run: runRedo });
}
