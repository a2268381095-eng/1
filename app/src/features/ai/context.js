// 调用 AI 时可以选着带上的内容：本章前文、前几章、本章要点、作品简介、人物信息。
// 带不带、带多少在确认卡里勾，按功能记住上一次的选择。人物信息由角色卡模块提供（命令 cards.list / cards.context），没有时不显示。
import { db } from "../../core/db.js";
import { commands } from "../../core/commands.js";
import { countWords } from "../../core/text.js";
import { ws } from "../editor/workspace.js";

export const BEFORE_SIZES = [500, 1000, 2000, 5000, -1];   // -1 = 本章前面全部
export const CTX_NONE = { before: false, beforeLen: 1000, prev: false, prevN: 1, prevMode: "summary", points: false, intro: false, people: [] };

export async function lastCtx(feature) { return { ...CTX_NONE, ...(await db.getKV("ai:ctx:" + feature, {})) }; }
export async function noteCtx(feature, ctx) { await db.setKV("ai:ctx:" + feature, ctx); }

/** 这次能带上什么：不在作品里时返回 null */
export async function ctxSource(opts) {
  if (!ws.book || (opts.bookId && opts.bookId !== ws.book.id)) return null;
  const id = ws.chapters.some((c) => c.id === opts.ref) ? opts.ref : ws.current && ws.current.id;
  const i = ws.chapters.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const ch = ws.chapters[i];
  const full = ws.textOf(id);
  // 选区（或光标）前面的文字算「前文」；对着别的章调用时整章都算
  let at = full.length;
  if (ws.current && ws.current.id === id && ws.editor && ws.editor.view) at = ws.editor.view.state.selection.main.from;
  // 「人物」这一排只列人物卡（设定库里还有地点、物品……）
  const people = commands.get("cards.list") ? ((await commands.run("cards.list", { bookId: ws.book.id })) || []).filter((c) => !c.kind || c.kind === "person") : null;
  return { id, ch, before: full.slice(0, at), prevList: ws.chapters.slice(Math.max(0, i - 5), i).reverse(), points: ch.points || [], intro: ws.book.intro || "", people };
}

/** 按勾选拼成要发出去的参考内容；同时给出每一块的字数，确认卡里显示 */
export async function ctxText(src, ctx) {
  if (!src) return { text: "", parts: [] };
  const parts = [];
  if (ctx.intro && src.intro.trim()) parts.push(["作品简介", src.intro.trim()]);
  if (ctx.prev && src.prevList.length) {
    const list = src.prevList.slice(0, ctx.prevN).reverse();
    const body = list.map((c) => {
      const s = ctx.prevMode === "summary" && (c.summary || "").trim() ? c.summary.trim() : ws.textOf(c.id);
      return `${ws.fullTitle(c)}\n${s}`;
    }).join("\n\n");
    parts.push([ctx.prevMode === "summary" ? `前 ${list.length} 章（有摘要的用摘要）` : `前 ${list.length} 章全文`, body]);
  }
  if (ctx.points && src.points.length) parts.push(["本章要点", src.points.map((p) => "- " + p.text).join("\n")]);
  if (ctx.before && src.before.trim()) {
    const b = ctx.beforeLen > 0 ? src.before.slice(-ctx.beforeLen) : src.before;
    parts.push(["本章前文", b]);
  }
  if (src.people && ctx.people && ctx.people.length) {
    const t = await commands.run("cards.context", { bookId: ws.book.id, ids: ctx.people, chapterId: src.id });
    if (t) parts.push(["人物信息", t]);
  }
  const text = parts.map(([k, v]) => `【${k}】\n${v}\n【/${k}】`).join("\n\n");
  return { text, parts: parts.map(([k, v]) => ({ name: k, words: countWords(v) })) };
}
