// 鼠标停在按钮、功能入口上一小会儿，小恶魔用她这套风格的口吻讲一句这个功能是干什么的。
// 名字和说明取自命令表（data-cmd 对应的 title、hint），没有登记的按钮用它自己的 title / aria-label。
// 同一个功能这次打开软件只讲一遍；打字时、拖动时、开着弹窗时不讲；设置 demonGuide 关掉就不讲。
import { commands } from "../../core/commands.js";
import { getSettings } from "../../core/settings.js";
import { guideSay } from "./demon.js";

const DWELL = 850;      // 停多久开口
const GAP = 2500;       // 两句之间至少隔多久
const TARGETS = "[data-cmd], [data-guide], .tool-btn, .icon-btn[title], .btn[title], .demon-btn";

let timer = 0, cur = null, last = 0, lastKey = 0;
const told = new Set();

function infoOf(el) {
  const id = el.dataset.cmd;
  const c = id && commands.get(id);
  const own = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent.trim();
  const name = el.dataset.guideName || (c && c.title) || own;
  let hint = el.dataset.guide || (c && c.hint) || "";
  const title = el.getAttribute("title") || "";
  if (!hint && title && title !== name) hint = title.replace(name, "").replace(/^[：:，,\s]+/, "");
  return { key: id || name, name: String(name || "").slice(0, 16), hint: String(hint || "").slice(0, 40) };
}

function speak(el) {
  timer = 0;
  if (!el.isConnected || el !== cur || getSettings().demonGuide === "off") return;
  if (performance.now() - lastKey < 3000 || document.body.classList.contains("scene-typing")) return;
  if (document.querySelector(".modal-back") && !el.closest(".modal")) return;
  const { key, name, hint } = infoOf(el);
  if (!name || told.has(key)) return;
  if (performance.now() - last < GAP) return;
  if (guideSay(name, hint)) { told.add(key); last = performance.now(); }
}

export function mountGuide() {
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const t = e.target instanceof Element ? e.target.closest(TARGETS) : null;
    if (t === cur) return;
    cur = t;
    clearTimeout(timer); timer = 0;
    if (t && !t.disabled) timer = setTimeout(() => speak(t), DWELL);
  }, { passive: true });
  document.addEventListener("pointerdown", () => { clearTimeout(timer); timer = 0; }, true);
  document.addEventListener("keydown", () => { lastKey = performance.now(); clearTimeout(timer); timer = 0; }, true);
  commands.register({ id: "demon.guide", title: "鼠标停在功能上时小恶魔讲解", keywords: "讲解 引导 提示 悬停 介绍 小恶魔", hint: "开 / 关",
    run: async () => {
      const { setSettings } = await import("../../core/settings.js");
      const on = getSettings().demonGuide !== "off";
      await setSettings({ demonGuide: on ? "off" : "on" });
      if (!on) told.clear();
    } });
}
