// 设定库界面：在写作界面的右侧宽面板里，或者整页（#/lore/<书id>）。两处是同一套东西。
// 上面一排分类（带颜色点和张数）、「体系」（晋升阶梯）；搜索、只看有空字段的、排序、大图 / 列表；
// 点卡片在原地打开编辑（左上角返回回到列表，滚动位置不变；Esc 也是返回）。
import { h, icon, toast, pushLayer } from "../../core/ui.js";
import { bus } from "../../core/bus.js";
import { uid } from "../../core/db.js";
import { getBook, listChapters } from "../../core/store.js";
import { chapterLabel } from "../../core/text.js";
import { ws } from "../editor/workspace.js";
import { change, getMeta, listCards, getCard, catOf, emptyFields, matchCard, newCard, valueOf, fieldByKey } from "../../core/lore.js";
import { placeholder } from "./image.js";
import { cardView } from "./card.js";
import { renderSystem } from "./ladders.js";
import { catSettings, newCategory } from "./cats.js";
import { undoToast, flash, composing } from "./bits.js";

const pref = (k, d) => { try { return localStorage.getItem("xemo.lore." + k) || d; } catch (_) { return d; } };
const setPref = (k, v) => { try { localStorage.setItem("xemo.lore." + k, v); } catch (_) { /* 存不了就算了 */ } };
const SORTS = [["order", "建卡顺序"], ["recent", "最近改动"], ["name", "名字"]];

/**
 * 在 host 里放一个设定库。opts: { bookId, mode: "panel"|"page", scrollEl, start: { tab, cardId, quick, newIn } }
 * 返回 { env, ready, open(start), isDirty(), keepDraft(), destroy() }
 */
export function mountLore(host, opts) {
  const scrollEl = opts.scrollEl || host;
  const root = h("div.lr-root", { "data-mode": opts.mode });
  const listWrap = h("div.lr-listview");
  const cardHost = h("div.lr-cardhost", { hidden: true });
  root.append(listWrap, cardHost);
  host.append(root);

  const env = {
    bookId: opts.bookId, mode: opts.mode, root, book: null, meta: null, cards: [], chapterList: [],
    source: uid("src"), layers: new Set(), editing: new Set(), stale: false,
    aiFor: new Map(), catDrafts: new Map(), openLevels: new Set(), pasteDraft: null,
    tab: "all", q: "", onlyEmpty: false, sort: pref("sort", "order"), look: pref("view", "grid"),
    stack: [], listScroll: 0, destroyed: false,
  };

  // ---------------- 章节 ----------------
  const live = () => !!(ws.book && ws.book.id === env.bookId);
  env.chapters = () => (live() ? ws.chapters : env.chapterList);
  env.idxOf = (id) => env.chapters().findIndex((c) => c.id === id) + 1;
  env.chapterName = (c, i) => chapterLabel(i + 1, env.book ? env.book.numbering : "zh") + (c.title ? " " + c.title : "");
  /** 在写作界面里：现在写的这一章是第几章（阶梯显示那一章时的等级）；整页时是 null（看最新） */
  env.atNo = () => (live() && ws.current ? env.idxOf(ws.current.id) || null : null);
  env.curChapterId = () => (live() && ws.current ? ws.current.id : (env.book && env.book.lastChapterId) || null);

  // ---------------- 浮层、正在改的东西 ----------------
  env.pushLayer = (o) => {
    const l = pushLayer({ ...o, onClose: () => { env.layers.delete(l); o.onClose && o.onClose(); } });
    env.layers.add(l);
    return l;
  };
  env.dirty = () => [...env.editing].some((a) => a.dirty());
  env.commitAll = async () => { for (const a of [...env.editing]) await a.commit(); };
  env.cancelAll = () => { for (const a of [...env.editing]) a.cancel(); };
  env.afterEdit = () => { if (env.stale && !env.editing.size && !env.destroyed) { env.stale = false; renderAll(); } };

  // ---------------- 数据 ----------------
  async function load() {
    const [book, meta, cards] = await Promise.all([getBook(env.bookId), getMeta(env.bookId), listCards(env.bookId)]);
    env.book = book; env.meta = meta; env.cards = cards;
    if (!live()) env.chapterList = await listChapters(env.bookId);
  }
  env.reloadCard = async (id) => {
    const c = await getCard(id);
    const i = env.cards.findIndex((x) => x.id === id);
    if (c && c.type === "card") { if (i >= 0) env.cards[i] = c; else env.cards.push(c); }
    else if (i >= 0) env.cards.splice(i, 1);
  };
  /** 改一张卡：fn(卡的副本, tx)。算一步撤销，返回撤销条目 */
  env.updateCard = async (id, lbl, fn) => {
    const { entry } = await change(env.bookId, lbl, async (t) => { const c = await t.card(id); if (!c) return null; return fn(c, t); }, { source: env.source });
    await env.reloadCard(id);
    return entry;
  };
  /** 改分类、阶梯：改完重画当前界面 */
  env.updateMeta = async (lbl, fn) => {
    const { entry } = await change(env.bookId, lbl, async (t) => fn(await t.meta(), t), { source: env.source });
    env.meta = await getMeta(env.bookId);
    renderAll();
    return entry;
  };
  /** 一步里改几样（比如新建地点并设成所在地） */
  env.change = async (lbl, fn) => {
    const r = await change(env.bookId, lbl, fn, { source: env.source });
    env.meta = await getMeta(env.bookId);
    for (const id of r.ids) if (!id.startsWith("meta:")) await env.reloadCard(id);
    return r;
  };

  // ---------------- 卡片：一层一层打开，返回一层一层退 ----------------
  const top = () => env.stack[env.stack.length - 1] || null;
  env.openCard = (id, o = {}) => {
    if (!env.cards.some((c) => c.id === id)) { toast("这张卡不在了"); return; }
    const t = top();
    if (t && t.id === id) return;
    if (!t) env.listScroll = scrollEl.scrollTop;
    const entry = { id, prevScroll: scrollEl.scrollTop, view: cardView(env, id, { quick: !!o.quick }) };
    entry.layer = env.pushLayer({ isDirty: () => env.dirty(), onKeepDraft: () => env.commitAll(), onClose: () => popView(entry) });
    env.stack.push(entry);
    showCard(entry, true);
  };
  function popView(entry) {
    // 这张卡上还开着的小浮层、没写完的输入框一起收起
    const later = [...env.layers];
    later.forEach((l) => { if (l !== entry.layer && !env.stack.some((s) => s.layer === l)) l.close(true); });
    env.cancelAll();
    const i = env.stack.indexOf(entry);
    if (i >= 0) env.stack.splice(i, 1);
    if (env.destroyed) return;
    const t = top();
    if (t) { showCard(t, false); scrollEl.scrollTop = entry.prevScroll; }
    else { showList(); scrollEl.scrollTop = env.listScroll; }
  }
  function showCard(entry, enter) {
    listWrap.hidden = true;
    cardHost.hidden = false;
    entry.view.render();
    cardHost.replaceChildren(entry.view.el);
    if (enter) {
      scrollEl.scrollTop = 0;
      entry.view.el.classList.remove("lr-enter");
      void entry.view.el.offsetWidth;
      entry.view.el.classList.add("lr-enter");
    }
    setTimeout(() => { const b = entry.view.el.querySelector(".lr-back"); if (b && enter) b.focus({ preventScroll: true }); }, 0);
  }
  function showList() {
    cardHost.hidden = true;
    cardHost.replaceChildren();
    listWrap.hidden = false;
    renderList();
  }
  env.back = () => { const t = top(); if (t) t.layer.close(); };
  /** 卡被删了：直接退到上一层，不问 */
  env.dropCard = (id) => {
    env.cards = env.cards.filter((c) => c.id !== id);
    for (const s of [...env.stack].reverse()) if (s.id === id) s.layer.close(true);
    if (!env.stack.length) renderList();
  };
  env.redrawCard = (id, ...parts) => { const t = top(); if (t && t.id === id) t.view.redraw(...(parts.length ? parts : [])); if (t && t.id === id && !parts.length) t.view.render(); };
  env.showTab = (tab) => {
    for (const s of [...env.stack].reverse()) s.layer.close(true);
    env.tab = tab;
    showList();
    scrollEl.scrollTop = 0;
  };

  function renderAll() {
    if (env.destroyed) return;
    if (env.editing.size) { env.stale = true; return; }
    const t = top();
    if (t) t.view.render();
    else renderList();
  }

  // ---------------- 列表 ----------------
  let newRow = null;
  function renderList() {
    if (env.destroyed || !env.meta) return;
    const meta = env.meta;
    if (env.tab !== "all" && env.tab !== "sys" && !meta.cats.some((c) => c.id === env.tab)) env.tab = "all";
    const tabs = h("div.lr-tabs", { role: "tablist", "aria-label": "分类" });
    const tab = (id, kids, extra = {}) => {
      const b = h("button.lr-tab", { type: "button", role: "tab", "aria-selected": String(env.tab === id), "data-tab": id, ...extra }, ...kids);
      b.addEventListener("click", () => { if (env.tab !== id) { env.tab = id; env.q = env.q; renderList(); flash(b, "lr-tabbed"); } });
      return b;
    };
    tabs.append(tab("all", [h("span.lr-tab-t", {}, "全部"), h("span.lr-tab-n", {}, String(env.cards.length))]));
    meta.cats.forEach((c) => {
      const n = env.cards.filter((x) => x.cat === c.id).length;
      const b = tab(c.id, [h("i.lr-dot"), h("span.lr-tab-t", {}, c.name), h("span.lr-tab-n", {}, String(n))], { style: { "--c": c.color }, title: "双击改分类设置" });
      b.addEventListener("dblclick", () => catSettings(env, c.id));
      tabs.append(b);
    });
    tabs.append(tab("sys", [icon("ladder"), h("span.lr-tab-t", {}, "体系")], { title: "根基和晋升阶梯（境界、爵位、等级）" }));
    const addCat = h("button.lr-tab.lr-tab-add", { type: "button", title: "新建分类", "aria-label": "新建分类" }, icon("plus"));
    addCat.addEventListener("click", async () => { const c = await newCategory(env); if (c) { env.tab = c.id; renderList(); } });
    tabs.append(addCat);

    if (env.tab === "sys") {
      listWrap.replaceChildren(tabs, renderSystem(env));
      return;
    }

    // 工具条
    const q = h("input.input.lr-q", { type: "search", placeholder: "搜名字、别名、内容", value: env.q, "aria-label": "搜索设定卡" });
    let qt = 0;
    q.addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(() => { env.q = q.value; paintItems(); }, 120); });
    const emptyBtn = h("button.lr-filter", { type: "button", "aria-pressed": String(env.onlyEmpty), title: "只看还有字段空着的卡" }, "有空字段");
    emptyBtn.addEventListener("click", () => { env.onlyEmpty = !env.onlyEmpty; emptyBtn.setAttribute("aria-pressed", String(env.onlyEmpty)); paintItems(); });
    const sort = h("select.select.small.lr-sort", { "aria-label": "排序" }, ...SORTS.map(([v, t]) => h("option", { value: v }, t)));
    sort.value = env.sort;
    sort.addEventListener("change", () => { env.sort = sort.value; setPref("sort", env.sort); paintItems(); });
    const look = h("button.icon-btn.lr-look", { type: "button", title: env.look === "grid" ? "换成列表" : "换成大图", "aria-label": "切换显示方式" }, icon(env.look === "grid" ? "list" : "grid"));
    look.addEventListener("click", () => { env.look = env.look === "grid" ? "list" : "grid"; setPref("view", env.look); renderList(); });
    const cat = meta.cats.find((c) => c.id === env.tab);
    const gear = cat ? h("button.icon-btn.lr-catgear", { type: "button", title: `「${cat.name}」的设置：字段、颜色、占位字`, "aria-label": "分类设置" }, icon("gear")) : null;
    if (gear) gear.addEventListener("click", () => catSettings(env, cat.id));
    const add = h("button.btn.small.primary.lr-new", { type: "button" }, icon("plus"), h("span", {}, cat ? "新建" + cat.name : "新建"));
    add.addEventListener("click", () => openNew(cat ? cat.id : null));
    const tools = h("div.lr-tools", {}, h("div.lr-q-wrap", {}, icon("search"), q), emptyBtn, sort, look, gear, add);
    newRow = h("div.lr-newrow", { hidden: true });
    const items = h("div.lr-items." + (env.look === "list" ? "is-list" : "is-grid"), { role: "list" });
    listWrap.replaceChildren(tabs, tools, newRow, items);
    paintItems();

    function paintItems() {
      const all = env.cards.filter((c) => env.tab === "all" || c.cat === env.tab);
      let shown = all.filter((c) => matchCard(c, env.q) && (!env.onlyEmpty || emptyFields(c, catOf(meta, c)).length));
      if (env.sort === "recent") shown = [...shown].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      else if (env.sort === "name") shown = [...shown].sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-CN"));
      if (!shown.length) {
        const none = h("div.lr-none");
        if (!env.cards.length) none.append(h("p.lr-none-t", {}, "设定库还是空的"), h("p.muted", {}, "人物、地点、物品、势力……写到谁就建谁。空着的格子不用急着填。"), firstBtn());
        else if (!all.length) none.append(h("p.lr-none-t", {}, `「${cat ? cat.name : ""}」里还没有卡`), firstBtn());
        else none.append(h("p.muted", {}, env.q.trim() ? `没找到含「${env.q.trim()}」的卡。` : "都填满了，没有空着的字段。"));
        items.replaceChildren(none);
        return;
      }
      items.replaceChildren(...shown.map((c, i) => itemEl(c, i)));
    }
    function firstBtn() {
      const b = h("button.btn.primary", { type: "button" }, icon("plus"), cat ? `新建${cat.name}` : "新建人物");
      b.addEventListener("click", () => openNew(cat ? cat.id : (meta.cats.find((c) => c.kind === "person") || meta.cats[0]).id));
      return b;
    }
  }

  function subOf(c, cat) {
    if (cat.kind === "person") {
      const id = valueOf(c, fieldByKey(cat, "identity"));
      return [c.role, String(id || "").split(/\n/)[0]].filter(Boolean).join(" · ");
    }
    const f = (cat.fields || []).find((x) => String(valueOf(c, x)).trim());
    return f ? String(valueOf(c, f)).split(/\n/)[0] : "";
  }

  function itemEl(c, i) {
    const cat = catOf(env.meta, c);
    const empty = emptyFields(c, cat).length;
    const o = c.outfit && (c.outfits || []).find((x) => x.id === c.outfit && x.img);
    const img = (o && o.img) || c.img;
    const sub = subOf(c, cat);
    const b = h("button.lr-item", { type: "button", role: "listitem", "data-id": c.id, "data-kind": cat.kind, style: { "--c": cat.color, "--i": String(Math.min(i, 24)) }, title: c.name },
      h("span.lr-item-pic", {}, img ? h("img", { src: img.thumb, alt: "", loading: "lazy" }) : placeholder(cat)),
      h("span.lr-item-body", {},
        h("span.lr-item-name", {}, c.name || "未命名"),
        sub ? h("span.lr-item-sub", {}, sub) : null,
        env.tab === "all" ? h("span.lr-item-cat", {}, h("i.lr-dot"), cat.name) : null),
      empty ? h("span.lr-item-empty", { title: `${empty} 个字段空着` }, `空 ${empty}`) : null);
    b.addEventListener("click", () => env.openCard(c.id));
    return b;
  }

  // ---------------- 新建 ----------------
  function openNew(catId, name = "") {
    if (!newRow) return;
    if (newRow._layer) { newRow.querySelector("input").focus(); return; }
    const meta = env.meta;
    const cats = meta.cats;
    const sel = h("select.select.small", { "aria-label": "放进哪个分类" }, ...cats.map((c) => h("option", { value: c.id }, c.name)));
    sel.value = catId || (cats.find((c) => c.kind === "person") || cats[0]).id;
    const input = h("input.input.lr-new-in", { placeholder: "名字，比如 林晚", maxlength: "40", value: name, "aria-label": "新卡的名字" });
    const ok = h("button.btn.small.primary", { type: "button" }, "建好");
    const no = h("button.btn.small.ghost", { type: "button" }, "取消");
    newRow.replaceChildren(catId && env.tab !== "all" ? h("span.lr-new-cat", { style: { "--c": (cats.find((c) => c.id === catId) || {}).color } }, h("i.lr-dot"), (cats.find((c) => c.id === catId) || {}).name) : sel, input, ok, no);
    newRow.hidden = false;
    const close = () => { newRow.hidden = true; newRow.replaceChildren(); newRow._layer = null; };
    const create = async () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      const cid = catId && env.tab !== "all" ? catId : sel.value;
      layer.close(true);
      const card = await createCard(cid, v);
      if (card) env.openCard(card.id, { quick: true });
    };
    const layer = env.pushLayer({ isDirty: () => !!input.value.trim(), onKeepDraft: create, onClose: close });
    newRow._layer = layer;
    ok.addEventListener("click", create);
    no.addEventListener("click", () => layer.close());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); create(); } });
    flash(newRow, "lr-born");
    setTimeout(() => input.focus(), 0);
  }

  async function createCard(catId, name) {
    const { result, entry } = await change(env.bookId, `新建设定卡「${name}」`, async (t) => {
      const m = await t.meta();
      const cat = m.cats.find((c) => c.id === catId) || m.cats[0];
      return t.add(newCard(env.bookId, cat, { name }));
    }, { source: env.source });
    await load();
    undoToast(`已新建「${name}」`, entry);
    return result;
  }
  env.createCard = createCard;

  // ---------------- 外面来的改动（撤销、回收站恢复、别处新建） ----------------
  const offs = [
    bus.on("lore:changed", async (d) => {
      if (d.bookId !== env.bookId || env.destroyed) return;
      if (d.source === env.source && !d.undo && !d.redo) return;
      await load();
      renderAll();
    }),
    bus.on("chapter:created", () => { if (!live() && !env.destroyed) load(); }),
    bus.on("chapter:deleted", () => { if (!live() && !env.destroyed) load(); }),
  ];

  // ---------------- 对外 ----------------
  async function open(start = {}) {
    if (start.tab) env.showTab(start.tab);
    if (start.newIn) {
      if (env.stack.length) env.showTab(env.tab);
      const c = env.meta.cats.find((x) => x.id === start.newIn) || null;
      if (c) { env.tab = c.id; renderList(); }
      openNew(c ? c.id : null, start.name || "");
    }
    if (start.cardId) {
      if (!env.cards.some((c) => c.id === start.cardId)) await load();
      env.openCard(start.cardId, { quick: !!start.quick });
    }
  }
  const ready = (async () => {
    await load();
    if (opts.start && opts.start.tab) env.tab = opts.start.tab;
    renderList();
    if (opts.start && opts.start.listScroll) scrollEl.scrollTop = opts.start.listScroll;
    if (opts.start) await open({ ...opts.start, tab: null });
  })();

  return {
    env, ready, open,
    isDirty: () => env.dirty(),
    keepDraft: () => env.commitAll(),
    state: () => ({ tab: env.tab, cardId: top() ? top().id : null, listScroll: env.stack.length ? env.listScroll : scrollEl.scrollTop }),
    destroy() {
      if (env.destroyed) return;
      env.destroyed = true;
      offs.forEach((f) => f());
      for (const l of [...env.layers].reverse()) l.close(true);
      env.stack.length = 0;
      root.remove();
    },
  };
}
