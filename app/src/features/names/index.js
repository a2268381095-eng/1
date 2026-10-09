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
import { readMeta, getMeta, listCards, getCard, catOf, findCat, newCard, change, fieldByKey, valueOf, levelAt, levelIndex } from "../../core/lore.js";
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

const clicks = EditorView.domEventHandlers({
  click(e, view) {
    if (e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
    const el = e.target.closest && e.target.closest(".nm-t, .nm-c");
    if (!el || !view.state.selection.main.empty) return false;
    setTimeout(() => (el.classList.contains("nm-c") ? candPop(el, el.dataset.nmc) : termPop(el, el.dataset.nm)), 0);
    return false;
  },
});

// ---------------- 小卡片（浮在名字旁边） ----------------
let pop = null;
function closePop() { if (pop) pop.layer.close(true); }
function openPop(anchor, cls, content) {
  closePop();
  const el = h("div.nm-pop" + cls, { role: "dialog" }, ...content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let top = r.bottom + 8, side = "down";
  if (top + hgt > innerHeight - 8 && r.top - hgt - 8 > 8) { top = r.top - hgt - 8; side = "up"; }
  el.style.left = Math.round(Math.max(8, Math.min(r.left - 16, innerWidth - w - 8))) + "px";
  el.style.top = Math.round(Math.max(8, Math.min(top, innerHeight - hgt - 8))) + "px";
  el.dataset.side = side;
  const onDown = (ev) => { if (!el.contains(ev.target)) layer.close(true); };
  const offType = bus.on("typing:input", () => layer.close(true));
  setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
  const layer = pushLayer({ onClose: () => { el.remove(); document.removeEventListener("pointerdown", onDown, true); if (typeof offType === "function") offType(); if (pop && pop.el === el) pop = null; } });
  pop = { el, layer };
  return el;
}

const chapterNo = () => (ws.current ? ws.chapters.findIndex((c) => c.id === ws.current.id) + 1 : 0);

async function termPop(anchor, id) {
  const card = await getCard(id);
  if (!card || !st.bookId) return;
  const meta = await readMeta(st.bookId);
  const cat = catOf(meta, card);
  const cards = await listCards(st.bookId);
  const idxOf = (cid) => ws.chapters.findIndex((c) => c.id === cid) + 1;
  const at = chapterNo() || null;
  const thumb = card.img && card.img.thumb ? h("img.nm-pop-pic", { src: card.img.thumb, alt: "" }) : h("span.nm-pop-glyph", { "aria-hidden": "true" }, cat.glyph || "设");
  const rows = [];
  const fieldRow = (f) => {
    const v = valueOf(card, f);
    const val = h("button.nm-val" + (v ? "" : ".empty"), { type: "button", title: "点一下改" }, v || "点击填写");
    val.addEventListener("click", () => editField(val, card, f));
    return h("div.nm-row", {}, h("span.nm-k", {}, f.name), val);
  };
  const fields = cat.kind === "person" ? ["identity", "look", "personality"].map((k) => fieldByKey(cat, k)).filter(Boolean) : (cat.fields || []).filter((f) => f.key !== "notes").slice(0, 3);
  fields.forEach((f) => rows.push(fieldRow(f)));
  if (cat.kind === "person") {
    for (const lad of meta.ladders || []) {
      const s = levelAt(card, lad.id, idxOf, at);
      if (!s) continue;
      const lv = lad.levels[levelIndex(lad, s.levelId)];
      if (lv) rows.push(h("div.nm-row", {}, h("span.nm-k", {}, lad.name), h("span.nm-v", {}, lv.name + (s.no ? `（第 ${s.no} 章起）` : ""))));
    }
    const place = card.placeId && cards.find((c) => c.id === card.placeId);
    if (place) rows.push(h("div.nm-row", {}, h("span.nm-k", {}, "所在地"), h("span.nm-v", {}, place.name)));
    if ((card.traits || []).length) rows.push(h("div.nm-tags", {}, ...card.traits.slice(0, 6).map((t) => h("span.nm-tag", {}, t))));
  }
  const n = ws.editor ? countTerms(st.matcher, ws.editor.getText()).get(card.id) : null;
  const openB = h("button.btn.small.primary", { type: "button" }, icon("lore"), "打开卡片");
  openB.addEventListener("click", () => { closePop(); commands.run("cards.open", { bookId: st.bookId, id: card.id }); });
  const el = openPop(anchor, ".nm-term", [
    h("div.nm-pop-head", { style: "--nm:" + cat.color }, thumb,
      h("div.nm-pop-t", {}, h("b.nm-pop-name", {}, card.name), h("span.nm-chip", {}, h("i", { "aria-hidden": "true" }), cat.name + (card.role ? " · " + card.role : "")),
        (card.aliases || []).length ? h("span.nm-alias", {}, "又叫 " + card.aliases.join("、")) : null)),
    h("div.nm-rows", {}, ...rows),
    h("div.nm-pop-foot", {}, h("span.nm-count", {}, n ? `这一章出现 ${n.n} 次` : ""), openB),
  ]);
  el.style.setProperty("--nm", cat.color);
}

function editField(val, card, f) {
  const ta = h("textarea.nm-edit", { rows: 2, "aria-label": f.name }, valueOf(card, f));
  val.replaceWith(ta);
  ta.focus();
  ta.select();
  let done = false;
  const save = async () => {
    if (done) return;
    done = true;
    const v = ta.value.trim();
    const shown = h("button.nm-val" + (v ? "" : ".empty"), { type: "button", title: "点一下改" }, v || "点击填写");
    shown.addEventListener("click", () => editField(shown, { ...card, fields: { ...card.fields, [f.id]: v } }, f));
    ta.replaceWith(shown);
    if (v === (valueOf(card, f) || "")) return;
    const { entry } = await change(card.bookId, `改「${card.name}」的${f.name}`, async (t) => {
      const c = await t.card(card.id);
      if (c) c.fields = { ...(c.fields || {}), [f.id]: v };
    });
    card.fields = { ...card.fields, [f.id]: v };
    shown.classList.add("nm-saved");
    if (entry) toast(`已改好「${card.name}」的${f.name}`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
  };
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ta.value = valueOf(card, f); save(); }
  });
  ta.addEventListener("blur", save);
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
  const ign = h("button.btn.small.ghost", { type: "button" }, "忽略这个名字");
  ign.addEventListener("click", async () => { closePop(); await ignore([name]); toast(`以后不标「${name}」了。名字面板里能取消忽略。`); });
  openPop(anchor, ".nm-cand", [
    h("p.nm-pop-q", {}, h("b", {}, "「" + name + "」"), "不在设定库里", c.n ? h("span.nm-count", {}, `　找到 ${c.n} 次${c.src === "ai" ? " · AI 找的" : ""}`) : null),
    h("p.nm-pop-sub", {}, "收进哪个分类？"),
    catChips(c.kind, (cat) => { closePop(); archive([{ name, catId: cat.id }]); }),
    h("div.nm-pop-foot", {}, ign),
  ]);
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
    const b = h("button.nm-item", { type: "button", style: "--nm:" + x.term.color, title: "跳到第一次出现的地方" },
      h("i.nm-dot", { "aria-hidden": "true" }), h("span.nm-item-n", {}, x.term.name), h("span.nm-item-c", {}, x.term.cat), h("span.nm-item-x", {}, "×" + x.n));
    b.addEventListener("click", () => { ws.editor.select(x.first, x.first + x.term.name.length); });
    const o = h("button.icon-btn.nm-open", { type: "button", title: "打开卡片", "aria-label": "打开「" + x.term.name + "」的卡片" }, icon("lore"));
    o.addEventListener("click", () => commands.run("cards.open", { bookId: st.bookId, id: x.term.id }));
    return h("div.nm-li", {}, b, o);
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
    go.addEventListener("click", () => { const [kind, catId] = sel.value.split("|"); archive([{ name: c.name, kind, catId }]); });
    no.addEventListener("click", () => ignore([c.name]));
    const nameB = h("button.nm-cand-n", { type: "button", title: c.here ? "跳到正文里" : "这一章没出现" }, c.name);
    nameB.addEventListener("click", () => { if (!c.here) return; const i = text.indexOf(c.name); ws.editor.select(i, i + c.name.length); });
    return h("div.nm-cli", {}, nameB, h("span.nm-item-x", {}, c.here ? "×" + c.here : "别章"), c.src === "ai" ? h("span.nm-src", { title: "AI 找到的" }, "AI") : null, sel, go, no);
  };
  const localB = h("button.btn.small", { type: "button", title: "按「某某说」和地名、门派、节日的尾巴找，不花 token，可能不准" }, icon("search"), "本地找一找");
  localB.addEventListener("click", async () => { await scanLocal(scopeSel.value); renderPanel(); });
  const scopeSel = h("select.select.nm-scope", { "aria-label": "找的范围" }, h("option", { value: "chapter" }, "本章"), h("option", { value: "book" }, "全书"));
  const aiB = h("button.btn.small.primary", { type: "button", title: "把这一章发给 AI 找人名、地名、物品、节日（会先让你确认）" }, icon("chat"), "AI 找新名字");
  aiB.addEventListener("click", () => scanAI());
  const allB = h("button.btn.small", { type: "button" }, "全部收进");
  allB.addEventListener("click", () => {
    const sels = [...body.querySelectorAll(".nm-cli select")];
    archive(candHere.map((c, i) => { const [kind, catId] = (sels[i] ? sels[i].value : "|").split("|"); return { name: c.name, kind, catId }; }));
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
  addEditorExtension([plugin, clicks]);
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
