// 作品和章节的读写。界面只调这里，不直接碰数据库。
import { db, uid } from "./db.js";
import { bus } from "./bus.js";
import { countWords, todayKey } from "./text.js";

const now = () => Date.now();

// 同一条记录的「读出来、改、写回」排队进行，两次修改同时发生时后一次不会盖掉前一次
const locks = new Map();
function serial(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

// ---------------- 作品 ----------------
export const DEFAULT_BOOK = {
  title: "未命名作品",
  intro: "",
  tags: [],
  cover: "",            // 600×800 的 JPEG dataURL，空着就显示默认书封
  numbering: "zh",      // 章节号：zh 第一章 / num 第1章
  useVolumes: false,    // 是否分卷
  volumes: [],          // [{ id, title }]
  autoIndent: true,     // 回车后自动在段首空两格
  paraGap: 0,           // 段与段之间空几行（0 或 1）
  dailyGoal: 3000,      // 每天的字数目标，0 表示不设
  demonStyle: "auto",   // 小恶魔的风格：auto 按类型自动选，或某个风格 id
  lastChapterId: null,
};

export async function listBooks() {
  const books = await db.all("books");
  return books.sort((a, b) => (b.openedAt || b.updatedAt) - (a.openedAt || a.updatedAt));
}

export const getBook = (id) => db.get("books", id);

export async function createBook(data) {
  const book = { ...DEFAULT_BOOK, ...data, id: uid("b"), createdAt: now(), updatedAt: now(), openedAt: now() };
  await db.put("books", book);
  await createChapter(book.id, { title: "" });
  bus.emit("book:created", { book });
  return book;
}

export function updateBook(id, patch) {
  return serial("b:" + id, async () => {
    const book = await getBook(id);
    if (!book) return null;
    Object.assign(book, patch, { updatedAt: now() });
    await db.put("books", book);
    bus.emit("book:updated", { book });
    return book;
  });
}

/** 整本书删进回收站（连同章节），返回回收站条目 id，可以 restoreFromTrash 恢复。 */
export async function trashBook(id) {
  const book = await getBook(id);
  if (!book) return null;
  const chapters = await db.byIndex("chapters", "bookId", id);
  const entry = { id: uid("t"), kind: "book", bookId: id, title: book.title, data: { book, chapters }, deletedAt: now() };
  await db.tx(["books", "chapters", "trash"], (s) => {
    s.books.delete(id);
    chapters.forEach((c) => s.chapters.delete(c.id));
    s.trash.put(entry);
  });
  bus.emit("book:deleted", { book });
  return entry.id;
}

// ---------------- 章节 ----------------
export async function listChapters(bookId) {
  const list = await db.byIndex("chapters", "bookId", bookId);
  return list.sort((a, b) => a.order - b.order);
}

export const getChapter = (id) => db.get("chapters", id);

/** 新建章节。opts.afterId：插在哪一章后面（不给就放到最后）；opts.volumeId：放进哪一卷。 */
export async function createChapter(bookId, opts = {}) {
  const list = await listChapters(bookId);
  let order;
  if (opts.afterId) {
    const i = list.findIndex((c) => c.id === opts.afterId);
    const a = list[i], b = list[i + 1];
    order = a ? (b ? (a.order + b.order) / 2 : a.order + 1) : (list.length ? list[list.length - 1].order + 1 : 1);
  } else {
    order = list.length ? list[list.length - 1].order + 1 : 1;
  }
  const after = opts.afterId ? list.find((c) => c.id === opts.afterId) : list[list.length - 1];
  const chapter = {
    id: uid("c"), bookId, order,
    volumeId: opts.volumeId !== undefined ? opts.volumeId : (after ? after.volumeId || null : null),
    title: opts.title || "",
    content: opts.content || "",
    points: opts.points || [],
    words: countWords(opts.content || ""),
    createdAt: now(), updatedAt: now(),
  };
  await db.put("chapters", chapter);
  await normalizeOrder(bookId);
  bus.emit("chapter:created", { chapter });
  return chapter;
}

/** 把 order 重新排成 1,2,3…（插入很多次以后小数会越来越长） */
async function normalizeOrder(bookId) {
  const list = await listChapters(bookId);
  if (list.every((c, i) => c.order === i + 1)) return;
  await writeOrder(list.map((c) => c.id));
}

/**
 * 按 ids 的顺序写 order（和可选的卷）。在同一个事务里先读再写，只改 order / volumeId，
 * 这样和同时进行的自动保存不会互相覆盖正文。
 */
function writeOrder(ids, volumes = {}) {
  return db.tx(["chapters"], (s) => {
    ids.forEach((cid, i) => {
      const req = s.chapters.get(cid);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        c.order = i + 1;
        if (cid in volumes) c.volumeId = volumes[cid];
        s.chapters.put(c);
      };
    });
  });
}

export function updateChapter(id, patch) {
  return serial("c:" + id, async () => {
    const ch = await getChapter(id);
    if (!ch) return null;
    Object.assign(ch, patch, { updatedAt: now() });
    await db.put("chapters", ch);
    return ch;
  });
}

/** 自动保存正文：同时更新字数、今天的码字记录。 */
export function saveContent(id, text) {
  return serial("c:" + id, () => saveContentNow(id, text));
}
async function saveContentNow(id, text) {
  const ch = await getChapter(id);
  if (!ch) return null;
  if (ch.content === text) return ch;
  const before = ch.words || 0;
  ch.content = text;
  ch.words = countWords(text);
  ch.updatedAt = now();
  await db.put("chapters", ch);
  await addTodayWords(ch.bookId, ch.words - before);
  bus.emit("content:saved", { chapter: ch, text });
  return ch;
}

/** 把章节移到 newIndex（在全书里的位置，从 0 数），可同时换卷。 */
export async function moveChapter(id, newIndex, volumeId) {
  const ch = await getChapter(id);
  const list = (await listChapters(ch.bookId)).filter((c) => c.id !== id);
  newIndex = Math.max(0, Math.min(newIndex, list.length));
  list.splice(newIndex, 0, ch);
  await writeOrder(list.map((c) => c.id), volumeId !== undefined ? { [id]: volumeId } : {});
  if (volumeId !== undefined) ch.volumeId = volumeId;
  bus.emit("chapter:moved", { chapter: ch });
  return ch;
}

/** 把整本书的章节顺序设成 ids 的顺序（撤销移动时用） */
export async function setOrder(bookId, ids, volumes = {}) {
  await writeOrder(ids, volumes);
}

/** 章节删进回收站，返回回收站条目 id。 */
export async function trashChapter(id) {
  const ch = await getChapter(id);
  if (!ch) return null;
  const entry = { id: uid("t"), kind: "chapter", bookId: ch.bookId, title: ch.title, data: { chapter: ch }, deletedAt: now() };
  await db.tx(["chapters", "trash"], (s) => { s.chapters.delete(id); s.trash.put(entry); });
  bus.emit("chapter:deleted", { chapter: ch });
  return entry.id;
}

export async function listTrash(bookId) {
  const all = await db.all("trash");
  return all.filter((t) => !bookId || t.bookId === bookId).sort((a, b) => b.deletedAt - a.deletedAt);
}

/** 从回收站恢复。章节回到原来的位置（按原 order 插回去）。 */
export async function restoreFromTrash(trashId) {
  const entry = await db.get("trash", trashId);
  if (!entry) return null;
  if (entry.kind === "chapter") {
    const ch = entry.data.chapter;
    const book = await getBook(ch.bookId);
    if (!book) throw new Error("这一章所在的作品已经不在了，请先恢复作品");
    await db.tx(["chapters", "trash"], (s) => { s.chapters.put(ch); s.trash.delete(trashId); });
    await normalizeOrder(ch.bookId);
    bus.emit("chapter:created", { chapter: ch, restored: true });
    return ch;
  }
  if (entry.kind === "book") {
    const { book, chapters } = entry.data;
    await db.tx(["books", "chapters", "trash"], (s) => {
      s.books.put(book);
      chapters.forEach((c) => s.chapters.put(c));
      s.trash.delete(trashId);
    });
    bus.emit("book:created", { book, restored: true });
    return book;
  }
  return null;
}

export async function purgeTrash(trashId) { await db.del("trash", trashId); }

/** 把回收站条目原样放回去（撤销「恢复」「彻底删除」时用）：条目里的章节 / 作品会从书架上拿走 */
export async function putTrashEntry(entry) {
  const stores = ["trash", "chapters", "books"];
  await db.tx(stores, (s) => {
    s.trash.put(entry);
    if (entry.kind === "chapter" && entry.data && entry.data.chapter) s.chapters.delete(entry.data.chapter.id);
    if (entry.kind === "book" && entry.data) {
      s.books.delete(entry.data.book.id);
      (entry.data.chapters || []).forEach((c) => s.chapters.delete(c.id));
    }
  });
}

/** 回收站里超过 30 天的自动清掉 */
export async function purgeOldTrash(days = 30) {
  const all = await db.all("trash");
  const limit = now() - days * 86400000;
  for (const t of all) if (t.deletedAt < limit) await db.del("trash", t.id);
}

// ---------------- 码字记录 ----------------
// kv "stats:<bookId>" = { "2026-10-08": 1234, ... }  每天净增字数
export async function addTodayWords(bookId, delta) {
  if (!delta) return;
  const key = "stats:" + bookId;
  const stats = await db.getKV(key, {});
  const day = todayKey();
  const before = stats[day] || 0;
  stats[day] = before + delta;
  await db.setKV(key, stats);
  const book = await getBook(bookId);
  if (book && book.dailyGoal && before < book.dailyGoal && stats[day] >= book.dailyGoal) {
    bus.emit("goal:reached", { words: stats[day], goal: book.dailyGoal, book });
  }
}

export async function todayWords(bookId) {
  const stats = await db.getKV("stats:" + bookId, {});
  return Math.max(0, stats[todayKey()] || 0);
}

export async function getStats(bookId) { return db.getKV("stats:" + bookId, {}); }
