// 提示词库的改动：每次改动都推一条撤销（批量的算一步）。正向操作走 core/prompts.js，撤销 / 重做按快照原样写回。
import { db } from "../../core/db.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { notice } from "../../core/ui.js";
import { listPrompts, savePrompt, deletePrompt, importPrompts } from "../../core/prompts.js";
import { copyName, nextPinOrder, orderAfter, reorderRows, nameFrom } from "./logic.js";

// ---------------- 撤销 ----------------
// 撤销栈全软件共用。这里记着哪些条目是提示词库的、「可重做」那头连着几条是提示词库的。
const mine = new WeakSet();
const myUndone = [];
let undoing = null, redoing = null, busy = false;

/** 按快照写回：rows[i] 为 null 表示这一条不该存在 */
async function writeRows(ids, rows) {
  await db.tx(["prompts"], (s) => { ids.forEach((id, i) => (rows[i] ? s.prompts.put(rows[i]) : s.prompts.delete(id))); });
  bus.emit("prompts:changed", { undo: true });
}

function failed(what, e) {
  notice({ what, why: "浏览器存储被限制、被清理，或者另一个窗口刚改过提示词库。", detail: e && (e.stack || e.message || e) });
}

function push(label, ids, before, after) {
  const entry = {
    label,
    undo: async () => { undoing = entry; try { await writeRows(ids, before); } catch (e) { failed("没能撤销「" + label + "」。", e); } },
    redo: async () => { redoing = entry; try { await writeRows(ids, after); } catch (e) { failed("没能重做「" + label + "」。", e); } },
  };
  mine.add(entry);
  return appUndo.push(entry);
}

export const canUndoHere = () => mine.has(appUndo.peek());
export const canRedoHere = () => myUndone.length > 0 && appUndo.canRedo();
export const undoLabel = () => (canUndoHere() ? appUndo.peek().label : "");

/** 撤销：不给 entry 就撤最近一步（必须是提示词库的）；给了就撤到它为止（提示条上的「撤销」） */
export async function runUndo(entry) {
  if (busy) return;
  if (entry ? !mine.has(entry) : !canUndoHere()) return;
  busy = true;
  try { await (entry ? appUndo.undoEntry(entry) : appUndo.undo()); } finally { busy = false; }
}
export async function runRedo() {
  if (busy || !canRedoHere()) return;
  busy = true;
  try { await appUndo.redo(); } finally { busy = false; }
}

export function trackUndo(onChange) {
  bus.on("undo", () => { if (undoing) myUndone.push(undoing); else myUndone.length = 0; undoing = null; });
  bus.on("redo", () => { if (redoing && myUndone[myUndone.length - 1] === redoing) myUndone.pop(); else myUndone.length = 0; redoing = null; });
  bus.on("undo:changed", () => { if (!appUndo.canRedo()) myUndone.length = 0; onChange(); });
}

// ---------------- 改动 ----------------
const clean = (s, n) => String(s || "").trim().slice(0, n);

/** 新建一条。fields: { name, group, text, feature } */
export async function create(fields) {
  const row = await savePrompt({ name: clean(fields.name, 60) || nameFrom(fields.text), group: clean(fields.group, 30), text: fields.text, feature: fields.feature || "" });
  return { row, entry: push("新建提示词「" + row.name + "」", [row.id], [null], [row]) };
}

/** 改名字、分组、正文 */
export async function update(p, fields) {
  const old = (await db.get("prompts", p.id)) || null;   // 编辑期间被删了：保存时按原样新建回来
  const row = await savePrompt({ ...(old || p), name: clean(fields.name, 60) || nameFrom(fields.text), group: clean(fields.group, 30), text: fields.text });
  return { row, entry: push("修改提示词「" + row.name + "」", [row.id], [old], [row]) };
}

/** 复制一份：名字加「（副本）」，用过的次数从 0 算；原来是固定的，副本紧跟在它后面 */
export async function copy(p) {
  const list = await listPrompts();
  const row = await savePrompt({ name: copyName(p.name, list.map((x) => x.name)), group: p.group, text: p.text, feature: p.feature,
    pinned: p.pinned, order: p.pinned ? orderAfter(list, p) : undefined });
  return { row, entry: push("复制提示词「" + p.name + "」", [row.id], [null], [row]) };
}

export async function remove(p) {
  const old = (await db.get("prompts", p.id)) || p;
  await deletePrompt(p.id);
  return { entry: push("删除提示词「" + old.name + "」", [old.id], [old], [null]) };
}

/** 固定 / 取消固定。新固定的排在固定的最后 */
export async function setPinned(p, pinned) {
  const old = (await db.get("prompts", p.id)) || p;
  const order = pinned ? nextPinOrder(await listPrompts()) : Date.now();
  const row = await savePrompt({ ...old, pinned, order });
  return { row, entry: push((pinned ? "固定" : "取消固定") + "「" + old.name + "」", [row.id], [old], [row]) };
}

/** 调整固定的顺序：rows 是这一组固定的几条（现在的顺序），ids 是新顺序 */
export async function reorder(rows, ids) {
  const changed = reorderRows(rows, ids);
  if (!changed.length) return null;
  const keys = changed.map((r) => r.id);
  const before = keys.map((id) => rows.find((r) => r.id === id));
  await writeRows(keys, changed);
  return { entry: push("调整提示词顺序", keys, before, changed) };
}

/** 分组改名（改成已有的名字就并进那一组），算一步 */
export async function renameGroup(rows, name) {
  const g = clean(name, 30);
  const after = rows.map((r) => ({ ...r, group: g, updatedAt: Date.now() }));
  const ids = rows.map((r) => r.id);
  await writeRows(ids, after);
  return { entry: push("分组改名", ids, rows, after) };
}

/** 导入（已经挑过重复的）。整批算一步；中途出错把这次加进去的都删掉 */
export async function importMany(fresh) {
  const haveIds = new Set((await listPrompts()).map((p) => p.id));
  let n = 0, err = null;
  try { n = await importPrompts({ prompts: fresh }); } catch (e) { err = e; }
  const added = (await listPrompts()).filter((p) => !haveIds.has(p.id));
  if (err) {
    if (added.length) await writeRows(added.map((p) => p.id), added.map(() => null)).catch(() => {});
    throw err;
  }
  if (!added.length) return { n: 0, entry: null };
  return { n: n || added.length, entry: push(`导入 ${added.length} 条提示词`, added.map((p) => p.id), added.map(() => null), added) };
}
