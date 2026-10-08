// 本章要点：写之前记下这章要写什么，写的时候对照，写完逐条打勾。没打勾的会在章节列表里提示。
import { h, icon } from "../../core/ui.js";
import { uid } from "../../core/db.js";
import { tip } from "../demon/demon.js";
import { commands } from "../../core/commands.js";
import { ws } from "./workspace.js";

/** 在 root 里画要点面板；onChange(points) 保存 */
export function renderPoints(root, chapter, onChange) {
  let points = (chapter.points || []).map((p) => ({ ...p }));
  const list = h("ol.pt-list");
  const input = h("input.input.pt-add", { placeholder: "加一条要点，回车", "aria-label": "新要点" });
  const count = h("span.pt-count");
  const sum = h("textarea.textarea.pt-summary", { rows: "4", placeholder: "这一章写了什么（自己写，或者让 AI 写）。写下一章时可以用 {前一章摘要} 代替整章发给 AI，省 token。", "aria-label": "本章摘要" });
  sum.value = chapter.summary || "";
  let sumTimer = 0;
  sum.addEventListener("input", () => { clearTimeout(sumTimer); sumTimer = setTimeout(() => ws.patchChapter(chapter.id, { summary: sum.value }), 500); });
  const sumAI = h("button.btn.small.ghost", { type: "button", title: "用便宜的模型写个摘要，写好后可以反复用" }, "AI 写摘要");
  sumAI.addEventListener("click", () => commands.run("chapter.summaryAI"));
  root.replaceChildren(
    h("div.panel-head", {}, h("h3", {}, "本章要点"), count),
    h("div.panel-body.pt-body", {}, list, input,
      h("p.pt-note.muted", {}, "写之前列几条这章要写到的事，写完逐条打勾。"),
      h("div.pt-sum-head", {}, h("h3", {}, "本章摘要"), sumAI), sum));

  const save = () => { onChange(points.map((p) => ({ ...p }))); renderAll(); };
  let dragIdx = -1;

  function renderAll() {
    list.textContent = "";
    const done = points.filter((p) => p.done).length;
    count.textContent = points.length ? `${done} / ${points.length}` : "";
    points.forEach((p, i) => {
      const cb = h("input", { type: "checkbox", "aria-label": "完成" });
      cb.checked = !!p.done;
      cb.addEventListener("change", () => { p.done = cb.checked; save(); });
      const text = h("span.pt-text", { contenteditable: "plaintext-only", spellcheck: "false", role: "textbox", "aria-label": "要点内容" }, p.text);
      text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); text.blur(); } });
      text.addEventListener("blur", () => {
        const v = text.textContent.trim();
        if (!v) { points.splice(i, 1); save(); return; }
        if (v !== p.text) { p.text = v; save(); }
      });
      const del = h("button.icon-btn.pt-del", { type: "button", "aria-label": "删掉这条", title: "删掉这条" }, icon("close"));
      del.addEventListener("click", () => { points.splice(i, 1); save(); });
      const li = h("li.pt-item" + (p.done ? ".done" : ""), { draggable: "true" }, h("label.check", {}, cb), text, del);
      li.addEventListener("dragstart", (e) => { dragIdx = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "pt"); });
      li.addEventListener("dragover", (e) => { if (dragIdx >= 0) { e.preventDefault(); li.classList.add("drop-before"); } });
      li.addEventListener("dragleave", () => li.classList.remove("drop-before"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        li.classList.remove("drop-before");
        if (dragIdx < 0 || dragIdx === i) return;
        const [m] = points.splice(dragIdx, 1);
        points.splice(dragIdx < i ? i - 1 : i, 0, m);
        dragIdx = -1;
        save();
      });
      list.append(li);
    });
    if (!points.length) list.append(h("li.pt-empty.muted", {}, "还没有要点"));
  }

  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const v = input.value.trim();
    if (!v) return;
    points.push({ id: uid("p"), text: v, done: false });
    input.value = "";
    save();
    tip("points-first", "要点记好了。写完一条就打个勾，全打完我会夸你的。");
  });
  renderAll();
}
