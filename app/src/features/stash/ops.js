// 暂存盒改数据的操作：删除、置顶、标签。每次操作推一条撤销（批量删也只推一条），删除后出「已删除 · 撤销」提示条。
// 撤销栈是全软件共用的：在写作界面按 Ctrl+Z、点提示条上的「撤销」、在总暂存盒点撤销按钮，走的都是同一条。
import { updateStash, deleteStash, restoreStash } from "../../core/stash.js";
import { undo as appUndo } from "../../core/undo.js";
import { bus } from "../../core/bus.js";
import { h, toast, notice } from "../../core/ui.js";
import { label } from "../../core/settings.js";

const mine = new WeakSet();     // 暂存盒推进撤销栈的条目
const myUndone = [];            // 撤销栈「可重做」那头最上面连着的几条暂存盒条目
let undoing = null, redoing = null, busy = false;

export const L = () => label("暂存盒");

/** 存储出错时的中文说明 */
export function failed(what, e, retry) {
  notice({
    what,
    why: "浏览器存储被限制、被清理，或者另一个窗口刚改过" + L() + "。",
    detail: e ? String(e.stack || e.message || e) : "",
    actions: retry ? [{ label: "重试", primary: true, run: retry }] : [],
  });
}

const guard = (what, fn) => async () => { try { await fn(); } catch (e) { failed(what, e); } };

function pushUndo({ label: lbl, undo, redo }) {
  const entry = { label: lbl, live: true };
  entry.undo = async () => { entry.live = false; undoing = entry; await guard("没能撤销「" + lbl + "」。", undo)(); };
  entry.redo = async () => { entry.live = true; redoing = entry; await guard("没能重做「" + lbl + "」。", redo)(); };
  mine.add(entry);
  return appUndo.push(entry);
}

export const canUndoHere = () => mine.has(appUndo.peek());
export const canRedoHere = () => myUndone.length > 0 && appUndo.canRedo();

/** 撤销：不给 target 就撤最近一步（必须是暂存盒的）；给了就撤到它为止（提示条上的「撤销」） */
export async function runUndo(target) {
  if (busy) return;
  if (target ? !target.live : !canUndoHere()) return;
  busy = true;
  try { await (target && appUndo.peek() !== target ? appUndo.undoEntry(target) : appUndo.undo()); }
  finally { busy = false; bus.emit("stash:undo-state", {}); }
}

export async function runRedo() {
  if (busy || !canRedoHere()) return;
  busy = true;
  try { await appUndo.redo(); } finally { busy = false; bus.emit("stash:undo-state", {}); }
}

/** 删除几条，算一步。rows 是条目本身（撤销时原样放回）。返回撤销条目；出错返回 null */
export async function removeRows(rows, { what } = {}) {
  if (!rows.length) return null;
  const ids = rows.map((r) => r.id);
  let gone;
  try { gone = await deleteStash(ids); }
  catch (e) { failed("没能删除。", e, () => removeRows(rows, { what })); return null; }
  if (!gone.length) { toast("这些已经不在" + L() + "里了"); return null; }
  const name = what || (gone.length === 1 ? "1 条" : gone.length + " 条");
  const u = pushUndo({
    label: "删除" + L() + "里的 " + name,
    undo: () => restoreStash(gone),
    redo: () => deleteStash(gone.map((r) => r.id)),
  });
  toast("已删除 " + name, { action: { label: "撤销", run: () => runUndo(u) }, timeout: 9000 });
  const el = document.querySelector(".toasts .toast:last-child");
  if (el) el.classList.add("stash-toast");
  return u;
}

/** 改一条的几个字段（置顶、标签），算一步 */
async function patchRow(row, patch, lbl) {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, structuredClone(row[k])]));
  try {
    const r = await updateStash(row.id, patch);
    if (!r) { toast("这一条已经不在" + L() + "里了"); return null; }
  } catch (e) { failed("没能保存。", e, () => patchRow(row, patch, lbl)); return null; }
  return pushUndo({ label: lbl, undo: () => updateStash(row.id, before), redo: () => updateStash(row.id, patch) });
}

export const setPinned = (row, pinned) => patchRow(row, { pinned }, pinned ? "置顶" : "取消置顶");
export const setTags = (row, tags, lbl) => patchRow(row, { tags }, lbl || "改标签");

/** 复制：先用剪贴板接口，不行就用老办法 */
export async function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (_) { /* 换老办法 */ }
  const back = document.activeElement;
  const ta = h("textarea", { style: { position: "fixed", left: "-9999px", top: "0", opacity: "0" }, "aria-hidden": "true" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
  ta.remove();
  if (back && back.focus) back.focus();
  return ok;
}

/** 启动时接上撤销栈的事件：记住哪几条是暂存盒的、现在能不能重做 */
export function wireUndo() {
  bus.on("undo", () => { if (undoing) myUndone.push(undoing); else myUndone.length = 0; undoing = null; bus.emit("stash:undo-state", {}); });
  bus.on("redo", () => { if (redoing && myUndone[myUndone.length - 1] === redoing) myUndone.pop(); else myUndone.length = 0; redoing = null; bus.emit("stash:undo-state", {}); });
  bus.on("undo:changed", () => { if (!appUndo.canRedo()) myUndone.length = 0; bus.emit("stash:undo-state", {}); });
}
