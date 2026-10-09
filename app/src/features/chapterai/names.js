// AI 起章名：读本章正文出几个候选，在章名下面就地展开（不弹窗），点一个写进章名（可撤销），或者都不要。
// 候选一边生成一边一条条冒出来；这一章以前生成过的在「暂存盒」里，点「列出来挑」放回这里。
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { h, icon, toast, pushLayer } from "../../core/ui.js";
import { label } from "../../core/settings.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { runAI } from "../ai/runner.js";
import { parseNames } from "./logic.js";
import { promptPlan, openStash, flash, motionFull } from "./common.js";

let box = null;        // 展开着的候选列表
let running = null;    // 正在起名的 { chapterId, ctrl }

const titleInput = () => document.querySelector(".ws .ch-title");
const aiBtn = () => document.querySelector(".ws .ch-name-ai");

/** 写进章名，算一步撤销 */
async function setTitle(id, title) {
  const write = async (t) => {
    await ws.patchChapter(id, { title: t });
    const inp = titleInput();
    if (inp && ws.current && ws.current.id === id) { inp.value = t; flash(inp); }
  };
  const before = (ws.chapters.find((c) => c.id === id) || {}).title || "";
  if (before === title) { toast("章名已经是这个了"); return null; }
  await write(title);
  const entry = appUndo.push({ label: "AI 章名", undo: () => write(before), redo: () => write(title) });
  toast(`章名换成「${title}」`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
  return entry;
}

/** force：换章、离开作品时收起（正在生成的不打断，生成完进暂存盒）；作者自己关的会停下正在生成的 */
function closeBox(force) { if (box) { box.forced = !!force; box.layer.close(force); } }

/** 在章名下面展开候选列表。返回控制对象 */
function openBox(chapterId) {
  if (box && box.chapterId === chapterId) return box;
  closeBox(true);
  const els = ws.els();
  if (!els) return null;
  const center = els.center;
  const head = center.querySelector(".ch-head");
  const count = h("span.cai-names-n", { "aria-live": "polite" });
  const stop = h("button.btn.small.ghost.cai-stop", { type: "button", hidden: true }, "停下");
  const again = h("button.btn.small.ghost.cai-again", { type: "button", title: "再让 AI 出一批（会先确认）" }, "再出几个");
  const stashBtn = h("button.btn.small.ghost.cai-stash", { type: "button", title: "这一章以前生成过的章名" }, label("暂存盒"));
  const none = h("button.btn.small.ghost.cai-none", { type: "button" }, "都不要");
  const x = h("button.icon-btn.cai-x", { type: "button", "aria-label": "关闭", title: "关闭（Esc）" }, icon("close"));
  const list = h("div.cai-names-list", { role: "radiogroup", "aria-label": "章名候选" });
  const note = h("p.cai-names-note");
  const el = h("section.cai-names", { "aria-label": "章名候选", "data-state": "busy" },
    h("div.cai-names-head", {}, h("h3.cai-h", {}, "章名候选"), count, h("span.spacer"), stop, again, stashBtn, none, x), list, note);
  head.after(el);

  const me = { chapterId, el, names: [], stopFn: null };
  me.layer = pushLayer({
    onClose: () => {
      if (box === me) box = null;
      if (!me.forced && running && running.chapterId === chapterId) running.ctrl.abort();
      if (motionFull()) {
        el.classList.add("cai-out");
        setTimeout(() => el.remove(), 320);
      } else el.remove();
    },
  });
  x.addEventListener("click", () => me.layer.close());
  none.addEventListener("click", () => { me.layer.close(); if (me.names.length) toast("这批候选留在" + label("暂存盒") + "里"); });
  stop.addEventListener("click", () => { if (me.stopFn) me.stopFn(); });
  again.addEventListener("click", () => nameAI());
  stashBtn.addEventListener("click", () => openStash({
    feature: "chapterName", bookId: ws.book.id, ref: chapterId, title: "章名候选", useLabel: "列出来挑",
    onUse: (row) => {
      const names = parseNames(row.text);
      if (!names.length) { toast("这一条里没拆出章名"); return; }
      const b = ws.current && ws.current.id === chapterId ? openBox(chapterId) : null;
      if (!b) { toast("先回到这一章再挑"); return; }
      b.set(names, "这是以前生成的一批。");
      const d = document.querySelector(".side-right .stash-drawer");
      if (d) ws.closePanel();
      b.focusFirst();
    },
  }));

  // 方向键在候选之间走，回车 / 空格选
  list.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const items = [...list.querySelectorAll(".cai-name")];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    items[n].focus();
  });

  function item(name, i, fresh) {
    const cur = (ws.chapters.find((c) => c.id === chapterId) || {}).title || "";
    const b = h("button.cai-name" + (fresh && motionFull() ? ".cai-in" : ""), { type: "button", role: "radio", "aria-checked": String(cur === name), style: { "--i": String(i) } },
      h("span.cai-name-mark", { "aria-hidden": "true" }), h("span.cai-name-t", {}, name));
    b.addEventListener("click", async () => {
      if (box !== me) return;
      const done = await setTitle(chapterId, name);
      if (done) {
        me.layer.close(true);
        if (ws.editor && ws.current && ws.current.id === chapterId) ws.editor.focus();
      }
    });
    return b;
  }

  /** 流式：已经写完的行先显示出来，新冒出来的带出场动画 */
  me.stream = (text) => {
    el.dataset.state = "busy";
    stop.hidden = false;
    const names = parseNames(text, { partial: true });
    const known = me.names.length;
    if (names.length < known || names.slice(0, known).some((n, i) => n !== me.names[i])) { list.replaceChildren(); me.names = []; }
    names.slice(me.names.length).forEach((n, k) => list.append(item(n, k, true)));
    me.names = names;
    count.textContent = names.length ? `已经想到 ${names.length} 个……` : "正在想……";
    note.textContent = "";
  };
  me.set = (names, msg) => {
    el.dataset.state = "ready";
    stop.hidden = true;
    const old = new Set(me.names);
    me.names = names;
    list.replaceChildren(...names.map((n, i) => item(n, i, !old.has(n))));
    count.textContent = names.length ? `${names.length} 个` : "";
    note.textContent = names.length ? (msg ? msg + " " : "") + "点一个就换上，可以撤销。" : "AI 回的内容里没拆出章名，原文在" + label("暂存盒") + "里。";
  };
  me.busy = (on) => { el.dataset.state = on ? "busy" : "ready"; stop.hidden = !on; if (on && !me.names.length) count.textContent = "正在想……"; };
  me.focusFirst = () => { const f = list.querySelector('.cai-name[aria-checked="true"]') || list.querySelector(".cai-name"); if (f) f.focus(); };
  box = me;
  return me;
}

export async function nameAI() {
  if (!ws.book || !ws.current || !ws.editor) { toast("先打开一章"); return; }
  if (running) {
    if (box && running.chapterId === box.chapterId) toast("正在起名，等它出来");
    else toast("上一章的章名还在生成，等一下再来");
    return;
  }
  const ch = ws.current;
  const text = ws.editor.getText();
  if (!text.trim()) { toast("这一章还没写正文。写几段，AI 才知道起什么名字。"); return; }
  tip("chapterai-name", "我读一遍这章，出几个章名。挑一个点一下就换上，不喜欢就「都不要」。");
  const plan = await promptPlan("chapterName");
  if (!plan) return;
  const ctrl = new AbortController();
  running = { chapterId: ch.id, ctrl };
  const btn = aiBtn();
  if (btn) btn.classList.add("cai-busy");
  if (box && box.chapterId === ch.id) box.busy(true);
  let view = box && box.chapterId === ch.id ? box : null;
  let r = null;
  try {
    r = await runAI({
      feature: "chapterName", simple: true, input: text, inputLabel: "本章正文", vars: ws.varsFor(ch.id),
      ref: ch.id, bookId: ws.book.id, count: 1, maxTokens: 300, promptId: plan.promptId, temp: plan.temp,
      title: ws.fullTitle(ch) + " · 章名候选", signal: ctrl.signal,
      onDelta: (piece, all) => {
        if (ctrl.signal.aborted || !ws.current || ws.current.id !== ch.id) return;
        if (!view || box !== view) { view = openBox(ch.id); if (view) view.stopFn = () => ctrl.abort(); }
        if (view) { view.stopFn = () => ctrl.abort(); view.stream(all); }
      },
    });
  } finally {
    running = null;
    const b = aiBtn();
    if (b) b.classList.remove("cai-busy");
  }
  const here = ws.current && ws.current.id === ch.id;
  if (!r) {
    if (view && box === view) {
      if (ctrl.signal.aborted && view.names.length) view.set(view.names, "停下了，这几个是已经出来的。");
      else if (view.names.length && view.el.dataset.state === "busy") view.busy(false);
      else if (!view.names.length) view.layer.close(true);
    }
    return;
  }
  const names = parseNames(r.text);
  if (!here) {
    toast(`${ws.book ? ws.fullTitle(ch) : "那一章"}的章名候选放进${label("暂存盒")}了`);
    return;
  }
  view = view && box === view ? view : openBox(ch.id);
  if (!view) return;
  view.set(names);
  view.focusFirst();
  bus.emit("chapterai:done", { kind: "chapterName", chapterId: ch.id, count: names.length });
}

export function wireNames() {
  bus.on("chapter:opened", ({ chapter }) => { if (box && (!chapter || chapter.id !== box.chapterId)) closeBox(true); });
  bus.on("route", ({ name }) => { if (name !== "book") closeBox(true); });
}
