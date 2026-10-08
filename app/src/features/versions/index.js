// 历史版本：自动保存时顺手记一版（同一章至少隔 1 分钟），只存改动的部分；旧版本在启动时和每小时合并一次。
// 右侧栏列出本章的版本，点一版就在正文区上面和现在左右对比；「恢复这个版本」算一步，能撤销。
import { ws } from "../editor/workspace.js";
import { bus } from "../../core/bus.js";
import { db, uid } from "../../core/db.js";
import { commands } from "../../core/commands.js";
import { undo as appUndo } from "../../core/undo.js";
import { h, icon, toast, notice, pushLayer, helpTip } from "../../core/ui.js";
import { countWords } from "../../core/text.js";
import { tip } from "../demon/demon.js";
import { MIN_GAP, HOUR, DAY, encode, sortRows, textAt, chainState, compactChain, alignRows, foldRows,
  dayKey, dayLabel, hm, whenLabel } from "./engine.js";

// ---------------- 记录 ----------------
let queue = Promise.resolve();
/** 读写版本表的事排队一件件做，记录和合并不会互相踩 */
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

const heads = new Map();     // chapterId → 链尾 { text, ts, sinceFull }，null 表示还没有版本
const pending = new Map();   // chapterId → { text, timer }：离上一版不到 1 分钟的改动，等够了再记

async function loadRows(id) { return sortRows(await db.byIndex("versions", "chapterId", id)); }

async function headOf(id) {
  if (!heads.has(id)) heads.set(id, chainState(await loadRows(id)));
  return heads.get(id);
}

/** 记一版（要在 serial 里调用）。和上一版一样就不记。 */
async function writeNow(id, text, ts = Date.now(), note = "") {
  const hd = await headOf(id);
  if (hd && hd.text === text) return null;
  if (hd && ts <= hd.ts) ts = hd.ts + 1;
  const enc = encode(hd ? hd.text : null, text, hd ? hd.sinceFull : 0);
  const row = { id: uid("v"), chapterId: id, ts, kind: enc.kind, data: enc.data, words: countWords(text), len: text.length };
  if (note) row.note = note;
  await db.put("versions", row);
  heads.set(id, { text, ts, sinceFull: enc.kind === "full" ? 0 : hd.sinceFull + 1 });
  warned = false;
  changed(id);
  return row;
}

/** 自动保存之后：离上一版够 1 分钟就记；不够就等到够了，记那时最新的正文 */
function onSaved({ chapter, text }) {
  if (!chapter || typeof text !== "string") return;
  const id = chapter.id;
  serial(async () => {
    const hd = await headOf(id);
    const wait = hd ? hd.ts + MIN_GAP - Date.now() : 0;
    if (wait <= 0) { dropPending(id); await writeNow(id, text); return; }
    const p = pending.get(id) || { text, timer: 0 };
    p.text = text;
    if (!p.timer) p.timer = setTimeout(() => firePending(id, p), wait + 20);
    pending.set(id, p);
  }).catch(failed);
}

function firePending(id, p) {
  p.timer = 0;
  serial(async () => {
    if (pending.get(id) !== p) return;
    const hd = await headOf(id);
    const wait = hd ? hd.ts + MIN_GAP - Date.now() : 0;
    if (wait > 0) { p.timer = setTimeout(() => firePending(id, p), wait + 20); return; }
    pending.delete(id);
    await writeNow(id, p.text);
  }).catch(failed);
}

function dropPending(id) {
  const p = pending.get(id);
  if (p) { clearTimeout(p.timer); pending.delete(id); }
}

/** 马上记一版，不管隔没隔 1 分钟（恢复前先存一份现在的正文） */
export function recordNow(id, text, note) { return serial(() => writeNow(id, text, Date.now(), note)); }

/** 还没有版本的章（以前写的、导入的）：先把现有正文记成第一版 */
function baseline(ch, ts) {
  if (!ch || !ch.content) return;
  serial(async () => { if (!(await headOf(ch.id))) await writeNow(ch.id, ch.content, ts || Date.now()); }).catch(failed);
}

let warned = false;
function failed(e) {
  if (warned) return;
  warned = true;
  notice({
    what: "这一版没能记进历史版本。",
    why: "本地存储出错，可能磁盘满了，或者浏览器限制了存储。正文照常保存，没有受影响。",
    detail: e && (e.stack || e.message || e),
  });
}

// ---------------- 合并旧版本 ----------------
/**
 * 按规则合并：24 小时内全留，一周内每小时一份，更早的每天一份。
 * 启动时顺便：给还没有版本的章记第一版；清掉彻底删除（回收站里也没有了）的章留下的版本。
 */
export function maintain({ startup = false } = {}) {
  return serial(async () => {
    const now = Date.now();
    const by = new Map();
    for (const r of await db.all("versions")) {
      if (!by.has(r.chapterId)) by.set(r.chapterId, []);
      by.get(r.chapterId).push(r);
    }
    let removed = 0;
    for (const [id, list] of by) {
      let plan = null;
      try { plan = compactChain(sortRows(list), now); } catch (_) { continue; }   // 读不出来的链先不动
      if (!plan) continue;
      await db.tx(["versions"], (s) => {
        plan.dels.forEach((k) => s.versions.delete(k));
        plan.puts.forEach((r) => s.versions.put(r));
      });
      heads.delete(id);
      removed += plan.dels.length;
      changed(id);
    }
    if (startup) {
      const chapters = await db.all("chapters");
      const alive = new Set(chapters.map((c) => c.id));
      for (const t of await db.all("trash")) {
        const d = t.data || {};
        if (d.chapter) alive.add(d.chapter.id);
        (d.chapters || []).forEach((c) => alive.add(c.id));
      }
      const orphans = [];
      for (const [id, list] of by) if (!alive.has(id) && list.every((r) => now - r.ts > DAY)) orphans.push(...list.map((r) => r.id));
      if (orphans.length) await db.tx(["versions"], (s) => orphans.forEach((k) => s.versions.delete(k)));
      for (const c of chapters) if (c.content && !by.has(c.id)) await writeNow(c.id, c.content, c.updatedAt || now);
    }
    return removed;
  });
}

// ---------------- 面板 ----------------
let P = null;          // 打开着的面板 { id, body, top, list, rows, latest, sel, layer }
let C = null;          // 打开着的对比 { box, layer, row, then, ... }
let foldOn = true;     // 只看改动处
let busy = false;
let reloadTimer = 0;

const wsView = () => { const e = ws.els(); return e ? e.center.closest(".ws") : null; };
function setPressed(on) {
  const b = document.querySelector('.ws .tool-btn[data-cmd="versions.open"]');
  if (b) b.setAttribute("aria-pressed", String(on));
}

let opening = false;
async function openVersions() {
  if (!ws.book || !ws.current || !ws.els()) return;
  if (P) { focusList(); return; }
  if (opening) return;
  opening = true;
  try { await ws.editor.flush(); } catch (_) { /* 保存失败另有提示 */ }
  opening = false;
  if (!ws.current || !ws.els() || P) return;
  const p = ws.openPanel({ title: "历史版本", wide: true, onClose: onPanelClose, render: (body) => body.classList.add("ver-body") });
  const top = h("div.ver-top");
  const list = h("div.ver-list", { role: "listbox", "aria-label": "版本" });
  p.body.append(top, list, h("p.ver-note.muted", {}, "自动保存时记一版，同一章至少隔 1 分钟。只存改动的部分。"));
  P = { id: ws.current.id, body: p.body, top, list, rows: [], latest: null, sel: -1, layer: p.layer, first: true };
  const v = wsView();
  if (v) v.classList.add("has-ver");
  document.body.classList.add("ver-open");
  setPressed(true);
  await reload();
  tip("versions-first", "点一版就能和现在左右对比。不满意可以一键恢复，恢复了也能撤销。");
}

function onPanelClose() {
  if (C) closeCompare(false);
  clearTimeout(reloadTimer);
  const v = wsView();
  if (v) v.classList.remove("has-ver", "ver-cmp");
  document.body.classList.remove("ver-open");
  setPressed(false);
  P = null;
}

/** 版本有变化（记了新的一版、合并过）：面板开着就刷新 */
function changed(id) {
  if (!P || P.id !== id) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reload(), 250);
}

async function reload() {
  if (!P) return;
  const id = P.id;
  let rows;
  try { rows = await serial(() => loadRows(id)); }
  catch (e) {
    notice({
      what: "历史版本读不出来。",
      why: "本地存储出错，可能浏览器限制了存储。现在的正文不受影响。",
      detail: e && (e.stack || e.message || e),
      actions: [{ label: "再试一次", primary: true, run: () => reload() }],
    });
    return;
  }
  if (!P || P.id !== id) return;
  P.rows = rows;
  try { P.latest = rows.length ? textAt(rows, rows.length - 1) : null; } catch (_) { P.latest = null; }
  if (C && C.row) {
    const i = rows.findIndex((r) => r.id === C.row.id);
    P.sel = i;
    if (i < 0) closeCompare(false);
  }
  renderList();
  if (P.first) { P.first = false; focusList(); }
}

function renderList() {
  const { rows, list } = P;
  const ch = ws.chapters.find((c) => c.id === P.id) || ws.current;
  P.top.replaceChildren(
    h("span.ver-ch", {}, ch ? ws.fullTitle(ch) : ""),
    h("span.ver-n", {}, rows.length ? `共 ${rows.length} 版` : ""),
    helpTip("24 小时内每次改动都留；一周内每小时留一份；更早的每天留一份。"));
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.i : null;
  list.textContent = "";
  if (!rows.length) {
    list.append(h("div.empty.ver-empty", {}, "这一章还没有历史版本。", h("br"), "写一会儿就有了：自动保存时会记一版。"));
    return;
  }
  const now = Date.now();
  const nowText = ws.textOf(P.id);
  let day = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (dayKey(r.ts) !== day) { day = dayKey(r.ts); list.append(h("div.ver-day", {}, dayLabel(r.ts, now))); }
    const prev = rows[i - 1];
    const d = prev ? (r.words || 0) - (prev.words || 0) : null;
    const delta = d == null
      ? h("span.ver-delta.first", { title: "最早的一版" }, "最早")
      : h("span.ver-delta" + (d > 0 ? ".up" : d < 0 ? ".down" : ""), { title: d > 0 ? `比上一版多 ${d} 字` : d < 0 ? `比上一版少 ${-d} 字` : "字数和上一版一样" },
        d > 0 ? "+" + d.toLocaleString() : d < 0 ? "−" + (-d).toLocaleString() : "±0");
    const same = i === rows.length - 1 && P.latest != null && P.latest === nowText;
    if (i === rows.length - 1) P.sameShown = same;
    const b = h("button.ver-item" + (i === P.sel ? ".cur" : ""), {
      type: "button", role: "option", "aria-selected": String(i === P.sel), "data-i": String(i),
      "aria-label": `${whenLabel(r.ts, now)}，${(r.words || 0).toLocaleString()} 字`,
    },
    h("span.ver-time", {}, hm(r.ts)),
    r.note ? h("span.chip.ver-tag", {}, r.note) : null,
    same ? h("span.chip.ver-tag.now", {}, "和现在一样") : null,
    h("span.ver-sp"),
    h("span.ver-words", {}, (r.words || 0).toLocaleString() + " 字"),
    delta);
    b.addEventListener("click", () => openCompare(i));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...list.querySelectorAll(".ver-item")];
      const k = items.indexOf(b) + (e.key === "ArrowDown" ? 1 : -1);
      if (!items[k]) return;
      items[k].focus();
      if (C) openCompare(Number(items[k].dataset.i));   // 对比开着时，上下键直接换着看
    });
    list.append(b);
  }
  if (focused != null) { const el = list.querySelector(`.ver-item[data-i="${focused}"]`); if (el) el.focus(); }
}

function focusList() {
  if (!P) return;
  const el = P.list.querySelector(".ver-item.cur") || P.list.querySelector(".ver-item");
  if (el) el.focus();
}

function markSel() {
  if (!P) return;
  P.list.querySelectorAll(".ver-item").forEach((b) => {
    const on = Number(b.dataset.i) === P.sel;
    b.classList.toggle("cur", on);
    b.setAttribute("aria-selected", String(on));
  });
}

/** 换了一章：面板跟着换 */
function follow(chapter) {
  if (!P || !chapter || chapter.id === P.id) return;
  P.id = chapter.id;
  P.sel = -1;
  P.rows = [];
  if (C) closeCompare(false);
  reload();
}

// ---------------- 对比 ----------------
function openCompare(i) {
  if (!P || !P.rows[i]) return;
  const row = P.rows[i];
  let then;
  try { then = textAt(P.rows, i); }
  catch (e) {
    notice({
      what: "这一版读不出来。",
      why: "存这一版的数据可能坏了。其他版本和现在的正文不受影响。",
      detail: e && (e.stack || e.message || e),
    });
    return;
  }
  P.sel = i;
  markSel();
  if (!C) buildCompare();
  Object.assign(C, { row, then });
  renderCompare();
}

function buildCompare() {
  const center = ws.els().center;
  const back = h("button.icon-btn", { type: "button", title: "返回列表（Esc）", "aria-label": "返回" }, icon("back"));
  const x = h("button.icon-btn", { type: "button", title: "关闭（Esc）", "aria-label": "关闭" }, icon("close"));
  const sub = h("span.ver-sub");
  const sum = h("div.ver-sum", { role: "status", "aria-live": "polite" });
  const only = h("input", { type: "checkbox" });
  only.checked = foldOn;
  const restoreBtn = h("button.btn.primary.ver-restore", { type: "button" }, icon("history"), "恢复这个版本");
  const thenHead = h("span.ver-col-name");
  const grid = h("div.ver-grid");
  const box = h("section.ver-overlay", { role: "dialog", "aria-label": "版本对比" },
    h("div.ver-head", {}, back, h("h2", {}, "对比"), sub, x),
    h("div.ver-bar", {}, sum, h("div.ver-btns", {}, h("label.check.ver-only", {}, only, "只看改动处"), restoreBtn)),
    h("div.ver-scroll", {},
      h("div.ver-cols", {},
        h("div.ver-col-t", {}, h("span.ver-col-name", {}, "现在"), h("span.ver-key.ver-ins", {}, "绿：后来加的")),
        h("div.ver-col-t", {}, thenHead, h("span.ver-key.ver-del", {}, "红：后来删掉的"))),
      grid));
  center.classList.add("ver-on");
  center.append(box);
  const v = wsView();
  if (v) v.classList.add("ver-cmp");
  const layer = pushLayer({
    onClose: () => {
      box.remove();
      center.classList.remove("ver-on");
      const vv = wsView();
      if (vv) vv.classList.remove("ver-cmp");
      const refocus = C && C.refocus !== false;
      C = null;
      if (P) { P.sel = -1; markSel(); if (refocus) focusList(); }
    },
  });
  back.addEventListener("click", () => layer.close());
  x.addEventListener("click", () => layer.close());
  only.addEventListener("change", () => { foldOn = only.checked; renderCompare(); });
  restoreBtn.addEventListener("click", () => restore());
  C = { box, layer, sub, sum, grid, thenHead, restoreBtn, only, row: null, then: "" };
}

function closeCompare(refocus = true) {
  if (!C) return;
  C.refocus = refocus;
  C.layer.close(true);
}

function renderCompare() {
  if (!C || !P) return;
  const { row, then } = C;
  const nowText = ws.textOf(P.id);
  const when = whenLabel(row.ts);
  C.sub.textContent = "左边现在 · 右边 " + when;
  C.thenHead.textContent = "那时 · " + when;
  const rows = alignRows(nowText, then);
  const n = rows.filter((r) => !r.same).length;
  const nw = countWords(nowText), tw = row.words != null ? row.words : countWords(then);
  const d = nw - tw;
  C.sum.replaceChildren(...(n
    ? [`那时 ${tw.toLocaleString()} 字，现在 ${nw.toLocaleString()} 字`, d ? `（${d > 0 ? "多" : "少"} ${Math.abs(d).toLocaleString()} 字）` : "", " · ", h("b", {}, n), " 处不同"]
    : ["和现在一样"]));
  C.restoreBtn.disabled = !n || busy;
  C.grid.textContent = "";
  if (!n) { C.grid.append(h("div.empty.ver-same", {}, "这一版和现在的正文一样，不用恢复。")); return; }
  const items = C.only.checked ? foldRows(rows, 1) : rows.map((r) => ({ row: r }));
  for (const it of items) C.grid.append(it.fold ? foldEl(it.fold) : rowEl(it.row));
}

function rowEl(r) {
  if (r.same) {
    const t = r.text.replace(/\n$/, "");
    return h("div.ver-row.same", {}, h("div.ver-cell", {}, t), h("div.ver-cell", {}, t));
  }
  return h("div.ver-row.chg", {}, cellEl(r.l, "ver-ins"), cellEl(r.r, "ver-del"));
}

/** 一格：一样的字照常显示，改过的标色；改动里的换行显示成 ↵ */
function cellEl(parts, cls) {
  const cell = h("div.ver-cell");
  parts.forEach((p, k) => {
    const last = k === parts.length - 1;
    if (p.t === 0) { cell.append(last ? p.s.replace(/\n$/, "") : p.s); return; }
    const el = h("span." + cls);
    const segs = p.s.split("\n");
    segs.forEach((seg, j) => {
      if (seg) el.append(seg);
      if (j === segs.length - 1) return;
      el.append(h("span.ver-nl", { "aria-hidden": "true" }, "↵"));
      if (!(last && j === segs.length - 2 && !segs[j + 1])) el.append("\n");
    });
    cell.append(el);
  });
  if (!parts.length) cell.classList.add("blank");
  return cell;
}

function foldEl(rows) {
  const b = h("button.ver-fold", { type: "button" }, `…… 中间 ${rows.length} 段没改，点开看 ……`);
  b.addEventListener("click", () => b.replaceWith(...rows.map(rowEl)));
  return b;
}

// ---------------- 恢复 ----------------
async function restore() {
  if (!C || !P || busy) return;
  const id = P.id, row = C.row, then = C.then;
  busy = true;
  C.restoreBtn.disabled = true;
  let step = "save";
  try {
    await ws.editor.flush();
    const nowText = ws.textOf(id);
    if (nowText === then) { toast("和现在一样，不用恢复"); return; }
    await recordNow(id, nowText, "恢复前");
    step = "apply";
    const entry = await ws.applyBatch("恢复历史版本", [{ chapterId: id, after: then }]);
    closeCompare(true);
    toast(`已恢复到${whenLabel(row.ts)}的版本`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
    bus.emit("version:restored", { chapter: ws.chapters.find((c) => c.id === id) || ws.current, ts: row.ts });
    changed(id);
  } catch (e) {
    notice({
      what: step === "save" ? "没能先存一份现在的正文，所以没有恢复。" : "没能恢复这个版本。",
      why: "本地存储出错，可能磁盘满了，或者浏览器限制了存储。" + (step === "save" ? "现在的正文没动。" : "按一次撤销能回到恢复前。"),
      detail: e && (e.stack || e.message || e),
      actions: [{ label: "再试一次", primary: true, run: () => restore() }],
    });
  } finally {
    busy = false;
    if (C) C.restoreBtn.disabled = false;
  }
}

// ---------------- 注册 ----------------
export async function register() {
  commands.register({
    id: "versions.open", title: "本章历史版本", keywords: "历史 版本 回溯 恢复 以前 对比 找回 改错了 后悔 备份",
    hint: "看这一章以前的样子，左右对比，一键恢复", when: () => !!(ws.book && ws.current), run: openVersions,
  });
  bus.on("content:saved", (d) => {
    onSaved(d);
    if (!P || !d.chapter || d.chapter.id !== P.id || busy) return;
    if (C) renderCompare();
    if (P.rows.length && (P.latest != null && P.latest === ws.textOf(P.id)) !== P.sameShown) renderList();   // 「和现在一样」跟着变
  });
  bus.on("chapter:opened", ({ chapter }) => { baseline(chapter, chapter && chapter.updatedAt); follow(chapter); });
  bus.on("chapter:created", ({ chapter, restored }) => { if (!restored) baseline(chapter, chapter && chapter.createdAt); });
  setTimeout(() => maintain({ startup: true }).catch(() => { /* 合并失败下次再来 */ }), 4000);
  setInterval(() => maintain().catch(() => {}), HOUR);
}
