// 分类设置：名字、占位字、颜色、占位图的样子、字段（加、改名、排顺序、删）。
// 弹窗里先改草稿，「保存」算一步撤销；没保存就关时问「保留草稿 / 丢弃」。
import { h, icon, modal, toast, prompt } from "../../core/ui.js";
import { uid } from "../../core/db.js";
import { KINDS, SWATCHES, newCat } from "../../core/lore.js";
import { placeholder } from "./image.js";
import { undoToast } from "./bits.js";

const KIND_HINT = {
  person: "人物卡：形象和服装、定位、辨识特征、晋升阶梯、所在地",
  place: "地点：山", item: "物品：箱子", faction: "势力：旗子", skill: "功法：火苗",
  creature: "生物：爪印", festival: "节日：灯笼", other: "其他：星星",
};

export function catSettings(env, catId) {
  const orig = env.meta.cats.find((c) => c.id === catId);
  if (!orig) return;
  const saved = env.catDrafts.get(catId);
  const d = JSON.parse(JSON.stringify(saved || orig));
  const n = env.cards.filter((c) => c.cat === catId).length;

  const name = h("input.input", { value: d.name, maxlength: "12", "aria-label": "分类名" });
  const glyph = h("input.input.lr-cs-glyph", { value: d.glyph || "", maxlength: "2", "aria-label": "占位字" });
  const prev = h("div.lr-cs-prev");
  const paintPrev = () => prev.replaceChildren(placeholder({ ...d, glyph: d.glyph || "设" }));
  name.addEventListener("input", () => { d.name = name.value; });
  glyph.addEventListener("input", () => { d.glyph = glyph.value.trim(); paintPrev(); });

  const sw = h("div.lr-cs-sw", { role: "radiogroup", "aria-label": "颜色" });
  const custom = h("input.lr-cs-color", { type: "color", value: d.color, "aria-label": "自己调颜色", title: "自己调颜色" });
  const paintSw = () => {
    sw.replaceChildren(...SWATCHES.map((c) => {
      const b = h("button.lr-cs-c", { type: "button", role: "radio", "aria-checked": String(c === d.color), style: { "--c": c }, title: c });
      b.addEventListener("click", () => { d.color = c; custom.value = c; paintSw(); paintPrev(); });
      return b;
    }), custom);
  };
  custom.addEventListener("input", () => { d.color = custom.value; paintSw(); paintPrev(); });

  const kind = h("select.select", { "aria-label": "样子" }, ...Object.entries(KINDS).map(([k]) => h("option", { value: k }, KIND_HINT[k])));
  kind.value = d.kind;
  kind.addEventListener("change", () => { d.kind = kind.value; paintPrev(); });

  const fields = h("ol.lr-cs-fields");
  const paintFields = () => {
    fields.replaceChildren(...d.fields.map((f, i) => {
      const nm = h("input.input.small", { value: f.name, maxlength: "12", "aria-label": "字段名" });
      nm.addEventListener("input", () => { f.name = nm.value; });
      const long = h("input", { type: "checkbox", checked: !!f.long });
      long.addEventListener("change", () => { f.long = long.checked; });
      const b = (txt, lbl, fn, dis) => { const x = h("button.icon-btn", { type: "button", "aria-label": lbl, title: lbl, disabled: !!dis }, txt); x.addEventListener("click", fn); return x; };
      return h("li.lr-cs-f", {},
        nm,
        f.hint ? h("span.lr-cs-hint", {}, f.hint) : null,
        h("label.check.switch.lr-cs-long", { title: "多行" }, long, "多行"),
        b("↑", "往上挪", () => { [d.fields[i - 1], d.fields[i]] = [d.fields[i], d.fields[i - 1]]; paintFields(); }, i === 0),
        b("↓", "往下挪", () => { [d.fields[i + 1], d.fields[i]] = [d.fields[i], d.fields[i + 1]]; paintFields(); }, i === d.fields.length - 1),
        b(icon("close"), `删掉「${f.name}」`, () => { d.fields.splice(i, 1); paintFields(); }));
    }));
  };
  const addF = h("button.btn.small.ghost", { type: "button" }, icon("plus"), "加字段");
  addF.addEventListener("click", async () => {
    const v = await prompt("加一个字段", "", "比如 灵根属性、契约魔兽");
    if (!v || !v.trim()) return;
    d.fields.push({ id: uid("lf"), name: v.trim().slice(0, 12), key: "", hint: "", long: false });
    paintFields();
  });

  const body = h("div.lr-cs", {},
    h("div.lr-cs-top", {}, prev, h("div.lr-cs-top-r", {},
      h("label.field", {}, h("span", {}, "名字"), name),
      h("label.field", {}, h("span", {}, "占位字（没有图时显示）"), glyph))),
    h("div.field", {}, h("span", {}, "颜色（正文里高亮名字也用它）"), sw),
    h("label.field", {}, h("span", {}, "样子"), kind),
    h("div.field", {}, h("span", {}, "字段（每张卡都有这几项，空着也没关系）"), fields, h("div.row", {}, addF)),
    saved ? h("p.lr-cs-draft", {}, "这是上次没保存的改动。") : null);
  paintSw(); paintPrev(); paintFields();

  let done = false;
  const dirty = () => !done && JSON.stringify(d) !== JSON.stringify(orig);
  const m = modal({
    title: "分类设置 · " + orig.name,
    body, wide: false,
    isDirty: dirty,
    onKeepDraft: () => env.catDrafts.set(catId, JSON.parse(JSON.stringify(d))),
    actions: [
      { label: "保存", primary: true, onClick: async () => {
        d.name = d.name.trim() || orig.name;
        d.fields = d.fields.filter((f) => f.name.trim()).map((f) => ({ ...f, name: f.name.trim() }));
        done = true;
        env.catDrafts.delete(catId);
        m.close(true);
        if (JSON.stringify(d) === JSON.stringify(orig)) return;
        const e = await env.updateMeta(`修改分类「${d.name}」`, (mm) => { const i = mm.cats.findIndex((c) => c.id === catId); if (i >= 0) mm.cats[i] = d; });
        undoToast(`已保存「${d.name}」`, e);
      } },
      { label: "取消", onClick: () => m.close() },
    ],
  });
  m.el.classList.add("lr-cs-modal");
  // 删除分类：空的才能删
  const del = h("button.btn.small.ghost.lr-cs-del", { type: "button", disabled: n > 0, title: n ? `里面还有 ${n} 张卡，先移走或删掉` : "删掉这个分类" }, icon("trash"), n ? `还有 ${n} 张卡，不能删` : "删掉这个分类");
  del.addEventListener("click", async () => {
    done = true;
    env.catDrafts.delete(catId);
    m.close(true);
    const e = await env.updateMeta(`删掉分类「${orig.name}」`, (mm) => { mm.cats = mm.cats.filter((c) => c.id !== catId); });
    if (env.tab === catId) env.showTab("all");
    undoToast(`已删掉分类「${orig.name}」`, e);
  });
  m.foot.prepend(del);
}

/** 新建分类：起个名字就好，颜色按顺序挑一个没用过的 */
export async function newCategory(env) {
  const v = await prompt("新分类", "", "比如 种族、组织、法宝");
  if (!v || !v.trim()) return null;
  const name = v.trim().slice(0, 12);
  if (env.meta.cats.some((c) => c.name === name)) { toast(`已经有「${name}」了`); return null; }
  const used = new Set(env.meta.cats.map((c) => c.color));
  const cat = newCat({ kind: "other", name, color: SWATCHES.find((c) => !used.has(c)) || SWATCHES[env.meta.cats.length % SWATCHES.length], glyph: [...name][0] });
  const e = await env.updateMeta(`新建分类「${name}」`, (m) => { m.cats.push(cat); });
  undoToast(`已新建分类「${name}」`, e);
  return cat;
}
