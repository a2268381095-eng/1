// 设定库的小零件：贴着按钮弹出的浮层、菜单、点一下就能改的文字、加标签的小输入框。
// 都登记在浮层栈里（Esc 关最上层），改了一半关掉时问「保留草稿 / 丢弃」。
import { h, icon, pushLayer, toast } from "../../core/ui.js";
import { undo as appUndo } from "../../core/undo.js";

export const composing = (e) => e.isComposing || e.keyCode === 229;
/** CSS 变量写成 style 字符串（h() 的 style 对象设不了 --变量） */
export const vars = (o) => Object.entries(o).filter(([, v]) => v != null && v !== "")
  .map(([k, v]) => `${k}: ${String(v).replace(/[^#\w(),.\s%-]/g, "")}`).join("; ");
export const typing = () => { const a = document.activeElement; return !!a && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };
const modalOpen = () => !!document.querySelector(".modal-back");

/** 「已删除 · 撤销」这类提示条 */
export function undoToast(msg, entry) {
  if (!entry) return toast(msg);
  return toast(msg, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
}

/** 让一个元素按当前风格闪一下（保存、采用之后） */
export function flash(el, cls = "lr-saved") {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 1300);
}

function placeNear(el, anchor) {
  if (!anchor || !anchor.isConnected) return;
  const r = anchor.getBoundingClientRect();
  const below = innerHeight - r.bottom - 14, above = r.top - 14;
  el.style.maxHeight = "";
  const ht = el.scrollHeight + 2;
  const down = ht <= below || below >= above;
  const room = Math.max(140, down ? below : above);
  el.style.maxHeight = Math.min(room, Math.round(innerHeight * 0.8)) + "px";
  const w = el.offsetWidth, hh = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  el.style.top = (down ? r.bottom + 6 : Math.max(8, r.top - hh - 6)) + "px";
}

/**
 * 贴着 anchor 弹出一块。点外面、Esc 关。再点一次 anchor 也是关。
 * opts: { cls, env（登记到设定库，界面关掉时一起关）, isDirty, onKeepDraft, onClose, label }
 */
export function popover(anchor, content, opts = {}) {
  if (anchor && anchor._lrPop) { anchor._lrPop.close(); return null; }
  const el = h("div.lr-pop" + (opts.cls || ""), { role: "dialog", "aria-label": opts.label || "" }, content);
  document.body.append(el);
  placeNear(el, anchor);
  const off = (e) => { if (!el.contains(e.target) && !(anchor && anchor.contains(e.target)) && !e.target.closest(".modal-back")) layer.close(); };
  const re = () => placeNear(el, anchor);
  const layer = pushLayer({
    isDirty: opts.isDirty,
    onKeepDraft: opts.onKeepDraft,
    onClose: () => {
      el.remove();
      if (ro) ro.disconnect();
      if (anchor) anchor._lrPop = null;
      document.removeEventListener("mousedown", off, true);
      window.removeEventListener("resize", re);
      if (opts.env) opts.env.layers.delete(layer);
      opts.onClose && opts.onClose();
    },
  });
  if (opts.env) opts.env.layers.add(layer);
  if (anchor) anchor._lrPop = layer;
  setTimeout(() => document.addEventListener("mousedown", off, true), 0);
  window.addEventListener("resize", re);
  // 里面的东西变多变少（搜索结果）时重新找位置
  let ro = null, lastH = 0;
  if (window.ResizeObserver) {
    ro = new ResizeObserver(() => { const hh = el.scrollHeight; if (Math.abs(hh - lastH) > 2) { lastH = hh; re(); } });
    [...el.children].forEach((c) => ro.observe(c));
  }
  setTimeout(() => {
    const f = el.querySelector("[autofocus], input, textarea, select, button");
    if (f) f.focus();
  }, 0);
  return { el, layer, close: (force) => layer.close(force), place: re };
}

/** 小菜单：items = [[文字, fn, { danger, disabled, title }] | "sep"] */
export function menu(anchor, items, env) {
  const box = h("div.menu.lr-menu", { role: "menu" });
  let p = null;
  items.filter(Boolean).forEach((it) => {
    if (it === "sep") { box.append(h("div.menu-sep")); return; }
    const [text, fn, o = {}] = it;
    const b = h("button.menu-item" + (o.danger ? ".danger" : ""), { type: "button", role: "menuitem", disabled: !!o.disabled, title: o.title || null }, text);
    b.addEventListener("click", () => { p.close(true); fn(); });
    box.append(b);
  });
  p = popover(anchor, box, { cls: ".lr-pop-menu", env });
  return p;
}

/**
 * 点一下就能改的文字。host 是显示用的元素（div / span），get() 取当前值，save(v) 保存（返回 Promise）。
 * opts: { long 多行, placeholder, env, max, onOpen, onDone, empty（空着时显示的字） }
 * 回车保存（多行时 Ctrl+回车），点别处也保存；Esc 关，改过的会问「保留草稿 / 丢弃」。
 */
export function editable(host, { get, save, long = false, placeholder = "", env, max = 4000, empty = "点击填写", cls = "" }) {
  host.classList.add("lr-ed");
  host.tabIndex = 0;
  host.setAttribute("role", "button");
  const paint = () => {
    const v = String(get() || "");
    host.classList.toggle("is-empty", !v.trim());
    host.textContent = v.trim() ? v : empty;
  };
  paint();
  const open = () => {
    if (host._lrEditing) return;
    const orig = String(get() || "");
    const input = long ? h("textarea.lr-ed-in" + cls, { rows: "2", maxlength: String(max), placeholder })
      : h("input.lr-ed-in" + cls, { maxlength: String(max), placeholder });
    input.value = orig;
    let done = false;
    const fit = () => { if (long) { input.style.height = "auto"; input.style.height = Math.min(360, input.scrollHeight + 2) + "px"; } };
    const finish = () => { if (done) return false; done = true; host._lrEditing = null; if (env) env.editing.delete(api); input.replaceWith(host); paint(); return true; };
    const commit = async () => {
      if (done) return;
      const v = input.value.replace(/\s+$/, "");
      layer.close(true);
      finish();
      if (v !== orig.replace(/\s+$/, "")) {
        try { await save(v); } catch (e) { console.error(e); toast("没存上：" + (e.message || e)); }
        if (host.isConnected) { paint(); flash(host.closest(".lr-row") || host); }
      }
      if (env) env.afterEdit();
    };
    const api = { dirty: () => !done && input.value !== orig, commit, cancel: () => { layer.close(true); finish(); if (env) env.afterEdit(); } };
    const layer = pushLayer({
      isDirty: () => api.dirty(),
      onKeepDraft: commit,
      onClose: () => { if (env) env.layers.delete(layer); if (finish() && env) env.afterEdit(); },
    });
    if (env) { env.layers.add(layer); env.editing.add(api); }
    host._lrEditing = api;
    input.addEventListener("input", fit);
    input.addEventListener("keydown", (e) => {
      if (composing(e)) return;
      if (e.key === "Enter" && (!long || e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    });
    // 点到别处就保存；弹出「保留草稿 / 丢弃」时不算
    input.addEventListener("blur", () => setTimeout(() => { if (!done && !modalOpen() && document.activeElement !== input) commit(); }, 0));
    host.replaceWith(input);
    fit();
    input.focus();
    if (!long) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
  };
  host.addEventListener("click", (e) => { if (e.target.closest("a, button") && e.target !== host) return; open(); });
  host.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !composing(e)) { e.preventDefault(); open(); } });
  return { paint, open };
}

/** 「+ 别名」这类按钮：点了变成小输入框，回车加一个（可以用顿号、逗号一次写几个），点别处收起 */
export function adder(label, { placeholder = "", onAdd, env, cls = "" }) {
  const btn = h("button.lr-add" + cls, { type: "button" }, icon("plus"), h("span", {}, label));
  btn.addEventListener("click", () => {
    const input = h("input.lr-add-in", { placeholder: placeholder || label, maxlength: "60", "aria-label": label });
    let done = false;
    const close = () => { if (done) return; done = true; if (env) { env.editing.delete(api); env.layers.delete(layer); } if (input.isConnected) input.replaceWith(btn); if (env) env.afterEdit(); };
    const add = async (keepOpen) => {
      const list = input.value.split(/[、，,；;\n]+/).map((x) => x.trim()).filter(Boolean);
      input.value = "";
      if (list.length) await onAdd(list, keepOpen);
      // 整段重画了：接着写的新输入框由调用方打开
      if (!input.isConnected || !keepOpen) { layer.close(true); close(); } else input.focus();
    };
    const api = { dirty: () => !done && !!input.value.trim(), commit: () => add(false), cancel: () => { layer.close(true); close(); } };
    const layer = pushLayer({ isDirty: () => api.dirty(), onKeepDraft: () => add(false), onClose: close });
    if (env) { env.layers.add(layer); env.editing.add(api); }
    input.addEventListener("keydown", (e) => {
      if (composing(e)) return;
      if (e.key === "Enter") { e.preventDefault(); add(true); }
    });
    input.addEventListener("blur", () => setTimeout(() => {
      if (done || modalOpen() || document.activeElement === input) return;
      if (input.value.trim()) add(false); else { layer.close(true); close(); }
    }, 0));
    btn.replaceWith(input);
    input.focus();
  });
  return btn;
}

/** 一枚小标签，带 × */
export function chip(text, { cls = "", onRemove, onClick, title, color } = {}) {
  const el = h("span.lr-chip" + cls, { title: title || null, style: color ? vars({ "--c": color }) : null });
  const t = onClick ? h("button.lr-chip-t", { type: "button" }, text) : h("span.lr-chip-t", {}, text);
  if (onClick) t.addEventListener("click", onClick);
  el.append(t);
  if (onRemove) {
    const x = h("button.lr-chip-x", { type: "button", "aria-label": "去掉「" + text + "」", title: "去掉" }, "×");
    x.addEventListener("click", onRemove);
    el.append(x);
  }
  return el;
}

/** 章节下拉：「现在（不记章节）」+ 每一章 */
export function chapterSelect(env, value, { none = "现在（不记章节）", label = "从哪一章起" } = {}) {
  const sel = h("select.select.small.lr-ch-sel", { "aria-label": label });
  if (none) sel.append(h("option", { value: "" }, none));
  env.chapters().forEach((c, i) => sel.append(h("option", { value: c.id }, env.chapterName(c, i))));
  sel.value = value || "";
  if (sel.value !== (value || "")) sel.value = "";
  return sel;
}
