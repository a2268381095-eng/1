// 名词标色：正文里设定库的名字按分类上色（第一层：本地匹配，免费、即时），点一下弹出这张卡，可以直接改；
// 疑似新名字用虚线标出（本地找或 AI 找，AI 要确认才调用），点一下「收进设定库」或「忽略」；
// 正文里选中一段也能「收入设定库」。状态栏「名字」打开名字面板：本章出现了谁、新名字、忽略过的。
// 数据：疑似新名字 kv "names:cand:<书id>" = [{ name, kind, n, src: "local"|"ai", at }]，忽略的 kv "names:ignore:<书id>" = [名字]。
// 开关：kv "names:marks"（正文标色）、"names:cands"（虚线标疑似新名字），设置页「正文标色」里改。
import { StateEffect } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin } from "@codemirror/view";
import { db } from "../../core/db.js";
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { h, icon, toast, pushLayer } from "../../core/ui.js";
import { undo as appUndo } from "../../core/undo.js";
import { FEATURES } from "../../core/stash.js";
import { readMeta, getMeta, listCards, getCard, catOf, findCat, newCard, change, valueOf, levelAt, levelIndex, trashCard, KINDS } from "../../core/lore.js";
import { placeholder, imageFrom } from "../lore/image.js";
import { setCardImage, lookText } from "../lore/card.js";
import { runAI } from "../ai/runner.js";
import { addEditorExtension } from "../editor/editor.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { buildMatcher, findAll, countTerms, localFind, parseNames, kindOfWord } from "./match.js";

const st = { bookId: null, meta: null, terms: [], matcher: null, cands: [], candMatcher: null, ignore: new Set(), marksOn: true, candsOn: true, fresh: new Set() };
const refresh = StateEffect.define();
const KIND_ORDER = ["person", "place", "item", "faction", "skill", "creature", "festival", "other"];

// ---------------- 数据 ----------------
async function load(bookId) {
  st.bookId = bookId;
  if (!bookId) { st.terms = []; st.matcher = null; st.cands = []; st.candMatcher = null; redraw(); return; }
  const [meta, cards, cands, ign, marks, candsOn] = await Promise.all([readMeta(bookId), listCards(bookId),
    db.getKV("names:cand:" + bookId, []), db.getKV("names:ignore:" + bookId, []), db.getKV("names:marks", true), db.getKV("names:cands", true)]);
  if (st.bookId !== bookId) return;
  st.meta = meta;
  st.terms = cards.filter((c) => c.name).map((c) => { const cat = catOf(meta, c); return { id: c.id, name: c.name, aliases: c.aliases || [], color: cat.color, kind: cat.kind, cat: cat.name }; });
  st.matcher = buildMatcher(st.terms);
  st.ignore = new Set(ign);
  st.marksOn = marks !== false;
  st.candsOn = candsOn !== false;
  st.cands = cands.filter((c) => !st.ignore.has(c.name) && !known(c.name));
  st.candMatcher = buildMatcher(st.cands.map((c) => ({ id: "cand:" + c.name, name: c.name, aliases: [], kind: c.kind, cand: true })));
  decos.clear();
  redraw();
  updateStatus();
  if (pop && pop.render && !busy()) pop.render();
}
/** 设定库里已经有（名字或别名） */
function known(name) { return st.terms.some((t) => t.name === name || (t.aliases || []).includes(name)); }
async function saveCands(list) {
  st.cands = list;
  await db.setKV("names:cand:" + st.bookId, list);
  await load(st.bookId);
}
async function ignore(names) {
  const set = new Set(await db.getKV("names:ignore:" + st.bookId, []));
  names.forEach((n) => set.add(n));
  await db.setKV("names:ignore:" + st.bookId, [...set]);
  await saveCands(st.cands.filter((c) => !names.includes(c.name)));
}
async function unignore(name) {
  const list = (await db.getKV("names:ignore:" + st.bookId, [])).filter((n) => n !== name);
  await db.setKV("names:ignore:" + st.bookId, list);
  await load(st.bookId);
}

/** 收进设定库：items = [{ name, kind 或 catId }]，几个一起算一步撤销 */
async function archive(items, { open = false } = {}) {
  const bookId = st.bookId || (ws.book && ws.book.id);
  if (!bookId || !items.length) return null;
  const meta = await getMeta(bookId);
  const catFor = (x) => (x.catId && meta.cats.find((c) => c.id === x.catId)) || findCat(meta, x.kind) || meta.cats.find((c) => c.kind === "person") || meta.cats[0];
  const label = items.length === 1 ? `收进设定库「${items[0].name}」` : `收进设定库 ${items.length} 个名字`;
  const { result, entry } = await change(bookId, label, async (t) => {
    await t.meta();
    return items.map((x) => t.add(newCard(bookId, catFor(x), { name: x.name })));
  });
  const done = new Set(items.map((x) => x.name));
  await saveCands(st.cands.filter((c) => !done.has(c.name)));
  result.forEach((c) => st.fresh.add(c.id));
  setTimeout(() => { result.forEach((c) => st.fresh.delete(c.id)); decos.clear(); redraw(); }, 1600);
  decos.clear(); redraw();
  const actions = [{ label: "撤销", run: () => appUndo.undoEntry(entry) }];
  if (result.length === 1) actions.push({ label: "打开卡片", run: () => commands.run("cards.open", { bookId, id: result[0].id }) });
  toast(items.length === 1 ? `已收进设定库：「${items[0].name}」（${catFor(items[0]).name}）` : `已收进设定库 ${items.length} 个名字`, { actions });
  if (open && result.length === 1) commands.run("cards.open", { bookId, id: result[0].id });
  bus.emit("names:archived", { bookId, ids: result.map((c) => c.id) });
  return result;
}

// ---------------- 编辑器里上色 ----------------
const decos = new Map();
function decoFor(term) {
  const k = term.id + (st.fresh.has(term.id) ? ":new" : "");
  if (!decos.has(k)) {
    decos.set(k, term.cand
      ? Decoration.mark({ class: "nm-c", attributes: { "data-nmc": term.name, title: "疑似新名字：点一下收进设定库" } })
      : Decoration.mark({ class: "nm-t nm-k-" + term.kind + (st.fresh.has(term.id) ? " nm-new" : ""), attributes: { "data-nm": term.id, style: "--nm:" + term.color } }));
  }
  return decos.get(k);
}
function build(view) {
  if (!ws.current || (!st.marksOn && !st.candsOn)) return Decoration.none;
  const marks = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const terms = st.marksOn ? findAll(st.matcher, text, from) : [];
    terms.forEach((x) => marks.push({ from: x.from, to: x.to, d: decoFor(x.term) }));
    if (st.candsOn) for (const x of findAll(st.candMatcher, text, from)) if (!terms.some((y) => y.from < x.to && x.from < y.to)) marks.push({ from: x.from, to: x.to, d: decoFor(x.term) });
  }
  marks.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(marks.map((m) => m.d.range(m.from, m.to)));
}
let countTimer = 0;
const plugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refresh)))) this.decorations = build(u.view);
    if (u.docChanged) { clearTimeout(countTimer); countTimer = setTimeout(updateStatus, 900); }
  }
}, { decorations: (p) => p.decorations });
function redraw() { const v = ws.editor && ws.editor.view; if (v) v.dispatch({ effects: refresh.of(null) }); }

// 鼠标停在名字上一会儿就弹出这张卡（看一眼）；点一下名字、或者在卡里点了 / 打了字，卡就留住，Esc 或点别处才关
let hoverTimer = 0, leaveTimer = 0, lastKey = 0;
const events = EditorView.domEventHandlers({
  click(e, view) {
    if (e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
    const el = e.target.closest && e.target.closest(".nm-t, .nm-c");
    if (!el || !view.state.selection.main.empty) return false;
    clearTimeout(hoverTimer);
    setTimeout(() => {
      if (el.classList.contains("nm-c")) candPop(el, el.dataset.nmc);
      else if (pop && pop.cardId === el.dataset.nm) pin();
      else termPop(el, el.dataset.nm, { pinned: true });
    }, 0);
    return false;
  },
  mouseover(e) {
    const el = e.target.closest && e.target.closest(".nm-t");
    if (!el) return false;
    clearTimeout(leaveTimer);
    if ((pop && (pop.pinned || pop.cardId === el.dataset.nm)) || Date.now() - lastKey < 1200) return false;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (el.isConnected && el.matches(":hover")) termPop(el, el.dataset.nm, { pinned: false }); }, 450);
    return false;
  },
  mouseout(e) {
    if (!(e.target.closest && e.target.closest(".nm-t"))) return false;
    clearTimeout(hoverTimer);
    leaveSoon();
    return false;
  },
});
function leaveSoon() {
  clearTimeout(leaveTimer);
  if (!pop || pop.pinned) return;
  leaveTimer = setTimeout(() => { if (pop && !pop.pinned && !pop.el.matches(":hover")) closePop(); }, 380);
}
function pin() { if (pop && !pop.pinned) { pop.pinned = true; pop.el.classList.add("pinned"); } }

// ---------------- 小卡片（浮在名字旁边） ----------------
let pop = null;
function closePop() { if (pop) pop.layer.close(true); }
function openPop(anchor, cls, content, { pinned = true, cardId = null } = {}) {
  closePop();
  const el = h("div.nm-pop" + cls + (pinned ? ".pinned" : ""), { role: "dialog" }, ...content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  const rect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  const onDown = (ev) => { if (!el.contains(ev.target)) layer.close(true); else pin(); };
  const offType = bus.on("typing:input", () => layer.close(true));
  setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
  el.addEventListener("mouseenter", () => clearTimeout(leaveTimer));
  el.addEventListener("mouseleave", leaveSoon);
  el.addEventListener("focusin", pin);
  const layer = pushLayer({ onClose: () => { el.remove(); document.removeEventListener("pointerdown", onDown, true); if (typeof offType === "function") offType(); if (pop && pop.el === el) pop = null; } });
  pop = { el, layer, pinned, cardId, rect, render: null };
  placePop();
  return el;
}
/** 按名字的位置摆：下面放不下就放上面，不出屏幕 */
function placePop() {
  if (!pop) return;
  const { el, rect: r } = pop;
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let top = r.bottom + 8, side = "down";
  if (top + hgt > innerHeight - 8 && r.top - hgt - 8 > 8) { top = r.top - hgt - 8; side = "up"; }
  el.style.left = Math.round(Math.max(8, Math.min(r.left - 16, innerWidth - w - 8))) + "px";
  el.style.top = Math.round(Math.max(8, Math.min(top, innerHeight - hgt - 8))) + "px";
  el.dataset.side = side;
}

const chapterNo = () => (ws.current ? ws.chapters.findIndex((c) => c.id === ws.current.id) + 1 : 0);
const busy = () => pop && pop.el.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
const composingKey = (e) => e.isComposing || e.keyCode === 229;

/** 改一处，卡片底下记一句「已改好 · 撤销」 */
function noteSaved(msg, entry) {
  if (!pop || !entry) return;
  const note = pop.el.querySelector(".nm-note-line");
  if (!note) return;
  const u = h("button.nm-undo", { type: "button" }, "撤销");
  u.addEventListener("click", async () => { await appUndo.undoEntry(entry); if (pop && pop.render) pop.render(); });
  note.replaceChildren(h("span", {}, msg), u);
}
async function save(card, label, fn, msg) {
  const { entry } = await change(card.bookId, label, async (t) => { const c = await t.card(card.id); if (c) fn(c); });
  if (pop && pop.render) await pop.render();
  noteSaved(msg || "已改好", entry);
  return entry;
}

async function termPop(anchor, id, { pinned = true } = {}) {
  if (!st.bookId || !(await getCard(id))) return;
  const el = openPop(anchor, ".nm-term", [h("p.nm-pop-sub", {}, "……")], { pinned, cardId: id });
  const render = async ({ focus = null } = {}) => {
    const card = await getCard(id);
    if (!card) { closePop(); return; }
    if (!pop || pop.el !== el) return;
    const meta = await readMeta(st.bookId);
    const cat = catOf(meta, card);
    const cards = await listCards(st.bookId);
    const idxOf = (cid) => ws.chapters.findIndex((c) => c.id === cid) + 1;
    const person = cat.kind === "person";
    const outfit = card.outfit && (card.outfits || []).find((o) => o.id === card.outfit);
    const img = (outfit && outfit.img) || card.img;

    // 形象：大一点；没有就是分类占位图，下面直接「上传」「AI 画」，也能拖进来、粘贴
    const file = h("input", { type: "file", accept: "image/*", hidden: true, tabindex: "-1", "aria-hidden": "true" });
    const setImg = async (src) => {
      const e = await setCardImage(card.bookId, id, outfit ? outfit.id : null, src);
      if (e) { await render(); noteSaved("换好图了", e); }
    };
    file.addEventListener("change", () => { if (file.files[0]) setImg(file.files[0]); file.value = ""; });
    const pic = h("button.nm-pic" + (img ? "" : ".none"), { type: "button", title: img ? "打开卡片看大图" : "点「上传」，或者把图拖到这里、复制后按 Ctrl+V", "aria-label": img ? "打开卡片" : "还没有形象" },
      img ? h("img", { src: img.thumb, alt: "" }) : placeholder(cat));
    pic.addEventListener("click", () => { if (img) { closePop(); commands.run("cards.open", { bookId: st.bookId, id }); } else file.click(); });
    pic.addEventListener("dragover", (e) => { e.preventDefault(); pic.classList.add("drop"); });
    pic.addEventListener("dragleave", () => pic.classList.remove("drop"));
    pic.addEventListener("drop", (e) => { e.preventDefault(); pic.classList.remove("drop"); const f = imageFrom(e.dataTransfer); if (f) setImg(f); });
    const upB = h("button.nm-mini", { type: "button" }, img ? "换图" : "上传");
    upB.addEventListener("click", () => file.click());
    const aiB = h("button.nm-mini", { type: "button", title: "按外貌和辨识特征画（会先让你确认）" }, "AI 画");
    aiB.addEventListener("click", () => {
      if (!commands.get("paint.open")) { toast("绘画功能还没装好"); return; }
      closePop();
      commands.run("paint.open", { bookId: card.bookId, cardId: id, outfitId: outfit ? outfit.id : null, name: card.name, purpose: (KINDS[cat.kind] || KINDS.other).purpose,
        prompt: lookText(card, cat, outfit), onDone: async (dataUrl) => { const e = await setCardImage(card.bookId, id, outfit ? outfit.id : null, dataUrl); if (e) toast(`「${card.name}」的形象画好了`, { action: { label: "撤销", run: () => appUndo.undoEntry(e) } }); } });
    });
    const clrB = img ? h("button.nm-mini.ghost", { type: "button" }, "去掉") : null;
    if (clrB) clrB.addEventListener("click", () => save(card, `去掉「${card.name}」的形象`, (c) => { const o = c.outfit && (c.outfits || []).find((x) => x.id === c.outfit); if (o && o.img) o.img = null; else c.img = null; }, "去掉了"));

    // 名字：点一下改
    const nameB = h("button.nm-name-b", { type: "button", title: "点一下改名字" }, card.name);
    nameB.addEventListener("click", () => {
      const inp = h("input.input.nm-name-edit", { value: card.name, "aria-label": "名字", maxlength: 40 });
      nameB.replaceWith(inp);
      inp.focus(); inp.select();
      let done = false;
      const go = async (keep) => {
        if (done) return; done = true;
        const v = inp.value.trim();
        if (!keep || !v || v === card.name) { render(); return; }
        if (st.terms.some((t) => t.id !== id && (t.name === v || (t.aliases || []).includes(v)))) { toast(`设定库里已经有「${v}」了`); render(); return; }
        await save(card, `把「${card.name}」改名叫「${v}」`, (c) => { c.name = v; }, "改好名字了");
      };
      inp.addEventListener("keydown", (e) => { if (composingKey(e)) return; if (e.key === "Enter") { e.preventDefault(); go(true); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); go(false); } });
      inp.addEventListener("blur", () => go(true));
    });
    // 分类：换一个
    const catSel = h("select.nm-catsel", { "aria-label": "分类", style: "--nm:" + cat.color }, ...meta.cats.map((c) => h("option", { value: c.id, selected: c.id === cat.id }, c.name)));
    catSel.addEventListener("change", () => { const to = meta.cats.find((c) => c.id === catSel.value); if (to) save(card, `把「${card.name}」换到「${to.name}」`, (c) => { c.cat = to.id; }, "换好分类了"); });

    const rows = [];
    for (const f of cat.fields || []) {
      const v = valueOf(card, f);
      const val = h("button.nm-val" + (v ? "" : ".empty"), { type: "button", title: "点一下改" }, v || "点击填写");
      val.addEventListener("click", () => editField(val, card, f));
      rows.push(h("div.nm-row", {}, h("span.nm-k", { title: f.hint || null }, f.name), val));
    }
    if (person) {
      for (const lad of meta.ladders || []) {
        const s = levelAt(card, lad.id, idxOf, chapterNo() || null);
        const lv = s && lad.levels[levelIndex(lad, s.levelId)];
        if (lv) rows.push(h("div.nm-row", {}, h("span.nm-k", {}, lad.name), h("span.nm-v", {}, lv.name + (s.no ? `（第 ${s.no} 章起）` : ""))));
      }
      const place = card.placeId && cards.find((c) => c.id === card.placeId);
      if (place) rows.push(h("div.nm-row", {}, h("span.nm-k", {}, "所在地"), h("span.nm-v", {}, place.name)));
    }
    const n = ws.editor ? countTerms(st.matcher, ws.editor.getText()).get(card.id) : null;
    const delB = h("button.btn.small.ghost.nm-del", { type: "button", title: "删到回收站，能撤销" }, icon("trash"), "删除");
    delB.addEventListener("click", async () => {
      closePop();
      const r = await trashCard(id);
      if (r && r.entry) toast(`已删除「${card.name}」，在回收站里`, { action: { label: "撤销", run: () => appUndo.undoEntry(r.entry) } });
    });
    const openB = h("button.btn.small.primary", { type: "button" }, icon("lore"), "打开卡片");
    openB.addEventListener("click", () => { closePop(); commands.run("cards.open", { bookId: st.bookId, id }); });

    el.style.setProperty("--nm", cat.color);
    el.replaceChildren(
      h("div.nm-pop-head", {},
        h("div.nm-pic-col", {}, pic, h("div.nm-pic-btns", {}, upB, aiB, clrB), file),
        h("div.nm-pop-t", {}, nameB, catSel,
          h("div.nm-line", {}, h("span.nm-k", {}, "别名"), chipsEdit(card.aliases || [], "别名", "alias", (list) => save(card, `改「${card.name}」的别名`, (c) => { c.aliases = list; }, "别名改好了").then(() => render({ focus: "alias" })))),
          person ? h("div.nm-line", {}, h("span.nm-k", {}, "特征"), chipsEdit(card.traits || [], "辨识特征", "trait", (list) => save(card, `改「${card.name}」的辨识特征`, (c) => { c.traits = list; }, "特征改好了").then(() => render({ focus: "trait" })))) : null)),
      h("div.nm-rows", {}, ...rows),
      h("p.nm-note-line", { "aria-live": "polite" }),
      h("div.nm-pop-foot", {}, h("span.nm-count", {}, n ? `这一章出现 ${n.n} 次` : "这一章没出现"), delB, openB),
    );
    if (focus) { const f = el.querySelector(`[data-focus="${focus}"]`); if (f) f.focus(); }
    placePop();
  };
  pop.render = render;
  await render();
}

/** 一排可以删、可以加的小签（别名、辨识特征） */
function chipsEdit(items, label, key, onSave) {
  const box = h("div.nm-chips");
  items.forEach((t, i) => {
    const x = h("button.nm-chip-x", { type: "button", "aria-label": `去掉${label}「${t}」`, title: "去掉" }, "×");
    x.addEventListener("click", () => onSave(items.filter((_, j) => j !== i)));
    box.append(h("span.nm-tag", {}, t, x));
  });
  const add = h("input.nm-chip-in", { placeholder: "+ " + label, "aria-label": "加" + label, "data-focus": key, maxlength: 20 });
  add.addEventListener("keydown", (e) => {
    if (composingKey(e) || e.key !== "Enter") return;
    e.preventDefault();
    const v = add.value.trim();
    add.value = "";
    if (v && !items.includes(v)) onSave([...items, v]);
  });
  box.append(add);
  return box;
}

function editField(val, card, f) {
  const ta = h("textarea.nm-edit", { rows: 2, "aria-label": f.name }, valueOf(card, f));
  val.replaceWith(ta);
  ta.focus();
  ta.select();
  let done = false;
  const go = async (keep) => {
    if (done) return;
    done = true;
    const v = ta.value.trim();
    if (!keep || v === (valueOf(card, f) || "")) { if (pop && pop.render) pop.render(); return; }
    await save(card, `改「${card.name}」的${f.name}`, (c) => { c.fields = { ...(c.fields || {}), [f.id]: v }; }, `${f.name}改好了`);
  };
  ta.addEventListener("keydown", (e) => {
    if (composingKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(true); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); go(false); }
  });
  ta.addEventListener("blur", () => go(true));
}

/** 选分类的一排小签：猜的那个排第一 */
function catChips(guess, onPick) {
  const cats = [...(st.meta ? st.meta.cats : [])].sort((a, b) => (b.kind === guess) - (a.kind === guess) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return h("div.nm-cats", { role: "group", "aria-label": "收进哪个分类" }, ...cats.map((c, i) => {
    const b = h("button.nm-cat" + (i === 0 && guess ? ".guess" : ""), { type: "button", style: "--nm:" + c.color }, h("i", { "aria-hidden": "true" }), c.name);
    b.addEventListener("click", () => onPick(c));
    return b;
  }));
}

async function candPop(anchor, name) {
  if (!st.meta) st.meta = await readMeta(st.bookId);
  const c = st.cands.find((x) => x.name === name) || { name, kind: null };
  const input = h("input.input.nm-name-in", { value: name, "aria-label": "名字（可以改一下再收）", maxlength: 20 });
  const ign = h("button.btn.small.ghost", { type: "button", title: "以后不再标这个名字" }, "忽略");
  ign.addEventListener("click", async () => { closePop(); await ignore([name]); toast(`以后不标「${name}」了。名字面板里能取消忽略。`); });
  const drop = h("button.btn.small.ghost", { type: "button", title: "从疑似名单里拿掉（下次找名字还可能找到）" }, "移出名单");
  drop.addEventListener("click", async () => { closePop(); await saveCands(st.cands.filter((x) => x.name !== name)); });
  const pick = (cat) => {
    const n = input.value.trim();
    if (!n) { input.focus(); return; }
    if (known(n)) { toast(`「${n}」已经在设定库里了`); return; }
    closePop();
    archive([{ name: n, catId: cat.id }]).then(() => { if (n !== name) saveCands(st.cands.filter((x) => x.name !== name)); });
  };
  openPop(anchor, ".nm-cand", [
    h("p.nm-pop-q", {}, h("b", {}, "「" + name + "」"), "不在设定库里", c.n ? h("span.nm-count", {}, `　找到 ${c.n} 次${c.src === "ai" ? " · AI 找的" : ""}`) : null),
    input,
    h("p.nm-pop-sub", {}, "名字不对可以先改，再点一个分类收进去。"),
    catChips(c.kind, pick),
    h("div.nm-pop-foot", {}, drop, ign),
  ]);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composingKey(e)) { e.preventDefault(); const first = pop && pop.el.querySelector(".nm-cat"); if (first) first.click(); } });
}

/** 正文里选中一段 →「收入设定库」：名字可以改一下，再挑分类 */
async function archiveSelection(o = {}) {
  if (!ws.book || !ws.editor) { toast("先打开一本书"); return; }
  if (st.bookId !== ws.book.id) await load(ws.book.id);
  if (!st.meta) st.meta = await readMeta(ws.book.id);
  const v = ws.editor.view;
  const sel = v.state.selection.main;
  const raw = o.text != null ? o.text : v.state.sliceDoc(sel.from, sel.to);
  const name = raw.replace(/[\s「」『』“”"《》【】，。！？：；、]/g, "").slice(0, 20);
  const r = v.coordsAtPos(sel.from) || v.contentDOM.getBoundingClientRect();
  const anchor = { left: r.left, right: r.right || r.left, top: r.top, bottom: r.bottom, getBoundingClientRect: null };
  const input = h("input.input.nm-name-in", { value: name, placeholder: "名字", "aria-label": "名字", maxlength: 20 });
  const pick = (cat) => {
    const n = input.value.trim();
    if (!n) { input.focus(); return; }
    if (known(n)) { closePop(); toast(`「${n}」已经在设定库里了`); return; }
    closePop();
    archive([{ name: n, catId: cat.id }], { open: !!o.open });
  };
  openPop(anchor, ".nm-arch", [
    h("p.nm-pop-q", {}, "收进设定库"),
    input,
    catChips(kindOfWord(name) || guessKind(name), pick),
    h("p.nm-pop-sub", {}, "点一个分类就建好，卡片里的格子以后慢慢填。"),
  ]);
  input.focus();
  input.select();
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !(e.isComposing || e.keyCode === 229)) { e.preventDefault(); const first = pop && pop.el.querySelector(".nm-cat"); if (first) first.click(); } });
}
/** 只凭字面猜分类（地名、门派、节日的尾巴） */
function guessKind(name) {
  const tail = name.slice(-1);
  if ("城镇村寨峰岭谷崖岛洲州郡国宫殿阁楼府寺庙关港山河江湖海林原塔".includes(tail)) return "place";
  if ("宗派帮盟门教会堂".includes(tail)) return "faction";
  if ("节祭".includes(tail)) return "festival";
  if ("剑刀枪丹珠镜".includes(tail)) return "item";
  return "person";
}

// ---------------- 找新名字 ----------------
async function chapterTexts(scope) {
  if (scope === "book") return ws.chapters.map((c) => (ws.current && c.id === ws.current.id && ws.editor ? ws.editor.getText() : c.content || "")).join("\n");
  return ws.editor ? ws.editor.getText() : "";
}
function knownSet() {
  const s = new Set(st.ignore);
  st.terms.forEach((t) => { s.add(t.name); (t.aliases || []).forEach((a) => s.add(a)); });
  return s;
}
async function mergeCands(found, src) {
  const now = Date.now();
  const map = new Map(st.cands.map((c) => [c.name, c]));
  let added = 0;
  for (const f of found) {
    if (st.ignore.has(f.name) || known(f.name)) continue;
    if (!map.has(f.name)) added++;
    map.set(f.name, { ...(map.get(f.name) || {}), name: f.name, kind: f.kind || (map.get(f.name) || {}).kind || guessKind(f.name), n: f.n || (map.get(f.name) || {}).n || 0, src, at: now });
  }
  await saveCands([...map.values()]);
  return added;
}
async function scanLocal(scope = "chapter") {
  if (!ws.book) { toast("先打开一本书"); return 0; }
  if (st.bookId !== ws.book.id) await load(ws.book.id);
  const text = await chapterTexts(scope);
  const found = localFind(text, knownSet());
  const added = await mergeCands(found, "local");
  toast(found.length ? `本地找到 ${found.length} 个疑似名字${added ? `，新的 ${added} 个` : ""}，正文里用虚线标出来了。` : "本地没找到新名字。可以试试「AI 找新名字」。");
  bus.emit("names:found", { bookId: st.bookId });
  return found.length;
}
async function scanAI() {
  if (!ws.book || !ws.current) { toast("先打开一本书"); return; }
  if (st.bookId !== ws.book.id) await load(ws.book.id);
  const text = ws.editor.getText();
  if (!text.trim()) { toast("这一章还没有字"); return; }
  const r = await runAI({
    feature: "names", bookId: ws.book.id, ref: ws.current.id, input: text, inputLabel: "本章正文", title: "找新名字",
    vars: ws.varsFor ? ws.varsFor() : {},
  });
  if (!r || !r.text) return;
  const found = parseNames(r.text, text).filter((x) => !known(x.name) && !st.ignore.has(x.name))
    .map((x) => ({ ...x, kind: x.kind || guessKind(x.name), n: text.split(x.name).length - 1 }));
  const added = await mergeCands(found, "ai");
  toast(found.length ? `AI 找到 ${found.length} 个设定库里没有的名字${added ? `（新的 ${added} 个）` : ""}，在名字面板里挑着收。` : "AI 的回答里没认出新名字。回答里一行写一个「名字｜分类」最好认。");
  bus.emit("names:found", { bookId: st.bookId });
  if (found.length) openNames();
}

// ---------------- 名字面板 ----------------
let panel = null;
function openNames() {
  if (!ws.book || !ws.els()) { toast("先打开一本书"); return; }
  const p = ws.openPanel({ title: "名字", render: (body) => { body.classList.add("nm-panel"); panel = { body }; renderPanel(); }, onClose: () => { panel = null; } });
  panel = { body: p.body, close: p.close };
  tip("names", "设定库里的名字会按分类上色，点一下能看、能改。虚线是疑似新名字，点一下收进设定库。");
}
async function renderPanel() {
  if (!panel || !ws.book) return;
  if (st.bookId !== ws.book.id) await load(ws.book.id);
  const body = panel.body;
  const text = ws.editor ? ws.editor.getText() : "";
  const here = [...countTerms(st.matcher, text).values()].sort((a, b) => b.n - a.n);
  const candHere = st.cands.map((c) => ({ ...c, here: text.split(c.name).length - 1 })).sort((a, b) => b.here - a.here || (b.n || 0) - (a.n || 0));
  const scroll = body.scrollTop;
  const sec = (title, n, ...kids) => h("section.nm-sec", {}, h("h4.nm-sec-t", {}, title, n != null ? h("span.nm-n", {}, String(n)) : null), ...kids);

  const termItem = (x) => {
    const b = h("button.nm-item", { type: "button", style: "--nm:" + x.term.color, title: "看这张卡、改、删" },
      h("i.nm-dot", { "aria-hidden": "true" }), h("span.nm-item-n", {}, x.term.name), h("span.nm-item-c", {}, x.term.cat), h("span.nm-item-x", {}, "×" + x.n));
    b.addEventListener("click", () => termPop(b, x.term.id, { pinned: true }));
    const go = h("button.icon-btn.nm-go-text", { type: "button", title: "跳到正文里第一次出现的地方", "aria-label": "跳到「" + x.term.name + "」" }, icon("search"));
    go.addEventListener("click", () => ws.editor.select(x.first, x.first + x.term.name.length));
    return h("div.nm-li", {}, b, go);
  };

  const picks = new Map(candHere.map((c) => [c.name, c.kind || guessKind(c.name)]));
  const catSel = (c) => {
    const s = h("select.select.nm-kind", { "aria-label": "「" + c.name + "」收进哪个分类" },
      ...(st.meta ? st.meta.cats : []).map((cat) => h("option", { value: cat.kind + "|" + cat.id, selected: cat.kind === picks.get(c.name) }, cat.name)));
    s.addEventListener("change", () => picks.set(c.name, s.value.split("|")[0]));
    return s;
  };
  const candItem = (c) => {
    const go = h("button.btn.small.nm-go", { type: "button" }, "收进");
    const no = h("button.btn.small.ghost.nm-no", { type: "button" }, "忽略");
    const sel = catSel(c);
    const nameIn = h("input.nm-cand-in", { value: c.name, "aria-label": "名字（可以改）", maxlength: 20, title: "名字不对可以直接改" });
    go.addEventListener("click", async () => {
      const n = nameIn.value.trim();
      if (!n) return;
      if (known(n)) { toast(`「${n}」已经在设定库里了`); return; }
      const [kind, catId] = sel.value.split("|");
      await archive([{ name: n, kind, catId }]);
      if (n !== c.name) saveCands(st.cands.filter((x) => x.name !== c.name));
    });
    no.addEventListener("click", () => ignore([c.name]));
    const jump = h("button.icon-btn.nm-go-text", { type: "button", title: c.here ? "跳到正文里" : "这一章没出现", "aria-label": "跳到「" + c.name + "」", disabled: !c.here }, icon("search"));
    jump.addEventListener("click", () => { const i = text.indexOf(c.name); if (i >= 0) ws.editor.select(i, i + c.name.length); });
    return h("div.nm-cli", {}, nameIn, h("span.nm-item-x", {}, c.here ? "×" + c.here : "别章"), c.src === "ai" ? h("span.nm-src", { title: "AI 找到的" }, "AI") : jump, sel, go, no);
  };
  const localB = h("button.btn.small", { type: "button", title: "按「某某说」和地名、门派、节日的尾巴找，不花 token，可能不准" }, icon("search"), "本地找一找");
  localB.addEventListener("click", async () => { await scanLocal(scopeSel.value); renderPanel(); });
  const scopeSel = h("select.select.nm-scope", { "aria-label": "找的范围" }, h("option", { value: "chapter" }, "本章"), h("option", { value: "book" }, "全书"));
  const aiB = h("button.btn.small.primary", { type: "button", title: "把这一章发给 AI 找人名、地名、物品、节日（会先让你确认）" }, icon("chat"), "AI 找新名字");
  aiB.addEventListener("click", () => scanAI());
  const allB = h("button.btn.small", { type: "button" }, "全部收进");
  allB.addEventListener("click", () => {
    const rowsEl = [...body.querySelectorAll(".nm-cli")];
    const items = rowsEl.map((r) => { const n = r.querySelector(".nm-cand-in").value.trim(); const [kind, catId] = r.querySelector("select").value.split("|"); return { name: n, kind, catId }; })
      .filter((x) => x.name && !known(x.name));
    archive(items).then(() => saveCands(st.cands.filter((x) => !candHere.some((c) => c.name === x.name))));
  });
  const ignored = [...st.ignore];
  const ignBox = h("details.nm-ign", {}, h("summary", {}, `忽略过的 ${ignored.length} 个`),
    ...ignored.map((n) => { const b = h("button.btn.small.ghost", { type: "button" }, "取消忽略"); b.addEventListener("click", () => unignore(n)); return h("div.nm-ign-li", {}, h("span", {}, n), b); }));

  const marks = h("input", { type: "checkbox", checked: st.marksOn });
  marks.addEventListener("change", () => setPref("names:marks", marks.checked));
  const dash = h("input", { type: "checkbox", checked: st.candsOn });
  dash.addEventListener("change", () => setPref("names:cands", dash.checked));

  body.replaceChildren(...[
    h("div.nm-switches", {}, h("label.check.switch", {}, marks, h("span", {}, "正文标色")), h("label.check.switch", {}, dash, h("span", {}, "虚线标出疑似新名字"))),
    sec("这一章出现的", here.length,
      here.length ? h("div.nm-list", {}, ...here.map(termItem))
        : h("p.nm-empty", {}, st.terms.length ? "这一章还没写到设定库里的名字。" : "设定库还是空的。在正文里选中一个名字，点「收入设定库」就能建卡。")),
    sec("疑似新名字", candHere.length,
      h("div.nm-tools", {}, scopeSel, localB, aiB),
      candHere.length ? h("div.nm-list", {}, ...candHere.map(candItem)) : h("p.nm-empty", {}, "还没有。点「本地找一找」（免费，可能不准）或「AI 找新名字」（要确认才发）。"),
      candHere.length > 1 ? h("div.nm-all", {}, allB) : null),
    ignored.length ? ignBox : null,
    h("p.nm-note", {}, "两个字以上的名字和别名才会上色。在正文里选中一段，AI 工具栏「更多」里也能收入设定库。"),
  ].filter(Boolean));
  body.scrollTop = scroll;
}
async function setPref(key, on) {
  await db.setKV(key, on);
  await load(st.bookId);
  renderPanel();
}

// ---------------- 状态栏 ----------------
let statusEl = null;
function updateStatus() {
  const bar = document.querySelector(".ws .statusbar");
  if (!bar || !ws.book || !ws.editor) return;
  if (!statusEl || !statusEl.isConnected) {
    statusEl = h("button.nm-status", { type: "button", title: "名字：这一章出现了谁、疑似新名字" });
    statusEl.addEventListener("click", openNames);
    const spacer = bar.querySelector(".spacer");
    bar.insertBefore(statusEl, spacer || null);
  }
  const text = ws.editor.getText();
  const n = st.matcher ? countTerms(st.matcher, text).size : 0;
  const c = st.candMatcher ? countTerms(st.candMatcher, text).size : 0;
  statusEl.replaceChildren(h("i.nm-status-dot", { "aria-hidden": "true" }), `名字 ${n}`, c ? h("span.nm-status-new", {}, `新 ${c}`) : "");
  if (panel) renderPanel();
}

// ---------------- 注册 ----------------
export async function register() {
  FEATURES.names = "找新名字";
  addEditorExtension([plugin, events]);
  bus.on("typing:input", () => { lastKey = Date.now(); clearTimeout(hoverTimer); });
  bus.on("chapter:opened", () => { closePop(); if (ws.book && ws.book.id !== st.bookId) load(ws.book.id); else { redraw(); setTimeout(updateStatus, 0); } });
  bus.on("lore:changed", ({ bookId }) => { if (bookId === st.bookId) load(bookId); });
  bus.on("kv:changed", ({ key }) => { if (String(key).startsWith("names:") && st.bookId) load(st.bookId); });
  bus.on("book:deleted", () => { st.bookId = null; });
  commands.register({ id: "names.panel", title: "名字（本章出现了谁、找新名字）", keywords: "名字 人名 地名 物品 节日 标色 高亮 新名字 找名字 设定库 建档", hint: "设定库里的名字在正文里上色，虚线是疑似新名字", when: () => !!ws.book, run: openNames });
  commands.register({ id: "names.archive", title: "收入设定库", keywords: "收入设定库 建档 加进设定库 新名字 人名 地名 物品 节日 收进", hint: "把正文里选中的名字建成设定卡", when: () => !!ws.book && !!ws.editor, run: (o) => archiveSelection(o || {}) });
  commands.register({ id: "names.local", title: "本地找新名字", keywords: "找名字 新名字 人名 地名 不花钱 本地", hint: "不花 token，可能不准", when: () => !!ws.book, run: () => scanLocal("chapter") });
  commands.register({ id: "names.ai", title: "AI 找新名字", keywords: "找名字 新名字 人名 地名 物品 节日 AI 扫描", hint: "把这一章发给 AI 找设定库里没有的名字（要确认）", when: () => !!ws.book, run: scanAI });
  commands.register({ id: "names.toggle", title: "正文标色（开 / 关）", keywords: "标色 高亮 名字 颜色 关掉", hint: "设定库里的名字在正文里按分类上色", run: async () => { const on = !(await db.getKV("names:marks", true) !== false); await db.setKV("names:marks", on); bus.emit("kv:changed", { key: "names:marks" }); toast(on ? "正文标色：开" : "正文标色：关"); } });
  if (ws.book) load(ws.book.id);
}
