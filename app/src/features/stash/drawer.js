// 暂存盒抽屉：每个功能界面里就地打开，只列这个功能（这一章、这张卡）产生的结果。
// 在作品里放右侧栏（ws.openPanel wide），不在作品里、或者前面已经开着弹窗时用弹窗。
// 查看、采用、复制、置顶、标签、继续追问、删除、多选删、搜索都在这里做完；条目可以直接拖进正文。
import { listStash } from "../../core/stash.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { h, modal, pushLayer, toast } from "../../core/ui.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { cardEl, animateOut, focusKey, restoreFocus } from "./card.js";
import { applyFilter, tally, featureName } from "./logic.js";
import { L, removeRows, failed } from "./ops.js";

let current = null;   // 打开着的抽屉（同一时间一个）

/** 没给 onUse 时，在作品里「采用」= 插到光标处（替换选中的文字），算一步撤销 */
async function insertAtCursor(row) {
  if (!ws.editor || !ws.current) { toast("先打开一章"); return; }
  const text = row.text || "";
  if (!text) { toast("这一条没有文字"); return; }
  const { from, to } = ws.editor.view.state.selection.main;
  const before = ws.editor.getText();
  const u = await ws.applyBatch("插入" + L() + "里的文字", [{ chapterId: ws.current.id, after: before.slice(0, from) + text + before.slice(to) }]);
  if (!u) return;
  ws.editor.select(from + text.length);
  toast("已插入正文", { action: { label: "撤销", run: () => appUndo.undoEntry(u) } });
}

/**
 * opts: { feature, bookId, ref, title, onUse(row), useLabel, modal }
 *   bookId 不给时：在作品里就是这本书，不在作品里是全部
 * 返回 { close(force), refresh() }
 */
export function openDrawer(opts = {}) {
  if (current) current.close(true);
  const bookId = "bookId" in opts ? opts.bookId || null : (ws.book ? ws.book.id : null);
  const st = { q: "", tag: null, feature: "all", selecting: false, selected: new Set(), expanded: new Set(), known: null, all: [], shown: [] };
  const inPanel = !opts.modal && !!ws.book && !!ws.els() && !document.querySelector(".modal-back");
  const title = opts.title ? L() + " · " + opts.title : L();
  const use = opts.onUse ? { label: opts.useLabel || "采用", run: opts.onUse }
    : ws.book && ws.editor ? { label: "插入正文", run: insertAtCursor } : null;

  const q = h("input.input.stash-q", { type: "search", placeholder: "搜索内容、标签", "aria-label": "搜索" + L(), autocomplete: "off" });
  const selBtn = h("button.btn.small.ghost.stash-sel-btn", { type: "button", "aria-pressed": "false", title: "选几条一起删" }, "多选");
  const count = h("span.stash-n", { "aria-live": "polite" });
  const chips = h("div.stash-chips", { hidden: true });
  const selBar = h("div.stash-selbar", { hidden: true });
  const list = h("div.stash-list", { role: "list", "aria-label": title });
  const root = h("div.stash-drawer", { "data-mode": inPanel ? "panel" : "modal" },
    h("div.stash-tools", {}, q, selBtn, count), chips, selBar, list,
    inPanel && ws.editor ? h("p.stash-hint", {}, "按住一条拖进正文，放在哪就插在哪。") : null);

  let timer = 0, seq = 0, closed = false, selLayer = null, unbind = [];

  // ---- 多选 ----
  function setSelecting(on) {
    st.selecting = on;
    st.selected.clear();
    selBtn.setAttribute("aria-pressed", String(on));
    selBtn.textContent = on ? "完成" : "多选";
    if (on && !selLayer) selLayer = pushLayer({ onClose: () => { selLayer = null; if (st.selecting && !closed) setSelecting(false); } });
    if (!on && selLayer) { const l = selLayer; selLayer = null; l.close(true); }
    render();
  }
  selBtn.addEventListener("click", () => setSelecting(!st.selecting));

  function renderSelBar() {
    selBar.hidden = !st.selecting;
    if (!st.selecting) return selBar.replaceChildren();
    const n = st.selected.size;
    const all = st.shown.length > 0 && st.shown.every((r) => st.selected.has(r.id));
    const allBtn = h("button.btn.small.ghost", { type: "button" }, all ? "全不选" : "全选");
    allBtn.addEventListener("click", () => {
      if (all) st.selected.clear(); else st.shown.forEach((r) => st.selected.add(r.id));
      render();
    });
    const del = h("button.btn.small.stash-del-sel", { type: "button", disabled: !n }, n ? `删除这 ${n} 条` : "删除");
    del.addEventListener("click", () => {
      const rows = st.all.filter((r) => st.selected.has(r.id));
      remove(rows, rows.map(cardOf));
    });
    selBar.replaceChildren(h("span.stash-sel-n", {}, n ? `已选 ${n} 条` : "点卡片选择"), allBtn, h("span.spacer"), del);
  }

  const cardOf = (row) => [...list.querySelectorAll(".stash-card")].find((c) => c.dataset.id === row.id);

  async function remove(rows, cards) {
    await animateOut(cards || rows.map(cardOf));
    const u = await removeRows(rows);
    if (u) { rows.forEach((r) => st.selected.delete(r.id)); if (st.selecting && !st.selected.size) setSelecting(false); }
    else await load();
  }

  // ---- 筛选条 ----
  function renderChips() {
    const parts = [];
    if (!opts.feature) {
      const feats = tally(st.all, (r) => r.feature || "other");
      if (feats.length > 1) {
        const seg = h("div.stash-seg", { role: "group", "aria-label": "按功能看" });
        [["all", "全部", st.all.length], ...feats.map(([f, n]) => [f, featureName(f), n])].forEach(([id, text, n]) => {
          const b = h("button", { type: "button", "aria-pressed": String(st.feature === id), "data-v": id }, text, h("span.stash-seg-n", {}, String(n)));
          b.addEventListener("click", () => { st.feature = id; render(); });
          seg.append(b);
        });
        parts.push(seg);
      } else st.feature = "all";
    }
    if (st.tag) {
      const x = h("button.stash-tag-on", { type: "button", title: "不按标签筛了" }, "标签：" + st.tag + " ×");
      x.addEventListener("click", () => { st.tag = null; render(); });
      parts.push(x);
    }
    chips.hidden = !parts.length;
    chips.replaceChildren(...parts);
  }

  // ---- 列表 ----
  function render() {
    if (closed) return;
    const key = focusKey(root);
    renderChips();
    st.shown = applyFilter(st.all, { feature: opts.feature ? null : st.feature, tag: st.tag, q: st.q });
    const filtered = st.shown.length !== st.all.length;
    count.textContent = st.all.length ? (filtered ? `${st.shown.length} / ${st.all.length} 条` : `${st.all.length} 条`) : "";
    const first = !st.known;
    const known = st.known || new Set();
    if (!st.all.length) {
      list.replaceChildren(h("div.stash-none", {},
        h("p.stash-none-t", {}, "还没有东西"),
        h("p.muted", {}, opts.feature ? `用「${featureName(opts.feature)}」生成的结果会自动放进来。` : "用 AI 生成的结果会自动放进来。")));
    } else if (!st.shown.length) {
      list.replaceChildren(h("div.stash-none", {}, h("p.muted", {}, st.q ? `没找到含「${st.q.trim()}」的。` : "这个筛选下没有。")));
    } else {
      let i = 0;
      list.replaceChildren(...st.shown.map((row) => cardEl(row, {
        showFeature: !opts.feature && st.feature === "all", showBook: false,
        selecting: st.selecting, selected: st.selected, onSelect: (id, on) => { if (on) st.selected.add(id); else st.selected.delete(id); render(); },
        expanded: st.expanded, use, draggable: inPanel && !!ws.editor && !st.selecting,
        onTag: (t) => { st.tag = st.tag === t ? null : t; render(); },
        remove,
        fresh: first || !known.has(row.id), index: first || !known.has(row.id) ? i++ : 0,
      })));
    }
    st.known = new Set(st.all.map((r) => r.id));
    renderSelBar();
    restoreFocus(root, key);
  }

  async function load() {
    const my = ++seq;
    const scroller = root.closest(".panel-body, .modal-body");
    const top = scroller ? scroller.scrollTop : 0;
    let rows;
    try { rows = await listStash({ bookId: bookId || undefined, feature: opts.feature || undefined, ref: opts.ref || undefined }); }
    catch (e) {
      if (my !== seq || closed) return;
      list.replaceChildren(h("div.stash-none", {}, h("p.muted", {}, L() + "没读出来。")));
      return failed(L() + "读不出来。", e, load);
    }
    if (my !== seq || closed) return;
    st.all = rows;
    for (const id of [...st.selected]) if (!rows.some((r) => r.id === id)) st.selected.delete(id);
    render();
    if (scroller) scroller.scrollTop = top;
  }

  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { st.q = q.value; render(); }, 120); });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape" && q.value && !(e.isComposing || e.keyCode === 229)) { e.stopPropagation(); e.preventDefault(); q.value = ""; st.q = ""; render(); } });

  // 数据变了（新结果进来、撤销、别处删了）就重读
  let reloadT = 0;
  unbind.push(bus.on("stash:changed", () => { clearTimeout(reloadT); reloadT = setTimeout(load, 30); }));

  function cleanup() {
    closed = true;
    clearTimeout(timer); clearTimeout(reloadT);
    unbind.forEach((f) => f());
    if (selLayer) { const l = selLayer; selLayer = null; l.close(true); }
    const v = document.querySelector(".ws");
    if (v) v.classList.remove("has-stash");
    document.body.classList.remove("stash-open", "stash-dragging");
    if (current && current.root === root) current = null;
  }

  let box;
  if (inPanel) {
    box = ws.openPanel({ title, wide: true, onClose: cleanup, render: (body) => { body.classList.add("stash-body"); body.append(root); } });
    const v = document.querySelector(".ws");
    if (v) v.classList.add("has-stash");
    document.body.classList.add("stash-open");
  } else {
    box = modal({ title, body: root, wide: true, onClose: cleanup });
    box.el.classList.add("stash-modal");
  }
  const handle = { root, close: (force) => box.close(force), refresh: load };
  current = handle;
  load();
  tip("stash-drawer", opts.feature
    ? `这里只放「${featureName(opts.feature)}」生成的结果。用得上就点「${use ? use.label : "复制"}」，用不上的随手删。`
    : "AI 生成的结果都在这儿。点「插入正文」或者直接拖进正文，用不上的随手删。");
  return handle;
}

