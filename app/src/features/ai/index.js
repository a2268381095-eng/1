// AI 接入：接入界面（#/ai）、调用入口。选中调用的完整对比界面、提示词库、暂存盒在各自的模块里。
import { nav } from "../../core/nav.js";
import { commands } from "../../core/commands.js";
import { bus } from "../../core/bus.js";
import { h, icon, modal, toast } from "../../core/ui.js";
import { ws } from "../editor/workspace.js";
import { react, tip } from "../demon/demon.js";
import { renderSetup } from "./setup.js";
import { runAI } from "./runner.js";
import { renderSamples, sampleForm, samplesModal } from "./samples.js";

function renderAIView() {
  const back = h("button.icon-btn", { type: "button", "aria-label": "返回", title: "返回（Alt+←）", onclick: () => nav.back() }, icon("back"));
  const body = h("div.ai-view-body");
  document.getElementById("app").replaceChildren(h("div.view.ai-view", {},
    h("header.topbar", {}, back, h("span.title", {}, "AI 接入"), h("span.spacer"),
      h("button.tool-btn", { type: "button", "data-cmd": "prompts.open", onclick: () => commands.run("prompts.open") }, icon("prompt"), "提示词库"),
      h("button.tool-btn", { type: "button", "data-cmd": "stash.open", onclick: () => commands.run("stash.open") }, icon("box"), "暂存盒")),
    h("main.ai-view-main", {}, h("p.muted.ai-lead", {}, "选一家，粘贴 Key，拉取模型，测试通过就能用。软件不预设模型和提示词，每次调用前都会让你确认。"), body)));
  renderSetup(body);
  // 文风样本也在这一页管
  const ss = h("div.ss-box");
  body.after(h("section.ai-samples", {}, h("h2.ai-samples-h", {}, "文风样本"), ss));
  renderSamples(ss);
  tip("ai-setup", "选一家粘贴 Key 就行。Key 只存在你电脑上，我帮你看着。");
}

/** 正文里选中的一段存成文风样本 */
async function selectionAsSample() {
  const v = ws.editor && ws.editor.view;
  const sel = v ? v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) : "";
  if (!sel.trim()) { toast("先在正文里选中一段文字"); return; }
  await sampleForm(null, sel);
}

export function register() {
  nav.route("ai", "/ai", renderAIView);
  commands.register({ id: "ai.setup", title: "接入 AI", keywords: "AI Key 模型 ofox claude gpt gemini deepseek grok 接口", hint: "粘贴 Key、拉取模型、测试", run: () => nav.go("/ai") });
  commands.register({ id: "samples.fromSelection", title: "存为文风样本", keywords: "文风 样本 模仿 语气 句式 AI", hint: "把选中的一段存起来，调用 AI 时可以让它照着写", when: () => !!ws.book && !!ws.editor, run: selectionAsSample });
  commands.register({ id: "samples.open", title: "文风样本", keywords: "文风 样本 模仿 AI", hint: "管理存下来的文风样本", run: () => samplesModal() });
  bus.on("ai:start", () => react("ai_wait", { force: true }));
  bus.on("ai:error", () => react("ai_error", { force: true }));
}
