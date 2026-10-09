// 三个功能共用：调用前看提示词库、写回数据（可撤销）、就地打开暂存盒、章节勾选列表。
import { listPrompts } from "../../core/prompts.js";
import { updateBook } from "../../core/store.js";
import { db } from "../../core/db.js";
import { commands } from "../../core/commands.js";
import { undo as appUndo } from "../../core/undo.js";
import { h, choose, toast } from "../../core/ui.js";
import { countWords } from "../../core/text.js";
import { ws } from "../editor/workspace.js";

export const motionFull = () => document.documentElement.dataset.motion === "full";

const WHAT = { chapterName: "起章名", summary: "写摘要", intro: "写简介" };
const tempOk = new Set();   // 这次打开软件期间已经选过「临时写一句」的功能，不再问

/**
 * 调用前看一眼提示词库。一条都没有时说明一下：去写一条，或者在确认卡里临时写一句。
 * 有专门给这个功能写的提示词、这个功能又没用过别的组合时，预先选上它。
 * 返回 { promptId, temp }；作者取消返回 null。
 */
export async function promptPlan(feature) {
  let list = await listPrompts();
  if (!list.length && !tempOk.has(feature)) {
    const c = await choose({
      title: "还没有提示词",
      body: `软件不带提示词。可以先写一条，告诉 AI 怎么${WHAT[feature] || "做"}；也可以在下一步的确认卡里临时写一句。`,
      buttons: [{ id: "write", label: "去写一条", primary: true }, { id: "temp", label: "临时写一句" }, { id: "cancel", label: "取消" }],
    });
    if (c === "write") { await commands.run("prompts.manage", { feature }); list = await listPrompts(); }
    else if (c === "temp") tempOk.add(feature);
    else return null;
  }
  const recent = await db.getKV("ai:recent:" + feature, []);
  const mine = list.find((p) => p.feature === feature);
  // 库里一条都没有时，确认卡直接打开「临时写一个」
  return { promptId: !recent.length && mine ? mine.id : undefined, temp: !list.length || undefined };
}

// ---------------- 写回：摘要、简介（都能撤销） ----------------
/** 本章摘要框（要点面板里的）：当前章是这一章时同步显示 */
export function summaryBox(id) {
  const ta = document.querySelector(".side-right .pt-summary");
  return ta && ws.current && ws.current.id === id ? ta : null;
}

async function writeSummaries(map) {
  for (const [id, summary] of map) {
    await ws.patchChapter(id, { summary });
    const ta = summaryBox(id);
    if (ta) { ta.value = summary; flash(ta); }
  }
}

/** changes: [{ id, summary }]，算一步撤销；返回撤销条目 */
export async function setSummaries(changes, label) {
  if (!changes.length) return null;
  const before = new Map(changes.map((c) => [c.id, c.before != null ? c.before : ((ws.chapters.find((x) => x.id === c.id) || {}).summary || "")]));
  const after = new Map(changes.map((c) => [c.id, c.summary]));
  await writeSummaries(after);
  return appUndo.push({ label, undo: () => writeSummaries(before), redo: () => writeSummaries(after) });
}

/** 已经一章章写进去了，最后补一条撤销记录（批量写摘要用） */
export function pushSummaryUndo(done, label) {
  if (!done.length) return null;
  const before = new Map(done.map((c) => [c.id, c.before]));
  const after = new Map(done.map((c) => [c.id, c.summary]));
  return appUndo.push({ label, undo: () => writeSummaries(before), redo: () => writeSummaries(after) });
}

async function writeIntro(bookId, intro) {
  const b = await updateBook(bookId, { intro });
  if (b && ws.book && ws.book.id === bookId) ws.book = b;
  document.dispatchEvent(new CustomEvent("cai:intro", { detail: { bookId, intro } }));
}

/** 写进作品简介，可撤销；返回撤销条目 */
export async function setIntro(bookId, intro) {
  const before = (ws.book && ws.book.id === bookId ? ws.book.intro : "") || "";
  if (before === intro) { toast("简介已经是这一版了"); return null; }
  await writeIntro(bookId, intro);
  const entry = appUndo.push({ label: "AI 简介", undo: () => writeIntro(bookId, before), redo: () => writeIntro(bookId, intro) });
  toast("已写进作品简介", { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
  return entry;
}

/** 写回后闪一下（跟着主题换样子，见 chapterai.css） */
export function flash(el, cls = "cai-set") {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 1200);
}

/** 就地打开暂存盒抽屉，只看这个功能的 */
export function openStash(o) { return commands.run("stash.drawer", o); }

// ---------------- 章节勾选列表（简介、批量摘要共用） ----------------
/**
 * mode: "intro" 每章标出会发摘要还是正文开头；"summary" 标出已有摘要、没有正文。
 * 返回 { el, picked() → [chapter], onChange(fn) }
 */
export function chapterPicker({ ids = [], mode }) {
  const want = new Set(ids);
  const listeners = [];
  const changed = () => listeners.forEach((f) => f());
  const rows = ws.chapters.map((c) => {
    const text = ws.textOf(c.id);
    const hasText = !!text.trim(), hasSum = !!(c.summary || "").trim();
    let badge, kind, disabled = false;
    if (mode === "intro") {
      if (hasSum) { badge = "用摘要"; kind = "ok"; }
      else if (hasText) { badge = "用正文开头"; kind = "head"; }
      else { badge = "空的"; kind = "empty"; disabled = true; }
    } else if (!hasText) { badge = "没有正文"; kind = "empty"; disabled = true; }
    else if (hasSum) { badge = "已有摘要"; kind = "warn"; }
    else { badge = `${countWords(text).toLocaleString()} 字`; kind = "words"; }
    const cb = h("input", { type: "checkbox", disabled, "aria-label": ws.fullTitle(c) });
    cb.checked = want.has(c.id) && !disabled;
    cb.addEventListener("change", changed);
    const row = h("label.cai-pick-row" + (disabled ? ".off" : ""), { "data-id": c.id },
      cb, h("span.cai-pick-no", {}, ws.labelOf(c)), h("span.cai-pick-t", {}, c.title || ""), h("span.cai-badge", { "data-kind": kind }, badge));
    return { c, cb, row, hasSum, hasText, disabled };
  });
  const bulk = (fn) => () => { rows.forEach((r) => { if (!r.disabled) r.cb.checked = fn(r); }); changed(); };
  const tools = h("div.cai-pick-tools", {},
    h("button.btn.small.ghost", { type: "button", onclick: bulk(() => true) }, "全选"),
    mode === "intro" ? h("button.btn.small.ghost", { type: "button", onclick: bulk((r) => r.hasSum) }, "只选有摘要的") : null,
    mode === "summary" ? h("button.btn.small.ghost", { type: "button", onclick: bulk((r) => !r.hasSum) }, "只选没摘要的") : null,
    h("button.btn.small.ghost", { type: "button", onclick: bulk(() => false) }, "清空"));
  const list = h("div.cai-pick-list", { role: "group", "aria-label": "勾选章节" }, ...rows.map((r) => r.row));
  const el = h("div.cai-pick", {}, tools, list);
  return {
    el,
    picked: () => rows.filter((r) => r.cb.checked && !r.disabled).map((r) => r.c),
    onChange: (fn) => listeners.push(fn),
    disable(on) { rows.forEach((r) => { r.cb.disabled = on || r.disabled; }); tools.querySelectorAll("button").forEach((b) => { b.disabled = on; }); },
  };
}

/** 1–4 个版本的小分段按钮 */
export function countSeg(value, onChange) {
  const seg = h("div.cai-seg", { role: "radiogroup", "aria-label": "出几版" });
  const set = (n) => {
    value = n;
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(+b.dataset.n === n)));
    onChange && onChange(n);
  };
  [1, 2, 3, 4].forEach((n) => {
    const b = h("button", { type: "button", role: "radio", "data-n": String(n), "aria-checked": String(n === value) }, `${n} 版`);
    b.addEventListener("click", () => set(n));
    seg.append(b);
  });
  seg.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const n = Math.max(1, Math.min(4, value + (e.key === "ArrowRight" ? 1 : -1)));
    set(n);
    seg.querySelector(`[data-n="${n}"]`).focus();
  });
  return { el: seg, get: () => value };
}
