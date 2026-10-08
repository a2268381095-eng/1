// 一键排版：整理本章、选中的几章或全书的空白和标点，不改字。
// 预览盖在正文区上面（删掉的标红划线、加上的标绿），点「写回」才改；写回算一步，按一次撤销全部还原。
import { ws } from "../editor/workspace.js";
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { undo as appUndo } from "../../core/undo.js";
import { db } from "../../core/db.js";
import { h, icon, toast, notice, pushLayer, topLayer, prompt, confirm } from "../../core/ui.js";
import { undo as cmUndo, redo as cmRedo, undoDepth, redoDepth } from "@codemirror/commands";
import { tip } from "../demon/demon.js";
import { RULES, formatText, getSchemes, saveScheme, deleteScheme, getUserSchemes, setUserSchemes,
  normalizeRules, sameRules, isBuiltinScheme } from "./engine.js";
import { diffParts } from "./diff.js";

let cur = null;        // 打开着的预览
let opening = false;

const bookGap = () => (ws.book && ws.book.paraGap ? 1 : 0);
const lastKey = () => "format:last:" + ws.book.id;
const narrow = () => matchMedia("(max-width: 640px)").matches;

/** 方案实际用的规则：「默认」的段间空行跟着作品设置走 */
function effective(scheme) {
  const r = normalizeRules(scheme.rules);
  if (scheme.builtin && scheme.name === "默认") r.paraGap = bookGap();
  return r;
}

/** 删掉、加上的空白换成看得见的记号 */
const WS_GLYPH = { " ": "␣", " ": "␣", "　": "□", "\t": "→", "\n": "↵" };
const SHOW_MAX = 3000;   // 一章里最多标出这么多段改动，再多页面会卡
function renderParts(parts) {
  const box = h("div.fmt-text");
  let shown = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.t === 0) { box.append(p.s); continue; }
    if (++shown > SHOW_MAX) {
      const rest = parts.slice(i).filter((x) => x.t !== 0).length;
      box.append(h("p.fmt-more", {}, `后面还有 ${rest} 段改动没列出来，写回时一起改。`));
      break;
    }
    const el = h(p.t < 0 ? "del.fmt-del" : "ins.fmt-ins", { title: p.t < 0 ? "删掉" : "加上" });
    let buf = "";
    const flush = () => { if (buf) { el.append(buf); buf = ""; } };
    for (const ch of p.s) {
      const g = WS_GLYPH[ch];
      if (!g) { buf += ch; continue; }
      flush();
      el.append(h("span.fmt-ws", {}, g));
      if (ch === "\n" && p.t > 0) el.append("\n");
    }
    flush();
    box.append(el);
  }
  return box;
}

function setPressed(on) {
  const b = document.querySelector('.ws .tool-btn[data-cmd="format.open"]');
  if (b) b.setAttribute("aria-pressed", String(on));
}

// ---------------- 打开预览 ----------------
async function openFormat(opts = {}) {
  if (!ws.book || !ws.els()) return;
  if (cur) {
    // 已经开着：点了「排版这几章」就换到选中的几章
    const want = (opts && opts.scope) || (ws.selectedIds().length >= 2 ? "selected" : "");
    if (want) cur.setScope(want);
    cur.focus();
    return;
  }
  if (opening) return;
  opening = true;
  try {
    try { await ws.editor.flush(); } catch (_) { /* 保存失败另有提示，这里照样能看预览 */ }
    const schemes = await getSchemes();
    let last = null;
    try { last = await db.getKV(lastKey(), null); } catch (_) { /* 读不到上次的设置就用默认 */ }
    if (!ws.book || !ws.els()) return;
    const sel = ws.selectedIds();
    const scope = (opts && opts.scope) || (sel.length >= 2 ? "selected" : "current");
    // 上次用的是「默认」：段间空行照样跟着作品设置走（作品设置可能改过）
    const lastBuiltin = last && schemes.find((s) => s.builtin && s.name === last.scheme);
    const rules = lastBuiltin ? effective(lastBuiltin) : last && last.rules ? normalizeRules(last.rules) : effective(schemes[0]);
    build({ scope, rules, scheme: last ? last.scheme || "" : schemes[0].name, schemes });
  } finally { opening = false; }
  tip("format-first", "排版只动空白和标点，不改字。先在这里看改动，点「写回」才生效，按一次撤销能全部还原。");
}

function build(st) {
  const center = ws.els().center;
  Object.assign(st, { results: [], gen: 0, skip: new Set(), open: new Set(), multi: false, busy: false });

  const back = h("button.icon-btn", { type: "button", title: "返回正文（Esc）", "aria-label": "返回正文" }, icon("back"));
  const closeX = h("button.icon-btn.fmt-x", { type: "button", title: "关闭（Esc）", "aria-label": "关闭" }, icon("close"));
  const head = h("div.fmt-head", {}, back, h("h2", {}, "一键排版"), h("span.fmt-sub", {}, "只动空白和标点，不改字"), closeX);

  const scopeSeg = h("div.fmt-seg", { role: "group", "aria-label": "排版范围" });
  const schemeSel = h("select.select.fmt-scheme", { "aria-label": "排版方案" });
  const saveBtn = h("button.btn.small", { type: "button" }, "存为方案");
  const delBtn = h("button.btn.small.ghost.fmt-del-scheme", { type: "button" }, "删除方案");
  const rulesSum = h("summary");
  const grid = h("div.fmt-rules-grid");
  const rulesBox = h("details.fmt-rules", { open: !narrow() }, rulesSum, grid);
  const ctrl = h("div.fmt-ctrl", {},
    h("div.fmt-row", {}, h("span.fmt-label", {}, "范围"), scopeSeg),
    h("div.fmt-row", {}, h("span.fmt-label", {}, "方案"), schemeSel, saveBtn, delBtn),
    rulesBox);
  const sum = h("div.fmt-sum", { role: "status", "aria-live": "polite" });
  const cancelBtn = h("button.btn", { type: "button" }, "取消");
  const okBtn = h("button.btn.primary.fmt-ok", { type: "button", disabled: true }, icon("check"), "写回");
  const actions = h("div.fmt-actions", {}, sum, h("div.fmt-btns", {}, cancelBtn, okBtn));
  const preview = h("div.fmt-preview", { "aria-label": "改动预览" });
  const box = h("section.fmt-overlay", { role: "dialog", "aria-label": "一键排版" }, head, ctrl, actions, preview);
  center.classList.add("fmt-on");
  center.append(box);
  setPressed(true);
  // 盖住的章名和正文不让键盘摸到（不然 Tab 能跳进去打字，预览就对不上了）
  const hidden = [center.querySelector(".ch-head"), ws.els().edHost].filter(Boolean);
  hidden.forEach((el) => { el.inert = true; });
  closeX.focus();

  const offs = [];
  const layer = pushLayer({
    onClose: () => {
      box.remove();
      hidden.forEach((el) => { el.inert = false; });
      center.classList.remove("fmt-on");
      offs.forEach((off) => off());
      cur = null;
      setPressed(false);
      if (ws.book && ws.editor) ws.editor.focus();
    },
  });
  const close = () => layer.close(true);
  back.addEventListener("click", close);
  closeX.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  okBtn.addEventListener("click", () => commit());

  // ---- 范围 ----
  function idsFor() {
    if (st.scope === "book") return ws.chapters.map((c) => c.id);
    if (st.scope === "selected") { const s = ws.selectedIds(); if (s.length >= 2) return s; }
    return ws.current ? [ws.current.id] : [];
  }
  function renderScope() {
    const n = ws.selectedIds().length;
    if (st.scope === "selected" && n < 2) st.scope = "current";
    const opts = [["current", "本章"], n >= 2 ? ["selected", `选中的 ${n} 章`] : null, ["book", `全书 ${ws.chapters.length} 章`]].filter(Boolean);
    scopeSeg.replaceChildren(...opts.map(([id, text]) => {
      const b = h("button", { type: "button", "aria-pressed": String(st.scope === id), "data-scope": id }, text);
      b.addEventListener("click", () => setScope(id));
      return b;
    }));
  }
  function setScope(id) {
    if (st.scope === id) return;
    st.scope = id;
    st.skip.clear();
    st.open.clear();
    renderScope();
    compute();
  }

  // ---- 规则 ----
  function renderRules() {
    grid.textContent = "";
    for (const rule of RULES) {
      const cb = h("input", { type: "checkbox", "data-rule": rule.id });
      cb.checked = !!st.rules[rule.id];
      cb.addEventListener("change", () => { st.rules[rule.id] = cb.checked; rulesChanged(); });
      const card = h("div.fmt-rule" + (cb.checked ? ".on" : ""), {},
        h("label.fmt-rule-main", {}, cb, h("span.fmt-rule-name", {}, rule.name), rule.optional ? h("span.fmt-opt", {}, "可选") : null),
        h("span.fmt-rule-desc", {}, rule.desc));
      if (rule.id === "gap") {
        const radio = (v, text) => {
          const rb = h("input", { type: "radio", name: "fmt-gap", value: String(v), disabled: !st.rules.gap });
          rb.checked = st.rules.paraGap === v;
          rb.addEventListener("change", () => { if (rb.checked) { st.rules.paraGap = v; rulesChanged(); } });
          return h("label.check", {}, rb, text);
        };
        card.append(h("div.fmt-gap", { role: "radiogroup", "aria-label": "段与段之间" }, radio(0, "不空行"), radio(1, "空一行")));
      }
      grid.append(card);
    }
    rulesSum.textContent = `规则 · 开着 ${RULES.filter((r) => st.rules[r.id]).length} 条`;
  }
  function rulesChanged() {
    renderRules();
    renderSchemes();
    saveLast();
    compute();
  }

  // ---- 方案 ----
  function renderSchemes() {
    const match = st.schemes.find((s) => s.name === st.scheme && sameRules(effective(s), st.rules))
      || st.schemes.find((s) => sameRules(effective(s), st.rules));
    st.scheme = match ? match.name : "";
    schemeSel.replaceChildren(
      ...(match ? [] : [h("option", { value: "" }, "自定义")]),
      ...st.schemes.map((s) => h("option", { value: s.name }, s.name + (s.builtin && s.name === "默认" ? "（空行跟作品设置）" : ""))));
    schemeSel.value = st.scheme;
    delBtn.hidden = !match || !!match.builtin;
  }
  schemeSel.addEventListener("change", () => {
    const s = st.schemes.find((x) => x.name === schemeSel.value);
    if (!s) return;
    st.scheme = s.name;
    st.rules = effective(s);
    rulesChanged();
  });
  async function reloadSchemes() {
    st.schemes = await getSchemes();
    if (cur === api) renderSchemes();
  }

  saveBtn.addEventListener("click", async () => {
    const suggest = st.scheme && !isBuiltinScheme(st.scheme) ? st.scheme : "";
    // 输入框里按回车关掉弹窗后焦点会回到原来的按钮，回车又会点它一次；所以先把焦点放到方案下拉框上
    schemeSel.focus();
    const input = await prompt("存为排版方案", suggest, "方案名，比如：投稿用");
    if (input == null) return;
    const name = input.trim();
    if (!name) { toast("方案名不能空着"); return; }
    if (isBuiltinScheme(name)) { toast(`「${name}」是自带的方案，换个名字吧`); return; }
    const before = await getUserSchemes();
    if (before.some((s) => s.name === name) && !(await confirm(`已经有「${name}」了`, "用现在的规则覆盖它吗？", "覆盖"))) return;
    try { await saveScheme(name, st.rules); }
    catch (e) { schemeError("方案没能存上。", e, () => saveBtn.click()); return; }
    const after = await getUserSchemes();
    const entry = appUndo.push({
      label: "保存排版方案",
      undo: async () => { await setUserSchemes(before); await refreshOpen(); },
      redo: async () => { await setUserSchemes(after); await refreshOpen(); },
    });
    st.scheme = name;
    await reloadSchemes();
    toast(`已存为方案「${name}」`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
  });

  delBtn.addEventListener("click", async () => {
    const name = st.scheme;
    if (!name || isBuiltinScheme(name)) return;
    const before = await getUserSchemes();
    try { await deleteScheme(name); }
    catch (e) { schemeError("方案没能删掉。", e, () => delBtn.click()); return; }
    const after = await getUserSchemes();
    const entry = appUndo.push({
      label: "删除排版方案",
      undo: async () => { await setUserSchemes(before); await refreshOpen(); },
      redo: async () => { await setUserSchemes(after); await refreshOpen(); },
    });
    await reloadSchemes();
    toast(`已删除方案「${name}」`, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
  });

  function schemeError(what, e, retry) {
    notice({
      what,
      why: "本地存储出错，可能磁盘满了或者浏览器限制了存储。现在的规则还在，可以直接写回。",
      detail: e && (e.stack || e.message || e),
      actions: [{ label: "再试一次", primary: true, run: retry }],
    });
  }

  function saveLast() {
    if (!ws.book) return;
    db.setKV(lastKey(), { rules: { ...st.rules }, scheme: st.scheme }).catch(() => { /* 记不住上次的规则不要紧 */ });
  }

  // ---- 预览 ----
  async function compute() {
    const g = ++st.gen;
    const ids = idsFor();
    okBtn.disabled = true;
    sum.textContent = "正在看……";
    const res = [];
    let tick = performance.now();
    for (let k = 0; k < ids.length; k++) {
      const c = ws.chapters.find((x) => x.id === ids[k]);
      if (!c) continue;
      const before = ws.textOf(c.id);
      const after = formatText(before, st.rules);
      const d = after === before ? { parts: null, count: 0 } : diffParts(before, after);
      res.push({ id: c.id, title: ws.fullTitle(c), count: d.count, parts: d.parts, before, after });
      // 章多、章长的时候隔一会儿让出界面，不卡住
      if (performance.now() - tick > 40 && k + 1 < ids.length) {
        sum.textContent = `正在看…… ${k + 1} / ${ids.length} 章`;
        await new Promise((r) => setTimeout(r, 0));
        if (g !== st.gen || cur !== api) return;
        tick = performance.now();
      }
    }
    if (g !== st.gen || cur !== api) return;
    st.results = res;
    st.multi = ids.length > 1;
    renderPreview();
  }

  function updateSum() {
    const changed = st.results.filter((r) => r.count);
    const picked = changed.filter((r) => !st.skip.has(r.id));
    const total = picked.reduce((s, r) => s + r.count, 0);
    okBtn.disabled = !total || st.busy;
    if (!st.results.length) { sum.textContent = "没有能排版的章节。"; return; }
    if (!st.multi) {
      const r = st.results[0];
      if (!r.count) sum.replaceChildren(h("span.fmt-sum-t", {}, r.title), "：很整齐，没有要改的。");
      else sum.replaceChildren(h("span.fmt-sum-t", {}, r.title), "：要改 ", h("b", {}, String(r.count)), " 处");
      return;
    }
    if (!changed.length) { sum.textContent = `这 ${st.results.length} 章都很整齐，没有要改的。`; return; }
    sum.replaceChildren("要改 ", h("b", {}, String(total)), ` 处，${picked.length} 章`,
      picked.length < changed.length ? `（跳过 ${changed.length - picked.length} 章）` : "");
  }

  function chapterCard(r) {
    const cb = h("input", { type: "checkbox", "aria-label": "写回" + r.title });
    cb.checked = !st.skip.has(r.id);
    cb.addEventListener("change", () => { if (cb.checked) st.skip.delete(r.id); else st.skip.add(r.id); card.classList.toggle("off", !cb.checked); updateSum(); });
    const isOpen = st.open.has(r.id);
    const tog = h("button.btn.small.ghost.fmt-ch-tog", { type: "button", "aria-expanded": String(isOpen) }, isOpen ? "收起" : "看改动");
    const body = h("div.fmt-ch-body", { hidden: !isOpen });
    if (isOpen) body.append(renderParts(r.parts));
    tog.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      tog.setAttribute("aria-expanded", String(open));
      tog.textContent = open ? "收起" : "看改动";
      if (open) { st.open.add(r.id); if (!body.firstChild) body.append(renderParts(r.parts)); }
      else st.open.delete(r.id);
    });
    const card = h("div.fmt-ch" + (cb.checked ? "" : ".off"), { "data-id": r.id },
      h("div.fmt-ch-head", {}, h("label.check.fmt-ch-t", {}, cb, h("span", {}, r.title)), h("span.fmt-ch-n", {}, `改 ${r.count} 处`), tog),
      body);
    return card;
  }

  function renderPreview() {
    const top = preview.scrollTop;
    preview.textContent = "";
    updateSum();
    if (!st.results.length) { preview.append(h("div.empty", {}, "没有能排版的章节。")); return; }
    if (!st.multi) {
      const r = st.results[0];
      preview.append(r.count ? renderParts(r.parts) : h("div.empty", {}, "这一章不用改。"));
    } else {
      const changed = st.results.filter((r) => r.count);
      if (!changed.length) preview.append(h("div.empty", {}, "都不用改。"));
      changed.forEach((r) => preview.append(chapterCard(r)));
      const same = st.results.length - changed.length;
      if (same && changed.length) preview.append(h("p.fmt-same", {}, `另外 ${same} 章不用改。`));
    }
    preview.scrollTop = top;
  }

  // ---- 写回 ----
  async function commit() {
    if (st.busy) return;
    st.busy = true;
    okBtn.disabled = true;
    try { await ws.editor.flush(); } catch (_) { /* 保存失败另有提示 */ }
    const picked = new Map(st.results.filter((r) => r.count && !st.skip.has(r.id)).map((r) => [r.id, r]));
    const changes = [], befores = new Map(), afters = new Map(), depths = {};
    let count = 0;
    for (const c of ws.chapters) {
      const r = picked.get(c.id);
      if (!r) continue;
      // 预览算过的直接用；正文在预览之后又变了就重新排
      const before = ws.textOf(c.id), same = r.before === before;
      const after = same ? r.after : formatText(before, st.rules);
      if (after === before) continue;
      befores.set(c.id, before);
      afters.set(c.id, after);
      depths[c.id] = ws.editor.depthOf(c.id);
      changes.push({ chapterId: c.id, after });
      count += same ? r.count : diffParts(before, after).count;
    }
    if (!changes.length) { st.busy = false; toast("很整齐，没有要改的"); close(); return; }
    let entry;
    try { entry = await ws.applyBatch("一键排版", changes); if (entry) tidyUndo(entry, befores, afters, depths); }
    catch (e) {
      st.busy = false;
      updateSum();
      notice({
        what: "排版没能全部写回。",
        why: "本地存储出错（磁盘满了或浏览器限制了存储），也可能其中某章刚被删掉。",
        detail: e && (e.stack || e.message || e),
        actions: [
          { label: "还原成排版前", primary: true, run: () => restore(befores) },
          { label: "再试一次", run: () => commit() },
        ],
      });
      return;
    }
    saveLast();
    close();
    const msg = changes.length > 1 ? `已排版 ${changes.length} 章，改了 ${count} 处` : `已排版，改了 ${count} 处`;
    toast(msg, { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } });
    bus.emit("format:done", { count, chapters: changes.length });
  }

  async function restore(befores) {
    const back = [...befores].filter(([id, text]) => ws.chapters.some((c) => c.id === id) && ws.textOf(id) !== text)
      .map(([chapterId, after]) => ({ chapterId, after }));
    if (!back.length) { toast("正文没有改动"); return; }
    try {
      await ws.applyBatch("还原排版", back);
      toast(`已还原 ${back.length} 章`);
      if (cur === api) compute();
    } catch (e) {
      notice({
        what: "没能还原。",
        why: "本地存储还是写不进去。正文还在编辑器里，可以先把这一章复制出来。",
        detail: e && (e.stack || e.message || e),
      });
    }
  }

  // ---- 跟着外面的变化 ----
  const again = () => { renderScope(); compute(); };
  offs.push(
    bus.on("chapter:opened", () => { renderScope(); if (st.scope === "current") compute(); }),
    bus.on("chapter:created", again),
    bus.on("chapter:deleted", again),
    bus.on("replace:done", again),
    bus.on("undo", () => compute()),
    bus.on("redo", () => compute()),
    bus.on("route", () => close()),
  );
  // 章节列表里改了多选：范围按钮上的章数跟着变，正在看「选中的几章」就重新算
  const side = ws.els().list.closest("aside") || ws.els().list;
  let nSel = ws.selectedIds().length;
  const onSide = () => setTimeout(() => {
    if (cur !== api) return;
    const n = ws.selectedIds().length;
    if (n === nSel) return;
    nSel = n;
    const was = st.scope;
    renderScope();
    if (was === "selected" || st.scope !== was) compute();
  }, 0);
  side.addEventListener("click", onSide);
  offs.push(() => side.removeEventListener("click", onSide));

  const api = {
    setScope: (id) => { renderScope(); if (id === "selected" && ws.selectedIds().length < 2) return; setScope(id); },
    // 上面还盖着别的弹窗（比如存方案的输入框）时不抢焦点，免得回车点到「写回」
    focus: () => { if (topLayer() === layer) (okBtn.disabled ? closeX : okBtn).focus(); },
    close,
    reloadSchemes,
  };
  cur = api;
  renderScope();
  renderRules();
  renderSchemes();
  compute().then(() => { if (cur === api) api.focus(); });
}

/**
 * ws.applyBatch 撤销时是往编辑器里再写一笔，历史里会留下「排版」「还原」两步，
 * 之后在正文里按 Ctrl+Z 会把排版又改回来，连着排两次再撤两次也回不到原文。这里补两件事：
 *   · 打开着的那一章，最近一步就是这次排版时，改用编辑器自己的撤销 / 重做，历史里不多出一步；
 *   · 其他章：上一条批量操作记的撤销深度接到现在，正文里按 Ctrl+Z 还能接着整体撤销。
 * depths：写回之前各章的撤销深度（重做时更新）。
 */
function tidyUndo(entry, befores, afters, depths) {
  const undo0 = entry.undo, redo0 = entry.redo;
  const step = (back) => {
    const view = ws.editor && ws.editor.view, id = ws.current && ws.current.id;
    const from = back ? afters : befores, to = back ? befores : afters;
    if (!view || !id || !from.has(id) || view.state.doc.toString() !== from.get(id)) return;
    if (back ? undoDepth(view.state) !== entry.chapters[id] : !redoDepth(view.state)) return;
    (back ? cmUndo : cmRedo)(view);
    // 对不上（中间有别的改动）就退回去，照原来的办法写
    if (view.state.doc.toString() !== to.get(id)) (back ? cmRedo : cmUndo)(view);
  };
  entry.undo = async () => {
    const prev = appUndo.peek();   // 这一条已经出栈，peek 到的是上一条
    step(true);
    await undo0();
    if (prev && prev !== entry && prev.chapters) {
      for (const [id, d] of Object.entries(entry.chapters || {})) {
        if (depths[id] >= 0 && prev.chapters[id] === depths[id]) prev.chapters[id] = d;
      }
    }
  };
  entry.redo = async () => {
    for (const id of afters.keys()) depths[id] = ws.editor ? ws.editor.depthOf(id) : -1;
    step(false);
    await redo0();
  };
}

/** 撤销、重做方案改动时，预览开着就刷新下拉框 */
async function refreshOpen() { if (cur) await cur.reloadSchemes(); }

// ---------------- 注册 ----------------
export async function register() {
  const inBook = () => ws.isOpen() && !!ws.els();
  commands.register({
    id: "format.open", title: "一键排版",
    keywords: "排版 整理 格式 缩进 段首 空两格 空行 段间 行尾空格 标点 全角 半角 引号 省略号 破折号 断行 合并",
    hint: "整理空白和标点，不改字；先看改动再写回", key: "Mod-Shift-l", when: inBook,
    run: (o) => openFormat(o && o.scope ? o : {}),
  });
  commands.register({
    id: "format.book", title: "全书排版",
    keywords: "排版 全书 整本 所有章节 统一格式",
    hint: "整本书一起整理空白和标点", when: inBook,
    run: () => openFormat({ scope: "book" }),
  });
}
