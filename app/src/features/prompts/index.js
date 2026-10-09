// 提示词库：软件不带任何提示词，全是作者自己写的。新建、命名、分组、排序（固定 + 按用得多少）、复制、删除、导入导出，支持变量。
// 独立界面 #/prompts；调用 AI 的确认卡里点「管理提示词库」时，在当前界面上弹窗管理（commands.run("prompts.manage", { feature })，关掉时 resolve）。
// 命令：prompts.open、prompts.manage、prompts.new、prompts.undo / prompts.redo。改动都能撤销，批量的算一步。
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { h, icon, modal, toast, hasLayers, topLayer } from "../../core/ui.js";
import { FEATURES } from "../../core/stash.js";
import { tip } from "../demon/demon.js";
import { createManager, updateAllButtons } from "./manager.js";
import { openForm } from "./form.js";
import * as ops from "./ops.js";

const TIP = "提示词全是你自己写的。正文里放 {选中文本} 这类变量，调用 AI 时自动填进去。";

let page = null;                 // { view, main, mgr }
const manageLayers = new Set();  // 开着的「管理提示词库」弹窗

const onPage = () => { const c = nav.current(); return !!(c && c.name === "prompts" && page && page.view.isConnected); };
const here = () => (onPage() && !hasLayers()) || manageLayers.has(topLayer());
const typing = () => document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);

// ---------------- 独立界面 ----------------
async function renderPage(params, restore) {
  const back = h("button.icon-btn", { type: "button", title: "返回（Alt+←）", "aria-label": "返回" }, icon("back"));
  back.addEventListener("click", () => nav.back());
  const host = h("div.pr-page-root");
  const main = h("main.pr-main", {}, h("div.pr-wrap", {}, host));
  const view = h("div.view.pr-view", {}, h("header.topbar", {}, back, h("span.title.pr-title", {}, "提示词库")), main);
  document.getElementById("app").replaceChildren(view);
  if (page) page.mgr.destroy();
  page = { view, main, mgr: createManager(host, { scrollEl: main }) };
  await page.mgr.ready;
  if (restore && restore.prScroll) main.scrollTop = restore.prScroll;
  tip("prompts-first", TIP);
}

// ---------------- 在当前界面上弹窗管理 ----------------
function openManage(opts = {}) {
  const feature = (opts && opts.feature) || "";
  return new Promise((resolve) => {
    const host = h("div.pr-manage");
    let mgr = null;
    const m = modal({
      title: "提示词库" + (FEATURES[feature] ? " · " + FEATURES[feature] : ""),
      body: host, wide: true,
      onClose: () => { manageLayers.delete(m.layer); if (mgr) mgr.destroy(); updateAllButtons(); resolve(); },
    });
    m.el.classList.add("pr-modal");
    manageLayers.add(m.layer);
    // 弹窗里按 Ctrl+Z / Ctrl+Shift+Z 只撤提示词库的改动，不碰后面界面里的东西
    m.el.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229 || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "z" || typing()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) ops.runRedo(); else ops.runUndo();
    });
    mgr = createManager(host, { feature, scrollEl: m.body });
    tip("prompts-first", TIP);
  });
}

/** 从命令面板直接写一条（不离开当前界面） */
async function quickNew() {
  const r = await openForm({});
  if (r) toast(`已存进提示词库：「${r.row.name}」`, { action: { label: "撤销", run: () => ops.runUndo(r.entry) } });
}

export async function register() {
  nav.route("prompts", "/prompts", (params, restore) => renderPage(params, restore));
  nav.onLeave(() => (onPage() ? { prScroll: page.main.scrollTop } : {}));
  bus.on("route", ({ name }) => { if (name !== "prompts" && page) { page.mgr.destroy(); page = null; } });
  ops.trackUndo(updateAllButtons);

  const kw = "提示词 prompt 模板 指令 咒语 变量 分组 常用 导入 导出 AI";
  commands.register({ id: "prompts.open", title: "提示词库", keywords: kw, hint: "写给 AI 的话：分组、排序、导入导出", run: () => nav.go("/prompts") });
  commands.register({ id: "prompts.manage", title: "管理提示词库（弹窗）", keywords: kw + " 管理", hint: "在当前界面上弹窗改，不离开手上的事", run: (opts) => openManage(opts) });
  commands.register({ id: "prompts.new", title: "新建提示词", keywords: "提示词 新建 写一条 prompt 模板", hint: "写一条自己的提示词，存进库里", run: () => quickNew() });
  commands.register({ id: "prompts.undo", title: "撤销", keywords: "撤回 后悔 删错了", hint: "撤销刚才在提示词库里的改动", key: "Mod-z",
    when: () => here() && !typing() && ops.canUndoHere(), run: () => ops.runUndo() });
  commands.register({ id: "prompts.redo", title: "重做", keywords: "重做 撤销错了", key: "Mod-Shift-z",
    when: () => here() && !typing() && ops.canRedoHere(), run: () => ops.runRedo() });
}
