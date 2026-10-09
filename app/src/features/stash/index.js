// 暂存盒：AI 生成的文字和图片自动进来（runAI 调 core/stash.js 的 addStash），按作品、时间、功能分类。
// 两处界面：
//   抽屉 stash.drawer({ feature, bookId, ref, title, onUse(row) })：各功能界面里就地打开，只列这个功能的结果（drawer.js）
//   总暂存盒 #/stash/:bookId?：汇总、搜索、按条件批量删（view.js）
// 界面里的叫法都走 label("暂存盒")（主题彩蛋会变成「恶魔口袋」）。
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { label } from "../../core/settings.js";
import { hasLayers } from "../../core/ui.js";
import { ws } from "../editor/workspace.js";
import { openDrawer } from "./drawer.js";
import { renderView, refresh, onView, openCondDelete, leaveView, viewScroll, updateUndoBtns } from "./view.js";
import { wireUndo, runUndo, runRedo, canUndoHere, canRedoHere } from "./ops.js";

export async function register() {
  wireUndo();
  nav.route("stash", "/stash/:bookId?", (params, restoreState, prev) => renderView(params, restoreState, prev));
  nav.onLeave(viewScroll);
  bus.on("route", ({ name }) => { if (name !== "stash") leaveView(); });
  let t = 0;
  bus.on("stash:changed", () => { if (onView()) { clearTimeout(t); t = setTimeout(refresh, 30); } });
  bus.on("stash:undo-state", updateUndoBtns);
  bus.on("settings:changed", ({ patch }) => { if (patch && "themeNames" in patch && onView()) refresh(); });

  commands.register({
    id: "stash.open",
    get title() { return label("暂存盒"); },
    keywords: "暂存盒 恶魔口袋 AI 结果 生成 候选 以前生成的 找回 搜索 清理",
    hint: "AI 生成的结果都在这里，可以搜索、清理",
    /** opts.bookId：只看这本书；不给时在作品里默认只看这本书 */
    run: (opts = {}) => {
      const id = opts.bookId || (ws.book ? ws.book.id : null);
      return nav.go(id ? "/stash/" + id : "/stash");
    },
  });
  commands.register({
    id: "stash.drawer",
    get title() { return "打开" + label("暂存盒") + "抽屉"; },
    keywords: "暂存盒 恶魔口袋 抽屉 侧栏 AI 结果 候选 插入 拖进正文",
    hint: "不离开正文，看这本书的 AI 结果，可以拖进正文",
    run: (opts = {}) => openDrawer(opts || {}),
  });
  commands.register({
    id: "stash.clean",
    get title() { return "按条件清理" + label("暂存盒"); },
    keywords: "暂存盒 批量删除 清理 30 天前 旧的",
    hint: "比如删掉 30 天前、没置顶的",
    when: onView,
    run: openCondDelete,
  });
  const here = () => onView() && !hasLayers();
  const typing = () => document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  commands.register({ id: "stash.undo", title: "撤销", keywords: "撤回 后悔 删错了", hint: "撤销刚才在" + label("暂存盒") + "里的删除、置顶、标签", key: "Mod-z", when: () => here() && !typing() && canUndoHere(), run: () => runUndo() });
  commands.register({ id: "stash.redo", title: "重做", keywords: "重做 撤销错了", key: "Mod-Shift-z", when: () => here() && !typing() && canRedoHere(), run: () => runRedo() });

  // 自动测试用（测试用假接口打开时才有）：别的模块还没接上抽屉时，测试能直接打开它
  try { if (localStorage.getItem("xemoMock") === "1") window.__xemoStash = { drawer: (o) => commands.run("stash.drawer", o) }; } catch (_) { /* 没有 localStorage 就算了 */ }
}
