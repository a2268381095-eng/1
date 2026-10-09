// 一张设定卡（人物就是角色卡）：顶上形象区，原形象和服装缩略图，名字和定位，别名、辨识特征，
// 晋升阶梯，所在地，新卡的快速填写，字段，关联，标签，记一笔。点一下就能改，每改一处算一步撤销。
import { h, icon, toast, prompt } from "../../core/ui.js";
import { commands } from "../../core/commands.js";
import { label as L } from "../../core/settings.js";
import { uid } from "../../core/db.js";
import { change, getImage, putImage, trashCard, catOf, fieldByKey, valueOf, KINDS, ROLES, newCard, getCard } from "../../core/lore.js";
import { imageArea, readImage, placeholder } from "./image.js";
import { ladderRow } from "./ladders.js";
import { suggestBox, runFill, fromStash } from "./aifill.js";
import { catSettings } from "./cats.js";
import { popover, menu, editable, adder, chip, chapterSelect, undoToast, flash, composing, vars } from "./bits.js";

const modalOpen = () => !!document.querySelector(".modal-back");

/** 给卡（或它的某套服装）换图。界面关了也照样存（AI 画完回来时可能已经关了） */
export async function setCardImage(bookId, cardId, outfitId, src, source = null) {
  let img;
  try { img = await readImage(src); }
  catch (e) { toast("这张图读不出来：" + (e.message || e)); return null; }
  const card = await getCard(cardId);
  if (!card) { toast("这张卡已经不在了"); return null; }
  const id = await putImage(bookId, img.data);
  const rec = { id, thumb: img.thumb, w: img.w, h: img.h };
  const o0 = outfitId && (card.outfits || []).find((x) => x.id === outfitId);
  const { entry } = await change(bookId, `给「${card.name}」${o0 ? "的「" + o0.name + "」" : ""}换图`, async (t) => {
    const c = await t.card(cardId);
    if (!c) return;
    const o = outfitId && (c.outfits || []).find((x) => x.id === outfitId);
    if (o) o.img = rec; else c.img = rec;
  }, { source });
  return entry;
}

/** 画图用的文字：外貌、辨识特征、这套服装 */
export function lookText(card, cat, outfit) {
  const look = fieldByKey(cat, "look");
  return [valueOf(card, look), (card.traits || []).join("、"), outfit ? `${outfit.name}：${outfit.desc || ""}` : ""].map((x) => String(x || "").trim()).filter(Boolean).join("；");
}

const fresh = (c, cat) => !c.img && !(c.traits || []).length
  && ["identity", "personality", "look"].every((k) => !String(valueOf(c, fieldByKey(cat, k))).trim());

/** 卡片编辑。返回 { el, render(), redraw(...部分) } */
export function cardView(env, cardId, { quick: quickWanted = false } = {}) {
  const root = h("div.lr-cv", { "data-id": cardId });
  const S = {};
  const cur = () => env.cards.find((c) => c.id === cardId);
  const catNow = () => catOf(env.meta, cur());
  let quick = null;
  const save = async (lbl, fn, ...parts) => {
    const e = await env.updateCard(cardId, lbl, fn);
    if (parts.length) redraw(...parts);
    return e;
  };
  const sec = (key, cls, ...kids) => h("div.lr-row" + cls, { "data-key": key }, ...kids);
  const hidden = (key) => h("div", { hidden: true, "data-key": key });

  /** 名字、快速填写这类直接输入的框：回车或点别处保存；Esc 关卡片时问保留还是丢弃 */
  function bindInput(input, { get, put }) {
    let api = null;
    const reg = () => {
      if (api) return;
      api = { dirty: () => input.value.trim() !== String(get() || "").trim(), commit: () => done(), cancel: () => { input.value = get() || ""; env.editing.delete(api); api = null; } };
      env.editing.add(api);
    };
    const done = async () => {
      if (!api) return;
      const a = api;
      env.editing.delete(a);
      api = null;
      const v = input.value.trim();
      if (v !== String(get() || "").trim()) await put(v);
      env.afterEdit();
    };
    input.addEventListener("focus", reg);
    input.addEventListener("input", reg);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); e.stopPropagation(); done(); } });
    input.addEventListener("blur", () => setTimeout(() => { if (!modalOpen() && document.activeElement !== input) done(); }, 0));
  }

  // ---------------- 顶栏 ----------------
  function head() {
    const c = cur(), cat = catNow();
    const back = h("button.icon-btn.lr-back", { type: "button", "aria-label": "返回", title: env.stack.length > 1 ? "返回上一张（Esc）" : "返回列表（Esc）" }, icon("back"));
    back.addEventListener("click", () => env.back());
    const ai = h("button.btn.small.lr-ai-btn", { type: "button", title: "把这张卡发给 AI，补上空着的字段（发送前会让你确认）" }, icon("sparkle"), h("span.lr-ai-btn-t", {}, "AI 补全空着的设定"));
    ai.addEventListener("click", () => runFill(env, cardId));
    const stash = h("button.icon-btn.lr-stash-btn", { type: "button", title: `这张卡以前的 AI 结果（${L("暂存盒")}）`, "aria-label": L("暂存盒") }, icon("box"));
    stash.addEventListener("click", () => fromStash(env, cardId));
    const more = h("button.icon-btn", { type: "button", title: "更多", "aria-label": "这张卡的更多操作" }, icon("more"));
    more.addEventListener("click", () => menu(more, [
      ...env.meta.cats.filter((x) => x.id !== c.cat).map((x) => [`换到「${x.name}」`, () => moveTo(x)]),
      ["分类设置（字段、颜色）", () => catSettings(env, cat.id)],
      "sep",
      ["删除这张卡", () => remove(), { danger: true }],
    ], env));
    return h("div.lr-cv-head", {}, back,
      h("span.lr-cv-where", { style: vars({ "--c": cat.color }) }, h("i.lr-dot"), cat.name),
      h("span.spacer"), ai, stash, more);
  }

  async function moveTo(nc) {
    const c = cur();
    const e = await save(`「${c.name}」换到「${nc.name}」`, (x) => {
      const old = catOf(env.meta, x);
      x.fields = x.fields || {};
      for (const f of old.fields || []) {
        const v = x.fields[f.id];
        if (!v) continue;
        const g = nc.fields.find((y) => (f.key && y.key === f.key) || y.name === f.name);
        if (g && !x.fields[g.id]) x.fields[g.id] = v;
      }
      x.cat = nc.id;
    });
    render();
    undoToast(`已换到「${nc.name}」`, e);
  }

  async function remove() {
    const c = cur();
    const r = await trashCard(cardId);
    if (!r) return;
    env.dropCard(cardId);
    undoToast(`已删除「${c.name || "未命名"}」`, r.entry);
  }

  // ---------------- 形象 ----------------
  const outfitOf = (c) => (c.outfit ? (c.outfits || []).find((o) => o.id === c.outfit) || null : null);

  function imgSec() {
    const c = cur(), cat = catNow(), o = outfitOf(c);
    const area = imageArea({
      cat, img: o ? o.img : c.img, label: o ? o.name || "这套服装" : "原形象", loadFull: getImage,
      onFile: async (f) => {
        const e = await setCardImage(env.bookId, cardId, o ? o.id : null, f, env.source);
        if (!e) return;
        await env.reloadCard(cardId);
        redraw("img", "thumbs");
        flash(S.img, "lr-flip");
      },
      onPaint: () => paint(),
      onClear: async () => {
        const e = await save(o ? `去掉「${o.name}」的图` : `去掉「${c.name}」的形象`, (x) => { const oo = outfitOf(x); if (oo) oo.img = null; else x.img = null; }, "img", "thumbs");
        undoToast("已去掉这张图", e);
      },
    });
    area.dataset.key = "img";
    return area;
  }

  function paint() {
    const c = cur(), cat = catNow(), o = outfitOf(c);
    if (!commands.get("paint.open")) { toast("绘画功能马上就来"); return; }
    commands.run("paint.open", {
      bookId: env.bookId, cardId, outfitId: o ? o.id : null, name: c.name + (o ? "（" + o.name + "）" : ""),
      purpose: (KINDS[cat.kind] || KINDS.other).purpose,
      prompt: lookText(c, cat, o),
      onDone: async (dataUrl) => {
        const e = await setCardImage(env.bookId, cardId, o ? o.id : null, dataUrl);
        if (e) undoToast(`「${c.name}」的${o ? "「" + o.name + "」" : "形象"}画好了`, e);
      },
    });
  }

  function thumbsSec() {
    const c = cur(), cat = catNow();
    if (cat.kind !== "person") return hidden("thumbs");
    const row = h("div.lr-thumbs", { role: "listbox", "aria-label": "原形象和服装", "data-key": "thumbs" });
    const th = (o) => {
      const img = o ? o.img : c.img;
      const on = (c.outfit || null) === (o ? o.id : null);
      const b = h("button.lr-th" + (on ? ".on" : ""), { type: "button", role: "option", "aria-selected": String(on), title: o ? `换成「${o.name}」` : "原形象" },
        h("span.lr-th-pic", {}, img ? h("img", { src: img.thumb, alt: "" }) : placeholder(cat)),
        h("span.lr-th-n", {}, o ? o.name || "未命名" : "原形象"),
        !o && c.img ? h("i.lr-th-dot", { title: "原形象有图了" }) : null);
      b.addEventListener("click", async () => {
        if (on) return;
        await save(o ? `「${c.name}」换上「${o.name}」` : `「${c.name}」换回原形象`, (x) => { x.outfit = o ? o.id : null; }, "img", "thumbs", "outfit");
        flash(S.img, "lr-flip");
      });
      return b;
    };
    const add = h("button.lr-th.lr-th-add", { type: "button", title: "加一套服装（战斗装、礼服、便装、伪装……）" }, h("span.lr-th-pic", {}, icon("plus")), h("span.lr-th-n", {}, "造型"));
    add.addEventListener("click", () => {
      const input = h("input.input", { placeholder: "这套叫什么", maxlength: "16", "aria-label": "服装名" });
      const make = async (name) => {
        name = String(name || "").trim();
        if (!name) { input.focus(); return; }
        p.close(true);
        const o = { id: uid("of"), name, img: null, desc: "", fromId: null, toId: null };
        await save(`「${cur().name}」加造型「${name}」`, (x) => { x.outfits = [...(x.outfits || []), o]; x.outfit = o.id; }, "img", "thumbs", "outfit");
        flash(S.outfit, "lr-born");
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); e.stopPropagation(); make(input.value); } });
      const quickNames = ["战斗装", "礼服", "便装", "伪装"].map((n) => { const b = h("button.lr-pick-chip", { type: "button" }, n); b.addEventListener("click", () => make(n)); return b; });
      const ok = h("button.btn.small.primary", { type: "button" }, "加上");
      ok.addEventListener("click", () => make(input.value));
      const p = popover(add, h("div.lr-newfit", {}, h("b", {}, "加一套服装"), h("div.lr-pick-chips", {}, ...quickNames), h("div.row", {}, input, ok)),
        { env, isDirty: () => !!input.value.trim(), onKeepDraft: () => make(input.value), label: "加一套服装" });
    });
    row.append(th(null), ...(c.outfits || []).map(th), add);
    return row;
  }

  function outfitSec() {
    const c = cur(), o = outfitOf(c);
    if (!o) return hidden("outfit");
    const box = h("section.lr-outfit", { "data-key": "outfit" });
    const set = (lbl, fn) => save(`「${c.name}」的「${o.name}」${lbl}`, (x) => { const oo = (x.outfits || []).find((y) => y.id === o.id); if (oo) fn(oo); });
    const name = h("span.lr-outfit-name");
    editable(name, { get: () => (outfitOf(cur()) || {}).name, env, empty: "未命名", max: 16, save: async (v) => { await set("改名", (oo) => { oo.name = v.trim() || oo.name; }); redraw("thumbs"); } });
    const del = h("button.icon-btn.lr-outfit-del", { type: "button", title: "删掉这套服装", "aria-label": "删掉这套服装" }, icon("trash"));
    del.addEventListener("click", async () => {
      const e = await save(`删掉「${o.name}」`, (x) => { x.outfits = (x.outfits || []).filter((y) => y.id !== o.id); if (x.outfit === o.id) x.outfit = null; }, "img", "thumbs", "outfit");
      undoToast(`已删掉「${o.name}」`, e);
    });
    const desc = h("div.lr-fv.long");
    editable(desc, { get: () => (outfitOf(cur()) || {}).desc, env, long: true, empty: "衣服、配饰、发型……（会用来画图）", save: (v) => set("的样子", (oo) => { oo.desc = v; }) });
    const from = chapterSelect(env, o.fromId, { none: "开头", label: "从第几章" });
    const to = chapterSelect(env, o.toId, { none: "以后一直", label: "到第几章" });
    const range = async () => { await set("穿的章节", (oo) => { oo.fromId = from.value || null; oo.toId = to.value || null; }); flash(box); };
    from.addEventListener("change", range);
    to.addEventListener("change", range);
    box.append(h("div.lr-outfit-h", {}, icon("shirt"), name, h("span.spacer"), del),
      h("div.lr-row", { "data-key": "outfit-desc" }, h("span.lr-fl", {}, "穿着"), desc),
      h("div.lr-outfit-range", {}, h("span", {}, "从"), from, h("span", {}, "到"), to, h("span", {}, "穿")));
    return box;
  }

  // ---------------- 名字、定位 ----------------
  function nameSec() {
    const c = cur(), cat = catNow();
    const input = h("input.lr-name", { value: c.name || "", maxlength: "40", placeholder: "名字", "aria-label": "名字" });
    bindInput(input, {
      get: () => cur().name,
      put: async (v) => {
        const old = cur().name;
        if (!v) { input.value = old; toast("名字不能空着"); return; }
        await env.updateCard(cardId, `「${old}」改名「${v}」`, (x) => { x.name = v; });
        flash(S.name);
      },
    });
    const row = h("div.lr-name-row", { "data-key": "name" }, input);
    if (cat.kind === "person") {
      const used = [...new Set(env.cards.map((x) => x.role).filter((r) => r && !ROLES.includes(r)))];
      const sel = h("select.select.small.lr-role", { "aria-label": "定位" },
        h("option", { value: "" }, "定位：未定"), ...[...ROLES, ...used].map((r) => h("option", { value: r }, r)), h("option", { value: "__custom" }, "自己写……"));
      sel.value = c.role || "";
      sel.dataset.role = c.role || "";
      sel.addEventListener("change", async () => {
        let v = sel.value;
        if (v === "__custom") {
          const t = await prompt("这个人物的定位", "", "比如 导师、宿敌、青梅竹马");
          if (!t || !t.trim()) { sel.value = cur().role || ""; return; }
          v = t.trim().slice(0, 12);
        }
        await save(`「${cur().name}」的定位：${v || "未定"}`, (x) => { x.role = v; }, "name");
        flash(S.name);
      });
      row.append(sel);
    }
    return row;
  }

  // ---------------- 别名、辨识特征、标签 ----------------
  const LIST = {
    aliases: ["别名", "正文里也按别名认人，比如 晚晚、林姑娘", ""],
    traits: ["辨识特征", "一眼能认出的，比如 白发、泪痣", ".lr-chip-trait"],
    tags: ["标签", "比如 主线、已退场", ".lr-chip-tag"],
  };
  function listSec(key) {
    const c = cur();
    if (key === "traits" && catNow().kind !== "person") return hidden(key);
    const [label, ph, cls] = LIST[key];
    const box = h("div.lr-chips");
    (c[key] || []).forEach((v) => box.append(chip(v, {
      cls,
      onRemove: async () => {
        const e = await save(`去掉${label}「${v}」`, (x) => { x[key] = (x[key] || []).filter((y) => y !== v); }, key);
        undoToast(`已去掉「${v}」`, e);
      },
    })));
    box.append(adder(key === "traits" ? "辨识特征" : label, { placeholder: ph, env, onAdd: async (vals, keep) => {
      const have = cur()[key] || [];
      const add = [...new Set(vals.map((v) => v.slice(0, 20)))].filter((v) => !have.includes(v));
      if (!add.length) return;
      await save(`加${label}「${add.join("、")}」`, (x) => { x[key] = [...(x[key] || []), ...add.filter((v) => !(x[key] || []).includes(v))]; }, key);
      flash(S[key]);
      if (keep) setTimeout(() => { const b = S[key] && S[key].querySelector(".lr-add"); if (b) b.click(); }, 0);
    } }));
    return sec(key, ".lr-list-row.lr-" + key, h("span.lr-fl", {}, label), box);
  }

  // ---------------- 晋升阶梯 ----------------
  function laddersSec() {
    const c = cur();
    if (catNow().kind !== "person") return hidden("ladders");
    const box = h("div.lr-lads");
    if (!env.meta.ladders.length) {
      const go = h("button.btn.small.ghost", { type: "button" }, icon("ladder"), "去「体系」建一条");
      go.addEventListener("click", () => env.showTab("sys"));
      box.append(h("p.lr-muted", {}, "境界、爵位、职业等级……这本书还没有晋升阶梯。"), go);
    } else {
      env.meta.ladders.forEach((lad) => box.append(ladderRow(env, c, lad, {
        onChange: async (lbl, fn) => {
          await save(lbl, fn, "ladders");
          const row = S.ladders && S.ladders.querySelector(`[data-ladder="${lad.id}"]`);
          flash(row, "lr-lvup");
        },
      })));
    }
    return sec("ladders", ".lr-ladders", h("span.lr-fl", {}, "晋升"), box);
  }

  // ---------------- 所在地、关联 ----------------
  /** 挑一张卡：搜索、按分类筛，找不到可以直接新建 */
  function pickCard(anchor, { title, kinds = null, current = null, withLabel = false, onPick, onClear }) {
    const meta = env.meta;
    const q = h("input.input.lr-pick-q", { type: "search", placeholder: "搜名字、别名", "aria-label": "搜索" });
    const rel = withLabel ? h("input.input.lr-pick-rel", { placeholder: "关系，比如 师父、宿敌、所属", maxlength: "12", "aria-label": "关系" }) : null;
    const list = h("div.lr-pick-list", { role: "listbox" });
    const pool = () => env.cards.filter((x) => x.id !== cardId && (!kinds || kinds.includes(catOf(meta, x).kind)));
    const newCats = meta.cats.filter((x) => !kinds || kinds.includes(x.kind));
    const catSel = newCats.length > 1 ? h("select.select.small", { "aria-label": "放进哪个分类" }, ...newCats.map((x) => h("option", { value: x.id }, x.name))) : null;
    const paintList = () => {
      const s = q.value.trim().toLowerCase();
      const hits = pool().filter((x) => !s || [x.name, ...(x.aliases || [])].join(" ").toLowerCase().includes(s)).slice(0, 40);
      list.replaceChildren(...hits.map((x) => {
        const cc = catOf(meta, x);
        const b = h("button.lr-pick-i" + (x.id === current ? ".on" : ""), { type: "button", role: "option", style: vars({ "--c": cc.color }) },
          h("span.lr-pick-pic", {}, x.img ? h("img", { src: x.img.thumb, alt: "" }) : placeholder(cc)),
          h("span.lr-pick-n", {}, x.name || "未命名"), h("span.lr-pick-c", {}, cc.name));
        b.addEventListener("click", async () => { p.close(true); await onPick(x.id, rel ? rel.value.trim() : ""); });
        return b;
      }));
      if (!hits.length) list.append(h("p.lr-muted.lr-pick-none", {}, s ? `没有「${q.value.trim()}」` : "还没有可以选的卡"));
      if (s && newCats.length && !pool().some((x) => x.name === q.value.trim())) {
        const mk = h("button.btn.small.lr-pick-new", { type: "button" }, icon("plus"), `新建「${q.value.trim()}」`);
        mk.addEventListener("click", async () => {
          const name = q.value.trim();
          const catId = catSel ? catSel.value : newCats[0].id;
          p.close(true);
          await onPick(null, rel ? rel.value.trim() : "", { name, catId });
        });
        list.append(h("div.lr-pick-mk", {}, mk, catSel));
      }
    };
    q.addEventListener("input", paintList);
    q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); e.stopPropagation(); const f = list.querySelector("button"); if (f) f.click(); } });
    const clear = onClear && current ? h("button.btn.small.ghost", { type: "button" }, "清掉") : null;
    if (clear) clear.addEventListener("click", async () => { p.close(true); await onClear(); });
    const body = h("div.lr-pick", {}, h("div.lr-pick-head", {}, h("b", {}, title), clear), rel, q, list);
    const p = popover(anchor, body, { cls: ".lr-pop-pick", env, label: title, isDirty: () => !!(rel && rel.value.trim()) });
    if (p) { paintList(); setTimeout(() => (rel || q).focus(), 0); }
  }

  /** 选的是「新建」时：在同一步里建一张新卡 */
  async function linkTo(lbl, made, apply) {
    const { entry, result } = await env.change(lbl, async (t) => {
      let to = null;
      if (made) {
        const m = await t.meta();
        const cat = m.cats.find((x) => x.id === made.catId) || m.cats[0];
        to = t.add(newCard(env.bookId, cat, { name: made.name })).id;
      }
      const c = await t.card(cardId);
      if (c) apply(c, to);
      return to;
    });
    return { entry, made: result };
  }

  function placeSec() {
    const c = cur(), cat = catNow();
    if (!["person", "creature"].includes(cat.kind)) return hidden("place");
    const place = c.placeId && env.cards.find((x) => x.id === c.placeId);
    const pin = h("button.lr-pin" + (place ? ".set" : ""), { type: "button", "aria-haspopup": "dialog", title: "所在地：选一张地点卡" },
      icon("pin"), h("span.lr-pin-t", {}, place ? place.name : "还没定"));
    pin.addEventListener("click", () => pickCard(pin, {
      title: "所在地", kinds: ["place"], current: c.placeId,
      onPick: async (id, _r, made) => {
        const { entry } = id ? { entry: await save(`「${cur().name}」在「${env.cards.find((x) => x.id === id).name}」`, (x) => { x.placeId = id; }) }
          : await linkTo(`「${cur().name}」在新地点「${made.name}」`, made, (x, to) => { x.placeId = to; });
        redraw("place");
        flash(S.place, "lr-pinned");
        if (!id) undoToast(`已新建地点「${made.name}」`, entry);
      },
      onClear: async () => { const e = await save(`清掉「${cur().name}」的所在地`, (x) => { x.placeId = null; }, "place"); undoToast("已清掉所在地", e); },
    }));
    const kids = [h("span.lr-fl", {}, "所在地"), pin];
    if (place) {
      const go = h("button.btn.small.ghost.lr-go", { type: "button", title: "打开「" + place.name + "」" }, "看看");
      go.addEventListener("click", () => env.openCard(place.id));
      kids.push(go);
    }
    return sec("place", ".lr-place", ...kids);
  }

  function linksSec() {
    const c = cur(), meta = env.meta;
    const box = h("div.lr-chips");
    (c.links || []).forEach((l) => {
      const t = env.cards.find((x) => x.id === l.to);
      box.append(chip((l.label ? l.label + " · " : "") + (t ? t.name : "（已删除）"), {
        cls: ".lr-chip-link", color: t ? catOf(meta, t).color : null, title: t ? `打开「${t.name}」` : "",
        onClick: t ? () => env.openCard(t.id) : null,
        onRemove: async () => { const e = await save("去掉一条关联", (x) => { x.links = (x.links || []).filter((y) => y.id !== l.id); }, "links"); undoToast("已去掉关联", e); },
      }));
    });
    const add = h("button.lr-add", { type: "button" }, icon("link"), h("span", {}, "关联"));
    add.addEventListener("click", () => pickCard(add, {
      title: "关联到哪张卡", withLabel: true,
      onPick: async (id, rel, made) => {
        const link = (to) => ({ id: uid("ln"), label: rel.slice(0, 12), to });
        const { entry } = id ? { entry: await save("加关联", (x) => { x.links = [...(x.links || []), link(id)]; }) }
          : await linkTo(`关联到新卡「${made.name}」`, made, (x, to) => { x.links = [...(x.links || []), link(to)]; });
        redraw("links");
        flash(S.links);
        if (!id) undoToast(`已新建「${made.name}」并关联上`, entry);
      },
    }));
    box.append(add);
    return sec("links", ".lr-list-row.lr-links", h("span.lr-fl", {}, "关联"), box);
  }

  function refsSec() {
    const c = cur(), cat = catNow(), meta = env.meta;
    const here = env.cards.filter((x) => x.placeId === cardId);
    const by = env.cards.filter((x) => x.id !== cardId && x.placeId !== cardId && (x.links || []).some((l) => l.to === cardId));
    if (!here.length && !by.length) return hidden("refs");
    const mk = (x, extra = "") => chip(x.name + extra, { cls: ".lr-chip-ref", color: catOf(meta, x).color, onClick: () => env.openCard(x.id), title: `打开「${x.name}」` });
    const kids = [];
    if (here.length) kids.push(sec("refs-here", ".lr-list-row.lr-refs", h("span.lr-fl", {}, cat.kind === "place" ? "在这里" : "在这"), h("div.lr-chips", {}, ...here.map((x) => mk(x)))));
    if (by.length) kids.push(sec("refs-by", ".lr-list-row.lr-refs", h("span.lr-fl", {}, "被提到"), h("div.lr-chips", {}, ...by.map((x) => {
      const l = x.links.find((y) => y.to === cardId);
      return mk(x, l && l.label ? `（${l.label}）` : "");
    }))));
    return h("div.lr-refs-box", { "data-key": "refs" }, ...kids);
  }

  // ---------------- 新卡：快速填写 ----------------
  function quickSec() {
    const c = cur(), cat = catNow();
    if (!quick || cat.kind !== "person") return hidden("quick");
    const box = h("section.lr-quick", { "data-key": "quick" });
    const x = h("button.icon-btn.lr-quick-x", { type: "button", title: "先不填", "aria-label": "收起快速填写" }, icon("close"));
    x.addEventListener("click", () => { quick = false; redraw("quick"); });
    const inputs = [];
    // 三样都写了，焦点离开这一块时收起来
    const fold = () => setTimeout(() => {
      if (!quick || !box.isConnected || box.contains(document.activeElement) || !filled()) return;
      quick = false;
      redraw("quick");
    }, 400);
    box.addEventListener("focusout", fold);
    const filled = () => { const y = cur(), cc = catNow(); return (y.traits || []).length > 0 && ["identity", "personality"].every((k) => !fieldByKey(cc, k) || String(valueOf(y, fieldByKey(cc, k))).trim()); };
    const add = (label, ph, get, put) => {
      const i = h("input.input.lr-quick-in", { placeholder: ph, "aria-label": label, value: get() || "", maxlength: "200" });
      bindInput(i, { get, put: async (v) => { await put(v); flash(i.closest(".lr-quick-f")); fold(); } });
      inputs.push(h("label.lr-quick-f", {}, h("span", {}, label), i));
    };
    add("一眼能认出的特征", "比如 白发、左眼下有泪痣", () => (cur().traits || []).join("、"), async (v) => {
      const list = [...new Set(v.split(/[、，,；;\s]+/).map((t) => t.trim()).filter(Boolean))];
      await save(`「${cur().name}」的辨识特征`, (y) => { y.traits = list; }, "traits");
    });
    const idF = fieldByKey(cat, "identity"), peF = fieldByKey(cat, "personality");
    const fieldPut = (f) => async (v) => { await save(`「${cur().name}」的${f.name}`, (y) => { y.fields = y.fields || {}; y.fields[f.id] = v; }, "fields"); };
    if (idF) add("身份", "比如 青云宗外门弟子", () => valueOf(cur(), idF), fieldPut(idF));
    if (peF) add("性格一句话", "比如 嘴硬心软，记仇", () => valueOf(cur(), peF), fieldPut(peF));
    box.append(h("div.lr-quick-h", {}, h("b", {}, "新角色，还差形象和设定"), h("span.lr-muted", {}, "先写三样，其余的写到哪填到哪"), x), h("div.lr-quick-g", {}, ...inputs));
    return box;
  }

  // ---------------- 字段 ----------------
  function fieldsSec() {
    const c = cur(), cat = catNow();
    const box = h("div.lr-fields", { "data-key": "fields" });
    (cat.fields || []).forEach((f) => {
      const v = h("div.lr-fv" + (f.long ? ".long" : ""));
      editable(v, {
        get: () => valueOf(cur(), f), long: !!f.long, env, placeholder: f.hint || "",
        save: async (val) => {
          await env.updateCard(cardId, `「${cur().name}」的${f.name}`, (x) => { x.fields = x.fields || {}; x.fields[f.id] = val; });
          if (quick) redraw("quick");
        },
      });
      box.append(h("div.lr-row.lr-field", { "data-key": "f:" + f.id }, h("span.lr-fl", {}, f.name, f.hint ? h("small", {}, f.hint) : null), v));
    });
    const addF = adder("字段", { placeholder: "比如 灵根属性、契约魔兽", env, cls: ".lr-add-field", onAdd: async (names, keep) => {
      const cn = cat.name;
      const e = await env.updateMeta(`给「${cn}」加字段「${names.join("、")}」`, (m) => {
        const cc = m.cats.find((x) => x.id === cat.id);
        if (cc) names.forEach((n) => { if (!cc.fields.some((y) => y.name === n)) cc.fields.push({ id: uid("lf"), name: n.slice(0, 12), key: "", hint: "", long: false }); });
      });
      undoToast(`每张「${cn}」卡都多了「${names.join("、")}」`, e);
      if (keep) setTimeout(() => { const btn = S.fields && S.fields.querySelector(".lr-add-field"); if (btn) btn.click(); }, 0);
    } });
    const manage = h("button.btn.small.ghost.lr-manage", { type: "button", title: "改名、排顺序、删字段" }, "管理字段");
    manage.addEventListener("click", () => catSettings(env, cat.id));
    box.append(h("div.lr-fields-foot", {}, addF, manage));
    return box;
  }

  // ---------------- 记一笔 ----------------
  function logSec() {
    const c = cur();
    const box = h("section.lr-log", { "data-key": "log" });
    const btn = h("button.btn.small.lr-log-btn", { type: "button" }, icon("pen"), "记一笔（本章发生的变化）");
    btn.addEventListener("click", () => {
      const ta = h("textarea.textarea.lr-log-ta", { rows: "2", placeholder: "比如 突破炼气；和师父吵翻；左手受伤", maxlength: "400" });
      const ch = chapterSelect(env, env.curChapterId(), { none: "不记章节", label: "哪一章" });
      const ok = h("button.btn.small.primary", { type: "button" }, "记下");
      const no = h("button.btn.small.ghost", { type: "button" }, "取消");
      const form = h("div.lr-log-form", {}, ta, h("div.row", {}, ch, h("span.spacer"), no, ok));
      let done = false;
      const api = { dirty: () => !done && !!ta.value.trim(), commit: () => write(), cancel: () => close() };
      const close = () => {
        if (done) return;
        done = true;
        env.editing.delete(api);
        layer.close(true);
        if (form.isConnected) form.replaceWith(btn);
        env.afterEdit();
      };
      const write = async () => {
        const text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        const chId = ch.value || null;
        close();
        await save(`「${cur().name}」记一笔`, (x) => { x.log = [...(x.log || []), { id: uid("lg"), chapterId: chId, text, at: Date.now() }]; }, "log");
        flash(S.log && S.log.querySelector(".lr-log-i"), "lr-born");
      };
      // 浮层栈：Esc 先收起这一小块（写了字的会问保留还是丢弃）
      const layer = env.pushLayer({ isDirty: () => api.dirty(), onKeepDraft: () => write(), onClose: () => close() });
      env.editing.add(api);
      ok.addEventListener("click", write);
      no.addEventListener("click", () => close());
      ta.addEventListener("keydown", (e) => { if (!composing(e) && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); write(); } });
      btn.replaceWith(form);
      ta.focus();
    });
    const list = h("ol.lr-log-list");
    [...(c.log || [])].reverse().forEach((g) => {
      const no = g.chapterId ? env.idxOf(g.chapterId) : 0;
      const del = h("button.icon-btn.lr-log-del", { type: "button", "aria-label": "删掉这一笔", title: "删掉这一笔" }, icon("close"));
      del.addEventListener("click", async () => { const e = await save("删掉一笔记录", (x) => { x.log = (x.log || []).filter((y) => y.id !== g.id); }, "log"); undoToast("已删掉这一笔", e); });
      list.append(h("li.lr-log-i", {},
        h("span.lr-log-c", {}, (no ? `第 ${no} 章` : g.chapterId ? "（章节已删）" : "") + (no || g.chapterId ? " · " : "") + new Date(g.at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })),
        h("span.lr-log-t", {}, g.text), del));
    });
    box.append(btn);
    if ((c.log || []).length) box.append(list);
    return box;
  }

  // ---------------- 组装 ----------------
  const B = {
    head, img: imgSec, thumbs: thumbsSec, outfit: outfitSec, ai: () => suggestBox(env, cardId), name: nameSec,
    aliases: () => listSec("aliases"), traits: () => listSec("traits"), quick: quickSec, ladders: laddersSec, place: placeSec,
    fields: fieldsSec, links: linksSec, refs: refsSec, tags: () => listSec("tags"), log: logSec,
  };

  function render() {
    const c = cur();
    if (!c) {
      const back = h("button.btn.small", { type: "button" }, icon("back"), "返回");
      back.addEventListener("click", () => env.back());
      root.replaceChildren(h("div.lr-none", {}, h("p.lr-none-t", {}, "这张卡不在了"), h("p.muted", {}, "可能已经删掉了，" + L("回收站") + "里能找回。"), back));
      return;
    }
    const cat = catNow();
    if (quick === null) quick = cat.kind === "person" && (quickWanted || fresh(c, cat));
    for (const k of Object.keys(B)) S[k] = B[k]();
    const a = h("div.lr-sheet-a", {}, S.img, S.thumbs, S.outfit);
    const b = h("div.lr-sheet-b", {}, S.ai, S.name, S.aliases, S.traits, S.quick, S.ladders, S.place, S.fields, S.links, S.refs, S.tags, S.log);
    const sheet = h("article.lr-sheet", { "data-kind": cat.kind, "data-glyph": (cat.glyph || "设").slice(0, 1), "data-cat": cat.name, style: vars({ "--c": cat.color }) },
      h("span.lr-sheet-deco", { "aria-hidden": "true" }), h("span.lr-sheet-deco2", { "aria-hidden": "true" }), a, b);
    root.replaceChildren(S.head, sheet);
  }

  function redraw(...names) {
    if (!cur()) return render();
    for (const n of names) {
      const old = S[n];
      if (!old || !B[n]) continue;
      const nu = B[n]();
      S[n] = nu;
      if (old.isConnected) old.replaceWith(nu);
    }
  }

  return { el: root, id: cardId, render, redraw };
}
