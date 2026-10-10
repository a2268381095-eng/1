// 界面通用件：弹窗、浮层、提示条、中文报错卡、帮助小问号。
// 所有浮层都登记在一个栈里：Esc 关最上面一层；有改了一半的内容时先问「保留草稿 / 丢弃」。
import { escapeHtml } from "./text.js";
import { db } from "./db.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 小工具：h("div.cls#id", {attrs}, ...children) 造元素 */
export function h(tag, attrs = {}, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || "div");
  for (const r of rest) {
    if (r[0] === ".") el.classList.add(r.slice(1));
    else if (r[0] === "#") el.id = r.slice(1);
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "html") el.innerHTML = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const icon = (name) => {
  const paths = {
    back: "M15 18l-6-6 6-6",
    close: "M6 6l12 12M18 6L6 18",
    plus: "M12 5v14M5 12h14",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
    format: "M4 6h16M8 10h12M4 14h16M8 18h12",
    history: "M12 7v5l3 2M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4",
    list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
    check: "M5 12l4 4 10-10",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z",
    focus: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
    redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3",
    upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
    box: "M4 8l8-4 8 4v9l-8 4-8-4zM4 8l8 4 8-4M12 12v9",
    prompt: "M5 4h14v12H10l-5 4V4zM9 9h6M9 12h4",
    chat: "M3 5h12v8H8l-5 4V5zM9 16v1h7l4 3V10h-3",
    download: "M12 4v12M7 11l5 5 5-5M4 20h16",
    book: "M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4zM5 16a4 4 0 0 1 4-4h10",
    flag: "M5 21V4h11l-2 4 2 4H5",
    drag: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
    more: "M6 12h.01M12 12h.01M18 12h.01",
    help: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
    brush: "M18.5 3.5a2.1 2.1 0 0 1 3 3L12 16l-3-3zM8 14.5c-2 0-3.5 1.4-3.5 3.3 0 1.1-.6 1.9-1.5 2.4 1 .6 2.3.8 3.5.8 2.6 0 4.5-1.8 4.5-4.2z",
    lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 14.5v2",
    crop: "M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14",
    zoom: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    refresh: "M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5",
    chart: "M3 20h18M6 17v-5M11 17V6M16 17v-8M21 17v-3",
    board: "M3 4h18v16H3zM9 4v16M15 4v16M5 7h2.5M5 10h2.5M11 7h2.5M17 7h2.5M17 10h2.5M17 13h2.5",
    lore: "M3 6h18v13H3zM9 9.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM5.8 17c.6-1.5 1.8-2.3 3.2-2.3s2.6.8 3.2 2.3M14 10h4M14 13.5h3",
    image: "M4 5h16v14H4zM8.5 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM20 15l-5-5-9 9",
    pin: "M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11zM12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    ladder: "M8 3v18M16 3v18M8 7h8M8 12h8M8 17h8",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
    grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    pen: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
    shirt: "M8 4l4 2 4-2 4 4-3 3v9H7v-9L4 8z",
  };
  const span = document.createElement("span");
  span.className = "ico";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] || ""}"/></svg>`;
  return span;
};

// ---------------- 浮层栈 ----------------
const layers = [];

/**
 * 登记一个浮层（弹窗、侧面板、下拉菜单）。
 * opts.onClose()    真正关闭时调用（负责把元素移走）
 * opts.isDirty()    返回 true 表示里面有改了一半的东西，关闭前要问
 * opts.onKeepDraft() 选「保留草稿」时调用（把草稿存起来）
 * 返回 { close(force) }
 */
export function pushLayer(opts) {
  const layer = { ...opts, closed: false };
  layer.close = async (force = false) => {
    if (layer.closed) return true;
    if (!force && layer.isDirty && layer.isDirty()) {
      const choice = await choose({
        title: "里面还有没保存的内容",
        body: "关掉之前，要把它留着下次接着用吗？",
        buttons: [{ id: "keep", label: "保留草稿", primary: true }, { id: "discard", label: "丢弃" }, { id: "cancel", label: "先不关" }],
      });
      if (choice === "cancel" || choice == null) return false;
      if (choice === "keep" && layer.onKeepDraft) await layer.onKeepDraft();
    }
    layer.closed = true;
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    layer.onClose && layer.onClose();
    return true;
  };
  layers.push(layer);
  return layer;
}

export const topLayer = () => layers[layers.length - 1] || null;
export const hasLayers = () => layers.length > 0;

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
  const top = topLayer();
  if (top) { e.preventDefault(); e.stopPropagation(); top.close(); }
}, true);

// ---------------- 弹窗 ----------------
/** 通用弹窗。返回 { el, body, close } ；opts: { title, body(Node|string), wide, isDirty, onClose, actions:[{label, primary, onClick}] } */
export function modal(opts) {
  const body = h("div.modal-body");
  if (opts.body instanceof Node) body.append(opts.body);
  else if (opts.body) body.innerHTML = opts.body;
  const closeBtn = h("button.icon-btn.modal-x", { type: "button", "aria-label": "关闭", title: "关闭（Esc）" }, icon("close"));
  const foot = h("div.modal-foot");
  const box = h("div.modal" + (opts.wide ? ".wide" : ""), { role: "dialog", "aria-modal": "true", "aria-label": opts.title || "" },
    h("div.modal-head", {}, h("h2.modal-title", {}, opts.title || ""), closeBtn), body, foot);
  const back = h("div.modal-back", {}, box);
  document.body.append(back);
  const prevFocus = document.activeElement;
  const layer = pushLayer({
    isDirty: opts.isDirty,
    onKeepDraft: opts.onKeepDraft,
    onClose: () => { back.remove(); opts.onClose && opts.onClose(); if (prevFocus && prevFocus.focus) prevFocus.focus(); },
  });
  closeBtn.addEventListener("click", () => layer.close());
  back.addEventListener("mousedown", (e) => { if (e.target === back) layer.close(); });
  (opts.actions || []).forEach((a) => {
    const b = h("button.btn" + (a.primary ? ".primary" : "") + (a.danger ? ".danger" : ""), { type: "button" }, a.label);
    b.addEventListener("click", () => a.onClick && a.onClick(layer));
    foot.append(b);
  });
  if (!foot.childElementCount) foot.remove();
  setTimeout(() => {
    const f = box.querySelector("[autofocus], input, textarea, select, .btn.primary") || closeBtn;
    f.focus();
  }, 0);
  return { el: box, body, foot, layer, close: (force) => layer.close(force) };
}

/** 几个按钮选一个，返回按钮 id；关掉返回 null */
export function choose({ title, body, buttons }) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({
      title,
      body: h("p.modal-text", {}, body || ""),
      onClose: () => resolve(result),
      actions: buttons.map((b) => ({ label: b.label, primary: b.primary, danger: b.danger, onClick: () => { result = b.id; m.close(true); } })),
    });
  });
}

export const confirm = (title, body, okLabel = "确定", danger = false) =>
  choose({ title, body, buttons: [{ id: "ok", label: okLabel, primary: !danger, danger }, { id: "cancel", label: "取消" }] }).then((r) => r === "ok");

/** 输入一行文字 */
export function prompt(title, value = "", placeholder = "") {
  return new Promise((resolve) => {
    let result = null;
    const input = h("input.input", { value, placeholder, autofocus: true });
    const m = modal({
      title, body: input, onClose: () => resolve(result),
      actions: [{ label: "确定", primary: true, onClick: () => { result = input.value; m.close(true); } }, { label: "取消", onClick: () => m.close(true) }],
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !(e.isComposing || e.keyCode === 229)) { e.preventDefault(); result = input.value; m.close(true); } });
    setTimeout(() => input.select(), 0);
  });
}

// ---------------- 提示条 ----------------
let toastBox = null;
/** toast("已删除", { action: { label: "撤销", run }, actions: [{ label, run }, ...], timeout }) */
export function toast(msg, opts = {}) {
  if (!toastBox) { toastBox = h("div.toasts", { role: "status", "aria-live": "polite" }); document.body.append(toastBox); }
  const t = h("div.toast", {}, h("span.toast-msg", {}, msg));
  let timer;
  const close = () => { clearTimeout(timer); t.classList.add("out"); setTimeout(() => t.remove(), 200); };
  for (const a of [...(opts.actions || []), ...(opts.action ? [opts.action] : [])]) {
    const b = h("button.toast-act", { type: "button" }, a.label);
    b.addEventListener("click", async () => { close(); await a.run(); });
    t.append(b);
  }
  const x = h("button.icon-btn.toast-x", { type: "button", "aria-label": "关闭提示" }, icon("close"));
  x.addEventListener("click", close);
  t.append(x);
  toastBox.append(t);
  timer = setTimeout(close, opts.timeout || (opts.action || opts.actions ? 8000 : 3500));
  return { close };
}

// ---------------- 中文报错卡 ----------------
/**
 * 出错时统一用这个：出了什么事 / 可能的原因 / 现在可以怎么做（按钮）+ 折叠的详细信息。
 * notice({ what, why, actions: [{ label, run, primary }], detail })
 * 同时记进「报错记录」（kv "errlog"）。
 */
export async function notice({ what, why, actions = [], detail = "" }) {
  try {
    const log = await db.getKV("errlog", []);
    log.unshift({ at: Date.now(), what, why, detail: String(detail || "") });
    await db.setKV("errlog", log.slice(0, 200));
  } catch (_) { /* 记录失败不影响提示 */ }
  const body = h("div.notice",
    {},
    h("p.notice-what", {}, what),
    why ? h("p.notice-why", {}, h("b", {}, "可能的原因："), why) : null,
    detail ? h("details.notice-detail", {}, h("summary", {}, "详细信息"), h("pre", {}, String(detail))) : null);
  const m = modal({
    title: "出了点问题",
    body,
    actions: [...actions.map((a) => ({ label: a.label, primary: a.primary, onClick: async () => { m.close(true); await a.run(); } })),
      { label: "知道了", primary: !actions.length, onClick: () => m.close(true) }],
  });
  return m;
}

/** 设置项旁边的小问号，悬停显示用途 */
export function helpTip(text) {
  const b = h("span.help-tip", { tabindex: "0", role: "img", "aria-label": text, "data-tip": text }, "?");
  return b;
}

export { escapeHtml };

// 滑块：渐变填到当前值（lively.css 用 --p）。拖动时更新；新出现的滑块也补上
function fillRange(el) {
  const min = Number(el.min) || 0, max = Number(el.max) || 100, v = Number(el.value);
  el.style.setProperty("--p", (((v - min) / (max - min || 1)) * 100).toFixed(1) + "%");
}
if (typeof document !== "undefined") {
  document.addEventListener("input", (e) => { if (e.target instanceof HTMLInputElement && e.target.type === "range") fillRange(e.target); }, true);
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (!(n instanceof Element)) continue;
      if (n.matches('input[type="range"]')) fillRange(n);
      n.querySelectorAll && n.querySelectorAll('input[type="range"]').forEach(fillRange);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
