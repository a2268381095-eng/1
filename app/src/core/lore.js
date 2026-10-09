// 设定库的数据：分类、设定卡、晋升阶梯。界面只调这里，不直接碰数据库。
// lore 表（索引 bookId）：
//   每本书一条 { id: "meta:<书id>", type: "meta", cats, ladders, roots }   分类（含字段）、晋升阶梯、根基
//   每张卡一条 { id, bookId, type: "card", cat, name, aliases, fields, ... }  见 newCard()
// loreimg 表：图片原图 { id, bookId, data }，卡上只存缩略图（列表里不用读大图）。
// 改动都走 change()：一次改动算一步撤销，写完发 lore:changed { bookId, ids }。
import { db, uid } from "./db.js";
import { bus } from "./bus.js";
import { undo as appUndo } from "./undo.js";

export const metaId = (bookId) => "meta:" + bookId;
const now = () => Date.now();
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

// ---------------- 分类 ----------------
// kind 决定占位图的样子、AI 画图的用途；人物（person）另有定位、辨识特征、晋升阶梯、所在地、服装
export const KINDS = {
  person: { name: "人物", glyph: "角", purpose: "character" },
  place: { name: "地点", glyph: "地", purpose: "place" },
  item: { name: "物品", glyph: "物", purpose: "item" },
  faction: { name: "势力", glyph: "势", purpose: "item" },
  skill: { name: "功法", glyph: "技", purpose: "item" },
  creature: { name: "生物", glyph: "兽", purpose: "character" },
  festival: { name: "节日", glyph: "节", purpose: "place" },
  other: { name: "其他", glyph: "设", purpose: "item" },
};

// 柔和的中间色（以后正文里高亮名字也用这个颜色）
export const SWATCHES = ["#d77fa1", "#5aa39a", "#c99a4e", "#7c8fd0", "#a68bd8", "#6fa86f", "#e08a6d", "#6aa7c9", "#b88a6a", "#9a9a5a", "#c47a8f", "#8a8f9c"];

const F = (name, key = "", hint = "", long = false) => ({ name, key, hint, long });
const DEFAULT_CATS = [
  { kind: "person", name: "人物", color: "#d77fa1", fields: [F("身份", "identity"), F("外貌", "look", "会用来画图", true), F("性格", "personality"), F("备注", "notes", "", true)] },
  { kind: "place", name: "地点", color: "#5aa39a", fields: [F("方位", "where"), F("外观", "look", "会用来画图", true), F("来历", "history", "", true), F("备注", "notes", "", true)] },
  { kind: "item", name: "物品", color: "#c99a4e", fields: [F("外观", "look", "会用来画图", true), F("用途", "use"), F("来历", "history", "", true), F("备注", "notes", "", true)] },
  { kind: "faction", name: "势力", color: "#7c8fd0", fields: [F("首领"), F("据点"), F("宗旨", "", "", true), F("备注", "notes", "", true)] },
  { kind: "skill", name: "功法/技能", color: "#a68bd8", fields: [F("品阶"), F("效果", "", "", true), F("代价"), F("备注", "notes", "", true)] },
  { kind: "creature", name: "生物", color: "#6fa86f", fields: [F("外形", "look", "会用来画图", true), F("习性"), F("栖息地"), F("备注", "notes", "", true)] },
  { kind: "festival", name: "节日", color: "#e08a6d", fields: [F("日子"), F("习俗", "", "", true), F("由来", "", "", true), F("备注", "notes", "", true)] },
];

export function newCat({ kind = "other", name, color, glyph, fields } = {}) {
  const k = KINDS[kind] ? kind : "other";
  return {
    id: uid("lc"), kind: k, name: name || KINDS[k].name, color: color || SWATCHES[0], glyph: glyph || KINDS[k].glyph,
    fields: (fields || [F("备注", "notes", "", true)]).map((f) => ({ id: uid("lf"), ...f })),
  };
}

export function defaultMeta(bookId) {
  return {
    id: metaId(bookId), bookId, type: "meta",
    cats: DEFAULT_CATS.map((c) => newCat({ ...c, glyph: KINDS[c.kind].glyph })),
    ladders: [], roots: [], createdAt: now(),
  };
}

export const ROLES = ["主角", "配角", "反派", "路人"];

export function newCard(bookId, cat, data = {}) {
  return {
    id: uid("k"), bookId, type: "card", cat: cat.id,
    name: "", aliases: [], role: "", traits: [], tags: [],
    fields: {},            // 字段 id → 文字
    img: null,             // 原形象 { id, thumb, w, h }
    outfits: [],           // 服装卡 [{ id, name, img, desc, fromId, toId }]
    outfit: null,          // 当前服装（null = 原形象）
    levels: {},            // 晋升阶梯 id → [{ id, levelId, chapterId（null = 现在，不记章节）, at }]
    placeId: null,         // 所在地（地点卡）
    links: [],             // 关联 [{ id, label, to }]
    log: [],               // 记一笔 [{ id, chapterId, text, at }]
    order: now(), createdAt: now(), updatedAt: now(),
    ...data,
  };
}

// ---------------- 读 ----------------
// 同一本书的改动排队进行，两次修改同时发生时后一次不会盖掉前一次
const locks = new Map();
function serial(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

/** 这本书的分类和阶梯。第一次用时建好默认分类（不算一步撤销） */
export async function getMeta(bookId) {
  const m = await db.get("lore", metaId(bookId));
  if (m) return fixMeta(m);
  return serial(bookId, async () => {
    const again = await db.get("lore", metaId(bookId));
    if (again) return fixMeta(again);
    const fresh = defaultMeta(bookId);
    await db.put("lore", fresh);
    return fresh;
  });
}
/** 只读：没建过时给一份默认的（不存），给别的模块查询用，不会替不存在的书建数据 */
export async function readMeta(bookId) {
  const m = await db.get("lore", metaId(bookId));
  return m ? fixMeta(m) : defaultMeta(bookId);
}
function fixMeta(m) {
  m.cats = m.cats || []; m.ladders = m.ladders || []; m.roots = m.roots || [];
  return m;
}

export async function listCards(bookId) {
  const all = await db.byIndex("lore", "bookId", bookId);
  return all.filter((r) => r.type === "card").sort((a, b) => (a.order || 0) - (b.order || 0));
}
export const getCard = (id) => db.get("lore", id);

// ---------------- 图片 ----------------
/** 存一张原图，返回 id。图片不变，换图时存新的一张（撤销时还能换回去），没人用的启动时清掉 */
export async function putImage(bookId, data) {
  const id = uid("li");
  await db.put("loreimg", { id, bookId, data, at: now() });
  return id;
}
export async function getImage(id) {
  if (!id) return null;
  const r = await db.get("loreimg", id);
  return r ? r.data : null;
}
/** 清掉没有卡（包括回收站里的卡）用到的图。只在刚打开软件时跑：那时还没有撤销记录会用到旧图 */
export async function sweepImages() {
  const imgs = await db.all("loreimg");
  if (!imgs.length) return 0;
  const used = new Set();
  const note = (c) => { if (!c) return; if (c.img) used.add(c.img.id); (c.outfits || []).forEach((o) => o.img && used.add(o.img.id)); };
  (await db.all("lore")).forEach((r) => r.type === "card" && note(r));
  (await db.all("trash")).forEach((t) => t.kind === "lore" && t.data && note(t.data.card));
  const gone = imgs.filter((i) => !used.has(i.id));
  if (gone.length) await db.tx(["loreimg"], (s) => gone.forEach((i) => s.loreimg.delete(i.id)));
  return gone.length;
}

// ---------------- 改：一次 change 算一步撤销 ----------------
const mine = new WeakSet();   // 设定库推进撤销栈的条目
export const isLoreEntry = (e) => !!e && mine.has(e);
// 撤销栈「可重做」那一头最上面连着的几条设定库条目（整页的「重做」按钮只重做设定库自己的）
const undone = [];
let undoing = null, redoing = null;
bus.on("undo", () => { if (undoing) undone.push(undoing); else undone.length = 0; undoing = null; });
bus.on("redo", () => { if (redoing && undone[undone.length - 1] === redoing) undone.pop(); else undone.length = 0; redoing = null; });
bus.on("undo:changed", () => { if (!appUndo.canRedo()) undone.length = 0; });
export const canLoreUndo = () => isLoreEntry(appUndo.peek());
export const canLoreRedo = () => appUndo.canRedo() && undone.length > 0;

class Tx {
  constructor(bookId) { this.bookId = bookId; this.recs = new Map(); this.trashAdd = []; this.trashDel = []; }
  async get(id) {
    if (this.recs.has(id)) return this.recs.get(id).cur;
    const rec = await db.get("lore", id);
    this.recs.set(id, { before: clone(rec) || null, cur: clone(rec) || null });
    return this.recs.get(id).cur;
  }
  async meta() {
    let m = await this.get(metaId(this.bookId));
    if (!m) { m = defaultMeta(this.bookId); this.recs.get(m.id).cur = m; }
    return fixMeta(m);
  }
  card(id) { return this.get(id); }
  /** 放一条新记录（新建的卡） */
  add(rec) { this.recs.set(rec.id, { before: null, cur: rec }); return rec; }
  async del(id) { await this.get(id); this.recs.get(id).cur = null; }
  /** 删卡时顺便放进回收站（同一个事务，撤销时一起拿回来） */
  trash(entry) { this.trashAdd.push(entry); }
}

/**
 * 改设定库。fn(tx) 里用 tx.meta() / tx.card(id) 拿到可以直接改的副本，tx.add / tx.del 新建、删除。
 * 改完自动比较前后，写进数据库，推一步撤销（label 是撤销提示里的名字）。返回 { result, entry, ids }。
 * opts.silent：不推撤销（导入时用）
 */
export function change(bookId, label, fn, opts = {}) {
  return serial(bookId, async () => {
    const t = new Tx(bookId);
    const result = await fn(t);
    const diffs = [];
    for (const [id, r] of t.recs) {
      const a = JSON.stringify(r.before), b = JSON.stringify(r.cur);
      if (a === b) continue;
      if (r.cur && r.cur.type === "card") r.cur.updatedAt = now();
      if (r.cur && r.cur.type === "meta") r.cur.updatedAt = now();
      diffs.push({ id, before: r.before, after: clone(r.cur) });
    }
    if (!diffs.length && !t.trashAdd.length) return { result, entry: null, ids: [] };
    const trashAdd = t.trashAdd.map(clone);
    const ids = diffs.map((d) => d.id);
    const write = async (which) => {
      await db.tx(["lore", "trash"], (s) => {
        for (const d of diffs) { const rec = d[which]; if (rec) s.lore.put(clone(rec)); else s.lore.delete(d.id); }
        if (which === "after") trashAdd.forEach((e) => s.trash.put(e));
        else trashAdd.forEach((e) => s.trash.delete(e.id));
      });
    };
    await write("after");
    bus.emit("lore:changed", { bookId, ids, source: opts.source || null });
    let entry = null;
    if (!opts.silent) {
      entry = {
        label, bookId, lore: true,
        undo: async () => { undoing = entry; await serial(bookId, () => write("before")); bus.emit("lore:changed", { bookId, ids, undo: true }); },
        redo: async () => { redoing = entry; await serial(bookId, () => write("after")); bus.emit("lore:changed", { bookId, ids, redo: true }); },
      };
      mine.add(entry);
      appUndo.push(entry);
    }
    return { result, entry, ids };
  });
}

/** 设定卡删进回收站，返回 { entry（撤销条目）, trashId } */
export async function trashCard(cardId) {
  const card = await getCard(cardId);
  if (!card) return null;
  const meta = await getMeta(card.bookId);
  const cat = meta.cats.find((c) => c.id === card.cat) || null;
  const trashId = uid("t");
  const { entry } = await change(card.bookId, `删除设定卡「${card.name || "未命名"}」`, async (t) => {
    const c = await t.card(cardId);
    await t.del(cardId);
    t.trash({ id: trashId, kind: "lore", bookId: c.bookId, title: c.name || "未命名", data: { card: c, cat: clone(cat) }, deletedAt: now() });
  });
  return { entry, trashId };
}

// ---------------- 查 ----------------
export const catOf = (meta, card) => meta.cats.find((c) => c.id === card.cat) || meta.cats[0] || newCat({ kind: "other", name: "未分类" });
export const kindOf = (meta, card) => catOf(meta, card).kind;
/** 按语义找字段：identity 身份、look 外貌、personality 性格、notes 备注……（改了名也找得到） */
export const fieldByKey = (cat, key) => (cat.fields || []).find((f) => f.key === key) || null;
export const valueOf = (card, field) => (field && card.fields && card.fields[field.id]) || "";

/** 这张卡空着的字段 */
export function emptyFields(card, cat) {
  return (cat.fields || []).filter((f) => !String(valueOf(card, f)).trim());
}

/** 分类的名字、id、kind 都能用来找分类（cards.new / cards.list 的 cat 参数） */
export function findCat(meta, cat) {
  if (!cat) return null;
  const s = String(cat);
  return meta.cats.find((c) => c.id === s) || meta.cats.find((c) => c.name === s)
    || meta.cats.find((c) => c.kind === s) || meta.cats.find((c) => KINDS[c.kind] && KINDS[c.kind].name === s) || null;
}

/** 搜索：名字、别名、字段、辨识特征、标签、定位 */
export function matchCard(card, q) {
  q = String(q || "").trim().toLowerCase();
  if (!q) return true;
  const hay = [card.name, ...(card.aliases || []), ...(card.traits || []), ...(card.tags || []), card.role || "",
    ...Object.values(card.fields || {}), ...(card.outfits || []).map((o) => o.name + " " + (o.desc || ""))].join("\n").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

// ---------------- 晋升阶梯：某一章时在第几级 ----------------
/**
 * 一张卡在某个阶梯上的记录，按章节先后排好。
 * idxOf(chapterId) → 第几章（从 1 数，找不到返回 0）。不记章节的那条算「现在」，排最后。
 */
export function stepsOf(card, ladderId, idxOf) {
  const list = ((card.levels || {})[ladderId] || []).map((s) => {
    const i = s.chapterId ? idxOf(s.chapterId) : 0;
    return { ...s, no: i || null, key: s.chapterId ? (i || 1e9) : Infinity };
  });
  return list.sort((a, b) => a.key - b.key || (a.at || 0) - (b.at || 0));
}
/** at：第几章（不给就是现在）。返回那一步 { levelId, no, ... } 或 null（还没到第一条记录） */
export function levelAt(card, ladderId, idxOf, at = null) {
  const steps = stepsOf(card, ladderId, idxOf);
  if (!steps.length) return null;
  if (at == null) return steps[steps.length - 1];
  const tied = steps.filter((s) => Number.isFinite(s.key) && s.key < 1e9);
  if (!tied.length) return steps[steps.length - 1];
  let best = null;
  for (const s of tied) if (s.key <= at) best = s;
  return best;
}
export const levelIndex = (ladder, levelId) => ladder.levels.findIndex((l) => l.id === levelId);

// ---------------- 给 AI、给人看的文字 ----------------
const chapterNo = (idxOf, id) => { const i = id ? idxOf(id) : 0; return i ? `第 ${i} 章` : ""; };

/**
 * 一张卡写成「字段：内容」的样子（AI 补全时发出去，空的写「（空）」）。
 * ctx: { meta, cards, idxOf }
 */
export function cardText(card, { meta, cards = [], idxOf = () => 0 }) {
  const cat = catOf(meta, card);
  const person = cat.kind === "person";
  const nameOf = (id) => { const c = cards.find((x) => x.id === id); return c ? c.name : ""; };
  const L = [`名字：${card.name || "（未命名）"}`, `分类：${cat.name}`];
  if (person) L.push(`定位：${card.role || "（空）"}`);
  L.push(`别名：${(card.aliases || []).join("、") || "（空）"}`);
  if (person) L.push(`辨识特征：${(card.traits || []).join("、") || "（空）"}`);
  for (const f of cat.fields || []) L.push(`${f.name}：${String(valueOf(card, f)).trim() || "（空）"}`);
  if (person) {
    for (const lad of meta.ladders) {
      const steps = stepsOf(card, lad.id, idxOf).filter((s) => levelIndex(lad, s.levelId) >= 0);
      const name = (s) => lad.levels[levelIndex(lad, s.levelId)].name;
      L.push(`${lad.name}：${steps.length ? steps.map((s) => (s.no ? `第 ${s.no} 章 ` : "") + name(s)).join(" → ") : "（空）"}`);
    }
    L.push(`所在地：${nameOf(card.placeId) || "（空）"}`);
  }
  if ((card.links || []).length) L.push(`关联：${card.links.map((l) => `${l.label || "关联"} → ${nameOf(l.to) || "？"}`).join("；")}`);
  if ((card.outfits || []).length) L.push(...card.outfits.map((o) => `服装「${o.name || "未命名"}」：${o.desc || "（空）"}`));
  if ((card.tags || []).length) L.push(`标签：${card.tags.join("、")}`);
  if ((card.log || []).length) L.push(`经历：${card.log.slice(-6).map((g) => (chapterNo(idxOf, g.chapterId) ? chapterNo(idxOf, g.chapterId) + "：" : "") + g.text).join("；")}`);
  return L.join("\n");
}

/** 发给 AI 的人物信息（cards.context）：只写有内容的，阶梯按 chapterId 那一章时的等级 */
export function contextText(list, { meta, cards = [], idxOf = () => 0, chapterId = null }) {
  const at = chapterId ? idxOf(chapterId) || null : null;
  const nameOf = (id) => { const c = cards.find((x) => x.id === id); return c ? c.name : ""; };
  return list.map((card) => {
    const cat = catOf(meta, card);
    const head = `${card.name || "未命名"}（${cat.name}${card.role ? " · " + card.role : ""}）` + ((card.aliases || []).length ? `，又叫${card.aliases.join("、")}` : "");
    const L = [head];
    const keyed = ["identity", "look", "personality"].map((k) => fieldByKey(cat, k)).filter(Boolean);
    const main = keyed.map((f) => [f.name, String(valueOf(card, f)).trim()]).filter(([, v]) => v);
    if (main.length) L.push(main.map(([k, v]) => `${k}：${v}`).join("；"));
    if (cat.kind === "person") {
      const lv = meta.ladders.map((lad) => {
        const s = levelAt(card, lad.id, idxOf, at);
        const i = s ? levelIndex(lad, s.levelId) : -1;
        return i >= 0 ? `${lad.name}：${lad.levels[i].name}` : "";
      }).filter(Boolean);
      if (lv.length) L.push(lv.join("；"));
      if (card.placeId && nameOf(card.placeId)) L.push(`所在地：${nameOf(card.placeId)}`);
      if ((card.traits || []).length) L.push(`辨识特征：${card.traits.join("、")}`);
      const o = (card.outfits || []).find((x) => x.id === card.outfit);
      if (o) L.push(`现在穿：${o.name}${o.desc ? "（" + o.desc + "）" : ""}`);
    }
    const rest = (cat.fields || []).filter((f) => !keyed.includes(f)).map((f) => [f.name, String(valueOf(card, f)).trim()]).filter(([, v]) => v);
    if (rest.length) L.push(rest.map(([k, v]) => `${k}：${v}`).join("；"));
    if ((card.links || []).length) L.push("关联：" + card.links.map((l) => `${l.label || "关联"} ${nameOf(l.to) || "？"}`).join("、"));
    return L.join("\n");
  }).join("\n\n");
}

/** AI 回的「字段：内容」拆开：[{ label, value }]，其余的放 rest */
export function parsePairs(text) {
  const out = [];
  const rest = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*·•]|\d+[.、)）])\s*/, "").replace(/\*\*/g, "").trim();
    if (!line) { cur = null; continue; }
    const m = line.match(/^([^：:\s]{1,12})\s*[：:]\s*(.*)$/);
    if (m) { cur = { label: m[1].replace(/[【】「」]/g, ""), value: m[2].trim() }; out.push(cur); continue; }
    if (cur) cur.value += (cur.value ? "\n" : "") + line;
    else rest.push(line);
  }
  return { pairs: out.filter((p) => p.value), rest: rest.join("\n") };
}
const EMPTYISH = /^[（(]?\s*(空|空着|无|没有|暂无|待填写?|未知|不详|略|—+|-+)\s*[)）]?[。.]?$/;
export const isEmptyish = (v) => !String(v || "").trim() || EMPTYISH.test(String(v).trim());

// ---------------- 晋升阶梯模板（整套导入后随便改） ----------------
const LV = (name, power, need, cost, ratio) => ({ name, power, need, cost, ratio });
export const TEMPLATES = [
  { id: "xian", name: "修仙境界", levels: [
    LV("凡人", "肉体凡胎，寿数不过百年。", "感应到灵气，开辟丹田。", "无。", "九成九以上"),
    LV("炼气", "引气入体，能用小法术，身轻体健。", "灵气积满经脉，凝成真元。", "要有灵根；资质差的耗尽寿元也难进一步。", "千中一二"),
    LV("筑基", "寿元两百载，能御器飞行。", "真元凝实，筑成道基。", "筑基丹难求；失败伤根基。", "万中一"),
    LV("金丹", "结成金丹，寿元五百，可开宗立派。", "碎丹成婴。", "第一重天劫。", "十万中一"),
    LV("元婴", "元婴可出窍，肉身毁了也能夺舍重生。", "感悟天地法则。", "心魔劫。", "一州之内数人"),
    LV("化神", "神识覆盖千里，能引动地脉。", "元神与天地相合。", "要舍掉一部分凡心。", "一界数十人"),
    LV("炼虚", "炼化虚空，挪移空间。", "看破虚实。", "寿元外的一切都可能失去。", "一界数人"),
    LV("合体", "元神、肉身、天地合一。", "法则圆满。", "与天地因果相连。", "传闻中有"),
    LV("大乘", "近乎不死，一念移山。", "等天劫。", "无处可退。", "屈指可数"),
    LV("渡劫", "渡过天劫即可飞升。", "渡过九重天劫。", "失败就身死道消。", "只在传说里"),
  ] },
  { id: "noble", name: "西幻爵位", levels: [
    LV("平民", "没有封地，受领主管辖。", "立军功、捐钱、联姻得到册封。", "要交税、服劳役。", "九成以上"),
    LV("骑士", "终身头衔，不能世袭，有少量俸禄。", "效忠领主并立功。", "随时应召出战。", "百中一二"),
    LV("男爵", "最低的世袭爵位，一座庄园或村镇。", "扩大领地，得到王室赏识。", "向上级领主纳税、出兵。", "千中一"),
    LV("子爵", "管一座城，常是伯爵的副手。", "接下更大的封地。", "城防和税收都要自己担。", "数千中一"),
    LV("伯爵", "一郡的领主，有自己的骑士团。", "战功或王室联姻。", "郡里出事要向国王交代。", "一国数十位"),
    LV("侯爵", "镇守边境要地，手握重兵。", "守住边境，打下新地。", "直面外敌，也被王室提防。", "一国十来位"),
    LV("公爵", "王室旁支或大功臣，领地像小国。", "王室血统或立国之功。", "卷进王位之争。", "一国几位"),
    LV("大公", "与国王几乎平起平坐，能自己铸币。", "独立或被王国承认。", "随时可能和王国开战。", "一两位"),
  ] },
  { id: "knight", name: "骑士晋升", levels: [
    LV("奴隶", "没有人身自由，归主人所有。", "赎身、立功或被解放。", "赎金，或拿命去换。", "战乱时很多"),
    LV("自由民", "能自己谋生、迁居。", "被骑士收为侍从，要有人推荐。", "离开家人，跟着主人走。", "多数人"),
    LV("侍从", "照顾骑士的马和铠甲，跟着学武。", "成年后通过比武，或主人推荐。", "几年没有报酬的服侍。", "百中一"),
    LV("见习骑士", "能佩剑上阵，还没有封号。", "战场立功，接受授勋。", "自备马匹和装备。", "数百中一"),
    LV("正式骑士", "有封号和誓言，可以收侍从。", "带队打胜仗。", "为领主出战，守誓言。", "千中一"),
    LV("骑士队长", "带十到几十名骑士。", "多次战功，得到团长认可。", "部下的命算在自己头上。", "一个骑士团几人"),
    LV("骑士团长", "统领整个骑士团，参加王国军议。", "前任退位或战死。", "政治斗争。", "一国几位"),
    LV("圣骑士", "被教会或神明认可，能用神术。", "通过神的试炼。", "一生守戒。", "一代几人"),
  ] },
  { id: "craft", name: "职业等级", levels: [
    LV("学徒", "跟着师傅打下手，只会最基本的活。", "通过出师考核。", "几年学徒期，几乎没有收入。", "最多"),
    LV("初级", "能独立接简单的委托。", "攒够完成的委托。", "接不到好活，常被压价。", "很多"),
    LV("中级", "行里的中坚，养家不成问题。", "做出让人记住的作品。", "活多，没空学新东西。", "不少"),
    LV("高级", "一城里排得上名号。", "拿出代表作，通过行会评审。", "同行盯着，名声一坏就难翻身。", "百中几人"),
    LV("专家", "一国知名，有人登门求教。", "在一个方向上做到最好。", "大半时间在应付请托。", "千中一"),
    LV("大师", "自成一派，作品被收藏。", "开创新技法。", "大半生的心血。", "一国几位"),
    LV("宗师", "一个时代的标杆，行规由他定。", "带出一代弟子。", "名声比人重。", "一代一两位"),
    LV("传说", "只在故事里。", "——", "——", "传说"),
  ] },
];

/** 粘贴的文字拆成一级一级：一行一级、「名称：说明」、「名称 | 能力 | 突破 | 代价 | 比例」、「凡人 → 炼气 → 筑基」 */
export function parseLadder(text) {
  let lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ARROW = /\s*(?:→|->|=>|⇒|＞|>|—>)\s*/;
  if (lines.length === 1 && !/[：:|｜\t]/.test(lines[0])) lines = lines[0].split(ARROW.test(lines[0]) ? ARROW : /\s*[、，,;；/]\s*|\s+/);
  else lines = lines.flatMap((l) => (ARROW.test(l) && !/[：:|｜\t]/.test(l) ? l.split(ARROW) : [l]));
  const out = [];
  for (let raw of lines) {
    let line = raw.replace(/^(?:[-*·•]+|\d+\s*[.、)）:：]|[（(]\d+[)）]|第[一二三四五六七八九十百零\d]+[级层阶重境步品]?\s*[：:、.]?)\s*/, "").trim();
    if (!line) continue;
    let lv = LV("", "", "", "", "");
    if (/[|｜\t]/.test(line)) {
      const [name, power, need, cost, ratio] = line.split(/\s*[|｜\t]\s*/);
      lv = LV(name || "", power || "", need || "", cost || "", ratio || "");
    } else {
      const m = line.match(/^([^：:]{1,16})[：:]\s*([\s\S]*)$/);
      let name = line, rest = "";
      if (m) { name = m[1]; rest = m[2]; }
      else { const s = line.match(/^(\S{1,8})\s+(.+)$/); if (s) { name = s[1]; rest = s[2]; } }
      lv.name = name.trim();
      // 说明里再分「突破：」「代价：」「比例：」
      const LBL = /(能力表现|能力|表现|突破条件|突破|晋升条件|条件|代价|在世人数|人数比例|比例|人数)\s*[：:]/g;
      const marks = [...rest.matchAll(LBL)];
      const strip = (s) => s.replace(/^[\s，,。；;]+|[\s，,。；;]+$/g, "");
      if (!marks.length) lv.power = strip(rest);
      else {
        lv.power = strip(rest.slice(0, marks[0].index));
        marks.forEach((mk, i) => {
          const val = strip(rest.slice(mk.index + mk[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined));
          const k = mk[1];
          if (/能力|表现/.test(k)) lv.power = lv.power ? lv.power + "；" + val : val;
          else if (/突破|条件/.test(k)) lv.need = val;
          else if (/代价/.test(k)) lv.cost = val;
          else lv.ratio = val;
        });
      }
    }
    lv.name = lv.name.replace(/[。；;，,]+$/, "").slice(0, 20);
    if (lv.name) out.push(lv);
    if (out.length >= 60) break;
  }
  return out;
}

export function newLadder(name, levels = []) {
  return { id: uid("ld"), name: name || "新阶梯", rootId: null, levels: levels.map((l) => ({ id: uid("lv"), name: "", power: "", need: "", cost: "", ratio: "", ...l })) };
}
