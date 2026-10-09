// 绘画：先做封面。就地打开的大弹窗（view.js）：书名、作者锁在提示词里 → 先出便宜的草稿 → 挑中的出高清 → 拖框裁成 600×800 → 设为封面（一步撤销）。
// 角色、地点、物品也用同一个界面（设定库调 paint.open），挑中的图交回给调用的模块。
// 命令：
//   paint.cover({ bookId?, title?, author?, intro?, cover?, onMeta?, onCover? })   封面制作（作品信息表单、写作界面顶栏、F1 都能打开）
//   paint.open({ bookId, purpose: "cover"|"character"|"place"|"item", cardId?, name?, prompt?, onDone? })  返回 Promise：用了的图（dataURL）或 null
// 事件：paint:done { purpose, bookId, cardId, dataUrl }（用上了一张图）
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { FEATURES } from "../../core/stash.js";
import { listBooks } from "../../core/store.js";
import { h, icon, choose, toast } from "../../core/ui.js";
import { ws } from "../editor/workspace.js";
import { openPaint } from "./view.js";
import { PURPOSES, purposeOf } from "./prompt.js";

/** 不在作品里时从 F1 打开封面制作：挑一本书 */
async function pickBook() {
  const books = (await listBooks()).slice(0, 5);
  if (!books.length) { toast("书架还是空的，先新建一本"); return null; }
  if (books.length === 1) return books[0].id;
  const id = await choose({ title: "给哪本书做封面？", body: "最近打开的几本：", buttons: [...books.map((b) => ({ id: b.id, label: "《" + b.title + "》" })), { id: "", label: "取消" }] });
  return id || null;
}

async function openCover(opts = {}) {
  const o = opts && typeof opts === "object" && !(opts instanceof Event) ? opts : {};
  const bookId = "bookId" in o ? o.bookId : ws.book ? ws.book.id : await pickBook();
  if (!bookId && !("bookId" in o)) return null;
  return openPaint({ ...o, purpose: "cover", bookId: bookId || null });
}

async function openAny(opts = {}) {
  const o = opts && typeof opts === "object" && !(opts instanceof Event) ? opts : {};
  const purpose = purposeOf(o.purpose || "character");
  if (purpose === "cover") return openCover(o);
  return openPaint({ ...o, purpose, bookId: o.bookId || (ws.book ? ws.book.id : null) });
}

/** 写作界面顶栏放一个「封面」入口（放在暂存盒、对话后面） */
function addTopbarButton() {
  const bar = document.querySelector(".ws .topbar");
  if (!bar || bar.querySelector('[data-cmd="paint.cover"]')) return;
  const b = h("button.tool-btn.paint-tb", { type: "button", title: "封面制作：先出草稿，挑中的出高清，裁成 600×800", "data-cmd": "paint.cover" }, icon("brush"), h("span.tb-t", {}, "封面"));
  b.addEventListener("click", () => commands.run("paint.cover"));
  const after = bar.querySelector('[data-cmd="chat.new"]') || bar.querySelector('[data-cmd="stash.drawer"]');
  if (after) after.after(b); else bar.querySelector(".spacer")?.after(b);
}

export async function register() {
  // 暂存盒里这一类叫「绘画」
  if (!FEATURES.paint) FEATURES.paint = "绘画";
  commands.register({
    id: "paint.cover",
    title: "封面制作",
    keywords: "封面 书封 画封面 绘画 画图 AI 出图 生成图片 作者 600x800 裁剪 草稿 高清",
    hint: "先出几张便宜的草稿，挑中的出高清，裁成 600×800",
    run: (opts) => openCover(opts),
  });
  commands.register({
    id: "paint.open",
    title: "绘画",
    keywords: "绘画 画图 AI 出图 角色形象 立绘 地点 场景 物品 插画",
    hint: "画角色、地点、物品的图",
    run: (opts) => openAny(opts),
  });
  bus.on("route", ({ name }) => { if (name === "book") addTopbarButton(); });

  // 自动测试用（测试用假接口打开时才有）
  try {
    if (localStorage.getItem("xemoMock") === "1") window.__xemoPaint = { open: (o) => commands.run("paint.open", o), purposes: Object.keys(PURPOSES) };
  } catch (_) { /* 没有 localStorage 就算了 */ }
}
