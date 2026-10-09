// chapterai：AI 起章名（章名下面就地出候选）、AI 写章节摘要（单章 / 几章一起）、AI 生成作品简介（几版并排挑）。
// 都走 runAI（确认卡 → 发送 → 记账 → 进暂存盒），起章名和摘要是 simple 的活，默认用作者绑定的便宜模型。
// 命令：chapter.nameAI、chapter.summaryAI({ ids? })、chapter.summaryAIBatch({ ids? })、book.introAI({ ids? })。完成后发 chapterai:done { kind }。
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { h } from "../../core/ui.js";
import { ws } from "../editor/workspace.js";
import { nameAI, wireNames } from "./names.js";
import { summaryAI } from "./summary.js";
import { introAI } from "./intro.js";

const inBook = () => !!ws.book;

export async function register() {
  wireNames();
  // 章节列表多选时，多选条上的两个按钮
  ws.addSelAction("AI 写摘要", (ids) => commands.run("chapter.summaryAI", { ids }), "确认一次，逐章写摘要");
  ws.addSelAction("AI 简介", (ids) => commands.run("book.introAI", { ids }), "用这几章写作品简介");

  commands.register({
    id: "chapter.nameAI", title: "AI 起章名", keywords: "章名 起名 取名 标题 候选 想不出名字 AI",
    hint: "读本章正文出几个章名，挑一个换上", when: () => inBook() && !!ws.current, run: () => nameAI(),
  });
  commands.register({
    id: "chapter.summaryAI", title: "AI 写本章摘要", keywords: "摘要 总结 概括 前情提要 省 token 前一章摘要 AI",
    hint: "写进本章摘要，以后能反复用；多选了几章就逐章写", when: inBook, run: (opts) => summaryAI(opts || {}),
  });
  commands.register({
    id: "chapter.summaryAIBatch", title: "AI 给几章一起写摘要", keywords: "批量 摘要 多章 一起 逐章 总结 AI",
    hint: "就地勾几章，确认一次，逐章写", when: inBook, run: (opts) => summaryAI({ ...(opts || {}), batch: true }),
  });
  commands.register({
    id: "book.introAI", title: "AI 生成简介", keywords: "简介 作品简介 文案 介绍 书介 宣传 AI",
    hint: "用几章的摘要或开头写简介，可以一次出几版", when: inBook, run: (opts) => introAI(opts || {}),
  });
}
