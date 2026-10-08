// 小恶魔文书 · 启动
import { db } from "./core/db.js";
import { bus } from "./core/bus.js";
import { nav } from "./core/nav.js";
import { commands, setCustomKeys } from "./core/commands.js";
import { loadSettings, getSettings } from "./core/settings.js";
import { purgeOldTrash } from "./core/store.js";
import { notice, toast } from "./core/ui.js";
import { mountDemon } from "./features/demon/demon.js";
import { registerShelf } from "./features/shelf/shelf.js";
import { registerWorkspace } from "./features/editor/workspace.js";
import { registerFeatures } from "./features/index.js";

/** 主题、字体这些跟着设置走的东西 */
export function applyLook() {
  const s = getSettings();
  const root = document.documentElement;
  if (s.theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", s.theme);
  const fonts = {
    system: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    serif: '"Noto Serif SC", "Songti SC", "SimSun", serif',
    sans: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    kai: '"LXGW WenKai TC", "KaiTi", "STKaiti", serif',
    kuaile: '"ZCOOL KuaiLe", "Noto Sans SC", sans-serif',
  };
  const pick = (id) => fonts[id] || `"${id}", ${fonts.serif}`;
  root.style.setProperty("--f-ui", s.uiFont === "system" ? fonts.system : pick(s.uiFont));
  root.style.setProperty("--f-text", pick(s.textFont));
  root.style.setProperty("--text-size", s.textSize + "px");
  root.style.setProperty("--text-lh", String(s.lineHeight));
  root.style.setProperty("--text-width", s.textWidth + "px");
  setCustomKeys(s.keys);
}

async function start() {
  try {
    await db.open();
  } catch (e) {
    notice({
      what: "本地数据库打不开，写的东西没法保存。",
      why: "浏览器开了无痕模式、禁止了网站存储，或者另一个窗口正在用。",
      detail: e && (e.stack || e.message || e),
      actions: [{ label: "刷新重试", primary: true, run: () => location.reload() }],
    });
    return;
  }
  await loadSettings();
  applyLook();
  bus.on("settings:changed", applyLook);
  mountDemon(document.body);
  registerShelf();
  registerWorkspace();
  await registerFeatures();
  await nav.start();
  bus.emit("app:open", {});
  purgeOldTrash().catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

window.addEventListener("error", (e) => console.error(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  toast("出了点小问题：" + ((e.reason && e.reason.message) || e.reason));
});

start();
export { commands };
