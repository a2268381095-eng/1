// 总暂存盒（#/stash，#/stash/<bookId> 只看这本书）：汇总所有 AI 结果，统一搜索和清理。
// 按作品、功能、时间筛选，搜索，置顶，标签，多选删，按条件批量删（先显示会删几条再确认）。删除一次算一步，可撤销。
import { listStash } from "../../core/stash.js";
import { listBooks, getBook } from "../../core/store.js";
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { h, icon, modal, pushLayer, toast } from "../../core/ui.js";
import { tip } from "../demon/demon.js";
import { cardEl, animateOut, focusKey, restoreFocus } from "./card.js";
import { applyFilter, tally, featureName, timeBucket, BUCKETS, matchCond, DAY } from "./logic.js";
import { L, removeRows, failed, runUndo, runRedo, canUndoHere, canRedoHere } from "./ops.js";

const S = {
  view: null, main: null, listEl: null, barEl: null, selEl: null, titleEl: null, countEl: null, q: null, selBtn: null,
  undoBtn: null, redoBtn: null, condBtn: null,
  bookId: null,     // 地址里带的：只看这本书
  fromBook: null,   // 从哪本书进来的（切到「全部」后还能切回去）
  book: "all", feature: "all", when: "all", pinnedOnly: false, tag: null, query: "",
  selecting: false, selected: new Set(), expanded: new Set(), known: null, selLayer: null,
  all: [], shown: [], books: {},
};
let seq = 0, qTimer = 0;

export const onView = () => { const c = nav.current(); return !!(c && c.name === "stash" && S.view && S.view.isConnected); };

const bookName = (row) => !row.bookId ? "不属于作品" : S.books[row.bookId] ? "《" + S.books[row.bookId].title + "》" : "作品已删除";

// ---------------- 数据 ----------------
async function load() {
  const rows = await listStash(S.bookId ? { bookId: S.bookId } : {});
  const books = {};
  for (const b of await listBooks()) books[b.id] = b;
  if (S.fromBook && !books[S.fromBook]) { const b = await getBook(S.fromBook); if (b) books[b.id] = b; }
  S.all = rows;
  S.books = books;
}

export async function refresh() {
  if (!onView()) return;
  const my = ++seq;
  const top = S.main.scrollTop;
  try { await load(); }
  catch (e) {
    if (my !== seq) return;
    S.listEl.replaceChildren(h("div.stash-none", {}, h("p.muted", {}, L() + "没读出来。")));
    return failed(L() + "读不出来。", e, refresh);
  }
  if (my !== seq || !onView()) return;
  for (const id of [...S.selected]) if (!S.all.some((r) => r.id === id)) S.selected.delete(id);
  renderTitle();
  renderBar();
  renderList();
  S.main.scrollTop = top;
  updateUndoBtns();
}

// ---------------- 撤销按钮 ----------------
export function updateUndoBtns() {
  if (!S.undoBtn || !S.undoBtn.isConnected) return;
  S.undoBtn.disabled = !canUndoHere();
  S.redoBtn.disabled = !canRedoHere();
}

// ---------------- 多选 ----------------
function setSelecting(on) {
  S.selecting = on;
  S.selected.clear();
  if (S.selBtn) { S.selBtn.setAttribute("aria-pressed", String(on)); S.selBtn.textContent = on ? "完成" : "多选"; }
  if (on && !S.selLayer) S.selLayer = pushLayer({ onClose: () => { S.selLayer = null; if (S.selecting) setSelecting(false); } });
  if (!on && S.selLayer) { const l = S.selLayer; S.selLayer = null; l.close(true); }
  if (onView()) renderList();
}

const cardOf = (row) => S.listEl && [...S.listEl.querySelectorAll(".stash-card")].find((c) => c.dataset.id === row.id);

async function remove(rows, cards, what) {
  await animateOut(cards || rows.map(cardOf));
  const u = await removeRows(rows, { what });
  if (u) { rows.forEach((r) => S.selected.delete(r.id)); if (S.selecting && !S.selected.size) setSelecting(false); }
  else await refresh();
  return u;
}

// ---------------- 按条件批量删 ----------------
export async function openCondDelete() {
  let all;
  try { all = await listStash({}); } catch (e) { return failed(L() + "读不出来。", e, openCondDelete); }
  if (!all.length) { toast(L() + "是空的"); return; }
  const books = {};
  for (const b of await listBooks()) books[b.id] = b;
  const nameOf = (id) => (id === "none" ? "不属于作品" : books[id] ? "《" + books[id].title + "》" : "作品已删除");
  const bookIds = tally(all, (r) => r.bookId || "none").map(([id]) => id);
  const feats = tally(all, (r) => r.feature || "other").map(([f]) => f);
  const startBook = S.bookId || (S.book !== "all" ? S.book : "all");
  const days = h("input.input.stash-cond-days", { type: "number", min: "0", max: "3650", step: "1", value: "30", "aria-label": "多少天以前" });
  const bookSel = h("select.select", { "aria-label": "作品" }, h("option", { value: "all" }, "全部作品"),
    ...bookIds.map((id) => h("option", { value: id, selected: id === startBook }, nameOf(id))));
  const featSel = h("select.select", { "aria-label": "功能" }, h("option", { value: "all" }, "全部功能"),
    ...feats.map((f) => h("option", { value: f, selected: f === S.feature }, featureName(f))));
  const keepPinned = h("input", { type: "checkbox", checked: true });
  const keepTagged = h("input", { type: "checkbox" });
  const result = h("p.stash-cond-n", { "aria-live": "polite" });
  const body = h("div.stash-cond", {},
    h("p.modal-text.muted", {}, "按下面的条件一起删。一次算一步，删完能撤销。"),
    h("label.field", {}, h("span", {}, "时间"), h("div.row", {}, h("span", {}, "删掉"), days, h("span", {}, "天以前的（填 0 不论时间）"))),
    h("div.stash-cond-2", {}, h("label.field", {}, h("span", {}, "作品"), bookSel), h("label.field", {}, h("span", {}, "功能"), featSel)),
    h("label.check", {}, keepPinned, "保留置顶的"),
    h("label.check", {}, keepTagged, "保留加了标签的"),
    result);
  let hits = [];
  const m = modal({
    title: "按条件删", body,
    actions: [
      { label: "删除", danger: true, onClick: async () => {
        if (!hits.length) return;
        const rows = hits;
        m.close(true);
        await remove(rows, null, rows.length + " 条");
      } },
      { label: "取消", onClick: () => m.close(true) },
    ],
  });
  m.el.classList.add("stash-cond-modal");
  const go = m.foot.querySelector(".btn.danger");
  const update = () => {
    const cond = { days: days.value, book: bookSel.value, feature: featSel.value, keepPinned: keepPinned.checked, keepTagged: keepTagged.checked };
    hits = matchCond(all, cond, Date.now());
    const scope = all.filter((r) => (cond.book === "all" || (cond.book === "none" ? !r.bookId : r.bookId === cond.book)) && (cond.feature === "all" || (r.feature || "other") === cond.feature)).length;
    result.replaceChildren(hits.length ? h("b", {}, `会删掉 ${hits.length} 条`) : h("span", {}, "没有符合条件的"), h("span.muted", {}, `（这个范围里共 ${scope} 条）`));
    result.classList.toggle("zero", !hits.length);
    go.disabled = !hits.length;
    go.textContent = hits.length ? `删掉 ${hits.length} 条` : "删除";
  };
  [days, bookSel, featSel, keepPinned, keepTagged].forEach((x) => { x.addEventListener("input", update); x.addEventListener("change", update); });
  update();
}

// ---------------- 界面 ----------------
export async function renderView(params, restoreState, prev) {
  const fresh = !prev || prev.name !== "stash";
  S.bookId = params.bookId || null;
  if (S.bookId) S.fromBook = S.bookId;
  else if (fresh) S.fromBook = null;
  if (fresh) Object.assign(S, { book: "all", feature: "all", when: "all", pinnedOnly: false, tag: null, query: "" });
  if (S.selLayer) { const l = S.selLayer; S.selLayer = null; l.close(true); }
  S.selecting = false; S.selected.clear(); S.known = null;

  const back = h("button.icon-btn", { type: "button", title: "返回（Alt+←）", "aria-label": "返回" }, icon("back"));
  back.addEventListener("click", () => nav.back());
  S.titleEl = h("span.title.stash-title-bar", {}, L());
  S.undoBtn = h("button.icon-btn", { type: "button", "aria-label": "撤销", title: "撤销（Ctrl+Z）" }, icon("undo"));
  S.redoBtn = h("button.icon-btn", { type: "button", "aria-label": "重做", title: "重做（Ctrl+Shift+Z）" }, icon("redo"));
  S.undoBtn.addEventListener("click", () => runUndo());
  S.redoBtn.addEventListener("click", () => runRedo());
  S.condBtn = h("button.tool-btn.stash-cond-btn", { type: "button", title: "按时间、作品、功能一起删" }, icon("trash"), h("span.tb-t", {}, "按条件删"));
  S.condBtn.addEventListener("click", openCondDelete);

  S.q = h("input.input.stash-q", { type: "search", placeholder: "搜索内容、提示词、标签", "aria-label": "搜索" + L(), autocomplete: "off", value: S.query });
  S.q.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.query = S.q.value; renderList(); }, 140); });
  S.q.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.q.value && !(e.isComposing || e.keyCode === 229)) { e.stopPropagation(); e.preventDefault(); S.q.value = ""; S.query = ""; renderList(); } });
  S.selBtn = h("button.btn.small.ghost.stash-sel-btn", { type: "button", "aria-pressed": "false", title: "选几条一起删" }, "多选");
  S.selBtn.addEventListener("click", () => setSelecting(!S.selecting));
  S.countEl = h("span.stash-n", { "aria-live": "polite" });
  S.barEl = h("div.stash-bar");
  S.selEl = h("div.stash-selbar", { hidden: true });
  S.listEl = h("div.stash-list.stash-groups", { role: "list" });
  S.main = h("main.stash-main", {}, h("div.stash-wrap", {},
    h("section.stash-filters", { "aria-label": "筛选" }, h("div.stash-tools", {}, S.q, S.selBtn, S.countEl), S.barEl),
    S.selEl, S.listEl));
  S.view = h("div.view.stash-view", {},
    h("header.topbar", {}, back, S.titleEl, h("span.spacer"), S.undoBtn, S.redoBtn, h("span.tb-sep"), S.condBtn),
    S.main);
  document.getElementById("app").replaceChildren(S.view);
  updateUndoBtns();
  await refresh();
  if (restoreState && restoreState.stashScroll) S.main.scrollTop = restoreState.stashScroll;
  tip("stash-view", "AI 生成的东西都收在这儿。按作品、功能、时间筛，用不上的可以按条件一起删，删了也能撤销。");
}

function renderTitle() {
  const b = S.bookId && S.books[S.bookId];
  S.titleEl.textContent = L() + (b ? " · 《" + b.title + "》" : "");
}

function seg(items, cur, onPick, cls, name) {
  const box = h("div.stash-seg" + cls, { role: "group", "aria-label": name });
  items.forEach(([id, text, n]) => {
    const b = h("button", { type: "button", "aria-pressed": String(id === cur), "data-v": id }, text, n != null ? h("span.stash-seg-n", {}, String(n)) : null);
    b.addEventListener("click", () => { if (id !== cur) onPick(id); });
    box.append(b);
  });
  return box;
}

function renderBar() {
  const parts = [];
  // 范围：从作品进来的可以在「这本书 / 全部」之间切
  if (S.fromBook) {
    const b = S.books[S.fromBook];
    parts.push(seg([["book", b ? "《" + b.title + "》" : "本书"], ["all", "全部作品"]], S.bookId ? "book" : "all",
      (v) => nav.go(v === "book" ? "/stash/" + S.fromBook : "/stash", { replace: true }), ".stash-scope", "范围"));
  }
  // 作品：看全部时按作品筛
  if (!S.bookId) {
    const ids = tally(S.all, (r) => r.bookId || "none");
    if (ids.length > 1 || S.book !== "all") {
      const sel = h("select.select.stash-book-sel", { "aria-label": "按作品看" }, h("option", { value: "all" }, "全部作品"),
        ...ids.map(([id, n]) => h("option", { value: id, selected: id === S.book }, (id === "none" ? "不属于作品" : bookName({ bookId: id })) + `（${n}）`)));
      sel.addEventListener("change", () => { S.book = sel.value; renderBar(); renderList(); });
      parts.push(sel);
    } else S.book = "all";
  }
  // 功能
  const feats = tally(S.all, (r) => r.feature || "other");
  if (feats.length > 1 || S.feature !== "all") {
    parts.push(seg([["all", "全部功能"], ...feats.map(([f, n]) => [f, featureName(f), n])], S.feature,
      (v) => { S.feature = v; renderBar(); renderList(); }, ".stash-feats", "功能"));
  } else S.feature = "all";
  // 时间
  parts.push(seg([["all", "全部时间"], ["today", "今天"], ["week", "7 天内"], ["older", "更早"]], S.when,
    (v) => { S.when = v; renderBar(); renderList(); }, ".stash-when-seg", "时间"));
  // 置顶、标签
  const pinBtn = h("button.stash-toggle", { type: "button", "aria-pressed": String(S.pinnedOnly) }, "只看置顶");
  pinBtn.addEventListener("click", () => { S.pinnedOnly = !S.pinnedOnly; renderBar(); renderList(); });
  parts.push(pinBtn);
  const tags = tally(S.all, (r) => r.tags || []);
  if (tags.length) {
    parts.push(h("div.stash-tagbar", { role: "group", "aria-label": "标签" }, h("span.muted", {}, "标签"),
      ...tags.slice(0, 24).map(([t, n]) => {
        const b = h("button.stash-tag", { type: "button", "aria-pressed": String(S.tag === t), "data-tag": t }, t, h("span.stash-seg-n", {}, String(n)));
        b.addEventListener("click", () => { S.tag = S.tag === t ? null : t; renderBar(); renderList(); });
        return b;
      })));
  } else S.tag = null;
  S.barEl.replaceChildren(...parts);
  S.condBtn.disabled = !S.all.length;
}

function filterNow() {
  return { book: S.bookId ? "all" : S.book, feature: S.feature, when: S.when, pinnedOnly: S.pinnedOnly, tag: S.tag, q: S.query };
}

function renderSelBar() {
  S.selEl.hidden = !S.selecting;
  if (!S.selecting) return S.selEl.replaceChildren();
  const n = S.selected.size;
  const all = S.shown.length > 0 && S.shown.every((r) => S.selected.has(r.id));
  const allBtn = h("button.btn.small.ghost", { type: "button" }, all ? "全不选" : `全选这 ${S.shown.length} 条`);
  allBtn.addEventListener("click", () => { if (all) S.selected.clear(); else S.shown.forEach((r) => S.selected.add(r.id)); renderList(); });
  const del = h("button.btn.small.stash-del-sel", { type: "button", disabled: !n }, n ? `删除这 ${n} 条` : "删除");
  del.addEventListener("click", () => { const rows = S.all.filter((r) => S.selected.has(r.id)); remove(rows, rows.map(cardOf)); });
  S.selEl.replaceChildren(h("span.stash-sel-n", {}, n ? `已选 ${n} 条` : "点卡片选择"), allBtn, h("span.spacer"), del);
}

function renderList() {
  if (!onView()) return;
  const key = focusKey(S.listEl);
  const now = Date.now();
  S.shown = applyFilter(S.all, filterNow(), now);
  const filtered = S.shown.length !== S.all.length;
  S.countEl.textContent = S.all.length ? (filtered ? `${S.shown.length} / ${S.all.length} 条` : `共 ${S.all.length} 条`) : "";
  renderSelBar();
  if (!S.all.length) {
    S.listEl.replaceChildren(h("div.stash-none", {},
      h("p.stash-none-t", {}, S.bookId ? "这本书还没有 AI 生成的东西" : L() + "是空的"),
      h("p.muted", {}, "用 AI 起章名、写摘要、改选中的文字、对话，结果都会自动放进来。"),
      S.bookId ? h("button.btn", { type: "button", onclick: () => nav.go("/stash", { replace: true }) }, "看全部作品的") : null));
    S.known = new Set();
    return;
  }
  if (!S.shown.length) {
    const reset = h("button.btn.small", { type: "button" }, "清除筛选");
    reset.addEventListener("click", () => {
      Object.assign(S, { book: "all", feature: "all", when: "all", pinnedOnly: false, tag: null, query: "" });
      S.q.value = "";
      renderBar(); renderList();
    });
    S.listEl.replaceChildren(h("div.stash-none", {}, h("p.muted", {}, S.query.trim() ? `没找到含「${S.query.trim()}」的。` : "这个筛选下没有。"), reset));
    return;
  }
  const first = !S.known;
  const known = S.known || new Set();
  let i = 0;
  const ctx = (row) => {
    const isNew = first || !known.has(row.id);
    return {
      showFeature: S.feature === "all", showBook: !S.bookId && S.book === "all", bookName,
      selecting: S.selecting, selected: S.selected, onSelect: (id, on) => { if (on) S.selected.add(id); else S.selected.delete(id); renderList(); },
      expanded: S.expanded, use: null, draggable: false,
      onTag: (t) => { S.tag = S.tag === t ? null : t; renderBar(); renderList(); },
      remove: (rows, cards) => remove(rows, cards),
      fresh: isNew, index: isNew ? i++ : 0,
    };
  };
  // 分组：置顶 / 今天 / 7 天内 / 更早
  const groups = [["pinned", "置顶", S.shown.filter((r) => r.pinned)],
    ...BUCKETS.map(([k, t]) => [k, t, S.shown.filter((r) => !r.pinned && timeBucket(r.at, now) === k)])].filter((g) => g[2].length);
  S.listEl.replaceChildren(...groups.map(([k, t, rows]) => h("section.stash-group", { "data-g": k },
    h("h3.stash-group-h", {}, h("span", {}, t), h("span.stash-group-n", {}, rows.length + " 条")),
    h("div.stash-group-list", {}, ...rows.map((r) => cardEl(r, ctx(r)))))));
  S.known = new Set(S.all.map((r) => r.id));
  restoreFocus(S.listEl, key);
}

/** 离开总暂存盒时收掉多选这一层 */
export function leaveView() {
  if (S.selLayer) { const l = S.selLayer; S.selLayer = null; l.close(true); }
  S.selecting = false;
  S.view = null;
  S.undoBtn = S.redoBtn = null;
}

export const viewScroll = () => (onView() ? { stashScroll: S.main.scrollTop } : {});
export { DAY };
