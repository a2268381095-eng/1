// 回收站的纯函数：剩几天、第几章、条目怎么显示。不碰数据库和界面，node 里能直接测。
import { chapterLabel, countWords } from "../../core/text.js";

export const DAY = 86400000;
export const KEEP_DAYS = 30;

export const KIND_LABEL = { book: "作品", chapter: "章节", setting: "设定", image: "图片" };
export const kindLabel = (kind) => KIND_LABEL[kind] || "其他";

/** 离自动清理还剩几天（向上取整；0 或负数表示已经到期，下次打开软件时清掉） */
export function daysLeft(deletedAt, now = Date.now(), keep = KEEP_DAYS) {
  return Math.ceil((deletedAt + keep * DAY - now) / DAY);
}

export function leftText(deletedAt, now = Date.now(), keep = KEEP_DAYS) {
  const d = daysLeft(deletedAt, now, keep);
  if (d <= 0) return "已到期，下次打开软件时清理";
  if (d === 1) return "还剩不到 1 天";
  return `还剩 ${d} 天`;
}

/** 快到期（3 天内）的标一下颜色 */
export const isSoon = (deletedAt, now = Date.now(), keep = KEEP_DAYS) => daysLeft(deletedAt, now, keep) <= 3;

/**
 * 删掉的这一章原来是第几章（大概）：同一本书里排在它前面的章数 + 1。
 * siblings 是这本书现在的章节（或者作品也删了时，作品删除那一刻的章节）。
 */
export function positionOf(chapter, siblings = []) {
  if (!siblings.length) return Math.max(1, Math.round(chapter.order) || 1);
  return siblings.filter((c) => c.id !== chapter.id && c.order < chapter.order).length + 1;
}

/** 正文开头一小段，空白压成一个空格 */
export function excerpt(text, n = 60) {
  const s = String(text || "").replace(/[\s　]+/g, " ").trim();
  return [...s].length > n ? [...s].slice(0, n).join("") + "…" : s;
}

const wordsOf = (c) => (c && (c.words != null ? c.words : countWords(c.content || ""))) || 0;

/**
 * 一条回收站条目怎么显示。
 * books：bookId → { book, live, chapters }（live = 书架上还在；chapters 用来算第几章）
 * 返回 { kind, kindText, title, sub, bookTitle, bookState, words, chapters, excerpt, bookId, chapterId }
 *   bookState：live 书架上还在 / trashed 也在回收站里 / gone 已经彻底删除
 */
export function describe(entry, books = {}) {
  const info = { kind: entry.kind, kindText: kindLabel(entry.kind), bookId: entry.bookId, words: 0, chapters: 0, excerpt: "" };
  const ctx = books[entry.bookId];
  if (entry.kind === "book") {
    const { book = {}, chapters = [] } = entry.data || {};
    info.title = "《" + (book.title || entry.title || "未命名作品") + "》";
    info.bookTitle = book.title || entry.title || "未命名作品";
    info.bookState = "trashed";
    info.chapters = chapters.length;
    info.words = chapters.reduce((s, c) => s + wordsOf(c), 0);
    info.excerpt = excerpt(book.intro) || (chapters[0] ? excerpt(chapters[0].content) : "");
    return info;
  }
  if (entry.kind === "chapter") {
    const ch = (entry.data && entry.data.chapter) || {};
    const no = chapterLabel(positionOf(ch, ctx ? ctx.chapters : []), ctx && ctx.book ? ctx.book.numbering : "zh");
    const name = ch.title || entry.title || "";
    info.chapterId = ch.id;
    info.title = no + (name ? " " + name : "");
    info.sub = name ? "" : "没有章名";
    info.bookTitle = ctx && ctx.book ? ctx.book.title : "";
    info.bookState = !ctx || !ctx.book ? "gone" : ctx.live ? "live" : "trashed";
    info.words = wordsOf(ch);
    info.excerpt = excerpt(ch.content);
    return info;
  }
  info.title = entry.title || "（没有名字）";
  const ctxBook = ctx && ctx.book;
  info.bookTitle = ctxBook ? ctxBook.title : "";
  info.bookState = !ctxBook ? "gone" : ctx.live ? "live" : "trashed";
  return info;
}

/** 按类型筛：all / book / chapter / … */
export function filterKind(list, kind) {
  return !kind || kind === "all" ? list : list.filter((t) => t.kind === kind);
}

/** 列表里出现了哪几种类型（按固定顺序），只有一种时不用显示筛选 */
export function kindsIn(list) {
  const order = ["book", "chapter", "setting", "image"];
  const seen = new Set(list.map((t) => t.kind));
  return [...order.filter((k) => seen.has(k)), ...[...seen].filter((k) => !order.includes(k))];
}

/** 恢复一章之前看它能不能直接放回去：ok 可以；book-trashed 作品也在回收站；book-gone 作品已经彻底删除 */
export function restoreBlock(entry, books = {}) {
  if (entry.kind !== "chapter") return "ok";
  const ctx = books[entry.bookId];
  if (ctx && ctx.live) return "ok";
  return ctx && ctx.book ? "book-trashed" : "book-gone";
}
