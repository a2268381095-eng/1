// 选中即调用：在正文里选中文字，旁边浮出小工具栏，列出作者自己的提示词（软件不带任何提示词）。
// 点一个 → 确认卡 → 结果流式进对比面板（compare.js），挑好了「完成」写回，一步撤销。
// 工具栏不挡选区，Esc 或点别处收起，打字时不出来；「选中时自动弹出」可以关，关了用 Ctrl+Shift+A 手动弹。
import { ws } from "../editor/workspace.js";
import { addEditorExtension } from "../editor/editor.js";
import { commands, keyOf, prettyKey } from "../../core/commands.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { listPrompts } from "../../core/prompts.js";
import { h, icon, toast, pushLayer, choose } from "../../core/ui.js";
import { label } from "../../core/settings.js";
import { tip } from "../demon/demon.js";
import { editorExtensions, refreshMarks, setMarksOn } from "./marks.js";
import { openCompare, startRun, currentCompare, fitAI } from "./compare.js";
import { prefs, loadPrefs, setPref, draftOf, dropDraft } from "./prefs.js";

const SHOWN = 6;          // 工具栏上直接列几个提示词，其余在「更多」里
let bar = null;           // 浮着的工具栏 { el, layer, from, to, chapterId }
let showTimer = 0;
let pointerDown = false, pendingPointer = false, lastType = 0;

const inBook = () => !!(ws.book && ws.current && ws.editor);
/** 只给选中调用用的提示词排前面（别的功能存进来的放「更多」里），其余照 listPrompts 的顺序 */
const orderPrompts = (list) => [...list.filter((p) => !p.feature || p.feature === "rewrite"), ...list.filter((p) => p.feature && p.feature !== "rewrite")];

function canShow(manual) {
  if (!inBook() || currentCompare()) return false;
  const els = ws.els();
  if (!els || els.center.classList.contains("fmt-on")) return false;
  if (document.querySelector(".modal-back")) return false;
  const v = ws.editor.view;
  if (!manual && (!prefs.auto || !v.hasFocus || v.composing || Date.now() - lastType < 350)) return false;
  return true;
}

function selection() {
  const v = ws.editor.view;
  const { from, to } = v.state.selection.main;
  return { from, to, input: v.state.sliceDoc(from, to), chapterId: ws.current.id, bookId: ws.book.id };
}

// ---------------- 工具栏 ----------------
function hideBar() {
  clearTimeout(showTimer);
  if (bar) bar.layer.close(true);
}

async function showBar({ manual = false } = {}) {
  if (!inBook()) return;
  if (manual && currentCompare()) { currentCompare().focus(); toast("先把这次的对比做完"); return; }
  const sel = selection();
  if (sel.from === sel.to || !sel.input.trim()) { if (manual) toast("先在正文里选中一段文字"); return; }
  const prompts = orderPrompts(await listPrompts());
  if (!inBook()) return;
  const now = ws.editor.view.state.selection.main;
  if (now.from !== sel.from || now.to !== sel.to || ws.current.id !== sel.chapterId) return;
  if (!canShow(manual)) return;
  hideBar();

  const btn = (cls, text, title, run) => {
    const b = h("button" + cls, { type: "button", title: title || null }, text);
    b.addEventListener("click", run);
    return b;
  };
  const el = h("div.rw-bar", { role: "toolbar", "aria-label": "AI 工具栏" });
  const menu = h("div.rw-menu.rw-bar-menu", { hidden: true, role: "menu" });
  const openMenu = (items, anchor) => {
    if (!menu.hidden && menu._anchor === anchor) { menu.hidden = true; return; }
    menu.replaceChildren(...items);
    menu._anchor = anchor;
    menu.hidden = false;
    const r = el.getBoundingClientRect();
    menu.classList.toggle("up", r.bottom + 260 > innerHeight && r.top > 260);
  };
  const draft = draftOf(sel.chapterId);
  const main = h("div.rw-bar-main");
  if (draft) main.append(btn(".rw-chip.rw-resume", "接着上次", "上次没做完的对比", () => { hideBar(); resume(); }));
  if (!prompts.length) {
    main.append(btn(".rw-chip.rw-write", "写一个提示词", "软件不带提示词，写一个自己的", async () => {
      hideBar();
      if (!commands.get("prompts.manage")) { startRun(sel, { temp: true }); return; }
      await commands.run("prompts.manage", { feature: "rewrite" });
      if ((await listPrompts()).length && inBook()) showBar({ manual: true });
    }));
  } else {
    prompts.slice(0, SHOWN).forEach((p) => main.append(btn(".rw-chip", p.name, (p.group ? p.group + " / " : "") + (p.text || "").slice(0, 80), () => run(sel, p.id))));
    if (prompts.length > SHOWN) {
      const more = btn(".rw-chip.rw-more", "更多", `还有 ${prompts.length - SHOWN} 个提示词`, () =>
        openMenu(prompts.slice(SHOWN).map((p) => btn(".rw-menu-i", (p.group ? p.group + " / " : "") + p.name, (p.text || "").slice(0, 80), () => run(sel, p.id))), more));
      more.setAttribute("aria-haspopup", "menu");
      main.append(more);
    }
    main.append(btn(".rw-chip.rw-temp", "临时写一个", "这次临时写几句话给 AI", () => run(sel, null, true)));
  }
  const stashB = btn(".rw-ico.rw-bar-stash", label("暂存盒"), "这一章选中调用的结果", () => { hideBar(); openStash(sel); });
  const moreB = h("button.icon-btn.rw-ico.rw-bar-opts", { type: "button", title: "更多设置", "aria-label": "更多设置", "aria-haspopup": "menu" }, icon("more"));
  moreB.addEventListener("click", () => openMenu(optionItems(), moreB));
  const x = h("button.icon-btn.rw-ico.rw-bar-x", { type: "button", title: "收起（Esc）", "aria-label": "收起" }, icon("close"));
  x.addEventListener("click", () => hideBar());
  el.append(h("span.rw-bar-mark", { "aria-hidden": "true" }), main, h("span.rw-bar-sep"), stashB, moreB, x, menu);
  // 点工具栏不抢走正文里的选区
  el.addEventListener("mousedown", (e) => { if (!e.target.closest("input, label")) e.preventDefault(); });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const items = [...el.querySelectorAll("button:not([hidden])")].filter((b) => b.offsetParent);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length].focus();
  });
  document.body.append(el);

  const scroller = ws.editor.view.scrollDOM;
  const onScroll = () => requestAnimationFrame(() => place());
  scroller.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  const layer = pushLayer({
    onClose: () => {
      el.remove();
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (bar && bar.el === el) bar = null;
    },
  });
  bar = { el, layer, from: sel.from, to: sel.to, chapterId: sel.chapterId };
  place();
  if (manual) { const f = el.querySelector(".rw-chip, .rw-ico"); if (f) f.focus(); }
  tip("rewrite-bar", "选中文字会浮出这条 AI 工具栏，里面是你自己写的提示词。点一个，结果在原地对比，挑好了点「完成」。");
}

/** 放在选区上面；上面没地方就放下面；都没地方就贴着正文区底边 */
function place() {
  if (!bar || !inBook()) return;
  const v = ws.editor.view, el = bar.el;
  const sr = v.scrollDOM.getBoundingClientRect();
  const a = v.coordsAtPos(Math.min(bar.from, v.state.doc.length)), b = v.coordsAtPos(Math.min(bar.to, v.state.doc.length), -1);
  const w = el.offsetWidth, hgt = el.offsetHeight;
  if (!a && !b) { el.style.visibility = "hidden"; return; }
  el.style.visibility = "";
  let top, left;
  const topLine = a ? a.top : sr.top, bottomLine = b ? b.bottom : sr.bottom;
  if (a && topLine - hgt - 8 >= Math.max(sr.top, 4)) { top = topLine - hgt - 8; left = a.left; el.dataset.side = "up"; }
  else if (b && bottomLine + hgt + 8 <= Math.min(sr.bottom, innerHeight - 4)) { top = bottomLine + 8; left = b.left - w / 2; el.dataset.side = "down"; }
  else { top = Math.min(sr.bottom, innerHeight) - hgt - 10; left = (a || b).left; el.dataset.side = "pin"; }
  if (topLine > sr.bottom || bottomLine < sr.top) { el.style.visibility = "hidden"; return; }
  left = Math.max(8, Math.min(left - 12, innerWidth - w - 8));
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(Math.max(4, top)) + "px";
}

function optionItems() {
  const check = (text, on, change) => {
    const input = h("input", { type: "checkbox", checked: on });
    input.addEventListener("change", () => change(input.checked));
    return h("label.check.rw-menu-c", {}, input, text);
  };
  const item = (text, run) => h("button.rw-menu-i", { type: "button", onclick: run }, text);
  return [
    check("选中时自动弹出", prefs.auto, (on) => setAuto(on)),
    check("AI 改过的段落留淡色标记", prefs.marks, (on) => setMarks(on)),
    item("清除 AI 标记……", () => { hideBar(); clearMarks(); }),
    commands.get("prompts.manage") ? item("管理提示词……", () => { hideBar(); commands.run("prompts.manage", { feature: "rewrite" }); }) : null,
    h("p.rw-menu-note", {}, `手动弹出：${prettyKey(keyOf(commands.get("rewrite.open")) || "Mod-Shift-a")}`),
  ].filter(Boolean);
}

async function setAuto(on) {
  await setPref("auto", !!on);
  toast(on ? "选中文字时会自动弹出 AI 工具栏" : `不自动弹了。要用时按 ${prettyKey(keyOf(commands.get("rewrite.open")) || "Mod-Shift-a")}`);
}
async function setMarks(on) {
  await setPref("marks", !!on);
  setMarksOn(on);
  toast(on ? "AI 改过的段落会留淡色标记" : "不显示 AI 标记了");
}

async function run(sel, promptId, temp = false) {
  hideBar();
  await startRun(sel, { promptId, temp });
}

function openStash(sel) {
  if (!commands.get("stash.drawer")) { toast(label("暂存盒") + "还没装好"); return; }
  commands.run("stash.drawer", {
    feature: "rewrite", bookId: sel.bookId, ref: sel.chapterId, title: "这一章的选中调用",
    onUse: (row) => useStashRow(row, sel),
  });
}

/** 暂存盒里的一条拿来再对比：对比开着就加一版，没开就对着它当时的原文（找不到就对着现在选中的）打开 */
function useStashRow(row, sel) {
  if (!row || !row.text) return;
  const c = currentCompare();
  if (c) { c.useStash(row); return; }
  if (!inBook() || ws.current.id !== sel.chapterId) { toast("先回到那一章再用"); return; }
  let ctx = sel;
  const text = ws.textOf(sel.chapterId);
  if (row.input && row.input.length < 4000 && row.input !== sel.input) {
    const i = text.indexOf(row.input);
    if (i >= 0 && text.indexOf(row.input, i + 1) < 0) ctx = { ...sel, from: i, to: i + row.input.length, input: row.input };
  }
  if (text.slice(ctx.from, ctx.to) !== ctx.input) { toast("原文找不到了，选中要对比的文字再试"); return; }
  const p = openCompare(ctx);
  if (p) p.addVersion({ text: fitAI(row.text, ctx.input), sent: row.prompt || "", stashId: row.id, model: row.model || "", choice: null });
}

/** 接着上次留下的草稿 */
async function resume() {
  if (!inBook()) return;
  const d = draftOf(ws.current.id);
  if (!d) { toast("这一章没有没做完的对比"); return; }
  const text = ws.textOf(d.chapterId);
  let from = d.from, to = d.to, lost = false;
  if (text.slice(from, to) !== d.input) {
    const i = text.indexOf(d.input);
    if (i >= 0 && text.indexOf(d.input, i + 1) < 0) { from = i; to = i + d.input.length; }
    else lost = true;
  }
  const p = openCompare({ chapterId: d.chapterId, bookId: d.bookId, from, to, input: d.input }, { orig: d.orig, versions: d.versions, picks: d.picks, view: d.view, lost });
  if (p) await dropDraft(d.chapterId);
}

// ---------------- 清除 AI 标记 ----------------
async function clearMarks() {
  if (!inBook()) return;
  const scope = await choose({
    title: "清除 AI 标记",
    body: "去掉 AI 改过的段落上的淡色底，正文不变。",
    buttons: [{ id: "ch", label: "本章", primary: true }, { id: "book", label: "全书" }, { id: "cancel", label: "取消" }],
  });
  if (scope !== "ch" && scope !== "book") return;
  const list = (scope === "ch" ? ws.chapters.filter((c) => c.id === ws.current.id) : ws.chapters).filter((c) => (c.aiParas || []).length);
  if (!list.length) { toast(scope === "ch" ? "这一章没有 AI 标记" : "这本书没有 AI 标记"); return; }
  const before = list.map((c) => [c.id, c.aiParas.slice()]);
  const apply = async (pairs) => { for (const [id, v] of pairs) await ws.patchChapter(id, { aiParas: v }); refreshMarks(); };
  const cleared = before.map(([id]) => [id, []]);
  await apply(cleared);
  const n = before.reduce((s, [, v]) => s + v.length, 0);
  const entry = appUndo.push({ label: "清除 AI 标记", undo: () => apply(before), redo: () => apply(cleared) });
  toast(`已清除 ${n} 段的 AI 标记`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
}

// ---------------- 选区变化：什么时候弹、什么时候收 ----------------
function watcher(u) {
  if (u.docChanged) {
    if (u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete"))) lastType = Date.now();
    clearTimeout(showTimer);
    pendingPointer = false;
    if (bar) hideBar();
    return;
  }
  if (!u.selectionSet) return;
  const { from, to } = u.state.selection.main;
  if (bar && (bar.from !== from || bar.to !== to)) hideBar();
  clearTimeout(showTimer);
  if (from === to || !u.transactions.some((t) => t.isUserEvent("select"))) { pendingPointer = false; return; }
  const pointer = u.transactions.some((t) => t.isUserEvent("select.pointer"));
  if (pointer && pointerDown) { pendingPointer = true; return; }
  showTimer = setTimeout(() => autoShow(), pointer ? 220 : 650);
}
function autoShow() {
  if (!prefs.auto || !inBook()) return;
  const { from, to } = ws.editor.view.state.selection.main;
  if (from === to || (bar && bar.from === from && bar.to === to)) return;
  showBar({ manual: false });
}

// ---------------- 登记 ----------------
export async function register() {
  await loadPrefs();
  setMarksOn(prefs.marks);
  addEditorExtension(editorExtensions(watcher));

  document.addEventListener("pointerdown", (e) => {
    if (bar && !bar.el.contains(e.target)) hideBar();
    pointerDown = !!(e.target && e.target.closest && e.target.closest(".ed-host .cm-content"));
  }, true);
  window.addEventListener("pointerup", () => {
    if (!pointerDown) return;
    pointerDown = false;
    if (pendingPointer) { pendingPointer = false; clearTimeout(showTimer); showTimer = setTimeout(() => autoShow(), 220); }
  }, true);

  bus.on("chapter:opened", ({ chapter }) => {
    hideBar();
    const c = currentCompare();
    if (c && chapter && c.chapterId !== chapter.id) c.autoClose();
    refreshMarks();
  });
  bus.on("route", ({ name }) => {
    hideBar();
    const c = currentCompare();
    if (c && name !== "book") c.autoClose();
  });
  bus.on("rewrite:prefs", async () => { await loadPrefs(); setMarksOn(prefs.marks); });

  const when = () => !!ws.book;
  // 覆盖 features/ai 里的简单版（后登记的生效）
  commands.register({ id: "ai.rewrite", title: "用 AI 处理选中的文字", keywords: "AI 改写 润色 扩写 选中 调用 提示词 工具栏", hint: "选中一段，浮出提示词工具栏", key: "Mod-j", when, run: () => showBar({ manual: true }) });
  commands.register({ id: "rewrite.open", title: "对选中的文字用 AI", keywords: "AI 工具栏 选中 调用 提示词 手动", hint: "手动弹出 AI 工具栏", key: "Mod-Shift-a", when, run: () => showBar({ manual: true }) });
  commands.register({ id: "rewrite.clearMarks", title: "清除 AI 标记", keywords: "AI 标记 淡色 段落 改过 清除", hint: "本章或全书，可以撤销", when, run: clearMarks });
  commands.register({ id: "rewrite.auto", title: "选中文字时自动弹出 AI 工具栏", keywords: "AI 工具栏 自动 弹出 开关", hint: "开 / 关", run: () => setAuto(!prefs.auto) });
  commands.register({ id: "rewrite.marks", title: "AI 改过的段落留标记", keywords: "AI 标记 淡色 开关", hint: "开 / 关", run: () => setMarks(!prefs.marks) });
  commands.register({ id: "rewrite.resume", title: "接着上次的 AI 对比", keywords: "AI 对比 草稿 继续", hint: "这一章没做完的对比", when: () => !!(ws.book && ws.current && draftOf(ws.current.id)), run: resume });
}
