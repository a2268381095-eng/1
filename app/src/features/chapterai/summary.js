// AI 写摘要：本章摘要（要点下面）一键让 AI 写，覆盖已有的先问，可撤销。
// 多选几章一起写：弹窗里就地勾章节，确认一次，逐章发送，进度一章章显示；整批算一步撤销。
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { h, modal, toast, choose } from "../../core/ui.js";
import { label } from "../../core/settings.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { runAI } from "../ai/runner.js";
import { promptPlan, setSummaries, pushSummaryUndo, summaryBox, openStash, chapterPicker, flash } from "./common.js";

const TIP = "摘要写好能反复用：写下一章时用 {前一章摘要} 代替整章发给 AI，省 token。";
let single = null;   // 正在写的单章 { id, ctrl }
let batch = null;    // 开着的批量弹窗

const chapterOf = (id) => ws.chapters.find((c) => c.id === id);
const sumOf = (id) => ((chapterOf(id) || {}).summary || "");

/** 入口：opts.ids 指定几章；没给时看章节列表的多选，多于一章就批量，否则写当前章 */
export async function summaryAI(opts = {}) {
  if (!ws.book) return;
  const ids = Array.isArray(opts.ids) && opts.ids.length ? opts.ids : ws.selectedIds();
  if (ids.length > 1 || opts.batch) return openBatch(ids);
  return summaryOne(ids[0] || (ws.current && ws.current.id));
}

async function summaryOne(id) {
  const ch = chapterOf(id);
  if (!ch) { toast("先打开一章"); return; }
  if (single) { toast("上一份摘要还在写，等一下"); return; }
  const text = ws.textOf(id);
  if (!text.trim()) { toast(`${ws.fullTitle(ch)}还没写正文，没东西可写摘要。`); return; }
  tip("chapterai-summary", TIP);
  const old = sumOf(id);
  if (old.trim()) {
    const c = await choose({
      title: "覆盖已有的摘要？",
      body: `${ws.fullTitle(ch)}已经有摘要了。新写的会替换它；换完马上能撤销，旧的不会丢。`,
      buttons: [{ id: "go", label: "写新的替换", primary: true }, { id: "cancel", label: "取消" }],
    });
    if (c !== "go") return;
  }
  const plan = await promptPlan("summary");
  if (!plan) return;
  const ctrl = new AbortController();
  single = { id, ctrl };
  let live = null;   // 流式写进摘要框（只是显示，写完才存）
  const r = await runAI({
    feature: "summary", simple: true, input: text, inputLabel: "本章正文", vars: ws.varsFor(id),
    ref: id, bookId: ws.book.id, maxTokens: 600, promptId: plan.promptId, temp: plan.temp, title: ws.fullTitle(ch) + " · 摘要", signal: ctrl.signal,
    onDelta: (piece, all) => {
      const ta = summaryBox(id);
      if (!ta) return;
      if (live !== ta) { live = ta; ta.readOnly = true; ta.classList.add("cai-live"); }
      ta.value = all;
      ta.scrollTop = ta.scrollHeight;
    },
  }).finally(() => { single = null; });
  const ta = summaryBox(id);
  if (live) { live.readOnly = false; live.classList.remove("cai-live"); }
  if (!r) { if (ta) ta.value = sumOf(id); return; }
  const summary = r.text.trim();
  const entry = await setSummaries([{ id, summary, before: old }], "AI 写摘要");
  if (!ta) flash(document.querySelector(".ws .ch-item[data-id=\"" + id + "\"]"));
  toast(ws.current && ws.current.id === id ? "已写进本章摘要" : `已写进${ws.fullTitle(ch)}的摘要`, {
    actions: [
      { label: "撤销", run: () => appUndo.undoEntry(entry) },
      { label: label("暂存盒"), run: () => openStash({ feature: "summary", bookId: ws.book.id, ref: id, title: "摘要", useLabel: "用这份", onUse: (row) => useOne(id, row.text) }) },
    ],
  });
  bus.emit("chapterai:done", { kind: "summary", ids: [id] });
}

/** 从暂存盒挑一份以前的摘要放回去 */
async function useOne(id, text) {
  const summary = String(text || "").trim();
  if (!summary) return;
  if (sumOf(id) === summary) { toast("摘要已经是这一份了"); return; }
  const entry = await setSummaries([{ id, summary }], "换摘要");
  toast("摘要换好了", { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
}

// ---------------- 几章一起写 ----------------
function openBatch(ids) {
  if (batch) { batch.focus(); return; }
  tip("chapterai-summary-batch", "勾几章，确认一次，我一章章写。已经有摘要的默认跳过。");
  const picker = chapterPicker({ ids, mode: "summary" });
  const overwrite = h("input", { type: "checkbox" });
  const owRow = h("label.check.cai-ow", {}, overwrite, "已经有摘要的也重写（可以撤销）");
  const info = h("p.cai-info", { "aria-live": "polite" });
  const result = h("p.cai-result", { role: "status" });
  const prog = h("ol.cai-prog", { hidden: true, "aria-label": "进度" });
  const body = h("div.cai-batch", {},
    h("p.cai-lead.muted", {}, "勾要写摘要的章。确认一次，一章章发；写好的直接放进各章的摘要。"),
    picker.el, owRow, info, result, prog);

  let running = false, ctrl = null, stopped = false, done = [], keep = false, asked = false, startBtn, stashBtn;
  const m = modal({
    title: "AI 写摘要 · 几章一起", body, wide: true,
    // 写到一半关掉：「保留草稿」留下已经写好的几章，「丢弃」把这批撤回去
    isDirty: () => running && (asked = true),
    onKeepDraft: () => { keep = true; },
    onClose: () => {
      batch = null;
      if (running) { stopped = true; if (ctrl) ctrl.abort(); finish(asked && !keep); }
    },
    actions: [
      { label: "开始写", primary: true, onClick: () => start() },
      { label: label("暂存盒"), onClick: () => openStash({ feature: "summary", bookId: ws.book.id, title: "摘要", modal: true, useLabel: "用作这章的摘要",
        onUse: (row) => { if (row.ref && chapterOf(row.ref)) return useOne(row.ref, row.text); toast("那一章已经不在了"); } }) },
      { label: "关闭", onClick: () => m.close() },
    ],
  });
  m.el.classList.add("cai-modal", "cai-batch-modal");
  [startBtn, stashBtn] = m.foot.querySelectorAll(".btn");
  batch = { focus: () => startBtn.focus() };

  const plan = () => {
    const picked = picker.picked();
    const skip = overwrite.checked ? [] : picked.filter((c) => sumOf(c.id).trim());
    const todo = picked.filter((c) => !skip.includes(c));
    return { picked, skip, todo };
  };
  const refresh = () => {
    if (running) return;
    const p = plan();
    const anySum = p.picked.some((c) => sumOf(c.id).trim());
    owRow.hidden = !anySum;
    info.textContent = !p.picked.length ? "还没勾章节。" : !p.todo.length ? `勾的 ${p.picked.length} 章都已经有摘要了。要重写就勾上面那一项。`
      : `要写 ${p.todo.length} 章` + (p.skip.length ? `，跳过 ${p.skip.length} 章已有摘要的` : "") + "。确认一次，花费约是单章的 " + p.todo.length + " 倍。";
    startBtn.disabled = !p.todo.length;
  };
  picker.onChange(refresh);
  overwrite.addEventListener("change", refresh);
  refresh();

  function rowOf(c) {
    const st = h("span.cai-st", { "data-st": "wait" }, "等着");
    const out = h("div.cai-prog-out");
    const li = h("li.cai-prog-row", { "data-id": c.id, "data-st": "wait" }, h("div.cai-prog-head", {}, h("span.cai-prog-t", {}, ws.fullTitle(c)), st), out);
    return {
      li,
      set(s, text) { st.dataset.st = s; st.textContent = text; li.dataset.st = s; },
      out(text) { out.textContent = text; },
    };
  }

  function finish(revert) {
    running = false;
    picker.disable(false);
    const list = done;
    done = [];
    if (!list.length) return;
    const entry = pushSummaryUndo(list, `AI 写摘要（${list.length} 章）`);
    if (revert) { appUndo.undoEntry(entry); toast(`已丢弃这批写好的 ${list.length} 章摘要`); return; }
    toast(`写好 ${list.length} 章摘要`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
    bus.emit("chapterai:done", { kind: "summary", ids: list.map((c) => c.id) });
  }

  async function start() {
    if (running) return;
    const p = plan();
    if (!p.todo.length) return;
    const pp = await promptPlan("summary");
    if (!pp || !m.el.isConnected) return;
    running = true; stopped = false; done = [];
    picker.disable(true);
    owRow.hidden = true;
    startBtn.disabled = true;
    result.textContent = "";
    const rows = new Map(p.todo.map((c) => [c.id, rowOf(c)]));
    prog.replaceChildren(...[...rows.values()].map((r) => r.li));
    prog.hidden = false;
    info.textContent = `0 / ${p.todo.length}`;
    const stopBtn = h("button.btn.cai-stop", { type: "button" }, "停下");
    stopBtn.addEventListener("click", () => { stopped = true; if (ctrl) ctrl.abort(); });
    m.foot.prepend(stopBtn);
    let choice = null, failed = false, canceled = false;
    for (const c of p.todo) {
      if (stopped) break;
      const row = rows.get(c.id);
      const text = ws.textOf(c.id);
      if (!text.trim()) { row.set("skip", "没有正文，跳过"); continue; }
      row.set("run", "正在写");
      row.li.scrollIntoView({ block: "nearest" });
      ctrl = new AbortController();
      const r = await runAI({
        feature: "summary", simple: true, input: text,
        inputLabel: choice ? "本章正文" : `${ws.fullTitle(c)} 的正文（这次一共 ${p.todo.length} 章，确认一次，逐章发送）`,
        vars: ws.varsFor(c.id), ref: c.id, bookId: ws.book.id, maxTokens: 600, promptId: pp.promptId, temp: pp.temp,
        title: ws.fullTitle(c) + " · 摘要", signal: ctrl.signal, reuse: choice || undefined,
        onDelta: (piece, all) => row.out(all),
      });
      if (!running) return;   // 弹窗已经关了（结果在暂存盒里）
      if (!r) {
        const aborted = stopped || ctrl.signal.aborted;
        if (!choice && !aborted) { canceled = true; row.set("wait", "没发"); break; }
        row.set("fail", aborted ? "停下了" : "没写成");
        failed = !aborted;
        break;
      }
      choice = r.choice;
      const summary = r.text.trim();
      const before = sumOf(c.id);
      await setSummariesNow(c.id, summary);
      done.push({ id: c.id, before, summary });
      row.out(summary);
      row.set("ok", "写好了");
      info.textContent = `${done.length} / ${p.todo.length}`;
    }
    stopBtn.remove();
    const n = done.length;
    if (canceled) prog.hidden = true;
    rows.forEach((r) => { if (r.li.dataset.st === "wait") r.set("wait", "没写"); });
    finish(false);
    if (n) overwrite.checked = false;
    refresh();
    result.textContent = canceled ? "取消了，什么都没发。"
      : n === p.todo.length ? `${n} 章都写好了，在各章的摘要里。`
      : `写好 ${n} 章，剩下的没写。` + (failed ? "出错的那章可以再点「开始写」重来。" : "");
    startBtn.textContent = !canceled && n < p.todo.length ? "接着写剩下的" : "开始写";
    (startBtn.disabled ? stashBtn : startBtn).focus();
  }
}

/** 批量里每写好一章就放进去（撤销记录最后整批补一条） */
async function setSummariesNow(id, summary) {
  await ws.patchChapter(id, { summary });
  const ta = summaryBox(id);
  if (ta) { ta.value = summary; flash(ta); }
}

