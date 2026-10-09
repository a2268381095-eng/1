// AI 结果对比与采用：在正文区里、对着原文选区的位置展开，不弹新窗口。
// 三种看法：并排（左原文右 AI，按段对齐，一起滚动）、行内（原文上直接标出改动）、按句（只看改了的句子）。
// 每一句「采用 / 保留原文」，选中 AI 版本的一段单独采用，两边都能直接改；最多四版一起比，每句从任意一版挑。
// 「完成」只替换原来选中的那一段，算一步，按一次撤销全部还原。
import { EditorView } from "@codemirror/view";
import { ws } from "../editor/workspace.js";
import { h, icon, toast, notice, pushLayer } from "../../core/ui.js";
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { undo as appUndo } from "../../core/undo.js";
import { label } from "../../core/settings.js";
import { runAI } from "../ai/runner.js";
import { tip } from "../demon/demon.js";
import { segmentAll, pickText, charDiff, mapRange, remapPicks, fitFormat } from "./align.js";
import { setPending, pendingOf, flash, refreshMarks } from "./marks.js";
import { prefs, setPref, saveDraft, dropDraft } from "./prefs.js";

const VIEWS = [["side", "并排"], ["inline", "行内"], ["sent", "按句"]];
const MAX_VERSIONS = 4;
const narrow = () => matchMedia("(max-width: 640px)").matches;

let cur = null;
export const currentCompare = () => cur;

const defIndent = () => (ws.book && ws.book.autoIndent === false ? "" : "　　");
export const fitAI = (text, orig) => fitFormat(text, orig, defIndent());

/** 结尾的换行单独拿出来（显示时不多出一个空行，改完再接回去） */
function splitTail(s) {
  const m = (s.match(/\s*$/) || [""])[0];
  const i = m.indexOf("\n");
  if (i < 0) return [s, ""];
  const at = s.length - m.length + i;
  return [s.slice(0, at), s.slice(at)];
}
/** 可编辑格子里的文字（<br>、换行的 div 都算换行） */
function readText(el) {
  let s = "";
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeName === "BR") s += "\n";
      else if (c.nodeType === 1) {
        if ((c.nodeName === "DIV" || c.nodeName === "P") && s && !s.endsWith("\n")) s += "\n";
        walk(c);
      }
    }
  };
  walk(el);
  return s;
}
function caretOffset(el) {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.focusNode)) return null;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(sel.focusNode, sel.focusOffset);
  return r.toString().length;
}
function setCaret(el, off) {
  if (off == null) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n, left = off;
  while ((n = walker.nextNode())) {
    if (left <= n.data.length) { const r = document.createRange(); r.setStart(n, left); r.collapse(true); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); return; }
    left -= n.data.length;
  }
}
/** 把 a → b 的改动画进 el：side="old" 只画原文（删掉的划线），side="new" 只画新的（加上的高亮） */
function diffInto(el, a, b, side) {
  if (a === b || a.length + b.length > 60000) { el.append(side === "old" ? a : b); return; }
  for (const [op, t] of charDiff(a, b)) {
    if (op === 0) el.append(t);
    else if (op < 0 && side === "old") el.append(h("del.rw-del", {}, t));
    else if (op > 0 && side === "new") el.append(h("ins.rw-ins", {}, t));
  }
}
function rowsOf(segs) {
  const rows = [];
  let r = [];
  segs.forEach((s, i) => { r.push(i); if (/\n$/.test(s.orig)) { rows.push(r); r = []; } });
  if (r.length) rows.push(r);
  return rows;
}
/** 改了的那几行（整行文字），记成「AI 改过的段落」 */
function changedLines(before, after, from, to, end) {
  const around = (s, a, b) => {
    if (b > a && s[b - 1] === "\n") b--;
    const st = a > 0 ? s.lastIndexOf("\n", a - 1) + 1 : 0;
    let en = s.indexOf("\n", b);
    if (en < 0) en = s.length;
    return s.slice(st, en).split("\n");
  };
  const old = new Set(around(before, from, to));
  return [...new Set(around(after, from, end).filter((l) => l.trim() && !old.has(l)))];
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast("已复制"); }
  catch (_) { toast("复制不了：浏览器没给剪贴板权限"); }
}

/**
 * 打开对比面板。ctx = { chapterId, bookId, from, to, input }；init（接着草稿时）= { orig, versions, picks, view, lost }
 * 返回面板对象：beginVersion(ac)、addVersion(v)、useStash(row)、focus()、close(force)、autoClose()
 */
export function openCompare(ctx, init = {}) {
  const els = ws.els();
  if (!els || !ws.editor) return null;
  if (cur) cur.close(true);
  const center = els.center;
  const st = {
    chapterId: ctx.chapterId, bookId: ctx.bookId, from: ctx.from, to: ctx.to, input: ctx.input,
    orig: init.orig != null ? init.orig : ctx.input,
    versions: [], segs: [], picks: [], last: {}, active: 0,
    view: init.view || prefs.view || (narrow() ? "inline" : "side"),
    onlyChanged: false, dirty: false, slots: new Set(), closed: false, busy: false, lost: !!init.lost,
  };
  let needRender = false, pointerIn = false, pending = null, fragSel = null, popSel = null;

  // ---- 骨架 ----
  const back = h("button.icon-btn.rw-back", { type: "button", title: "返回正文（Esc）", "aria-label": "返回正文" }, icon("back"));
  const closeX = h("button.icon-btn.rw-x", { type: "button", title: "关闭（Esc）", "aria-label": "关闭" }, icon("close"));
  const sub = h("span.rw-sub");
  const viewSeg = h("div.rw-seg", { role: "group", "aria-label": "对比方式" },
    ...VIEWS.map(([id, name]) => h("button", { type: "button", "data-view": id }, name)));
  const head = h("div.rw-head", {}, back, h("div.rw-head-t", {}, h("h2.rw-title", {}, "AI 结果对比"), sub), viewSeg, closeX);
  const allBtn = h("button.btn.small.rw-all", { type: "button" }, "全部采用");
  const noneBtn = h("button.btn.small.rw-none", { type: "button" }, "全部放弃");
  const againBtn = h("button.btn.small.rw-again", { type: "button", title: "用同样的模型和提示词再出一版（不再确认）" }, "再出一版");
  const askBtn = h("button.btn.small.ghost.rw-ask", { type: "button", title: "带着这次的问答去对话里接着问" }, "继续追问");
  const stashBtn = h("button.btn.small.ghost.rw-stash", { type: "button", title: "这一章选中调用的结果" }, label("暂存盒"));
  const onlyIn = h("input", { type: "checkbox" });
  const onlyBox = h("label.check.rw-only", {}, onlyIn, "只看改动");
  const verMenu = h("div.rw-menu.rw-ver-menu", { hidden: true, role: "menu" });
  const acts = h("div.rw-acts", {}, h("span.rw-all-wrap", {}, allBtn, verMenu), noneBtn, h("span.rw-acts-sep"), againBtn, askBtn, stashBtn, h("span.spacer"), onlyBox);
  const banner = h("div.rw-banner", { hidden: true });
  const body = h("div.rw-body");
  const sum = h("div.rw-sum", { role: "status", "aria-live": "polite" });
  const cancelBtn = h("button.btn.rw-cancel", { type: "button" }, "取消");
  const okBtn = h("button.btn.primary.rw-ok", { type: "button" }, icon("check"), "完成");
  const foot = h("div.rw-foot", {}, sum, h("div.rw-foot-btns", {}, cancelBtn, okBtn));
  const fragBtn = h("button.rw-frag", { type: "button", hidden: true }, "只采用选中的这段");
  // 「完成」放在上面：靠近原文，也不会被右下角的小恶魔挡住
  const box = h("section.rw-panel", { role: "dialog", "aria-label": "AI 结果对比", tabindex: "-1" }, head, foot, acts, banner, body, fragBtn);
  center.classList.add("rw-on");
  center.append(box);

  const layer = pushLayer({
    isDirty: () => st.dirty && (st.versions.length > 0 || st.orig !== st.input),
    onKeepDraft: () => keepDraft(),
    onClose: teardown,
  });

  const api = {
    get chapterId() { return st.chapterId; },
    beginVersion, addVersion, useStash,
    focus: () => box.focus(),
    close: (force) => layer.close(force),
    async autoClose() {
      if (st.dirty && st.versions.length) { await keepDraft(); }
      return layer.close(true);
    },
  };
  cur = api;

  // ---- 原文的位置：编辑器里标出来，跟着前后的改动挪 ----
  const v = ws.editor.view;
  const len = v.state.doc.length;
  if (ws.current && ws.current.id === st.chapterId) {
    v.dispatch({ effects: [setPending.of({ from: Math.min(st.from, len), to: Math.min(st.to, len) }), EditorView.scrollIntoView(Math.min(st.from, len), { y: "start", yMargin: 48 })] });
  }
  function place() {
    if (st.closed) return;
    if (narrow()) { box.style.top = "0px"; return; }
    const c = center.getBoundingClientRect();
    let top = 8;
    const view = ws.editor && ws.editor.view;
    const r = view && ws.current && ws.current.id === st.chapterId ? pendingOf(view.state) : null;
    if (r) {
      const co = view.coordsAtPos(r.from);
      if (co) top = co.bottom - c.top + 6;
    }
    const minH = Math.min(460, c.height - 16);
    box.style.top = Math.round(Math.max(8, Math.min(top, c.height - minH - 8))) + "px";
  }
  box.style.top = "8px";
  requestAnimationFrame(() => requestAnimationFrame(place));
  const onResize = () => place();
  window.addEventListener("resize", onResize);

  // ---- 状态 ----
  const srcText = (src) => (src === -1 ? st.orig : st.versions[src].text);
  function realign(opts = {}) {
    const segs = segmentAll(st.orig, st.versions.map((x) => x.text));
    st.picks = opts.fresh != null ? segs.map(() => opts.fresh) : remapPicks(st.segs, st.picks, segs, opts);
    st.segs = segs;
  }
  const finalText = () => st.segs.map((s, i) => pickText(s, st.picks[i])).join("");
  const changedSeg = (s) => s.alts.some((a) => a !== s.orig);
  function counts() {
    let changed = 0, took = 0, mine = 0;
    st.segs.forEach((s, i) => {
      const p = st.picks[i], t = pickText(s, p);
      if (!changedSeg(s) && t === s.orig) return;
      changed++;
      if (p && typeof p === "object") mine++;
      else if (t !== s.orig) took++;
    });
    return { changed, took, mine, kept: changed - took - mine };
  }
  const verName = (i) => (st.versions.length + st.slots.size > 1 ? `第 ${i + 1} 版` : "AI");
  function setPick(i, p) {
    const t = pickText(st.segs[i], st.picks[i]);
    if (t !== st.segs[i].orig && typeof st.picks[i] === "number") st.last[st.segs[i].oa] = st.picks[i];
    st.picks[i] = p;
    st.dirty = true;
  }
  function bestAlt(i) {
    const s = st.segs[i];
    const remembered = st.last[s.oa];
    if (remembered != null && st.versions[remembered] && s.alts[remembered] !== s.orig) return remembered;
    if (s.alts[st.active] != null && s.alts[st.active] !== s.orig) return st.active;
    const k = s.alts.findIndex((a) => a !== s.orig);
    return k >= 0 ? k : st.active;
  }

  // ---- 编辑：改完离开格子时才重新对齐；点按钮的那一下先把改动记下 ----
  function flushEdit() {
    const p = pending;
    pending = null;
    if (!p || !p.el.dataset.edited) { if (needRender) render(); return null; }
    delete p.el.dataset.edited;
    const kind = p.el._apply ? p.el._apply(readText(p.el)) : null;
    if (kind || needRender) render();
    return kind;
  }
  /** 按钮的回调都先过这一道：刚改的原文还没对齐好就先只刷新，免得点到错的那句 */
  const guard = (fn) => (...a) => { const k = flushEdit(); if (k === "orig") return; fn(...a); };
  box.addEventListener("pointerdown", () => { pointerIn = true; });
  const onUp = () => { if (!pointerIn) return; pointerIn = false; setTimeout(() => { if (!st.closed) flushEdit(); }, 0); };
  window.addEventListener("pointerup", onUp, true);

  /** 一个能直接打字的格子。src：-1 原文，0.. 第几版，"c" 自己拼的；off：在那一边全文里的起点；loc：重画后找回它用 */
  function editField(text, { src, off, loc, segIndex }) {
    const [bodyText, tail] = splitTail(text);
    const el = h("div.rw-text", { contenteditable: "plaintext-only", spellcheck: "false", "data-src": String(src), "data-off": String(off), "data-loc": loc, role: "textbox", "aria-multiline": "true" });
    el._apply = (next) => {
      next += tail;
      if (src === "c") {
        const p = st.picks[segIndex];
        if (!p || typeof p !== "object" || next === p.c) return null;
        st.picks[segIndex] = { c: next };
        st.dirty = true;
        return "custom";
      }
      const full = srcText(src);
      if (full.slice(off, off + text.length) !== text) { toast("这一处对不上了，刚才的改动没记下"); return null; }
      const changed = full.slice(0, off) + next + full.slice(off + text.length);
      if (changed === full) return null;
      if (src === -1) { st.orig = changed; realign({ origChanged: true, edited: -1 }); }
      else { st.versions[src].text = changed; realign({ edited: src }); }
      st.dirty = true;
      return src === -1 ? "orig" : "version";
    };
    el.addEventListener("input", () => { el.dataset.edited = "1"; st.dirty = true; });
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const t = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
      document.execCommand("insertText", false, t);
    });
    el.addEventListener("blur", () => {
      if (!el.dataset.edited) { if (needRender && !pointerIn) setTimeout(() => { if (!st.closed) flushEdit(); }, 0); return; }
      pending = { el };
      if (!pointerIn) flushEdit();
    });
    return { el, bodyText };
  }

  // ---- 画 ----
  function render() {
    if (st.closed) return;
    const a = document.activeElement;
    let restore = null;
    if (a && a.classList && a.classList.contains("rw-text") && body.contains(a)) {
      if (a.dataset.edited) { needRender = true; return; }
      restore = { src: a.dataset.src, loc: a.dataset.loc, off: caretOffset(a) };
    }
    needRender = false;
    fragBtn.hidden = true;
    fragSel = null;
    const keep = body.scrollTop, keepX = body.scrollLeft;
    viewSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === st.view)));
    box.dataset.view = st.view;
    body.replaceChildren();
    const live = [...st.slots];
    if (st.view === "side") body.append(renderSide(live));
    else {
      live.forEach((s) => body.append(s.el));
      body.append(st.view === "inline" ? renderInline() : renderSent());
    }
    body.scrollTop = keep;
    body.scrollLeft = keepX;
    if (restore) {
      const el = body.querySelector(`.rw-text[data-src="${restore.src}"][data-loc="${restore.loc}"]`);
      if (el) { el.focus({ preventScroll: true }); setCaret(el, restore.off); }
    }
    if (popSel) {
      const el = body.querySelector(popSel);
      popSel = null;
      if (el) { el.classList.remove("rw-pop"); void el.offsetWidth; el.classList.add("rw-pop"); }
    }
    updateBar();
  }

  function updateBar() {
    const n = st.versions.length, busy = st.slots.size > 0;
    const c = counts();
    const parts = [];
    if (!n) parts.push(busy ? "AI 正在写……" : "还没有结果");
    else if (!c.changed) parts.push("AI 没改动这段");
    else {
      parts.push(`${c.changed} 处改动`, `采用 ${c.took}`, `保留 ${c.kept}`);
      if (c.mine) parts.push(`自选 ${c.mine}`);
    }
    if (st.orig !== st.input) parts.push("原文改过");
    sum.textContent = parts.join(" · ");
    sub.textContent = n ? st.versions.map((x, i) => verName(i) + (x.model ? "：" + x.model : "")).join("　") : "";
    okBtn.disabled = !n || st.busy;
    allBtn.disabled = noneBtn.disabled = !n;
    askBtn.disabled = !n;
    againBtn.disabled = busy || n + st.slots.size >= MAX_VERSIONS;
    againBtn.title = n + st.slots.size >= MAX_VERSIONS ? `最多 ${MAX_VERSIONS} 版，去掉一版再出` : "用同样的模型和提示词再出一版（不再确认）";
    onlyIn.checked = st.onlyChanged;
    banner.hidden = !st.lost;
    banner.textContent = st.lost ? "原文在正文里找不到了（可能改过）。这次只能看、复制，完成时不会写回。" : "";
  }

  /** 并排：一列原文、每版一列，按段对齐，整张表一起滚 */
  function renderSide(live) {
    const cols = 1 + st.versions.length + live.length;
    const grid = h("div.rw-grid");
    grid.style.setProperty("--cols", String(cols));
    grid.append(h("div.rw-colh.orig", { style: { gridColumn: "1", gridRow: "1" } }, h("span.rw-colh-t", {}, "原文"),
      st.orig !== st.input ? h("span.rw-colh-m", {}, "改过") : null));
    st.versions.forEach((ver, i) => {
      const x = st.versions.length > 1
        ? h("button.icon-btn.rw-mini-x", { type: "button", title: "去掉这一版", "aria-label": `去掉${verName(i)}`, onclick: guard(() => removeVersion(i)) }, icon("close")) : null;
      grid.append(h("div.rw-colh" + (i === st.active ? ".active" : ""), { style: { gridColumn: String(i + 2), gridRow: "1" } },
        h("span.rw-colh-t", {}, verName(i)), ver.model ? h("span.rw-colh-m", { title: ver.model }, ver.model) : null,
        h("button.rw-mini", { type: "button", onclick: guard(() => adoptAll(i)) }, "整版采用"), x));
    });
    live.forEach((s, k) => grid.append(h("div.rw-colh.live", { style: { gridColumn: String(st.versions.length + 2 + k), gridRow: "1" } }, h("span.rw-colh-t", {}, s.name()))));
    const rows = rowsOf(st.segs);
    let shownRows = 0;
    rows.forEach((idxs, r) => {
      const segs = idxs.map((i) => st.segs[i]);
      const origText = segs.map((s) => s.orig).join("");
      const same = segs.every((s) => !changedSeg(s));
      if (same && st.onlyChanged) return;
      const row = String(shownRows + 2);
      shownRows++;
      const actText = st.versions.length ? segs.map((s) => s.alts[st.active]).join("") : origText;
      const cell = (src, text, colIndex) => {
        const { el, bodyText } = editField(text, { src, off: src === -1 ? segs[0].origOff : segs[0].altOff[src], loc: "r" + r });
        if (src === -1) diffInto(el, bodyText, splitTail(actText)[0], "old");
        else diffInto(el, splitTail(origText)[0], bodyText, "new");
        const state = idxs.every((i) => st.picks[i] === src) ? "on" : idxs.some((i) => st.picks[i] === src) ? "part" : "off";
        const take = st.versions.length && !same ? h("button.rw-take", { type: "button", "aria-pressed": String(state === "on"), "data-part": state === "part" ? "1" : null,
          title: src === -1 ? "这一段保留原文" : `这一段用${verName(src)}` }, src === -1 ? "保留原文" : "采用") : null;
        if (take) take.addEventListener("click", guard(() => {
          const now = rowsOf(st.segs)[r];
          if (!now) return render();
          now.forEach((i) => setPick(i, src));
          popSel = `.rw-cell[data-r="${r}"][data-src="${src}"] .rw-take`;
          render();
        }));
        return h("div.rw-cell" + (src === -1 ? ".orig" : "") + (same ? ".same" : "") + (state === "on" ? ".picked" : ""),
          { style: { gridColumn: String(colIndex), gridRow: row }, "data-r": String(r), "data-src": String(src) }, el, take);
      };
      grid.append(cell(-1, origText, 1));
      st.versions.forEach((ver, i) => grid.append(cell(i, segs.map((s) => s.alts[i]).join(""), i + 2)));
    });
    live.forEach((s, k) => {
      s.el.style.gridColumn = String(st.versions.length + 2 + k);
      s.el.style.gridRow = `2 / span ${Math.max(1, shownRows)}`;
      grid.append(s.el);
    });
    if (!shownRows) grid.append(h("p.rw-none-row", { style: { gridColumn: "1 / -1" } }, "没有改动的地方。"));
    return grid;
  }

  /** 行内：在原文上直接标出改动，点一处就在「采用 / 保留原文」之间换 */
  function renderInline() {
    const wrap = h("div.rw-inline");
    st.segs.forEach((s, i) => {
      const p = st.picks[i], t = pickText(s, p);
      if (!changedSeg(s) && t === s.orig) { wrap.append(s.orig); return; }
      const on = t !== s.orig;
      const span = h("span.rw-iseg" + (on ? ".on" : ".off") + (p && typeof p === "object" ? ".mine" : ""),
        { role: "button", tabindex: "0", "data-o": String(s.oa), title: on ? "点一下改回原文" : "点一下用 AI 的这句" });
      if (on) diffIntoBoth(span, s.orig, t);
      else span.append(s.orig);
      const toggle = guard(() => {
        const k = st.segs.findIndex((x) => x.oa === s.oa);
        if (k < 0) return render();
        const now = pickText(st.segs[k], st.picks[k]);
        setPick(k, now !== st.segs[k].orig ? -1 : bestAlt(k));
        popSel = `.rw-iseg[data-o="${s.oa}"]`;
        render();
      });
      span.addEventListener("click", toggle);
      span.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      wrap.append(span);
    });
    return wrap;
  }
  function diffIntoBoth(el, a, b) {
    for (const [op, t] of charDiff(a, b)) el.append(op === 0 ? t : h(op < 0 ? "del.rw-del" : "ins.rw-ins", {}, t));
  }

  /** 按句：改了的句子一句一块，原文和每一版并排列着挑；没改的淡化 */
  function renderSent() {
    const list = h("div.rw-sents");
    let hidden = 0;
    const flushHidden = () => { if (hidden) list.append(h("div.rw-same.rw-fold", {}, `…… ${hidden} 句没改`)); hidden = 0; };
    st.segs.forEach((s, i) => {
      const p = st.picks[i];
      if (!changedSeg(s) && !(p && typeof p === "object")) {
        if (st.onlyChanged) { hidden++; return; }
        flushHidden();
        list.append(h("div.rw-same", {}, splitTail(s.orig)[0] || "（空行）"));
        return;
      }
      flushHidden();
      const block = h("div.rw-sent", { "data-o": String(s.oa) });
      const opt = (src, text) => {
        const on = src === "c" ? !!(p && typeof p === "object") : p === src;
        const { el, bodyText } = editField(text, { src, off: src === -1 ? s.origOff : src === "c" ? 0 : s.altOff[src], loc: "o" + s.oa, segIndex: i });
        if (src === -1 || src === "c") el.append(bodyText);
        else diffInto(el, splitTail(s.orig)[0], bodyText, "new");
        if (!bodyText) el.dataset.empty = src === -1 ? "（原文这里是空的）" : "（这一版删掉了这句）";
        const name = src === -1 ? "原文" : src === "c" ? "自选" : verName(src);
        const btn = h("button.rw-pick", { type: "button", "aria-pressed": String(on), title: src === -1 ? "这句保留原文" : "这句用" + name },
          src === -1 ? "保留原文" : src === "c" ? "用这句" : "采用");
        btn.addEventListener("click", guard(() => {
          const k = st.segs.findIndex((x) => x.oa === s.oa);
          if (k < 0) return render();
          if (src === "c") { if (!(st.picks[k] && typeof st.picks[k] === "object")) return; }
          else setPick(k, src);
          popSel = `.rw-sent[data-o="${s.oa}"] .rw-opt[data-src="${src}"]`;
          render();
        }));
        return h("div.rw-opt" + (on ? ".on" : ""), { "data-src": String(src) }, h("span.rw-opt-l", {}, name), el, btn);
      };
      block.append(opt(-1, s.orig));
      st.versions.forEach((ver, k) => block.append(opt(k, s.alts[k])));
      if (p && typeof p === "object") block.append(opt("c", p.c));
      list.append(block);
    });
    flushHidden();
    if (!list.querySelector(".rw-sent") && st.versions.length) list.prepend(h("p.rw-none-row", {}, "AI 没改动这段。"));
    return list;
  }

  // ---- 操作 ----
  function adoptAll(src) {
    st.picks = st.segs.map(() => src);
    if (src >= 0) st.active = src;
    st.dirty = true;
    render();
  }
  function removeVersion(i) {
    if (st.versions.length < 2) return;
    st.versions.splice(i, 1);
    st.picks = st.picks.map((p) => (typeof p === "number" ? (p === i ? -1 : p > i ? p - 1 : p) : p));
    st.segs.forEach((s) => s.alts.splice(i, 1));
    st.last = {};
    st.active = Math.min(st.active > i ? st.active - 1 : st.active, st.versions.length - 1);
    realign({});
    st.dirty = true;
    render();
  }
  function addVersion(ver) {
    if (st.closed) return;
    const first = !st.versions.length;
    st.versions.push(ver);
    st.active = st.versions.length - 1;
    realign(first ? { fresh: 0 } : {});
    render();
  }
  /** 暂存盒里的一条拿来再对比一次 */
  function useStash(row) {
    if (!row || !row.text) return;
    if (st.versions.length + st.slots.size >= MAX_VERSIONS) { toast(`最多 ${MAX_VERSIONS} 版一起比，先去掉一版`); return; }
    addVersion({ text: fitAI(row.text, st.input), sent: row.prompt || "", stashId: row.id, model: row.model || "", choice: null });
    toast("放进对比里了");
  }
  /** 选中 AI 版本里的一段，只把这段换进原文 */
  function adoptFragment(vi, s, e) {
    const V = st.versions[vi].text, O = st.orig;
    const [os, oe] = mapRange(O, V, s, e);
    const frag = V.slice(s, e);
    let ks = [];
    if (os === oe) {
      const k = st.segs.findIndex((x) => x.origOff < os && os <= x.origOff + x.orig.length);
      ks = [k >= 0 ? k : 0];
    } else st.segs.forEach((x, k) => { if (x.origOff < oe && x.origOff + x.orig.length > os) ks.push(k); });
    if (!ks.length) return;
    const A = st.segs[ks[0]].origOff, lastSeg = st.segs[ks[ks.length - 1]], B = lastSeg.origOff + lastSeg.orig.length;
    const c = O.slice(A, os) + frag + O.slice(oe, B);
    if (c === O.slice(A, B)) { toast("选中的这段和原文一样"); return; }
    ks.forEach((k, j) => { st.picks[k] = j === 0 ? { c } : { c: "" }; });
    st.dirty = true;
    document.getSelection().removeAllRanges();
    popSel = st.view === "sent" ? `.rw-sent[data-o="${st.segs[ks[0]].oa}"] .rw-opt[data-src="c"]` : st.view === "inline" ? `.rw-iseg[data-o="${st.segs[ks[0]].oa}"]` : null;
    render();
    toast("只采用了选中的这段");
  }

  async function again() {
    const last = [...st.versions].reverse().find((x) => x.choice);
    await startRun({ chapterId: st.chapterId, bookId: st.bookId, from: st.from, to: st.to, input: st.input }, { reuse: last ? last.choice : null, panel: api });
  }
  function ask() {
    const ver = st.versions[st.active] || st.versions[st.versions.length - 1];
    if (!ver) return;
    if (!commands.get("chat.open")) { toast("对话功能还没装好"); return; }
    const ch = ws.chapters.find((c) => c.id === st.chapterId);
    commands.run("chat.open", {
      bookId: st.bookId, ref: st.chapterId, title: (ch ? ws.fullTitle(ch) : "") + " · 选中调用",
      history: [{ role: "user", content: ver.sent || st.input }, { role: "assistant", content: ver.text }],
    });
  }
  function openStash() {
    if (!commands.get("stash.drawer")) { toast(label("暂存盒") + "还没装好"); return; }
    commands.run("stash.drawer", { feature: "rewrite", bookId: st.bookId, ref: st.chapterId, title: "这一章的选中调用", onUse: (row) => useStash(row) });
  }

  /** 找到原文现在在正文里的位置；对比期间被改过就返回 null */
  function locate() {
    if (st.lost) return null;
    const text = ws.textOf(st.chapterId);
    const view = ws.editor && ws.editor.view;
    const r = view && ws.current && ws.current.id === st.chapterId ? pendingOf(view.state) : null;
    if (r) return text.slice(r.from, r.to) === st.input ? { from: r.from, to: r.to, text } : null;
    if (text.slice(st.from, st.to) === st.input) return { from: st.from, to: st.to, text };
    return null;
  }

  async function finish() {
    flushEdit();
    if (!st.versions.length || st.busy) return;
    const final = finalText();
    const loc = locate();
    if (!loc) {
      notice({
        what: "这段原文在对比期间改过了，没有写回。",
        why: `为了不盖掉你后来改的字，这次的结果不写进正文。AI 的原始结果在${label("暂存盒")}里，合好的文字可以复制走。`,
        actions: [{ label: "复制合好的文字", primary: true, run: () => copyText(final) }],
      });
      return;
    }
    if (final === loc.text.slice(loc.from, loc.to)) {
      st.dirty = false;
      await dropDraft(st.chapterId);
      await layer.close(true);
      toast("没有要改的地方");
      return;
    }
    st.busy = true;
    updateBar();
    try {
      const after = loc.text.slice(0, loc.from) + final + loc.text.slice(loc.to);
      const id = st.chapterId;
      const entry = await ws.applyBatch("采用 AI 结果", [{ chapterId: id, after }]);
      const end = loc.from + final.length;
      if (entry && prefs.marks) {
        const paras = changedLines(loc.text, after, loc.from, loc.to, end);
        const ch = ws.chapters.find((c) => c.id === id) || {};
        const prev = (ch.aiParas || []).slice();
        const next = [...prev.filter((p) => !paras.includes(p)), ...paras].slice(-400);
        if (paras.length) {
          await ws.patchChapter(id, { aiParas: next });
          refreshMarks();
          const u = entry.undo, r = entry.redo;
          entry.undo = async () => { await u(); await ws.patchChapter(id, { aiParas: prev }); refreshMarks(); };
          entry.redo = async () => { await r(); await ws.patchChapter(id, { aiParas: next }); refreshMarks(); };
        }
      }
      const c = counts();
      st.dirty = false;
      await dropDraft(id);
      await layer.close(true);
      if (ws.current && ws.current.id === id && ws.editor) {
        ws.editor.view.dispatch({ selection: { anchor: end } });
        flash(loc.from, end);
        ws.editor.focus();
      }
      bus.emit("rewrite:done", { count: c.took + c.mine || 1 });
      if (entry) toast("已采用", { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
    } finally { st.busy = false; if (!st.closed) updateBar(); }
  }

  async function keepDraft() {
    flushEdit();
    if (!st.versions.length && st.orig === st.input) return;
    await saveDraft(st.chapterId, {
      chapterId: st.chapterId, bookId: st.bookId, from: st.from, to: st.to, input: st.input, orig: st.orig,
      versions: st.versions.map((x) => ({ text: x.text, sent: x.sent || "", model: x.model || "", stashId: x.stashId || null, choice: x.choice || null })),
      picks: st.picks, view: st.view, at: Date.now(),
    });
    toast("对比留成草稿了。回到这一章选中文字，工具栏里点「接着上次」");
  }

  function teardown() {
    st.closed = true;
    for (const s of st.slots) { try { s.ac.abort(); } catch (_) { /* 已经停了 */ } }
    st.slots.clear();
    box.remove();
    center.classList.remove("rw-on");
    window.removeEventListener("resize", onResize);
    window.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("selectionchange", onSel);
    if (ws.current && ws.current.id === st.chapterId && ws.editor) ws.editor.view.dispatch({ effects: setPending.of(null) });
    if (cur === api) cur = null;
    if (ws.current && ws.editor) ws.editor.focus();
  }

  // ---- 正在出的一版（流式） ----
  function beginVersion(ac) {
    const slot = { ac, text: "", n: 0 };
    slot.name = () => `第 ${st.versions.length + [...st.slots].indexOf(slot) + 1} 版`;
    const stop = h("button.btn.small.ghost.rw-stop", { type: "button" }, "停下");
    stop.addEventListener("click", () => ac.abort());
    const t = h("div.rw-live-t");
    const caret = h("span.rw-caret", { "aria-hidden": "true" });
    const nameEl = h("b");
    slot.el = h("div.rw-live", { "aria-live": "polite" }, h("div.rw-live-h", {}, nameEl, h("span.rw-live-s", {}, "正在写"), stop), h("div.rw-live-body", {}, t, caret));
    slot.update = (text) => {
      slot.text = text;
      t.textContent = text;
      const sc = st.view === "side" ? slot.el : slot.el.querySelector(".rw-live-body");
      if (sc) sc.scrollTop = sc.scrollHeight;
    };
    slot.done = (r) => {
      if (!st.slots.has(slot)) return;
      st.slots.delete(slot);
      addVersion({ text: fitAI(r.text, st.input), sent: r.sent || "", choice: r.choice || null, stashId: r.stash ? r.stash.id : null, model: r.choice ? r.choice.model : "" });
    };
    slot.fail = () => {
      if (!st.slots.has(slot)) return;
      st.slots.delete(slot);
      if (st.closed) return;
      if (!st.versions.length) layer.close(true);
      else render();
    };
    st.slots.add(slot);
    nameEl.textContent = slot.name();
    render();
    return slot;
  }

  // ---- 选中 AI 版本里的一段 → 「只采用选中的这段」 ----
  function onSel() {
    if (st.closed) return;
    const sel = document.getSelection();
    fragSel = null;
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      const n = r.commonAncestorContainer;
      const base = n.nodeType === 1 ? n : n.parentElement;
      const el = base && base.closest(".rw-text");
      if (el && body.contains(el) && /^\d+$/.test(el.dataset.src) && st.versions[+el.dataset.src]) {
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(r.startContainer, r.startOffset);
        const s = +el.dataset.off + pre.toString().length, e = s + r.toString().length;
        if (e > s) {
          fragSel = { v: +el.dataset.src, s, e, el };
          const rr = r.getBoundingClientRect(), bb = box.getBoundingClientRect();
          fragBtn.hidden = false;
          const w = fragBtn.offsetWidth || 130;
          fragBtn.style.left = Math.round(Math.max(6, Math.min(rr.left - bb.left, bb.width - w - 6))) + "px";
          const below = rr.bottom - bb.top + 6;
          fragBtn.style.top = Math.round(below + 34 > bb.height ? Math.max(6, rr.top - bb.top - 36) : below) + "px";
        }
      }
    }
    fragBtn.hidden = !fragSel;
  }
  document.addEventListener("selectionchange", onSel);
  fragBtn.addEventListener("pointerdown", (e) => e.preventDefault());
  fragBtn.addEventListener("mousedown", (e) => e.preventDefault());
  fragBtn.addEventListener("click", () => {
    const f = fragSel;
    if (!f) return;
    if (f.el.dataset.edited) pending = { el: f.el };
    const kind = flushEdit();
    if (kind === "orig") return;
    adoptFragment(f.v, f.s, f.e);
  });

  // ---- 按钮 ----
  viewSeg.addEventListener("click", guard((e) => {
    const b = e.target.closest("button[data-view]");
    if (!b || b.dataset.view === st.view) return;
    st.view = b.dataset.view;
    setPref("view", st.view);
    render();
  }));
  allBtn.addEventListener("click", guard(() => {
    if (st.versions.length < 2) { adoptAll(0); popSel = null; return; }
    verMenu.replaceChildren(...st.versions.map((x, i) => h("button.rw-menu-i", { type: "button", role: "menuitem", onclick: () => { verMenu.hidden = true; adoptAll(i); } }, verName(i) + (x.model ? " · " + x.model : ""))));
    verMenu.hidden = !verMenu.hidden;
  }));
  box.addEventListener("pointerdown", (e) => { if (!verMenu.hidden && !e.target.closest(".rw-all-wrap")) verMenu.hidden = true; });
  noneBtn.addEventListener("click", guard(() => adoptAll(-1)));
  againBtn.addEventListener("click", guard(() => again()));
  askBtn.addEventListener("click", guard(() => ask()));
  stashBtn.addEventListener("click", guard(() => openStash()));
  onlyIn.addEventListener("change", guard(() => { st.onlyChanged = onlyIn.checked; render(); }));
  okBtn.addEventListener("click", () => finish());
  cancelBtn.addEventListener("click", () => layer.close());
  back.addEventListener("click", () => layer.close());
  closeX.addEventListener("click", () => layer.close());

  // ---- 接着草稿 ----
  if (init.versions && init.versions.length) {
    st.versions = init.versions.map((x) => ({ ...x }));
    st.active = st.versions.length - 1;
    realign({ fresh: 0 });
    if (Array.isArray(init.picks) && init.picks.length === st.segs.length) st.picks = init.picks.slice();
    st.dirty = true;
  } else realign({ fresh: -1 });
  render();
  setTimeout(() => { if (!st.closed && !box.contains(document.activeElement)) box.focus({ preventScroll: true }); }, 0);
  tip("rewrite-compare", "左边原文，右边 AI 的版本。每句都能采用或保留原文，两边都能直接改。点「完成」才写回，按一次撤销全部还原。");
  return api;
}

/**
 * 发一次：确认卡 → 流式结果直接进对比面板。panel 给了就是「再出一版」。
 * opts：promptId、temp（临时写一个）、reuse（上次的选择，不再弹确认卡）、panel
 */
export async function startRun(ctx, { promptId = null, temp = false, reuse = null, panel = null } = {}) {
  const ac = new AbortController();
  let slot = null;
  const ensure = () => {
    if (slot) return slot;
    let target;
    if (panel) target = panel === cur ? panel : null;     // 面板已经关了就不再打开
    else target = cur && cur.chapterId === ctx.chapterId ? cur : openCompare(ctx);
    if (!target) return null;
    slot = target.beginVersion(ac);
    return slot;
  };
  const ch = ws.chapters.find((c) => c.id === ctx.chapterId);
  let stopArm = null;
  if (temp && !reuse) stopArm = armTemp();
  let r = null;
  try {
    r = await runAI({
      feature: "rewrite", bookId: ctx.bookId, ref: ctx.chapterId, input: ctx.input, inputLabel: "选中的文字",
      vars: ws.varsFor(ctx.chapterId), promptId: temp ? "__temp" : promptId || undefined, reuse: reuse || undefined,
      title: (ch ? ws.fullTitle(ch) : "") + " · 选中调用", signal: ac.signal,
      onDelta: (piece, text) => { if (ac.signal.aborted) return; const s = ensure(); if (s) s.update(text); else ac.abort(); },
    });
  } finally { if (stopArm) stopArm(); }
  if (!r) { if (slot) slot.fail(); return null; }
  if (ac.signal.aborted) { if (slot) slot.fail(); return null; }
  const s = ensure();
  if (s) s.done(r);
  return r;
}

/** 「临时写一个」：确认卡里直接切到「临时写一个……」（确认卡还不支持直接指定，见 core_changes） */
function armTemp() {
  let alive = true;
  const t0 = Date.now();
  const tick = () => {
    if (!alive) return;
    const sel = document.querySelector('.modal .ai-card select[aria-label="提示词"]');
    if (sel) {
      if (sel.value !== "__temp" && [...sel.options].some((o) => o.value === "__temp")) {
        sel.value = "__temp";
        sel.dispatchEvent(new Event("change"));
      }
      const ta = document.querySelector(".modal .ai-card textarea");
      if (ta) setTimeout(() => ta.focus(), 30);
      return;
    }
    if (Date.now() - t0 < 120000) setTimeout(tick, 60);
  };
  setTimeout(tick, 0);
  return () => { alive = false; };
}
