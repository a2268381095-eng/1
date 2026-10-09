// 对话的存储（db 的 "chats" 表）和改数据的操作。改标题、删除、分叉都推一条撤销，删除后出「已删除 · 撤销」。
// chats：{ id, bookId, ref, title, messages: [{ role, content, at, model, sent?, stopped? }], forkOf: { chatId, index } | null, createdAt, updatedAt }
import { db, uid } from "../../core/db.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { notice } from "../../core/ui.js";
import { byRecent } from "./logic.js";

export function blankChat({ bookId = null, ref = null, title = "", messages = [], forkOf = null } = {}) {
  const now = Date.now();
  return { id: uid("c"), bookId: bookId || null, ref: ref || null, title, messages, forkOf, createdAt: now, updatedAt: now };
}

/** 这本书的所有对话（bookId 为空：不属于作品的对话），最近用过的在前 */
export async function listChats(bookId) {
  const rows = bookId ? await db.byIndex("chats", "bookId", bookId) : (await db.all("chats")).filter((c) => !c.bookId);
  return byRecent(rows);
}

export const getChat = (id) => db.get("chats", id);

export async function putChat(chat) {
  await db.put("chats", chat);
  bus.emit("chat:changed", { id: chat.id });
  return chat;
}

export async function dropChat(id) {
  await db.del("chats", id);
  bus.emit("chat:changed", { id, deleted: true });
}

// 上次看的是哪个对话（每本书一个）、输入框里留下的草稿
const key = (bookId) => bookId || "none";
export const lastChatId = (bookId) => db.getKV("chat:last:" + key(bookId), null);
export const setLastChat = (bookId, id) => db.setKV("chat:last:" + key(bookId), id);
export const getDraft = (bookId) => db.getKV("chat:draft:" + key(bookId), "");
export const setDraft = (bookId, text) => db.setKV("chat:draft:" + key(bookId), text || "");

// 对话默认用的模型和档位 { providerId, model, creativity, thinking, promptId }：上一次在对话里用的；没有就用任何功能上一次用的
export async function getPrefer() { return (await db.getKV("chat:prefer", null)) || (await db.getKV("ai:last", null)); }
export const setPrefer = (p) => db.setKV("chat:prefer", p);
/** 每个模型用过几次（确认卡记的），模型按这个排 */
export const modelUses = () => db.getKV("ai:modelUses", {});

/** 存储出错时的中文说明 */
export function failed(what, e, retry) {
  notice({
    what,
    why: "浏览器存储被限制、被清理，或者另一个窗口刚改过这些对话。",
    detail: e ? String(e.stack || e.message || e) : "",
    actions: retry ? [{ label: "重试", primary: true, run: retry }] : [],
  });
}

// ---------------- 撤销 ----------------
// 撤销栈是全软件共用的。这里记住哪些条目是对话的，弹窗里按 Ctrl+Z / 重做只动对话自己的。
const mine = new WeakSet();
const myUndone = [];          // 「可重做」那头最上面连着的几条对话条目
let undoing = null, redoing = null, busy = false;

/** 推一条撤销；undo / redo 出错时给中文说明 */
export function pushUndo({ label, undo, redo }) {
  const entry = { label, live: true };
  const guard = (what, fn) => async () => { try { await fn(); } catch (e) { failed(what, e); } };
  entry.undo = async () => { entry.live = false; undoing = entry; await guard("没能撤销「" + label + "」。", undo)(); };
  entry.redo = async () => { entry.live = true; redoing = entry; await guard("没能重做「" + label + "」。", redo)(); };
  mine.add(entry);
  return appUndo.push(entry);
}
export function wireUndo() {
  bus.on("undo", () => { if (undoing) myUndone.push(undoing); else myUndone.length = 0; undoing = null; });
  bus.on("redo", () => { if (redoing && myUndone[myUndone.length - 1] === redoing) myUndone.pop(); else myUndone.length = 0; redoing = null; });
  bus.on("undo:changed", () => { if (!appUndo.canRedo()) myUndone.length = 0; });
}
export const canUndoHere = () => mine.has(appUndo.peek());
export const canRedoHere = () => myUndone.length > 0 && appUndo.canRedo();

/** 提示条上的「撤销」：撤到这一条为止 */
export async function runUndo(target) {
  if (busy) return;
  if (target ? !target.live : !canUndoHere()) return;
  busy = true;
  try { await (target && appUndo.peek() !== target ? appUndo.undoEntry(target) : appUndo.undo()); }
  finally { busy = false; }
}
export async function runRedo() {
  if (busy || !canRedoHere()) return;
  busy = true;
  try { await appUndo.redo(); } finally { busy = false; }
}
