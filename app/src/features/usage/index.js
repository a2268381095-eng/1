// 用量与余额：整页 #/usage（AI 接入页顶栏、F1 都能进）。写作界面状态栏右边有一颗小胶囊：上次用的模型 · 思考档位 · 今天花了多少，点一下进用量页。
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { commands } from "../../core/commands.js";
import { h, icon } from "../../core/ui.js";
import { db } from "../../core/db.js";
import { usageRows, THINKING } from "../../core/ai.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { mountUsage } from "./view.js";

function renderPage(params) {
  const back = h("button.icon-btn", { type: "button", title: "返回（Alt+←）", "aria-label": "返回" }, icon("back"));
  back.addEventListener("click", () => nav.back());
  const main = h("main.au-page-main");
  document.getElementById("app").replaceChildren(h("div.view.au-page", {},
    h("header.topbar", {}, back, h("span.title", {}, "用量与余额"), h("span.spacer"),
      h("button.tool-btn", { type: "button", onclick: () => nav.go("/ai") }, icon("gear"), h("span.tb-t", {}, "接入和单价"))),
    main));
  mountUsage(main, { bookId: params.bookId || null });
  tip("usage", "能查余额的几家我帮你实时查；别的按本地记账算，每次调用的 token 乘你填的单价。");
}

// ---------------- 状态栏胶囊 ----------------
let pill = null;
async function updatePill() {
  const bar = document.querySelector(".ws .statusbar");
  if (!bar || !ws.book) return;
  if (!pill || !pill.isConnected) {
    pill = h("button.au-pill", { type: "button", title: "上次用的模型和思考档位，今天花了多少。点一下看用量和余额" });
    pill.addEventListener("click", () => nav.go("/usage"));
    const save = bar.lastElementChild;
    bar.insertBefore(pill, save || null);
  }
  const last = await db.getKV("ai:last", null);
  if (!last) { pill.hidden = true; return; }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = (await usageRows()).filter((r) => r.at >= today.getTime());
  const cost = {};
  rows.forEach((r) => { if (r.cost != null && r.currency) cost[r.currency] = (cost[r.currency] || 0) + r.cost; });
  const money = Object.entries(cost).filter(([, v]) => v > 0).map(([c, v]) => (c === "CNY" ? "¥" : c === "USD" ? "$" : c + " ") + v.toFixed(2)).join(" ");
  const model = String(last.model || "");
  pill.hidden = false;
  pill.replaceChildren(h("i.au-pill-dot", { "aria-hidden": "true" }), h("span.au-pill-m", { title: model }, model.length > 18 ? model.slice(0, 17) + "…" : model),
    last.thinking ? h("span.au-pill-t", {}, "思考" + (THINKING[last.thinking] || {}).name) : null,
    rows.length ? h("span.au-pill-c", {}, "今天 " + (money || rows.length + " 次")) : null);
}

export async function register() {
  nav.route("usage", "/usage/:bookId?", (params) => renderPage(params));
  commands.register({ id: "usage.open", title: "用量与余额", keywords: "用量 花费 花了多少 token 余额 账单 记账 钱 费用 成本", hint: "按天、作品、功能看 AI 花了多少，能查的余额实时查", run: () => nav.go("/usage") });
  bus.on("chapter:opened", () => updatePill());
  bus.on("ai:usage", () => updatePill());
  bus.on("ai:done", () => setTimeout(updatePill, 50));
}
