// 主线分镜看板的数据。每本书一条 kv "board:<书id>"：
//   { line 主线一句话, acts: [{ id, title, goal, cards: [卡 id] }] 大段落（卷 / 幕）, cards: { id: 分镜卡 } }
//   分镜卡 { id, title, goal 要达成什么, conflict 冲突, twist 转折, cast [设定卡 id] 谁出场, reveal 透露给读者的, note 备注, chapters [章 id] }
// 改动都走 edit()：一次改动算一步撤销，写完发 board:changed { bookId }。
// 章节挂到分镜卡下时，卡上的目标、冲突、转折、透露变成这一章的要点（要点上记着 board: "卡id:字段"），卡改了要点跟着改。
import { db, uid } from "./db.js";
import { bus } from "./bus.js";
import { undo as appUndo } from "./undo.js";
import { getChapter, updateChapter } from "./store.js";

const key = (bookId) => "board:" + bookId;
const clone = (x) => JSON.parse(JSON.stringify(x));
export const FIELDS = [
  { id: "goal", name: "目标", hint: "这一段要达成什么" },
  { id: "conflict", name: "冲突", hint: "挡在前面的是什么" },
  { id: "twist", name: "转折", hint: "哪里变了" },
  { id: "reveal", name: "透露", hint: "这一段让读者知道什么" },
];
export const TEMPLATES = [
  { id: "blank", name: "空白", acts: [["第一卷", ""]] },
  { id: "three", name: "三幕", acts: [["第一幕 · 开端", "立住主角和他想要的东西，出事"], ["第二幕 · 对抗", "越走越难，中点翻一次盘"], ["第三幕 · 结局", "最后一搏，付出代价，得到或失去"]] },
  { id: "four", name: "起承转合", acts: [["起", "人物登场，交代处境"], ["承", "事情展开，矛盾加深"], ["转", "意外、反转"], ["合", "收束，回应开头"]] },
  { id: "hero", name: "英雄之旅", acts: [["平凡世界", "原来的生活和缺憾"], ["启程", "召唤、拒绝、导师、跨过门槛"], ["试炼", "盟友、敌人、考验、最深的洞穴"], ["归来", "磨难、奖赏、带着改变回去"]] },
];

export function newAct(title = "", goal = "") { return { id: uid("ba"), title, goal, cards: [] }; }
export function newCard(data = {}) { return { id: uid("bc"), title: "", goal: "", conflict: "", twist: "", cast: [], reveal: "", note: "", chapters: [], at: Date.now(), ...data }; }

export async function getBoard(bookId) {
  const b = await db.getKV(key(bookId), null);
  return b ? fix(b) : { line: "", acts: [], cards: {}, v: 1 };
}
function fix(b) {
  b.acts = b.acts || []; b.cards = b.cards || {}; b.line = b.line || "";
  for (const a of b.acts) a.cards = (a.cards || []).filter((id) => b.cards[id]);
  return b;
}

/** 这一章挂在哪张卡上：{ card, act, index（全书第几张） } 或 null */
export function cardOfChapter(board, chapterId) {
  let n = 0;
  for (const act of board.acts) for (const id of act.cards) {
    n++;
    const c = board.cards[id];
    if (c && (c.chapters || []).includes(chapterId)) return { card: c, act, index: n };
  }
  return null;
}
/** 卡在全书里排第几（从 1 数） */
export function indexOf(board, cardId) {
  let n = 0;
  for (const act of board.acts) for (const id of act.cards) { n++; if (id === cardId) return n; }
  return 0;
}
export const filled = (c) => FIELDS.filter((f) => String(c[f.id] || "").trim()).length + ((c.cast || []).length ? 1 : 0);

// ---------------- 要点同步 ----------------
const pointsFor = (card) => FIELDS.filter((f) => String(card[f.id] || "").trim()).map((f) => ({ key: card.id + ":" + f.id, text: `${f.name}：${String(card[f.id]).trim()}` }));
/** 让这一章的要点跟这张卡对上（card 为 null：去掉这张卡留下的、还没打勾的要点） */
function syncPoints(points, card, oldCardId) {
  let list = (points || []).map((p) => ({ ...p }));
  const mine = (p) => p.board && (p.board.startsWith((card ? card.id : oldCardId) + ":") || (oldCardId && p.board.startsWith(oldCardId + ":")));
  if (!card) return list.filter((p) => !(mine(p) && !p.done));
  const want = pointsFor(card);
  // 卡上的字段改了：文字跟着改；清空了：还没打勾的拿掉
  list = list.filter((p) => !p.board || !p.board.startsWith(card.id + ":") || want.some((w) => w.key === p.board) || p.done)
    .map((p) => { const w = p.board && want.find((x) => x.key === p.board); return w ? { ...p, text: w.text } : p; });
  if (oldCardId && oldCardId !== card.id) list = list.filter((p) => !(p.board && p.board.startsWith(oldCardId + ":") && !p.done));
  const have = new Set(list.map((p) => p.board).filter(Boolean));
  const add = want.filter((w) => !have.has(w.key)).map((w) => ({ id: uid("p"), text: w.text, done: false, board: w.key }));
  // 从卡上来的要点放在前面
  const lead = list.filter((p) => p.board && p.board.startsWith(card.id + ":"));
  const rest = list.filter((p) => !(p.board && p.board.startsWith(card.id + ":")));
  return [...lead, ...add, ...rest];
}

/**
 * 改看板：fn(board) 直接改副本，返回值原样带回。前后比较，写进去，推一步撤销。
 * 挂的章节有变化、卡的字段有变化，会顺手改对应章节的要点（一起撤销）。
 */
export async function edit(bookId, label, fn, { silent = false } = {}) {
  const before = await getBoard(bookId);
  const after = clone(before);
  const result = await fn(after);
  fix(after);
  if (JSON.stringify(before) === JSON.stringify(after)) return { result, entry: null };
  // 哪些章节的要点要改：挂上 / 拿下 / 卡的内容变了
  const touched = new Map();   // chapterId → { card（现在挂的卡或 null）, old（原来挂的卡 id） }
  const at = (b) => { const m = new Map(); for (const c of Object.values(b.cards)) for (const ch of c.chapters || []) m.set(ch, c); return m; };
  const was = at(before), now = at(after);
  for (const ch of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(ch), b = now.get(ch);
    const same = a && b && a.id === b.id && FIELDS.every((f) => (a[f.id] || "") === (b[f.id] || ""));
    if (!same) touched.set(ch, { card: b || null, old: a ? a.id : null });
  }
  const chBefore = new Map(), chAfter = new Map();
  for (const [chId, t] of touched) {
    const ch = await getChapter(chId);
    if (!ch) continue;
    chBefore.set(chId, ch.points || []);
    chAfter.set(chId, syncPoints(ch.points, t.card, t.old));
  }
  const write = async (board, pts) => {
    await db.setKV(key(bookId), board);
    for (const [chId, p] of pts) await updateChapter(chId, { points: p });
    bus.emit("board:changed", { bookId, chapters: [...pts.keys()] });
  };
  await write(after, chAfter);
  let entry = null;
  if (!silent) entry = appUndo.push({ label, board: true, undo: () => write(before, chBefore), redo: () => write(after, chAfter) });
  return { result, entry };
}
