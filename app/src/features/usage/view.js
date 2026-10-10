// 用量与余额：能查余额的几家实时查；所有调用的本地记账按时间、作品、功能、模型统计。
// 花费按各模型自己填的单价算（美元、人民币分开记，不换算）；没填单价的只记 token，页面上会提醒去填。
import { h, icon, toast } from "../../core/ui.js";
import { nav } from "../../core/nav.js";
import { db } from "../../core/db.js";
import { listBooks } from "../../core/store.js";
import { FEATURES } from "../../core/stash.js";
import { usageRows, getConfig, getBalance, providerOf, allProviders } from "../../core/ai.js";

const DAY = 864e5;
const PERIODS = [["today", "今天"], ["7", "近 7 天"], ["30", "近 30 天"], ["all", "全部"]];
const CUR = { USD: "$", CNY: "¥" };
const money = (n, cur) => (CUR[cur] || cur + " ") + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K" : String(Math.round(n)));
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayName = (t) => { const d = new Date(t); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const ago = (t) => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? "刚刚查的" : m < 60 ? `${m} 分钟前查的` : m < 1440 ? `${Math.round(m / 60)} 小时前查的` : new Date(t).toLocaleDateString(); };

/** 一组记录的合计：次数、token、画了几张、各币种花费、没单价的次数 */
function sum(rows) {
  const t = { n: rows.length, input: 0, output: 0, images: 0, cost: {}, unpriced: 0 };
  for (const r of rows) {
    t.input += r.input || 0; t.output += r.output || 0; t.images += r.images || 0;
    if (r.cost != null && r.currency) t.cost[r.currency] = (t.cost[r.currency] || 0) + r.cost; else t.unpriced++;
  }
  return t;
}
const costText = (cost) => { const k = Object.keys(cost).filter((c) => cost[c] > 0); return k.length ? k.map((c) => money(cost[c], c)).join(" · ") : "—"; };

export function mountUsage(root, { bookId = null } = {}) {
  const st = { period: "30", bookId: bookId || "", metric: "tokens", table: false, rows: [], books: [], cfg: null };
  const balBox = h("section.au-bal", { "aria-label": "余额" });
  const seg = h("div.au-seg.look-seg", { role: "group", "aria-label": "时间" });
  const bookSel = h("select.select.au-book", { "aria-label": "作品" });
  const tiles = h("div.au-tiles");
  const chartBox = h("section.au-chart");
  const breakdown = h("div.au-break");
  const warn = h("p.au-warn", { hidden: true });
  const csv = h("button.tool-btn", { type: "button", title: "把记账导出成表格（CSV），能用 Excel 打开" }, icon("download"), h("span.tb-t", {}, "导出表格"));
  csv.addEventListener("click", exportCsv);
  root.replaceChildren(h("div.au-root", {},
    balBox,
    h("div.au-filters", {}, seg, bookSel, h("span.spacer"), csv),
    tiles, warn, chartBox, breakdown,
    h("p.au-note", {}, "记账只在这台电脑上，按每次调用返回的 token 数乘你填的单价算。和各家后台的账单可能差一点（缓存、四舍五入）。")));

  PERIODS.forEach(([id, name]) => {
    const b = h("button", { type: "button", "aria-pressed": String(id === st.period) }, name);
    b.addEventListener("click", () => { st.period = id; seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); paint(); });
    seg.append(b);
  });
  bookSel.addEventListener("change", () => { st.bookId = bookSel.value; paint(); });

  // ---------------- 余额 ----------------
  async function paintBalance(refresh = false) {
    const cfg = st.cfg = await getConfig();
    const cache = await db.getKV("ai:balance", {});
    const ready = allProviders().filter((p) => cfg.providers[p.id] && cfg.providers[p.id].key && cfg.providers[p.id].ok);
    if (!ready.length) { balBox.replaceChildren(h("p.au-bal-none", {}, "还没接入 AI。", linkTo("去接入", "/ai"))); return; }
    const rowFor = (p) => {
      const c = cfg.providers[p.id];
      const name = p.custom ? c.name || "自定义接口" : p.name;
      if (!p.balance) return h("div.au-bal-row.none", {}, h("b", {}, name), h("span.au-bal-v", {}, "查不到余额"), h("span.au-bal-t", {}, p.protocol === "anthropic" || p.protocol === "openai" ? "普通 Key 不给查，按本地记账看花了多少" : "这家没有余额接口，按本地记账看"));
      const b = cache[p.id];
      const btn = h("button.btn.small.ghost", { type: "button", title: "现在查一次" }, icon("refresh"), "刷新");
      const v = h("span.au-bal-v", {}, b ? money(b.amount, b.currency) : "—");
      const t = h("span.au-bal-t", {}, b ? ago(b.at) : "还没查过");
      const go = async () => {
        btn.disabled = true; t.textContent = "正在查……";
        try {
          const r = await getBalance(p.id, c);
          if (!r) { t.textContent = "这家没返回余额"; return; }
          const all = await db.getKV("ai:balance", {});
          all[p.id] = { ...r, at: Date.now() };
          await db.setKV("ai:balance", all);
          v.textContent = money(r.amount, r.currency); t.textContent = "刚刚查的";
          v.classList.remove("flash"); void v.offsetWidth; v.classList.add("flash");
        } catch (e) { t.textContent = "没查到：" + ((e && (e.what || e.message)) || e); }
        finally { btn.disabled = false; }
      };
      btn.addEventListener("click", go);
      if (refresh && (!b || Date.now() - b.at > 10 * 6e4)) setTimeout(go, 0);
      return h("div.au-bal-row", { "data-provider": p.id }, h("b", {}, name), v, t, btn);
    };
    balBox.replaceChildren(h("h3.au-h", {}, "余额"), ...ready.map(rowFor));
  }
  const linkTo = (text, path) => { const a = h("button.au-link", { type: "button" }, text); a.addEventListener("click", () => nav.go(path)); return a; };

  // ---------------- 统计 ----------------
  function picked() {
    const now = Date.now();
    const from = st.period === "today" ? dayStart(now) : st.period === "all" ? 0 : dayStart(now) - (Number(st.period) - 1) * DAY;
    return st.rows.filter((r) => r.at >= from && (!st.bookId || r.bookId === st.bookId));
  }
  function paint() {
    const rows = picked();
    const t = sum(rows);
    const tile = (k, v, sub, hero) => h("div.au-tile" + (hero ? ".hero" : ""), {}, h("span.au-tile-k", {}, k), h("b.au-tile-v", {}, v), sub ? h("span.au-tile-s", {}, sub) : null);
    tiles.replaceChildren(...[
      tile("花了", costText(t.cost), t.unpriced ? `另有 ${t.unpriced} 次没填单价` : null, true),
      tile("调用", t.n.toLocaleString() + " 次"),
      tile("发出去（输入）", compact(t.input) + " token"),
      tile("收回来（输出）", compact(t.output) + " token"),
      t.images ? tile("画图", t.images + " 张") : null,
    ].filter(Boolean));
    warn.hidden = !t.unpriced;
    if (t.unpriced) warn.replaceChildren(`有 ${t.unpriced} 次调用的模型没填单价，花费没算进去。`, linkTo("去填单价", "/ai"));
    paintChart(rows);
    paintBreak(rows);
  }

  // 按天的柱子（今天按小时，跨度太长按月）。一个量一张图，不叠两个刻度
  function buckets(rows) {
    const now = Date.now();
    if (st.period === "today") {
      const base = dayStart(now);
      return Array.from({ length: 24 }, (_, i) => ({ from: base + i * 36e5, to: base + (i + 1) * 36e5, label: i + " 点", short: i % 6 === 0 ? i + "点" : "" }));
    }
    let days = st.period === "all" ? Math.max(1, Math.ceil((dayStart(now) - dayStart(Math.min(now, ...rows.map((r) => r.at)))) / DAY) + 1) : Number(st.period);
    if (st.period === "all" && days > 62) {
      const first = new Date(Math.min(...rows.map((r) => r.at)));
      const out = [];
      for (let d = new Date(first.getFullYear(), first.getMonth(), 1); d.getTime() <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
        const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        out.push({ from: d.getTime(), to: next.getTime(), label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`, short: `${d.getMonth() + 1}月` });
      }
      return out;
    }
    days = Math.min(days, 62);
    const start = dayStart(now) - (days - 1) * DAY;
    const every = days > 14 ? 7 : 1;
    return Array.from({ length: days }, (_, i) => ({ from: start + i * DAY, to: start + (i + 1) * DAY, label: dayName(start + i * DAY), short: (days - 1 - i) % every === 0 ? dayName(start + i * DAY).replace(/ /g, "") : "" }));
  }
  function paintChart(rows) {
    const curs = [...new Set(rows.filter((r) => r.cost != null && r.currency).map((r) => r.currency))];
    const metrics = [["tokens", "token"], ["calls", "次数"], ...curs.map((c) => ["cost:" + c, "花费（" + (c === "CNY" ? "人民币" : c === "USD" ? "美元" : c) + "）"])];
    if (!metrics.some((m) => m[0] === st.metric)) st.metric = "tokens";
    const valueOf = (rs) => st.metric === "tokens" ? rs.reduce((t, r) => t + (r.input || 0) + (r.output || 0), 0)
      : st.metric === "calls" ? rs.length : rs.filter((r) => r.currency === st.metric.slice(5)).reduce((t, r) => t + (r.cost || 0), 0);
    const fmt = (v) => st.metric === "tokens" ? compact(v) + " token" : st.metric === "calls" ? v + " 次" : money(v, st.metric.slice(5));
    const bs = buckets(rows).map((b) => { const rs = rows.filter((r) => r.at >= b.from && r.at < b.to); return { ...b, rs, v: valueOf(rs) }; });
    const max = Math.max(0, ...bs.map((b) => b.v));
    // 纵轴刻度取整：1 / 2 / 5 × 10ⁿ
    const step = (() => { if (!max) return 1; const raw = max / 3, p = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw); })();
    const top = Math.max(step, Math.ceil(max / step) * step);
    const ticks = [0, 1, 2, 3].map((i) => i * step).filter((x) => x <= top + 1e-9);
    const mseg = h("div.au-mseg.look-seg", { role: "group", "aria-label": "看哪个量" }, ...metrics.map(([id, name]) => {
      const b = h("button", { type: "button", "aria-pressed": String(id === st.metric) }, name);
      b.addEventListener("click", () => { st.metric = id; paintChart(rows); });
      return b;
    }));
    const tableB = h("button.btn.small.ghost", { type: "button", "aria-pressed": String(st.table) }, st.table ? "看图" : "看表格");
    tableB.addEventListener("click", () => { st.table = !st.table; paintChart(rows); });
    const title = (st.period === "today" ? "今天每小时" : st.period === "all" && bs.length && bs[0].label.includes("年") ? "每月" : "每天") + "的" + ((n) => (/^[a-z]/i.test(n) ? " " + n : n))(metrics.find((m) => m[0] === st.metric)[1]);
    if (st.table) {
      chartBox.replaceChildren(h("div.au-chart-head", {}, h("h3.au-h", {}, title), mseg, tableB),
        h("table.au-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "时间"), h("th", {}, "次数"), h("th", {}, "token"), h("th", {}, "花费"))),
          h("tbody", {}, ...bs.filter((b) => b.rs.length).reverse().map((b) => { const t = sum(b.rs); return h("tr", {}, h("td", {}, b.label), h("td.num", {}, String(t.n)), h("td.num", {}, compact(t.input + t.output)), h("td.num", {}, costText(t.cost))); }))));
      return;
    }
    const tip = h("div.au-tip", { role: "status", hidden: true });
    const plot = h("div.au-plot", { style: `--n:${bs.length}` },
      h("div.au-grid", { "aria-hidden": "true" }, ...ticks.map((v) => h("div.au-gl", { style: `bottom:${(v / top) * 100}%` }, h("span", {}, st.metric === "tokens" ? compact(v) : st.metric === "calls" ? String(v) : (CUR[st.metric.slice(5)] || "") + (v < 1 && v > 0 ? v.toFixed(2) : compact(v)))))),
      h("div.au-bars", {}, ...bs.map((b, i) => {
        const col = h("button.au-col", { type: "button", "aria-label": `${b.label}：${fmt(b.v)}，${b.rs.length} 次调用`, "data-i": String(i) },
          h("span.au-bar", { style: `height:${top ? (b.v / top) * 100 : 0}%` + (b.v ? "" : ";min-height:0") }));
        const show = () => {
          const t = sum(b.rs);
          tip.replaceChildren(h("b", {}, b.label), h("span", {}, fmt(b.v)), h("span", {}, `${t.n} 次 · ${compact(t.input + t.output)} token · ${costText(t.cost)}`));
          tip.hidden = false;
          const r = col.getBoundingClientRect(), pr = plot.getBoundingClientRect();
          tip.style.left = Math.max(0, Math.min(r.left - pr.left + r.width / 2 - tip.offsetWidth / 2, pr.width - tip.offsetWidth)) + "px";
          col.classList.add("on");
        };
        const hide = () => { tip.hidden = true; col.classList.remove("on"); };
        col.addEventListener("mouseenter", show); col.addEventListener("focus", show);
        col.addEventListener("mouseleave", hide); col.addEventListener("blur", hide);
        return col;
      })),
      h("div.au-x", { "aria-hidden": "true" }, ...bs.map((b) => h("span", {}, b.short))),
      tip);
    chartBox.replaceChildren(h("div.au-chart-head", {}, h("h3.au-h", {}, title), mseg, tableB), rows.length ? plot : h("p.au-empty", {}, "这段时间没有调用 AI。"));
  }

  function paintBreak(rows) {
    const group = (keyOf, nameOf) => {
      const m = new Map();
      for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return [...m.entries()].map(([k, rs]) => ({ k, name: nameOf(k), t: sum(rs) })).sort((a, b) => (b.t.input + b.t.output) - (a.t.input + a.t.output) || b.t.n - a.t.n);
    };
    const bookName = (id) => { if (!id) return "不在作品里（对话、设置页）"; const b = st.books.find((x) => x.id === id); return b ? "《" + b.title + "》" : "已删除的作品"; };
    const featName = (id) => FEATURES[id] || id || "其他";
    const modelName = (k) => { const [pid, model] = k.split("\u0001"); const p = providerOf(pid); const c = st.cfg && st.cfg.providers[pid]; return (p ? (p.custom ? (c && c.name) || "自定义接口" : p.name) : pid) + " · " + model; };
    const table = (title, list) => {
      const maxT = Math.max(1, ...list.map((x) => x.t.input + x.t.output));
      return h("section.au-sec", {}, h("h3.au-h", {}, title),
        list.length ? h("table.au-table", {}, h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "次数"), h("th", {}, "token"), h("th", {}, "花费"))),
          h("tbody", {}, ...list.slice(0, 12).map((x) => h("tr", {},
            h("td", {}, h("span.au-name", {}, x.name), h("span.au-meter", { "aria-hidden": "true" }, h("i", { style: `width:${((x.t.input + x.t.output) / maxT) * 100}%` }))),
            h("td.num", {}, String(x.t.n)), h("td.num", {}, compact(x.t.input + x.t.output)), h("td.num", {}, costText(x.t.cost) + (x.t.unpriced ? " *" : "")))))) : h("p.au-empty", {}, "没有记录"));
    };
    breakdown.replaceChildren(...[
      st.bookId ? null : table("按作品", group((r) => r.bookId || "", bookName)),
      table("按功能", group((r) => r.feature || "other", featName)),
      table("按模型", group((r) => r.providerId + "\u0001" + r.model, modelName))].filter(Boolean));
  }

  async function exportCsv() {
    const rows = picked();
    if (!rows.length) { toast("这段时间没有记录"); return; }
    const esc = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    const head = ["时间", "作品", "功能", "提供商", "模型", "输入 token", "输出 token", "画图张数", "花费", "币种"];
    const lines = [head.map(esc).join(",")].concat(rows.sort((a, b) => a.at - b.at).map((r) => {
      const b = st.books.find((x) => x.id === r.bookId);
      return [new Date(r.at).toLocaleString(), b ? b.title : "", FEATURES[r.feature] || r.feature || "", (providerOf(r.providerId) || {}).name || r.providerId, r.model, r.input || 0, r.output || 0, r.images || 0, r.cost == null ? "" : r.cost, r.currency || ""].map(esc).join(",");
    }));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `小恶魔文书-AI用量-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a); a.click(); a.remove();
    toast(`导出了 ${rows.length} 条记录`);
  }

  async function load() {
    const [rows, books] = await Promise.all([usageRows(), listBooks()]);
    st.rows = rows; st.books = books;
    const used = new Set(rows.map((r) => r.bookId).filter(Boolean));
    bookSel.replaceChildren(h("option", { value: "" }, "全部作品"), ...books.filter((b) => used.has(b.id) || b.id === st.bookId).map((b) => h("option", { value: b.id, selected: b.id === st.bookId }, "《" + b.title + "》")));
    paint();
  }
  const ready = Promise.all([paintBalance(true), load()]);
  return { ready, refresh: () => load() };
}
