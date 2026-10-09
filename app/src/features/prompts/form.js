// 新建 / 编辑一条提示词：名字、分组、正文，正文上面一排变量按钮（点一下插到光标处）。
// 有没保存的改动时关闭先问「保留草稿 / 丢弃」，草稿存在 kv（prompts:draft:<id|new>），下次打开接着写。
import { db } from "../../core/db.js";
import { h, modal, notice } from "../../core/ui.js";
import { VARIABLES, listPrompts } from "../../core/prompts.js";
import { fmtTime } from "../../core/text.js";
import { varsIn, nameFrom } from "./logic.js";
import { create, update } from "./ops.js";

const draftKey = (id) => "prompts:draft:" + (id || "new");
const HINT = "点一下插到光标处，发送时换成对应的内容。";
const same = (a, b) => a.name === b.name && a.group === b.group && a.text === b.text;

/** 打开编辑弹窗。返回 { row, entry }（保存了），或 null */
export async function openForm({ prompt = null, feature = "" } = {}) {
  const orig = { name: prompt ? prompt.name || "" : "", group: prompt ? prompt.group || "" : "", text: prompt ? prompt.text || "" : "" };
  const key = draftKey(prompt && prompt.id);
  let draft = null, all = [];
  try { draft = await db.getKV(key); } catch (_) { draft = null; }
  if (draft && same({ name: draft.name || "", group: draft.group || "", text: draft.text || "" }, orig)) draft = null;
  try { all = await listPrompts(); } catch (_) { all = []; }
  const groups = [...new Set(all.map((p) => p.group).filter(Boolean))];

  return new Promise((resolve) => {
    let result = null, kept = false, saving = false;
    const listId = "pr-dl-" + Math.random().toString(36).slice(2, 8);
    const nameIn = h("input.input.pr-f-name", { maxlength: "60", placeholder: "不填就用正文第一行", "aria-label": "名字" });
    const groupIn = h("input.input.pr-f-group", { maxlength: "30", placeholder: "不填就放在「未分组」", list: listId, "aria-label": "分组" });
    const textIn = h("textarea.textarea.pr-f-text", { rows: "9", placeholder: "写给 AI 的话。用上面的变量按钮插入 {选中文本} 这类变量，发送时自动填入。",
      "aria-label": "正文", autofocus: !!prompt });
    const hint = h("p.pr-var-hint", { "aria-live": "polite" }, HINT);
    const used = h("div.pr-used");
    const count = h("span.pr-f-count");
    const dup = h("span.pr-f-dup");

    const fill = (f) => { nameIn.value = f.name || ""; groupIn.value = f.group || ""; textIn.value = f.text || ""; };
    const current = () => ({ name: nameIn.value, group: groupIn.value, text: textIn.value });
    fill(draft || orig);

    // 变量按钮：悬停 / 聚焦时下面说明这个变量是什么
    const varBtn = (v) => {
      const b = h("button.pr-var", { type: "button", "data-var": v.name, title: v.desc, "aria-label": `插入 {${v.name}}：${v.desc}` }, `{${v.name}}`);
      const show = () => { hint.textContent = `{${v.name}}：${v.desc}`; hint.classList.add("on"); };
      const hide = () => { hint.textContent = HINT; hint.classList.remove("on"); };
      b.addEventListener("mouseenter", show);
      b.addEventListener("focus", show);
      b.addEventListener("mouseleave", hide);
      b.addEventListener("blur", hide);
      b.addEventListener("mousedown", (e) => e.preventDefault());   // 正文框不丢光标
      b.addEventListener("click", () => { insertVar(v.name); show(); b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); });
      return b;
    };
    const vars = h("div.pr-vars", { role: "group", "aria-label": "插入变量" }, ...VARIABLES.map(varBtn));

    function insertVar(name) {
      const tok = "{" + name + "}";
      const s = textIn.selectionStart ?? textIn.value.length, e = textIn.selectionEnd ?? s;
      textIn.focus();
      textIn.setSelectionRange(s, e);
      // execCommand 能进正文框自己的撤销；不支持时直接改
      let ok = false;
      try { ok = document.execCommand("insertText", false, tok); } catch (_) { ok = false; }
      if (!ok || !textIn.value.includes(tok)) { textIn.setRangeText(tok, s, e, "end"); textIn.dispatchEvent(new Event("input", { bubbles: true })); }
    }

    function update_() {
      const f = current();
      const vs = varsIn(f.text);
      used.replaceChildren(...(vs.length ? [h("span.pr-used-l", {}, "用到："), ...vs.map((v) => h("span.pr-uv" + (v.known ? "" : ".warn"),
        { title: v.known ? (VARIABLES.find((x) => x.name === v.name) || {}).desc : "软件不认识这个变量，发送时会原样发出去" }, `{${v.name}}`))] : []));
      count.textContent = [...f.text].length ? `${[...f.text].length.toLocaleString()} 字` : "";
      const nm = f.name.trim() || (f.text.trim() ? nameFrom(f.text) : "");
      dup.textContent = nm && all.some((p) => p.name === nm && (!prompt || p.id !== prompt.id)) ? "已经有一条叫这个名字" : "";
      if (saveBtn) saveBtn.disabled = !f.text.trim();
    }
    [nameIn, groupIn, textIn].forEach((x) => x.addEventListener("input", update_));

    const draftNote = draft ? h("div.pr-draft", {},
      h("span", {}, `接着上次没保存的草稿（${fmtTime(draft.at || Date.now())}）`),
      h("button.btn.small.ghost", { type: "button", onclick: async () => {
        fill(orig); update_(); draftNote.remove();
        try { await db.del("kv", key); } catch (_) { /* 删不掉也不影响 */ }
      } }, prompt ? "用回原来的" : "清空草稿")) : null;

    const body = h("div.pr-form", {},
      draftNote,
      h("div.pr-f-row", {},
        h("label.field.pr-f-n", {}, h("span", {}, "名字", dup), nameIn),
        h("label.field.pr-f-g", {}, h("span", {}, "分组"), groupIn, h("datalist", { id: listId }, ...groups.map((g) => h("option", { value: g }))))),
      h("div.field.pr-f-t", {},
        h("span", {}, "正文", count),
        vars, hint, textIn, used));

    let saveBtn = null;
    const m = modal({
      title: prompt ? "编辑提示词" : "新建提示词",
      body, wide: true,
      isDirty: () => !result && !same(current(), orig),
      onKeepDraft: async () => {
        kept = true;
        try { await db.setKV(key, { ...current(), at: Date.now() }); } catch (_) { /* 存不了草稿也让它关掉 */ }
      },
      onClose: () => {
        if (!kept && !result) db.del("kv", key).catch(() => {});
        resolve(result);
      },
      actions: [
        { label: "保存", primary: true, onClick: () => save() },
        { label: "取消", onClick: () => m.close() },
      ],
    });
    m.el.classList.add("pr-form-modal");
    saveBtn = m.foot.querySelector(".btn.primary");
    update_();

    async function save() {
      const f = current();
      if (!f.text.trim() || saving) { if (!f.text.trim()) textIn.focus(); return; }
      saving = true;
      try {
        result = prompt ? await update(prompt, f) : await create({ ...f, feature });
      } catch (e) {
        saving = false;
        notice({ what: "这条提示词没能保存。", why: "浏览器存储被限制、被清理，或者空间不够。改的内容还在弹窗里。",
          detail: e && (e.stack || e.message || e), actions: [{ label: "重试", primary: true, run: save }] });
        return;
      }
      db.del("kv", key).catch(() => {});
      m.close(true);
    }

    body.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key.toLowerCase() === "s")) { e.preventDefault(); e.stopPropagation(); save(); }
    });
    if (prompt) setTimeout(() => { textIn.focus(); textIn.setSelectionRange(textIn.value.length, textIn.value.length); }, 0);
  });
}
