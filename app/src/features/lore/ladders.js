// 晋升阶梯：一级一根柱子、越往上越高（各套风格画成星星、铅笔记号、墨痕、蜡烛、档案标签、等级宝石），
// 人物卡上每条阶梯一行，点开选等级、记从第几章起；「体系」里编辑根基和阶梯，能整套导入模板、粘贴文字。
import { h, icon, modal, confirm, prompt } from "../../core/ui.js";
import { uid } from "../../core/db.js";
import { TEMPLATES, parseLadder, newLadder, stepsOf, levelAt, levelIndex, kindOf } from "../../core/lore.js";
import { popover, menu, editable, adder, chip, chapterSelect, undoToast, flash, composing } from "./bits.js";

/** 一排柱子：count 级，cur 是当前第几级（从 0 数，-1 是还没设） */
export function bars(count, cur = -1, cls = "") {
  const n = Math.max(1, count);
  const el = h("span.lr-bars" + cls, { style: { "--n": String(n) }, "aria-hidden": "true" });
  for (let k = 0; k < n; k++) el.append(h("i" + (k <= cur ? ".on" : "") + (k === cur ? ".cur" : ""), { style: { "--k": String(k + 1) } }));
  return el;
}

/** 把一条记录写进卡：同一章（或都不记章节）的那条换掉 */
export function setStep(card, ladderId, levelId, chapterId) {
  card.levels = card.levels || {};
  const list = card.levels[ladderId] = card.levels[ladderId] || [];
  const i = list.findIndex((s) => (s.chapterId || null) === (chapterId || null));
  if (i >= 0) list[i] = { ...list[i], levelId, at: Date.now() };
  else list.push({ id: uid("st"), levelId, chapterId: chapterId || null, at: Date.now() });
}

const stepLabel = (s) => (s.no ? `第 ${s.no} 章` : s.chapterId ? "（章节已删）" : "现在");

/** 人物卡上的一行：阶梯名、柱子、等级名；点开选等级 */
export function ladderRow(env, card, lad, { onChange }) {
  const at = env.atNo();
  const steps = stepsOf(card, lad.id, env.idxOf).filter((s) => levelIndex(lad, s.levelId) >= 0);
  const step = levelAt({ levels: { [lad.id]: steps } }, lad.id, env.idxOf, at);
  const cur = step ? levelIndex(lad, step.levelId) : -1;
  const name = cur >= 0 ? lad.levels[cur].name : "";
  const btn = h("button.lr-lad" + (cur >= 0 ? "" : ".unset"), { type: "button", "aria-haspopup": "dialog",
    title: `${lad.name}：${name || "未设定"}，点一下改` },
    h("span.lr-lad-n", {}, lad.name),
    bars(lad.levels.length, cur),
    h("span.lr-lad-v", {}, name || "未设定"),
    at && cur >= 0 && steps.some((s) => s.no) ? h("span.lr-lad-at", {}, `第 ${at} 章时`) : null);
  btn.addEventListener("click", () => openPicker(btn, env, card, lad, onChange));
  const row = h("div.lr-lad-row", { "data-ladder": lad.id }, btn);
  if (steps.length > 1 || steps.some((s) => s.chapterId)) {
    const line = h("ol.lr-tl", { "aria-label": lad.name + "的变化" });
    steps.forEach((s, i) => {
      const lv = lad.levels[levelIndex(lad, s.levelId)];
      line.append(h("li.lr-tl-s" + (s === step ? ".cur" : ""), {}, h("span.lr-tl-c", {}, stepLabel(s)), h("span.lr-tl-v", {}, lv.name)));
      if (i < steps.length - 1) line.append(h("li.lr-tl-arrow", { "aria-hidden": "true" }, "→"));
    });
    row.append(line);
  }
  return row;
}

function openPicker(anchor, env, card, lad, onChange) {
  const steps = stepsOf(card, lad.id, env.idxOf).filter((s) => levelIndex(lad, s.levelId) >= 0);
  const tied = steps.some((s) => s.chapterId);
  // 已经按章节记过的，默认记在现在写的这一章；没记过的默认不记章节
  const sel = chapterSelect(env, tied ? env.curChapterId() : "");
  const curOf = () => { const s = steps.find((x) => (x.chapterId || "") === sel.value); return s ? levelIndex(lad, s.levelId) : -1; };
  const opts = h("div.lr-lvopts", { role: "listbox", "aria-label": lad.name });
  const paint = () => {
    const cur = curOf();
    opts.replaceChildren(...lad.levels.map((lv, k) => {
      const b = h("button.lr-lvopt" + (k === cur ? ".cur" : ""), { type: "button", role: "option", "aria-selected": String(k === cur), title: lv.power || lv.name },
        bars(lad.levels.length, k, ".mini"), h("span.lr-lvopt-n", {}, lv.name || `第 ${k + 1} 级`), lv.ratio ? h("span.lr-lvopt-r", {}, lv.ratio) : null);
      b.addEventListener("click", async () => {
        p.close(true);
        await onChange(`「${card.name}」的${lad.name}：${lv.name}`, (c) => setStep(c, lad.id, lv.id, sel.value || null));
      });
      return b;
    }));
    clear.hidden = curOf() < 0;
  };
  const clear = h("button.btn.small.ghost.lr-lv-clear", { type: "button" }, "清掉这一条");
  clear.addEventListener("click", async () => {
    p.close(true);
    await onChange(`清掉「${card.name}」的一条${lad.name}`, (c) => {
      const list = (c.levels || {})[lad.id] || [];
      c.levels[lad.id] = list.filter((s) => (s.chapterId || "") !== sel.value);
    });
  });
  sel.addEventListener("change", paint);
  const tl = steps.length ? h("div.lr-lvpick-tl", {}, h("span.muted", {}, "记过的："),
    ...steps.map((s) => chip(`${stepLabel(s)} ${lad.levels[levelIndex(lad, s.levelId)].name}`, {
      cls: ".lr-chip-step",
      onRemove: async () => { p.close(true); await onChange(`删掉「${card.name}」的一条${lad.name}`, (c) => { c.levels[lad.id] = (c.levels[lad.id] || []).filter((x) => x.id !== s.id); }); },
    }))) : null;
  const body = h("div.lr-lvpick", {},
    h("div.lr-lvpick-head", {}, h("b", {}, lad.name), h("label.lr-lvpick-ch", {}, h("span", {}, "从哪一章起"), sel)),
    lad.levels.length ? opts : h("p.muted", {}, "这条阶梯还没有等级，去「体系」里加。"),
    h("div.row", {}, clear), tl);
  const p = popover(anchor, body, { cls: ".lr-pop-lv", env, label: lad.name });
  if (p) paint();
}

// ---------------- 体系：根基和阶梯 ----------------
/** 「体系」页。env.updateMeta(label, fn) 改完会重画 */
export function renderSystem(env) {
  const root = h("div.lr-sys");
  const meta = env.meta;
  const users = (lad) => env.cards.filter((c) => kindOf(meta, c) === "person" && ((c.levels || {})[lad.id] || []).some((s) => levelIndex(lad, s.levelId) >= 0)).length;

  // 根基
  const roots = h("div.lr-sys-roots");
  roots.append(h("span.lr-sys-k", {}, "根基"),
    ...meta.roots.map((r) => chip(r.name, {
      cls: ".lr-chip-root", title: r.note || "点一下改名",
      onClick: async () => {
        const v = await prompt("改根基的名字", r.name, "比如 斗气");
        if (v && v.trim() && v.trim() !== r.name) await env.updateMeta(`根基改名「${v.trim()}」`, (m) => { const x = m.roots.find((y) => y.id === r.id); if (x) x.name = v.trim(); });
      },
      onRemove: async () => {
        const e = await env.updateMeta(`删掉根基「${r.name}」`, (m) => { m.roots = m.roots.filter((y) => y.id !== r.id); m.ladders.forEach((l) => { if (l.rootId === r.id) l.rootId = null; }); });
        undoToast(`已删掉根基「${r.name}」`, e);
      },
    })),
    adder("根基", { placeholder: "比如 斗气、魔力", env, onAdd: async (list, keep) => {
      await env.updateMeta(`加根基「${list.join("、")}」`, (m) => { list.forEach((name) => { if (!m.roots.some((x) => x.name === name)) m.roots.push({ id: uid("rt"), name, note: "" }); }); });
      if (keep) setTimeout(() => { const b = env.root.querySelector(".lr-sys-roots .lr-add"); if (b) b.click(); }, 0);
    } }));
  root.append(h("section.lr-sys-sec", {}, h("p.lr-sys-tip.muted", {}, "根基是力量的来源（比如斗气、魔力），阶梯是一级一级往上走的路（境界、爵位、职业等级）。人物卡上每条阶梯会自动多一行。"), roots));

  // 阶梯
  const list = h("div.lr-ladders");
  meta.ladders.forEach((lad, li) => list.append(ladderCard(env, lad, li, users(lad))));
  if (!meta.ladders.length) list.append(h("div.lr-none", {}, h("p.lr-none-t", {}, "还没有晋升阶梯"), h("p.muted", {}, "可以从模板整套导入，再按自己的设定改；也可以把写好的等级粘贴进来。")));
  root.append(list);

  // 新建
  const blank = h("button.btn.small", { type: "button" }, icon("plus"), "空白阶梯");
  blank.addEventListener("click", async () => {
    const name = await prompt("新阶梯的名字", "", "比如 修炼境界、贵族爵位");
    if (name == null) return;
    const lad = newLadder(name.trim() || "新阶梯");
    const e = await env.updateMeta(`新建阶梯「${lad.name}」`, (m) => { m.ladders.push(lad); });
    undoToast(`已新建「${lad.name}」，在下面加等级`, e);
    focusLadder(env, lad.id);
  });
  const tpl = h("button.btn.small", { type: "button" }, icon("ladder"), "从模板导入");
  tpl.addEventListener("click", () => menu(tpl, TEMPLATES.map((t) => [`${t.name}　${t.levels.slice(0, 3).map((l) => l.name).join(" → ")} …`, async () => {
    const lad = newLadder(t.name, t.levels);
    const e = await env.updateMeta(`导入模板「${t.name}」`, (m) => { m.ladders.push(lad); });
    undoToast(`已导入「${t.name}」，${t.levels.length} 级，都可以改`, e);
    focusLadder(env, lad.id);
  }]), env));
  const paste = h("button.btn.small", { type: "button" }, icon("list"), "粘贴文字");
  paste.addEventListener("click", () => pasteLadder(env));
  root.append(h("div.lr-sys-new", {}, h("span.lr-sys-k", {}, "加一条阶梯"), blank, tpl, paste));
  return root;
}

function focusLadder(env, id) {
  setTimeout(() => {
    const el = env.root.querySelector(`.lr-ladder[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    flash(el, "lr-born");
  }, 30);
}

function ladderCard(env, lad, index, nUsers) {
  const meta = env.meta;
  const card = h("article.lr-ladder", { "data-id": lad.id, style: { "--i": String(index) } });
  const name = h("h3.lr-ladder-name");
  editable(name, { get: () => lad.name, env, empty: "未命名阶梯", save: (v) => env.updateMeta(`阶梯改名「${v || "未命名"}」`, (m) => { const x = m.ladders.find((y) => y.id === lad.id); if (x) x.name = v.trim() || "未命名阶梯"; }) });
  const more = h("button.icon-btn", { type: "button", "aria-label": "这条阶梯的更多操作", title: "更多" }, icon("more"));
  more.addEventListener("click", () => menu(more, [
    ["上移", () => env.updateMeta("移动阶梯", (m) => move(m.ladders, lad.id, -1)), { disabled: index === 0 }],
    ["下移", () => env.updateMeta("移动阶梯", (m) => move(m.ladders, lad.id, 1)), { disabled: index === meta.ladders.length - 1 }],
    "sep",
    ["删掉这条阶梯", async () => {
      if (nUsers && !(await confirm(`删掉「${lad.name}」？`, `有 ${nUsers} 个人物记了这条阶梯上的等级。删掉后人物卡上就不显示了，马上点「撤销」能找回。`, "删掉", true))) return;
      const e = await env.updateMeta(`删掉阶梯「${lad.name}」`, (m) => { m.ladders = m.ladders.filter((x) => x.id !== lad.id); });
      undoToast(`已删掉「${lad.name}」`, e);
    }, { danger: true }],
  ], env));
  const head = h("div.lr-ladder-head", {}, name, h("span.lr-ladder-meta", {}, `${lad.levels.length} 级` + (nUsers ? ` · ${nUsers} 个人物用到` : "")), more);
  if (meta.roots.length) {
    const rs = h("select.select.small.lr-ladder-root", { "aria-label": "属于哪个根基" },
      h("option", { value: "" }, "不属于哪个根基"), ...meta.roots.map((r) => h("option", { value: r.id }, "根基：" + r.name)));
    rs.value = lad.rootId || "";
    rs.addEventListener("change", () => env.updateMeta(`「${lad.name}」的根基`, (m) => { const x = m.ladders.find((y) => y.id === lad.id); if (x) x.rootId = rs.value || null; }));
    head.append(rs);
  }
  card.append(head);
  if (lad.levels.length) card.append(h("div.lr-ladder-stair", {}, bars(lad.levels.length, lad.levels.length - 1, ".big"),
    h("div.lr-ladder-ends", {}, h("span", {}, lad.levels[0].name), lad.levels.length > 1 ? h("span", {}, lad.levels[lad.levels.length - 1].name) : null)));

  const rows = h("ol.lr-lvs");
  lad.levels.forEach((lv, k) => rows.append(levelRow(env, lad, lv, k)));
  card.append(rows, adder("加一级", { placeholder: "等级名，可以用顿号一次写几个", env, cls: ".lr-add-lv", onAdd: async (names, keep) => {
    await env.updateMeta(`「${lad.name}」加 ${names.length} 级`, (m) => {
      const x = m.ladders.find((y) => y.id === lad.id);
      if (x) names.forEach((n) => x.levels.push({ id: uid("lv"), name: n.slice(0, 20), power: "", need: "", cost: "", ratio: "" }));
    });
    if (keep) setTimeout(() => { const b = env.root.querySelector(`.lr-ladder[data-id="${lad.id}"] .lr-add-lv`); if (b) b.click(); }, 0);
  } }));
  return card;
}

function move(list, id, d) {
  const i = list.findIndex((x) => x.id === id);
  const j = i + d;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

const LV_FIELDS = [["power", "能力表现", "这一级能做到什么"], ["need", "突破条件", "怎样升到下一级"], ["cost", "代价", "升级要付出什么"], ["ratio", "在世人数", "大致比例，比如 千中一"]];

function levelRow(env, lad, lv, k) {
  const open = env.openLevels.has(lv.id);
  const li = h("li.lr-lv" + (open ? ".open" : ""), { "data-id": lv.id });
  const set = (key, label) => (v) => env.updateMeta(`「${lv.name || "这一级"}」的${label}`, (m) => {
    const x = m.ladders.find((y) => y.id === lad.id);
    const l = x && x.levels.find((y) => y.id === lv.id);
    if (l) l[key] = key === "name" ? v.trim().slice(0, 20) || l.name : v.trim();
  });
  const name = h("span.lr-lv-name");
  editable(name, { get: () => lv.name, env, empty: "未命名", save: set("name", "名字") });
  const toggle = h("button.icon-btn.lr-lv-tog", { type: "button", "aria-expanded": String(open), "aria-label": "展开这一级的说明", title: "能力、突破条件、代价、人数" }, icon("more"));
  toggle.addEventListener("click", () => {
    if (env.openLevels.has(lv.id)) env.openLevels.delete(lv.id); else env.openLevels.add(lv.id);
    const on = env.openLevels.has(lv.id);
    li.classList.toggle("open", on);
    toggle.setAttribute("aria-expanded", String(on));
  });
  const del = h("button.icon-btn.lr-lv-del", { type: "button", "aria-label": `删掉「${lv.name}」`, title: "删掉这一级" }, icon("close"));
  del.addEventListener("click", async () => {
    const used = env.cards.filter((c) => ((c.levels || {})[lad.id] || []).some((s) => s.levelId === lv.id)).length;
    if (used && !(await confirm(`删掉「${lv.name}」？`, `有 ${used} 个人物记在这一级上，删掉后那几条记录不再显示。马上点「撤销」能找回。`, "删掉", true))) return;
    const e = await env.updateMeta(`删掉「${lv.name}」`, (m) => { const x = m.ladders.find((y) => y.id === lad.id); if (x) x.levels = x.levels.filter((y) => y.id !== lv.id); });
    undoToast(`已删掉「${lv.name}」`, e);
  });
  const up = h("button.icon-btn.lr-lv-up", { type: "button", "aria-label": "往前挪", title: "往前挪", disabled: k === 0 }, "↑");
  up.addEventListener("click", () => env.updateMeta("挪动等级", (m) => { const x = m.ladders.find((y) => y.id === lad.id); if (x) move(x.levels, lv.id, -1); }));
  const ratio = h("span.lr-lv-ratio");
  editable(ratio, { get: () => lv.ratio, env, empty: "人数比例", save: set("ratio", "在世人数") });
  li.append(h("div.lr-lv-main", {}, h("span.lr-lv-k", {}, String(k + 1)), name, ratio, h("span.lr-lv-acts", {}, up, toggle, del)));
  const more = h("div.lr-lv-more");
  LV_FIELDS.slice(0, 3).forEach(([key, label, hint]) => {
    const v = h("div.lr-fv");
    editable(v, { get: () => lv[key], env, long: true, placeholder: hint, save: set(key, label) });
    more.append(h("div.lr-row.lr-lv-f", {}, h("span.lr-fl", {}, label), v));
  });
  li.append(more);
  return li;
}

/** 粘贴一段文字建阶梯：一行一级，或「名称：说明」，或「凡人 → 炼气 → 筑基」 */
export function pasteLadder(env) {
  const draft = env.pasteDraft || { name: "", text: "" };
  const name = h("input.input", { placeholder: "阶梯名，比如 修炼境界", value: draft.name, maxlength: "30" });
  const ta = h("textarea.textarea.lr-paste-ta", { rows: "8", placeholder: "一行一级，比如：\n凡人：肉体凡胎\n炼气：能用小法术；突破：灵气积满；代价：要有灵根；比例：千中一\n\n也可以写成一行：凡人 → 炼气 → 筑基" });
  ta.value = draft.text;
  const prev = h("ol.lr-paste-prev");
  const count = h("span.muted");
  let parsed = [];
  const refresh = () => {
    parsed = parseLadder(ta.value);
    count.textContent = parsed.length ? `认出 ${parsed.length} 级` : "还没认出等级";
    prev.replaceChildren(...parsed.map((l, i) => h("li", {}, h("b", {}, l.name), [l.power, l.need && "突破：" + l.need, l.cost && "代价：" + l.cost, l.ratio && "比例：" + l.ratio].filter(Boolean).length
      ? h("span.muted", {}, "　" + [l.power, l.need && "突破：" + l.need, l.cost && "代价：" + l.cost, l.ratio && "比例：" + l.ratio].filter(Boolean).join("；")) : null)));
    if (ok) ok.disabled = !parsed.length;
  };
  ta.addEventListener("input", refresh);
  let ok = null;
  const m = modal({
    title: "粘贴一套阶梯",
    body: h("div.lr-paste", {}, h("label.field", {}, h("span", {}, "名字"), name), h("label.field", {}, h("span", {}, "等级（粘贴进来）"), ta), h("div.row", {}, count), prev),
    wide: true,
    isDirty: () => !!(ta.value.trim() || name.value.trim()) && !done,
    onKeepDraft: () => { env.pasteDraft = { name: name.value, text: ta.value }; },
    actions: [
      { label: "建好", primary: true, onClick: async () => {
        if (!parsed.length) return;
        done = true;
        env.pasteDraft = null;
        const lad = newLadder(name.value.trim() || "新阶梯", parsed);
        m.close(true);
        const e = await env.updateMeta(`粘贴建阶梯「${lad.name}」`, (mm) => { mm.ladders.push(lad); });
        undoToast(`已建好「${lad.name}」，${parsed.length} 级`, e);
        focusLadder(env, lad.id);
      } },
      { label: "取消", onClick: () => m.close() },
    ],
  });
  let done = false;
  m.el.classList.add("lr-paste-modal");
  ok = m.foot.querySelector(".btn.primary");
  ta.addEventListener("keydown", (e) => { if (!composing(e) && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ok.click(); } });
  refresh();
  setTimeout(() => (draft.text ? ta : name).focus(), 0);
}
