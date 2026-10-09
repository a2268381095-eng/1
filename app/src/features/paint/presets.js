// 常用要求：一排能勾的小签，勾上就加进提示词。作者可以改、加、删（删了能撤销），勾了哪些按用途记住。
// 存在 kv：paint:presets = { v, list: [{ id, name, text, for }] }（没存过时用默认的几条），paint:ticks:<用途> = [勾上的 id]。
import { db, uid } from "../../core/db.js";
import { h, icon, toast, pushLayer } from "../../core/ui.js";
import { DEFAULT_PRESETS, SCOPES, appliesTo } from "./prompt.js";

const KEY = "paint:presets";
export async function loadPresets() {
  const v = await db.getKV(KEY, null);
  return v && Array.isArray(v.list) ? v.list : DEFAULT_PRESETS.map((p) => ({ ...p }));
}
const savePresets = (list) => db.setKV(KEY, { v: 1, list });
export const loadTicks = (purpose) => db.getKV("paint:ticks:" + purpose, []);
const saveTicks = (purpose, ids) => db.setKV("paint:ticks:" + purpose, ids);

const motionFull = () => document.documentElement.dataset.motion === "full";

/**
 * presetBox({ purpose, onChange }) → { el, ready, picked() 勾上的（这个用途能用的）, flash() }
 * 悬停 / 聚焦一条时下面显示它的全文；「编辑」打开后每条能改、能删，还能加一条、恢复默认的几条。
 */
export function presetBox({ purpose, onChange }) {
  const st = { list: [], ticks: [], editing: false, form: null };
  const chips = h("div.paint-chips", { role: "group", "aria-label": "常用要求" });
  const tipEl = h("p.paint-chip-tip", { "aria-live": "polite" });
  const editBtn = h("button.btn.small.ghost.paint-chip-edit", { type: "button", "aria-pressed": "false" }, "编辑");
  const formBox = h("div.paint-chip-formbox");
  const hint = "鼠标放在一条上能看全文。勾上的加进提示词，下次还勾着。";
  const el = h("section.paint-sec.paint-presets", {},
    h("div.paint-sec-h", {}, h("h3", {}, "常用要求"), h("span.spacer"), editBtn),
    chips, tipEl, formBox);

  const shown = () => st.list.filter((p) => appliesTo(p, purpose));
  const showTip = (p) => { tipEl.textContent = p ? p.text : hint; tipEl.classList.toggle("on", !!p); };

  function chip(p) {
    const on = st.ticks.includes(p.id);
    const b = h("button.paint-chip", { type: "button", "aria-pressed": String(on), "data-id": p.id, title: p.text },
      h("span.paint-chip-mark", { "aria-hidden": "true" }), h("span.paint-chip-name", {}, p.name));
    b.addEventListener("click", () => toggle(p.id, b));
    b.addEventListener("mouseenter", () => showTip(p));
    b.addEventListener("focus", () => showTip(p));
    b.addEventListener("mouseleave", () => showTip(null));
    b.addEventListener("blur", () => showTip(null));
    if (!st.editing) return b;
    const ed = h("button.paint-chip-ed", { type: "button", "aria-label": `改「${p.name}」`, title: "改这一条" }, icon("pen"));
    const del = h("button.paint-chip-del", { type: "button", "aria-label": `删掉「${p.name}」`, title: "删掉这一条（能撤销）" }, icon("close"));
    ed.addEventListener("click", () => openForm(p));
    del.addEventListener("click", () => remove(p));
    return h("span.paint-chip-w", { "data-id": p.id }, b, ed, del);
  }

  function render() {
    const list = shown();
    chips.replaceChildren(...list.map(chip));
    if (st.editing) {
      const add = h("button.paint-chip-add", { type: "button" }, icon("plus"), "加一条");
      add.addEventListener("click", () => openForm(null));
      chips.append(add);
      const missing = DEFAULT_PRESETS.filter((d) => !st.list.some((p) => p.id === d.id));
      if (missing.length) {
        const back = h("button.btn.small.ghost.paint-chip-reset", { type: "button" }, `恢复默认的 ${missing.length} 条`);
        back.addEventListener("click", async () => { st.list = [...st.list, ...missing.map((d) => ({ ...d }))]; await persist(); toast(`已恢复默认的 ${missing.length} 条`); });
        chips.append(back);
      }
    }
    if (!list.length && !st.editing) chips.append(h("span.paint-chip-none", {}, "还没有常用要求。点「编辑」加一条。"));
    editBtn.textContent = st.editing ? "完成" : "编辑";
    editBtn.setAttribute("aria-pressed", String(st.editing));
    showTip(null);
  }

  async function persist() { await savePresets(st.list); render(); onChange && onChange(); }

  async function toggle(id, b) {
    st.ticks = st.ticks.includes(id) ? st.ticks.filter((x) => x !== id) : [...st.ticks, id];
    b.setAttribute("aria-pressed", String(st.ticks.includes(id)));
    if (motionFull()) { b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); }
    onChange && onChange();
    try { await saveTicks(purpose, st.ticks); } catch (_) { /* 记不住勾选不影响这次用 */ }
  }

  async function remove(p) {
    const i = st.list.indexOf(p);
    st.list = st.list.filter((x) => x !== p);
    await persist();
    toast(`已删除「${p.name}」`, { action: { label: "撤销", run: async () => {
      if (st.list.some((x) => x.id === p.id)) return;
      st.list.splice(Math.min(i, st.list.length), 0, p);
      await persist();
    } } });
  }

  // 改一条 / 加一条：就在签下面展开一个小表单
  function openForm(p) {
    const name = h("input.input.paint-pf-name", { maxlength: "12", placeholder: "名字（签上显示）", value: p ? p.name : "", "aria-label": "名字" });
    const text = h("textarea.textarea.paint-pf-text", { rows: "3", placeholder: "加进提示词的话，比如：手部清楚，手指自然。", "aria-label": "内容" });
    text.value = p ? p.text : "";
    const scope = h("select.select.paint-pf-for", { "aria-label": "用在哪" }, ...SCOPES.map(([v, t]) => h("option", { value: v, selected: (p ? p.for || "all" : purpose === "cover" ? "all" : purpose) === v }, t)));
    const save = h("button.btn.small.primary", { type: "button" }, "保存");
    const cancel = h("button.btn.small.ghost", { type: "button" }, "取消");
    if (st.form) st.form.layer.close(true);
    // 登记成一层：Esc 先关这个小表单，不关外面的大弹窗
    const layer = pushLayer({ onClose: () => { if (st.form && st.form.layer === layer) { st.form = null; formBox.replaceChildren(); } } });
    const close = () => layer.close(true);
    cancel.addEventListener("click", close);
    save.addEventListener("click", async () => {
      const t = text.value.trim();
      if (!t) { text.focus(); return; }
      const nm = name.value.trim() || [...t].slice(0, 6).join("");
      if (p) Object.assign(p, { name: nm, text: t, for: scope.value });
      else st.list.push({ id: uid("pp"), name: nm, text: t, for: scope.value });
      close();
      await persist();
      toast(p ? `已改「${nm}」` : `已加上「${nm}」`);
    });
    const form = h("div.paint-pf", { role: "group", "aria-label": p ? "改一条常用要求" : "加一条常用要求" },
      h("div.paint-pf-row", {}, name, scope), text, h("div.row", {}, save, cancel));
    form.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save.click(); }
    });
    st.form = { el: form, layer };
    formBox.replaceChildren(form);
    (p ? text : name).focus();
  }

  editBtn.addEventListener("click", () => { st.editing = !st.editing; if (!st.editing && st.form) st.form.layer.close(true); render(); });

  const ready = (async () => {
    try { st.list = await loadPresets(); } catch (_) { st.list = DEFAULT_PRESETS.map((p) => ({ ...p })); }
    try { st.ticks = await loadTicks(purpose); } catch (_) { st.ticks = []; }
    render();
  })();

  return {
    el, ready,
    picked: () => st.list.filter((p) => st.ticks.includes(p.id) && appliesTo(p, purpose)),
    busy: () => !!st.form,
    /** 大弹窗关掉时收起小表单 */
    destroy: () => { if (st.form) st.form.layer.close(true); },
  };
}
