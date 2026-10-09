// 创意度、思考程度的分档按钮：最左边「默认」，右边 5 格一格一格点亮；←→ 键逐级调。
// 两样用不同的记号（每套风格各画各的，见 ai.css），一眼分得清。
import { h } from "../../core/ui.js";
import { CREATIVITY, THINKING } from "../../core/ai.js";

const KINDS = { creativity: { label: "创意度", list: CREATIVITY }, thinking: { label: "思考程度", list: THINKING } };

/** levelPicker({ kind, value, onChange }) → 元素；el.value 读当前档，el.set(n) 改档，el.note(文字) 在下面显示一句说明 */
export function levelPicker({ kind, value = 0, onChange }) {
  const { label, list } = KINDS[kind];
  const name = h("b.ai-lv-name"), desc = h("span.ai-lv-desc"), note = h("span.ai-lv-note");
  const btn = (i) => h("button.ai-lv-b" + (i ? ".ai-lv-s" : ".ai-lv-0"), { type: "button", role: "radio", "data-i": String(i),
    title: `${list[i].name}：${list[i].desc}`, "aria-label": `${label}：${list[i].name}` }, i ? "" : "默认");
  const btns = list.map((_, i) => btn(i));
  const el = h("div.ai-lv", { role: "radiogroup", "aria-label": label, "data-kind": kind },
    h("span.ai-lv-k", {}, label), btns[0], h("span.ai-lv-steps", {}, ...btns.slice(1)),
    h("span.ai-lv-say", {}, name, desc), note);
  let cur = -1;
  const set = (n, fire) => {
    n = Math.max(0, Math.min(5, n | 0));
    const up = n > cur;
    btns.forEach((b, i) => {
      b.classList.toggle("on", i > 0 && i <= n);
      b.classList.toggle("cur", i === n);
      b.setAttribute("aria-checked", String(i === n));
      b.tabIndex = i === n ? 0 : -1;
    });
    if (cur >= 0 && n !== cur) {
      // 点亮或熄掉的那一格动一下
      const b = btns[up ? n : cur];
      b.classList.remove("pop", "drop");
      void b.offsetWidth;
      b.classList.add(up ? "pop" : "drop");
    }
    cur = n;
    el.dataset.level = String(n);
    name.textContent = list[n].name;
    desc.textContent = list[n].desc;
    if (fire && onChange) onChange(n);
  };
  btns.forEach((b, i) => b.addEventListener("click", () => set(i, true)));
  el.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    set(cur + d, true);
    btns[cur].focus();
  });
  btns.forEach((b) => b.addEventListener("animationend", () => b.classList.remove("pop", "drop")));
  set(value, false);
  Object.defineProperty(el, "value", { get: () => cur });
  el.set = (n) => set(n, false);
  el.note = (t) => { note.textContent = t || ""; note.hidden = !t; };
  el.note("");
  return el;
}
