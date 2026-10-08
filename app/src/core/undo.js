// 软件层面的撤销 / 重做：删章节、移动章节、全书替换、一键排版这类跨章节、批量的操作。
// 每次 push 一条 { label, undo(), redo() }，批量操作只 push 一条，所以按一次就全部还原。
// 正文里打字的撤销由编辑器自己管（每章一份），见 features/editor。
import { bus } from "./bus.js";

const MAX = 100;
const done = [];
const undone = [];

export const undo = {
  /** entry: { label, undo: async fn, redo: async fn, chapters?: {chapterId: editorDepth} } */
  push(entry) {
    entry.at = Date.now();
    done.push(entry);
    if (done.length > MAX) done.shift();
    undone.length = 0;
    bus.emit("undo:changed", {});
    return entry;
  },
  peek() { return done[done.length - 1] || null; },
  canUndo() { return done.length > 0; },
  canRedo() { return undone.length > 0; },
  async undo() {
    const e = done.pop();
    if (!e) return null;
    await e.undo();
    undone.push(e);
    bus.emit("undo", { label: e.label });
    bus.emit("undo:changed", {});
    return e;
  },
  async redo() {
    const e = undone.pop();
    if (!e) return null;
    await e.redo();
    done.push(e);
    bus.emit("redo", { label: e.label });
    bus.emit("undo:changed", {});
    return e;
  },
  /** 撤销指定的那一条（提示条上的「撤销」按钮用）：它必须是最新一条，否则先撤到它为止 */
  async undoEntry(entry) {
    if (!done.includes(entry)) return null;
    while (done.length && done[done.length - 1] !== entry) await this.undo();
    return this.undo();
  },
};
