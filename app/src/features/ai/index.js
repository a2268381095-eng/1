// AI 接入：接入界面（#/ai）、调用入口。选中调用的完整对比界面、提示词库、暂存盒在各自的模块里。
import { nav } from "../../core/nav.js";
import { commands } from "../../core/commands.js";
import { bus } from "../../core/bus.js";
import { h, icon, modal, toast } from "../../core/ui.js";
import { ws } from "../editor/workspace.js";
import { react, tip } from "../demon/demon.js";
import { renderSetup } from "./setup.js";
import { runAI } from "./runner.js";

function renderAIView() {
  const back = h("button.icon-btn", { type: "button", "aria-label": "返回", title: "返回（Alt+←）", onclick: () => nav.back() }, icon("back"));
  const body = h("div.ai-view-body");
  document.getElementById("app").replaceChildren(h("div.view.ai-view", {},
    h("header.topbar", {}, back, h("span.title", {}, "AI 接入")),
    h("main.ai-view-main", {}, h("p.muted.ai-lead", {}, "选一家，粘贴 Key，拉取模型，测试通过就能用。软件不预设模型和提示词，每次调用前都会让你确认。"), body)));
  renderSetup(body);
  tip("ai-setup", "选一家粘贴 Key 就行。Key 只存在你电脑上，我帮你看着。");
}

/** 选中一段正文让 AI 处理（简单版：结果在弹窗里看，可以替换选中的文字；完整的对比采用界面在 rewrite 模块） */
async function rewriteSelection() {
  if (!ws.editor || !ws.current) { toast("先打开一章，选中一段文字"); return; }
  const v = ws.editor.view;
  const { from, to } = v.state.selection.main;
  const input = v.state.sliceDoc(from, to);
  if (!input.trim()) { toast("先在正文里选中一段文字"); return; }
  const out = h("div.ai-stream");
  let m = null;
  const r = await runAI({
    feature: "rewrite", bookId: ws.book.id, ref: ws.current.id, input, inputLabel: "选中的文字",
    vars: { 本章要点: (ws.current.points || []).map((p) => "- " + p.text).join("\n"), 章名: ws.current.title || "", 书名: ws.book.title },
    title: ws.fullTitle(ws.current) + " · 选中调用",
    onDelta: (piece, text) => {
      if (!m) m = modal({ title: "AI 回来了", body: out, wide: true });
      out.textContent = text;
    },
  });
  if (!r) { if (m) m.close(true); return; }
  if (!m) m = modal({ title: "AI 回来了", body: out, wide: true });
  out.textContent = r.text;
  const replaceBtn = h("button.btn.primary", { type: "button" }, "替换选中的文字");
  replaceBtn.addEventListener("click", async () => {
    const before = ws.editor.getText();
    if (before.slice(from, to) !== input) { toast("原文已经改动过，没法直接替换，结果已存进暂存盒"); return; }
    await ws.applyBatch("采用 AI 结果", [{ chapterId: ws.current.id, after: before.slice(0, from) + r.text + before.slice(to) }]);
    m.close(true);
    toast("已替换", { action: { label: "撤销", run: () => commands.run("edit.undo") } });
  });
  m.foot.replaceChildren(replaceBtn, h("button.btn", { type: "button", onclick: () => m.close(true) }, "先放着（已进暂存盒）"));
  if (!m.foot.isConnected) m.el.append(m.foot);
}

export function register() {
  nav.route("ai", "/ai", renderAIView);
  commands.register({ id: "ai.setup", title: "接入 AI", keywords: "AI Key 模型 ofox claude gpt gemini deepseek grok 接口", hint: "粘贴 Key、拉取模型、测试", run: () => nav.go("/ai") });
  commands.register({ id: "ai.rewrite", title: "用 AI 处理选中的文字", keywords: "AI 改写 润色 扩写 选中 调用", hint: "先在正文里选中一段", key: "Mod-j", when: () => !!ws.book, run: rewriteSelection });
  bus.on("ai:start", () => react("ai_wait", { force: true }));
  bus.on("ai:error", () => react("ai_error", { force: true }));
}
