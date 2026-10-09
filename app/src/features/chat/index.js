// AI 对话：「继续追问」带上前面的对话，「新开对话」彻底清空，两个按钮常驻，上下文长度实时显示；
// 可以从某条回复分叉出新对话，试不同方向互不干扰。对话存在 db 的 "chats" 表（data.js）。
// 命令：chat.open（{ bookId, ref, history, title }，别的模块「继续追问」时调用）、chat.new「和 AI 聊聊」（Ctrl+Shift+J）。
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { h } from "../../core/ui.js";
import { openChat, currentChat, ico } from "./view.js";
import { canUndoHere, canRedoHere, runUndo, runRedo, wireUndo } from "./data.js";

/** 写作界面顶栏上放一个入口（顶栏里还没有的话），放在暂存盒后面 */
function addTopbarButton() {
  const bar = document.querySelector(".ws .topbar");
  if (!bar || bar.querySelector('[data-cmd="chat.new"]')) return;
  const b = h("button.tool-btn.chat-tb", { type: "button", title: "和 AI 聊聊（Ctrl+Shift+J）", "data-cmd": "chat.new" }, ico("chat"), h("span.tb-t", {}, "对话"));
  b.addEventListener("click", () => commands.run("chat.new"));
  const after = bar.querySelector('[data-cmd="stash.drawer"]');
  if (after) after.after(b); else bar.querySelector(".spacer")?.after(b);
}

export async function register() {
  wireUndo();
  commands.register({
    id: "chat.open",
    title: "打开 AI 对话",
    keywords: "对话 聊天 AI 问问 追问 继续追问 接着聊 分叉 上下文",
    hint: "接着上次的对话聊",
    /** opts: { bookId, ref, history: [{ role, content }], title }；带 history 时新建一个以它开头的对话 */
    run: (opts) => openChat(opts || {}),
  });
  commands.register({
    id: "chat.new",
    title: "和 AI 聊聊",
    keywords: "对话 聊天 AI 问问 新对话 新开对话 讨论 情节 灵感",
    hint: "开一个新对话，问什么都行",
    key: "Mod-Shift-j",
    run: () => openChat({ fresh: true }),
  });
  // 不在作品里（弹窗）时，Ctrl+Z 撤销对话的改名、删除、分叉；在作品里由写作界面的撤销统一管
  const typing = () => document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  const here = () => { const c = currentChat(); return !!c && c.mode === "modal" && !typing(); };
  commands.register({ id: "chat.undo", title: "撤销", keywords: "撤回 后悔 删错了", hint: "撤销刚才对话的改名、删除、分叉", key: "Mod-z", when: () => here() && canUndoHere(), run: () => runUndo() });
  commands.register({ id: "chat.redo", title: "重做", keywords: "重做", key: "Mod-Shift-z", when: () => here() && canRedoHere(), run: () => runRedo() });

  bus.on("chapter:opened", addTopbarButton);
}
