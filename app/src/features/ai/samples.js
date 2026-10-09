// 文风样本的管理界面：AI 接入页上一张卡片，确认卡里也能就地打开；正文里选中一段可以直接存。
import { h, icon, modal, toast } from "../../core/ui.js";
import { db } from "../../core/db.js";
import { bus } from "../../core/bus.js";
import { countWords } from "../../core/text.js";
import { listSamples, saveSample, deleteSample } from "../../core/samples.js";

const DRAFT = "samples:draft";

/** 新建或修改一条。返回存好的那条；关掉返回 null。没存的内容关闭时问「保留草稿 / 丢弃」 */
export async function sampleForm(row = null, preset = "") {
  const draft = row ? null : await db.getKV(DRAFT, null);
  const name = h("input.input", { type: "text", maxlength: "30", placeholder: "起个名字，比如「冷淡的第三人称」", value: (row && row.name) || (draft && draft.name) || "" });
  const text = h("textarea.textarea.ss-text", { rows: "9", placeholder: "粘贴一段想让 AI 照着写的文字。几百字就够。" });
  text.value = (row && row.text) || preset || (draft && draft.text) || "";
  const count = h("span.muted.ss-count");
  const upd = () => { count.textContent = `${countWords(text.value).toLocaleString()} 字` + (countWords(text.value) > 3000 ? " · 太长会多花 token，挑最有味道的一段就行" : ""); };
  text.addEventListener("input", upd);
  upd();
  const start = name.value + "\u0001" + text.value;
  return new Promise((resolve) => {
    let saved = null;
    const m = modal({
      title: row ? "改文风样本" : "新的文风样本",
      wide: true,
      body: h("div.ss-form", {}, h("label.field", {}, h("span", {}, "名字"), name), h("label.field", {}, h("span", {}, "样本"), text), count),
      isDirty: () => !saved && name.value + "\u0001" + text.value !== start && !!text.value.trim(),
      onKeepDraft: row ? undefined : () => db.setKV(DRAFT, { name: name.value, text: text.value }),
      onClose: () => resolve(saved),
      actions: [
        { label: "存好", primary: true, onClick: async () => {
          if (!text.value.trim()) { toast("样本还是空的"); text.focus(); return; }
          saved = await saveSample({ ...(row || {}), name: name.value, text: text.value });
          if (!row) await db.setKV(DRAFT, null);
          m.close(true);
          toast(row ? "已改好" : "已存成文风样本");
        } },
        { label: "取消", onClick: () => m.close() },
      ],
    });
    text.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "s")) { e.preventDefault(); m.foot.querySelector(".btn.primary").click(); } });
  });
}

/** 列表：每条能改、能删（删了出「撤销」）。box 是放列表的容器 */
export function renderSamples(box) {
  const list = h("div.ss-list");
  const add = h("button.btn.ghost.small.ss-add", { type: "button" }, icon("plus"), "粘贴一段新的");
  add.addEventListener("click", () => sampleForm());
  let shown = false;
  const draw = async () => {
    // 页面已经换走了：不再跟着刷新
    if (shown && !box.isConnected) { off(); return; }
    shown = true;
    const all = await listSamples();
    list.replaceChildren(...(all.length ? all.map(item) : [h("p.muted.ss-none", {}, "还没有样本。调用 AI 时默认不模仿。")]));
  };
  const item = (s) => {
    const edit = h("button.icon-btn", { type: "button", title: "改", "aria-label": "改" + s.name }, icon("format"));
    const del = h("button.icon-btn", { type: "button", title: "删除", "aria-label": "删除" + s.name }, icon("trash"));
    edit.addEventListener("click", () => sampleForm(s));
    del.addEventListener("click", async () => {
      const old = await deleteSample(s.id);
      toast(`已删除「${s.name}」`, { action: { label: "撤销", run: () => old && saveSample(old) } });
    });
    return h("div.ss-item", {},
      h("div.ss-main", {}, h("b.ss-name", {}, s.name), h("span.ss-meta", {}, `${countWords(s.text).toLocaleString()} 字` + (s.uses ? ` · 用过 ${s.uses} 次` : "")),
        h("p.ss-peek", {}, s.text.replace(/\s+/g, " ").slice(0, 80))),
      h("div.ss-acts", {}, edit, del));
  };
  const off = bus.on("samples:changed", () => draw());
  box.replaceChildren(h("p.muted.ss-lead", {}, "想让 AI 照着某段文字的味道写，就存在这里。用不用、用哪一段，在调用 AI 前的确认卡里每次自己选（默认不模仿）。也可以在正文里选中一段，从 AI 工具栏的「…」里点「存为文风样本」。"),
    list, add);
  draw();
  return () => off();
}

/** 弹窗管理（确认卡里点「管理」），关掉时 resolve */
export function samplesModal() {
  return new Promise((resolve) => {
    const box = h("div.ss-box");
    const stop = renderSamples(box);
    modal({ title: "文风样本", wide: true, body: box, onClose: () => { stop(); resolve(); } });
  });
}
