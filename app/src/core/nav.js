// 界面切换和「返回」。
// 地址栏用 #/ 记录当前界面：#/ 书架，#/book/<id> 作品，#/book/<id>/<章id> 某一章，#/settings 设置，#/trash 回收站。
// 返回：左上角按钮、Alt+←、鼠标侧键都走浏览器历史，回到进来之前的界面，滚动位置和光标都还原。
import { bus } from "./bus.js";

const routes = [];          // [{ name, pattern: RegExp, keys: [...], render(params, restore) }]
const saved = new Map();    // 每个地址离开时的滚动位置、光标等 { [hash]: state }
const savers = new Set();   // 离开前收集状态的函数：() => partialState
let current = null;         // { name, params, hash }

export const nav = {
  /** 注册界面。pattern 写成 "/book/:bookId/:chapterId?" 这样。render(params, restoreState) */
  route(name, pattern, render) {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/\/:(\w+)(\?)?/g, (_, k, opt) => { keys.push(k); return opt ? "(?:/([^/]+))?" : "/([^/]+)"; }) + "/?$");
    routes.push({ name, re, keys, render });
  },

  /** 进入一个新界面（会留下历史，可以返回） */
  go(path, { replace = false } = {}) {
    remember();
    const hash = "#" + path;
    if (location.hash === hash) return render();
    const depth = (history.state && history.state.depth) || 0;
    if (replace) history.replaceState({ depth }, "", hash);
    else history.pushState({ depth: depth + 1 }, "", hash);
    return render();
  },

  /** 返回上一个界面；已经是第一个界面了就回书架 */
  back() {
    if (history.state && history.state.depth > 0) history.back();   // popstate 里会记住当前位置
    else if (location.hash !== "#/") nav.go("/", { replace: true });
  },

  /** 各界面注册「离开前要记住什么」，比如编辑器的光标、列表的滚动位置 */
  onLeave(fn) { savers.add(fn); return () => savers.delete(fn); },

  current: () => current,
  has: (name) => routes.some((r) => r.name === name),
  start() {
    window.addEventListener("popstate", () => { remember(); render(); });
    if (!history.state) history.replaceState({ depth: 0 }, "", location.hash || "#/");
    return render();
  },
};

function remember() {
  if (!current) return;
  const state = {};
  for (const fn of savers) Object.assign(state, fn() || {});
  saved.set(current.hash, state);
}

async function render() {
  const path = location.hash.slice(1) || "/";
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { if (m[i + 1]) params[k] = decodeURIComponent(m[i + 1]); });
    const prev = current;
    current = { name: r.name, params, hash: location.hash };
    await r.render(params, saved.get(location.hash) || null, prev);
    bus.emit("route", { name: r.name, params });
    return;
  }
  history.replaceState(null, "", "#/");
  return render();
}

// Alt+← 返回；鼠标侧键（后退键）返回。浏览器自己也会处理，这里只在桌面版里接管。
const isDesktopShell = !!window.__TAURI__;
window.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowLeft" && isDesktopShell) { e.preventDefault(); nav.back(); }
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 3 && isDesktopShell) { e.preventDefault(); nav.back(); }
});
