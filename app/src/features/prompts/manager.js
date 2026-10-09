// 提示词库的列表：搜索、新建、按分组列出、固定（拖动调顺序）和按用得多少排、复制、删除、分组改名、导入导出。
// 独立界面和「管理提示词库」弹窗用的是同一个。数据一变（prompts:changed）就重画，位置变了的卡片滑过去。
import { bus } from "../../core/bus.js";
import { h, icon, toast, notice, prompt as askLine } from "../../core/ui.js";
import { listPrompts, exportPrompts } from "../../core/prompts.js";
import { FEATURES } from "../../core/stash.js";
import { burstAt } from "../../core/fx.js";
import { groupList, matches, segments, splitHits, excerptOf, heatLevel, parseImport, planImport, exportName, moveId } from "./logic.js";
import * as ops from "./ops.js";
import { openForm } from "./form.js";

const live = new Set();
const motionFull = () => document.documentElement.dataset.motion === "full";
const motionOn = () => document.documentElement.dataset.motion !== "off";

/** 撤销栈变了：每个开着的列表更新撤销 / 重做按钮 */
export function updateAllButtons() { live.forEach((m) => m.updateButtons()); }

function download(name, text) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

const storageWhy = "浏览器存储被限制、被清理，或者另一个窗口刚改过提示词库。";

/**
 * 在 host 里放一个提示词库。opts: { feature（从哪个功能打开的，新建的记上它）, scrollEl（滚动的容器） }
 * 返回 { ready, refresh, destroy, updateButtons }
 */
export function createManager(host, { feature = "", scrollEl = null } = {}) {
  const S = { list: [], q: "", seen: new Set(), first: true, dragging: false, later: false, token: 0, timer: 0, flashId: null, dead: false };
  host.classList.add("pr-root");

  // ---------------- 工具条 ----------------
  const search = h("input.input.pr-search", { type: "search", placeholder: "搜名字、分组、正文", "aria-label": "搜索提示词" });
  const newBtn = h("button.btn.primary.pr-new", { type: "button", "data-act": "new" }, icon("plus"), h("span", {}, "新建"));
  const undoBtn = h("button.icon-btn.pr-undo", { type: "button", "aria-label": "撤销", title: "撤销（Ctrl+Z）" }, icon("undo"));
  const redoBtn = h("button.icon-btn.pr-redo", { type: "button", "aria-label": "重做", title: "重做（Ctrl+Shift+Z）" }, icon("redo"));
  const impBtn = h("button.tool-btn.pr-import", { type: "button", title: "从 .json 文件导入" }, icon("upload"), h("span.pr-tb-t", {}, "导入"));
  const expBtn = h("button.tool-btn.pr-export", { type: "button", title: "导出成 .json 文件" }, icon("download"), h("span.pr-tb-t", {}, "导出"));
  const fileIn = h("input.pr-file", { type: "file", accept: ".json,application/json", hidden: true, tabindex: "-1" });
  const info = h("p.pr-info");
  const listEl = h("div.pr-list");
  host.append(
    h("div.pr-tools", {},
      h("label.pr-search-wrap", {}, icon("search"), search),
      newBtn,
      h("span.pr-tools-r", {}, undoBtn, redoBtn, h("span.pr-sep"), impBtn, expBtn)),
    fileIn, info, listEl);

  search.addEventListener("input", () => { S.q = search.value; render(); });
  newBtn.addEventListener("click", () => createNew());
  undoBtn.addEventListener("click", () => ops.runUndo());
  redoBtn.addEventListener("click", () => ops.runRedo());
  impBtn.addEventListener("click", () => fileIn.click());
  expBtn.addEventListener("click", () => doExport());
  fileIn.addEventListener("change", () => { const f = fileIn.files && fileIn.files[0]; fileIn.value = ""; importFile(f); });

  function updateButtons() {
    undoBtn.disabled = !ops.canUndoHere();
    redoBtn.disabled = !ops.canRedoHere();
    undoBtn.title = ops.canUndoHere() ? `撤销「${ops.undoLabel()}」（Ctrl+Z）` : "撤销（Ctrl+Z）";
  }

  // ---------------- 读数据、重画 ----------------
  const offChanged = bus.on("prompts:changed", () => schedule());
  function schedule() { clearTimeout(S.timer); S.timer = setTimeout(refresh, 40); }

  async function refresh() {
    if (S.dead) return;
    if (!S.first && !host.isConnected) { destroy(); return; }
    if (S.dragging) { S.later = true; return; }
    const t = ++S.token;
    let list;
    try { list = await listPrompts(); }
    catch (e) {
      if (t !== S.token) return;
      listEl.replaceChildren(h("div.empty", {}, "提示词库没读出来。"));
      notice({ what: "提示词库读不出来。", why: storageWhy, detail: e && (e.stack || e.message || e), actions: [{ label: "重试", primary: true, run: refresh }] });
      return;
    }
    if (t !== S.token || S.dead) return;
    S.list = list;
    render();
  }

  function render() {
    const before = rects();
    const fk = focusKey();
    const q = S.q.trim();
    const shown = q ? S.list.filter((p) => matches(p, q)) : S.list;
    const pinned = S.list.filter((p) => p.pinned).length;
    info.replaceChildren(...(S.list.length ? [
      h("span.pr-count", {}, q ? `找到 ${shown.length} 条` : `共 ${S.list.length} 条`),
      h("span.pr-how", {}, pinned ? "固定的按你排的顺序在前，其余按用得多少排" : "按用得多少排。点「固定」可以自己排顺序"),
    ] : []));
    info.hidden = !S.list.length;
    host.classList.toggle("is-empty", !S.list.length);
    if (!S.list.length) listEl.replaceChildren(emptyEl());
    else if (!shown.length) listEl.replaceChildren(noHitEl(q));
    else {
      const maxUses = Math.max(0, ...S.list.map((p) => p.uses || 0));
      let i = 0;
      listEl.replaceChildren(...groupList(shown).map((g) => groupEl(g, q, maxUses, () => i++)));
    }
    flip(before);
    restoreFocus(fk);
    S.seen = new Set(S.list.map((p) => p.id));
    S.first = false;
    updateButtons();
    if (S.flashId) { const id = S.flashId; S.flashId = null; flash(id); }
  }

  function rects() {
    const m = new Map();
    if (!motionFull() || S.first) return m;
    listEl.querySelectorAll(".pr-item").forEach((el) => m.set(el.dataset.id, el.getBoundingClientRect()));
    return m;
  }
  function flip(before) {
    if (!before.size) return;
    listEl.querySelectorAll(".pr-item").forEach((el) => {
      const b = before.get(el.dataset.id);
      if (!b) return;
      const a = el.getBoundingClientRect();
      const dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.2, .8, .3, 1)" });
    });
  }
  function focusKey() {
    const a = document.activeElement;
    if (!a || !listEl.contains(a)) return null;
    const it = a.closest(".pr-item");
    return it ? { id: it.dataset.id, act: a.dataset.act || "" } : null;
  }
  function restoreFocus(k) {
    if (!k) return;
    const it = listEl.querySelector(`.pr-item[data-id="${CSS.escape(k.id)}"]`);
    const el = it && (it.querySelector(`[data-act="${k.act}"]:not(:disabled)`) || it.querySelector("[data-act]"));
    if (el) el.focus({ preventScroll: false });
    else search.focus();
  }

  /** 刚保存、复制、固定过的那张卡闪一下 */
  function flash(id) {
    const el = listEl.querySelector(`.pr-item[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: motionFull() ? "smooth" : "auto" });
    el.classList.remove("pr-flash");
    void el.offsetWidth;
    el.classList.add("pr-flash");
    setTimeout(() => el.classList.remove("pr-flash"), 1400);
    if (motionFull()) setTimeout(() => burstAt(el, "style", 5), 120);
  }

  // ---------------- 各部分 ----------------
  function emptyEl() {
    return h("div.pr-empty", {},
      h("div.pr-empty-art", { "aria-hidden": "true" }, h("i"), h("i"), h("i")),
      h("p.pr-empty-t", {}, "软件不带提示词，写一个自己的"),
      h("p.pr-empty-s", {}, "正文里写 {选中文本}，发送时换成你在正文里选中的文字。别的变量在编辑时点一下就能插入。"),
      h("div.pr-empty-acts", {},
        h("button.btn.primary", { type: "button", onclick: () => createNew() }, icon("plus"), "新建"),
        h("button.btn", { type: "button", onclick: () => fileIn.click() }, icon("upload"), "导入 .json")));
  }
  function noHitEl(q) {
    return h("div.pr-nohit", {},
      h("p", {}, `没有找到含「${q}」的提示词`),
      h("button.btn.small", { type: "button", onclick: () => { search.value = ""; S.q = ""; render(); search.focus(); } }, "清空搜索"));
  }

  function groupEl(g, q, maxUses, nextIdx) {
    const all = S.list.filter((p) => (p.group || "") === g.group);
    const sec = h("section.pr-group", { "data-group": g.group, "aria-label": g.group || "未分组" },
      h("header.pr-group-head", {},
        h("h2.pr-group-t", {}, g.group ? hits(g.group, q) : "未分组"),
        h("span.pr-group-n", {}, q && all.length !== g.pinned.length + g.auto.length ? `${g.pinned.length + g.auto.length} / ${all.length} 条` : `${all.length} 条`),
        g.group ? h("button.btn.small.ghost.pr-group-rename", { type: "button", title: "给这一组改名（改成已有的名字就并进那一组）", onclick: () => renameGroup(g.group) }, "改名") : null));
    if (S.first && motionOn()) sec.classList.add("pr-in");
    if (g.pinned.length) {
      sec.append(h("div.pr-sub.pr-sub-pin", {}, h("span.pr-sub-t", {}, "固定"),
        h("span.pr-sub-note", {}, q ? "搜索时不能调顺序" : g.pinned.length > 1 ? "拖动左边的把手，或按 ↑ ↓ 调顺序" : "")));
      const pins = h("div.pr-pins", { role: "list", "data-group": g.group });
      g.pinned.forEach((p) => pins.append(itemEl(p, { q, maxUses, i: nextIdx(), pins, group: g.group, canDrag: !q && g.pinned.length > 1 })));
      sec.append(pins);
    }
    if (g.auto.length) {
      if (g.pinned.length) sec.append(h("div.pr-sub.pr-sub-auto", {}, h("span.pr-sub-t", {}, "按用得多少排")));
      sec.append(h("div.pr-autos", { role: "list" }, ...g.auto.map((p) => itemEl(p, { q, maxUses, i: nextIdx() }))));
    }
    return sec;
  }

  function hits(text, q) {
    return splitHits(text, q).map((s) => (s.hit ? h("mark.pr-hit", {}, s.t) : s.t));
  }

  function excerpt(text, q) {
    const ex = excerptOf(text, q);
    if (!ex) return [h("span.pr-text-none", {}, "（正文是空的）")];
    return segments(ex).flatMap((s) => (s.v != null ? [h("span.pr-v" + (s.known ? "" : ".unk"), {}, s.t)] : hits(s.t, q)));
  }

  function itemEl(p, { q, maxUses, i, pins = null, group = "", canDrag = false }) {
    const lv = heatLevel(p.uses, maxUses);
    const act = (label, name, fn, cls = "") => h("button.btn.small.ghost.pr-act" + cls, { type: "button", "data-act": name, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
    const open = h("button.pr-open", { type: "button", "data-act": "open", title: "编辑这一条" }, ...hits(p.name, q));
    const feat = p.feature && FEATURES[p.feature] ? h("span.pr-feat", { title: "在「" + FEATURES[p.feature] + "」里新建的" }, FEATURES[p.feature]) : null;
    const el = h("article.pr-item" + (p.pinned ? ".pinned" : ""), { role: "listitem", "data-id": p.id, "aria-label": p.name },
      p.pinned ? h("button.pr-drag.fx-skip", { type: "button", "data-act": "drag", disabled: !canDrag,
        title: canDrag ? "拖动调顺序（也可以按 ↑ ↓）" : q ? "搜索时不能调顺序" : "只有一条，不用排",
        "aria-label": "调顺序：按上下方向键移动" }, icon("drag")) : null,
      h("div.pr-main-col", {},
        h("div.pr-head", {}, h("h3.pr-name", {}, open), feat),
        h("p.pr-text", {}, ...excerpt(p.text, q)),
        h("div.pr-meta", {},
          h("span.pr-heat", { "data-lv": String(lv), "aria-hidden": "true" }, ...[0, 1, 2, 3, 4].map((k) => h("i" + (k < lv ? ".on" : "")))),
          h("span.pr-uses", {}, p.uses ? `用过 ${p.uses} 次` : "还没用过"))),
      h("div.pr-acts", {},
        act("编辑", "edit", () => edit(p)),
        act("复制", "copy", () => copy(p)),
        act(p.pinned ? "取消固定" : "固定", "pin", () => pin(p), ".pr-pin-btn"),
        act("删除", "del", () => del(p, el), ".pr-del")));
    open.addEventListener("click", () => edit(p));
    el.querySelector(".pr-text").addEventListener("click", () => edit(p));
    if (motionOn() && (S.first || !S.seen.has(p.id))) { el.classList.add("pr-in"); el.style.setProperty("--i", String(Math.min(i, 12))); }
    if (pins && canDrag) {
      const handle = el.querySelector(".pr-drag");
      handle.addEventListener("pointerdown", (e) => startDrag(e, el, pins, group));
      handle.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const ids = [...pins.children].map((x) => x.dataset.id);
        const next = moveId(ids, p.id, e.key === "ArrowUp" ? -1 : 1);
        if (next) commitOrder(group, next);
      });
    }
    return el;
  }

  // ---------------- 拖动调顺序 ----------------
  function startDrag(e, el, pins, group) {
    if (e.button !== 0 || S.q.trim() || S.dragging) return;
    e.preventDefault();
    const handle = e.currentTarget;
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* 有的浏览器不支持 */ }
    handle.focus({ preventScroll: true });
    const startIds = [...pins.children].map((x) => x.dataset.id);
    let anchor = e.clientY, lastScroll = scrollEl ? scrollEl.scrollTop : 0, dy = 0;
    S.dragging = true;
    el.classList.add("dragging");
    pins.classList.add("sorting");

    const onMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (scrollEl) {
        const r = scrollEl.getBoundingClientRect();
        if (ev.clientY < r.top + 36) scrollEl.scrollTop -= 12;
        else if (ev.clientY > r.bottom - 36) scrollEl.scrollTop += 12;
        anchor -= scrollEl.scrollTop - lastScroll;
        lastScroll = scrollEl.scrollTop;
      }
      const sibs = [...pins.children].filter((x) => x !== el);
      let before = null;
      for (const s of sibs) { const r = s.getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { before = s; break; } }
      if (el.nextElementSibling !== before) {
        const old = new Map(sibs.map((s) => [s, s.getBoundingClientRect().top]));
        const top0 = el.offsetTop;
        pins.insertBefore(el, before);
        anchor += el.offsetTop - top0;
        if (motionFull()) sibs.forEach((s) => { const d = old.get(s) - s.getBoundingClientRect().top; if (d) s.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: 180, easing: "ease-out" }); });
      }
      dy = ev.clientY - anchor;
      el.style.transform = `translateY(${dy}px)`;
    };
    const finish = async (cancel) => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      el.style.transform = "";
      if (motionFull() && dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 180, easing: "ease-out" });
      el.classList.remove("dragging");
      pins.classList.remove("sorting");
      S.dragging = false;
      const ids = [...pins.children].map((x) => x.dataset.id);
      const moved = ids.join() !== startIds.join();
      if (cancel && moved) { startIds.forEach((id) => pins.append(pins.querySelector(`[data-id="${CSS.escape(id)}"]`))); }
      if (S.dead) return;
      if (!cancel && moved) await commitOrder(group, ids);
      if (S.later || cancel) { S.later = false; schedule(); }
    };
    // 挪位置时卡片会离开再回到文档里，指针捕获会丢，所以在 window 上听
    const mine = (ev) => ev.pointerId === e.pointerId;
    const onUp = (ev) => { if (mine(ev)) finish(false); };
    const onCancel = (ev) => { if (mine(ev)) finish(true); };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
  }

  async function commitOrder(group, ids) {
    const rows = S.list.filter((p) => p.pinned && (p.group || "") === group);
    try {
      const r = await ops.reorder(rows, ids);
      if (r) toast("已调整顺序", { action: { label: "撤销", run: () => ops.runUndo(r.entry) } });
    } catch (e) {
      refresh();
      notice({ what: "顺序没能保存。", why: storageWhy, detail: e && (e.stack || e.message || e), actions: [{ label: "重试", primary: true, run: () => commitOrder(group, ids) }] });
    }
  }

  // ---------------- 操作 ----------------
  async function guarded(what, fn, retry) {
    try { return await fn(); }
    catch (e) {
      notice({ what, why: storageWhy, detail: e && (e.stack || e.message || e), actions: retry ? [{ label: "重试", primary: true, run: retry }] : [] });
      return null;
    }
  }

  async function createNew() {
    const r = await openForm({ feature });
    if (!r) return;
    S.flashId = r.row.id;
    schedule();
    toast(`已存进提示词库：「${r.row.name}」`, { action: { label: "撤销", run: () => ops.runUndo(r.entry) } });
  }

  async function edit(p) {
    const r = await openForm({ prompt: p });
    if (!r) return;
    S.flashId = r.row.id;
    schedule();
    toast(`已保存「${r.row.name}」`, { action: { label: "撤销", run: () => ops.runUndo(r.entry) } });
  }

  async function copy(p) {
    const r = await guarded("没能复制这条提示词。", () => ops.copy(p), () => copy(p));
    if (!r) return;
    S.flashId = r.row.id;
    schedule();
    toast(`已复制一份：「${r.row.name}」`, { action: { label: "撤销", run: () => ops.runUndo(r.entry) } });
  }

  async function pin(p) {
    const r = await guarded(p.pinned ? "没能取消固定。" : "没能固定。", () => ops.setPinned(p, !p.pinned), () => pin(p));
    if (!r) return;
    S.flashId = p.id;
    schedule();
    toast(p.pinned ? "已取消固定，按用得多少排" : "已固定，排在固定的最后", { action: { label: "撤销", run: () => ops.runUndo(r.entry) } });
  }

  async function del(p, el) {
    if (motionOn() && el && el.isConnected) {
      el.classList.add("pr-out");
      await new Promise((res) => { const t = setTimeout(res, 420); el.addEventListener("animationend", () => { clearTimeout(t); res(); }, { once: true }); });
    }
    const r = await guarded("没能删除这条提示词。", () => ops.remove(p), () => del(p));
    if (!r) { if (el) el.classList.remove("pr-out"); return; }
    toast(`已删除「${p.name}」`, { action: { label: "撤销", run: () => ops.runUndo(r.entry) } });
  }

  async function renameGroup(name) {
    const v = await askLine("给「" + name + "」改名", name, "空着就是「未分组」");
    if (v == null) return;
    const to = v.trim().slice(0, 30);
    if (to === name) return;
    const rows = S.list.filter((p) => (p.group || "") === name);
    const merge = to && S.list.some((p) => (p.group || "") === to);
    const r = await guarded("分组没能改名。", () => ops.renameGroup(rows, to), () => renameGroup(name));
    if (!r) return;
    toast(merge ? `已并进「${to}」` : `已改成「${to || "未分组"}」`, { action: { label: "撤销", run: () => ops.runUndo(r.entry) } });
  }

  // ---------------- 导入导出 ----------------
  async function doExport() {
    let data;
    try { data = await exportPrompts(); }
    catch (e) { return notice({ what: "没能导出。", why: storageWhy, detail: e && (e.stack || e.message || e), actions: [{ label: "重试", primary: true, run: doExport }] }); }
    if (!data.prompts.length) { toast("库里还没有提示词，没有可导出的"); return; }
    const name = exportName();
    download(name, JSON.stringify(data, null, 2));
    toast(`已导出 ${data.prompts.length} 条：${name}`);
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      return notice({ what: "这个文件太大了，没有导入。", why: "提示词库导出的文件一般只有几十 KB，可能选错了文件。", actions: [{ label: "换一个文件", primary: true, run: () => fileIn.click() }] });
    }
    let list;
    try { list = parseImport(await file.text()); }
    catch (e) {
      return notice({
        what: e.code === "shape" ? "这个文件里没有提示词。" : "这个文件读不出来。",
        why: e.code === "shape" ? "要用提示词库「导出」得到的 .json 文件，或者里面有 prompts 列表的 JSON。" : "它不是 JSON 格式，或者内容不完整（比如只拷了一半）。",
        detail: e && (e.message || e),
        actions: [{ label: "换一个文件", primary: true, run: () => fileIn.click() }],
      });
    }
    let have = [];
    try { have = await listPrompts(); } catch (_) { have = S.list; }
    const plan = planImport(list, have);
    const tail = [plan.skipped ? `跳过 ${plan.skipped} 条重复` : "", plan.bad ? `${plan.bad} 条没有正文，没导入` : ""].filter(Boolean);
    if (!plan.fresh.length) {
      toast(plan.skipped ? `没有新的提示词：${plan.skipped} 条都已经在库里了` + (plan.bad ? `，${plan.bad} 条没有正文` : "") : "文件里没有能用的提示词（都没有正文）");
      return;
    }
    const r = await guarded("没能导入。导入了一半的已经撤回，库里和导入前一样。", () => ops.importMany(plan.fresh), () => importFile(file));
    if (!r || !r.entry) return;
    toast([`导入了 ${r.n} 条`, ...tail].join("，"), { action: { label: "撤销", run: () => ops.runUndo(r.entry) } });
    if (motionFull()) setTimeout(() => burstAt(listEl.querySelector(".pr-group") || listEl, "celebrate"), 160);
  }

  function destroy() {
    if (S.dead) return;
    S.dead = true;
    clearTimeout(S.timer);
    offChanged();
    live.delete(api);
  }

  const api = { refresh, destroy, updateButtons, ready: null };
  live.add(api);
  api.ready = refresh();
  return api;
}
