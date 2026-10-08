// 各功能模块在这里登记。每个模块 export 一个 register()，启动时调用。
// 还没做完的功能先放占位：点了会说明「这个还在做」，不会什么反应都没有。
import { nav } from "../core/nav.js";
import { commands } from "../core/commands.js";
import { h, icon, toast } from "../core/ui.js";
import { label } from "../core/settings.js";
import { ws } from "./editor/workspace.js";

const PENDING = [
  ["search.open", "查找替换", "找字 替换 搜索", "Mod-f"],
  ["format.open", "一键排版", "排版 缩进 标点 空行", "Mod-Shift-l"],
  ["versions.open", "本章历史版本", "版本 回溯 恢复 以前"],
  ["io.import", "导入作品", "导入 txt docx md"],
  ["io.export", "导出", "导出 txt 下载"],
];

function stubView(title) {
  return () => {
    const back = h("button.icon-btn", { type: "button", "aria-label": "返回", onclick: () => nav.back() }, icon("back"));
    document.getElementById("app").replaceChildren(h("div.view", {},
      h("header.topbar", {}, back, h("span.title", {}, title)),
      h("div.empty", {}, title + "还在做，下一版就有。")));
  };
}

export async function registerFeatures() {
  const mods = [];
  // 功能模块按需加在这里：mods.push(import("./search/search.js")) ……
  for (const m of await Promise.all(mods)) if (m && m.register) await m.register();

  for (const [id, title, keywords, key] of PENDING) {
    if (commands.get(id)) continue;
    commands.register({ id, title, keywords, key, hint: "还在做", run: () => toast(title + "还在做，下一版就有。") });
  }
  if (!nav.has || !nav.has("settings")) nav.route("settings", "/settings", stubView(label("设置")));
  if (!nav.has || !nav.has("trash")) nav.route("trash", "/trash/:bookId?", stubView(label("回收站")));
  commands.register({ id: "nav.settings", title: label("设置"), keywords: "设置 字体 主题 深色 字号", run: () => nav.go("/settings") });
  commands.register({ id: "nav.trash", title: label("回收站"), keywords: "回收站 删除 找回 恢复", run: () => nav.go(ws.book ? "/trash/" + ws.book.id : "/trash") });
}
