// AI 补全空着的设定：把这张卡写成「字段：内容」发出去（作者在确认卡里选自己的提示词），
// 回来的结果按字段拆开，一条一条「采用 / 不要」，采用一条算一步撤销；认不出的部分原样放着可以复制。
import { h, icon, toast } from "../../core/ui.js";
import { commands } from "../../core/commands.js";
import { ws } from "../editor/workspace.js";
import { runAI } from "../ai/runner.js";
import { cardText, parsePairs, isEmptyish, catOf, fieldByKey, valueOf } from "../../core/lore.js";
import { undoToast, flash } from "./bits.js";

const SYN = { look: ["外貌", "外观", "外形", "长相", "样貌", "容貌"], identity: ["身份", "职业"], personality: ["性格", "个性", "脾气"], notes: ["备注", "补充"] };
const norm = (s) => String(s || "").replace(/[\s（）()【】「」]/g, "");
const splitList = (v) => String(v).split(/[、，,；;\s]+/).map((x) => x.trim().replace(/[。.]$/, "")).filter(Boolean);

/** AI 的回答 → 建议 [{ key, label, cur, value, mode: fill 补上 / change 改成 / add 加上 }] 和认不出的 rest */
export function suggestionsFrom(text, card, meta) {
  const cat = catOf(meta, card);
  const person = cat.kind === "person";
  const { pairs, rest } = parsePairs(text);
  const out = [];
  const extra = [];
  const seen = new Set();
  for (const p of pairs) {
    const lab = norm(p.label);
    const value = p.value.trim();
    if (isEmptyish(value)) continue;
    let f = (cat.fields || []).find((x) => norm(x.name) === lab);
    if (!f) for (const [key, names] of Object.entries(SYN)) if (names.includes(lab)) { f = fieldByKey(cat, key); if (f) break; }
    if (f) {
      if (seen.has(f.id)) continue;
      const cur = String(valueOf(card, f)).trim();
      if (cur === value) continue;
      seen.add(f.id);
      out.push({ key: "f:" + f.id, label: f.name, cur, value, mode: cur ? "change" : "fill" });
      continue;
    }
    const listKey = lab === "别名" || lab === "又名" ? "aliases" : (lab === "辨识特征" || lab === "特征") && person ? "traits" : lab === "标签" ? "tags" : null;
    if (listKey) {
      const have = card[listKey] || [];
      const add = splitList(value).filter((x) => !have.includes(x));
      if (add.length && !seen.has(listKey)) { seen.add(listKey); out.push({ key: listKey, label: { aliases: "别名", traits: "辨识特征", tags: "标签" }[listKey], cur: have.join("、"), value: add.join("、"), mode: "add" }); }
      continue;
    }
    if ((lab === "定位" || lab === "角色定位") && person) {
      if (value !== (card.role || "") && !seen.has("role")) { seen.add("role"); out.push({ key: "role", label: "定位", cur: card.role || "", value: value.slice(0, 12), mode: card.role ? "change" : "fill" }); }
      continue;
    }
    // 名字、分类、阶梯这些不在这里改；其他认不出的放到下面，作者自己复制
    if (["名字", "分类", "所在地", "关联", "经历"].includes(lab) || meta.ladders.some((l) => norm(l.name) === lab) || /^服装/.test(lab)) continue;
    extra.push(`${p.label}：${value}`);
  }
  return { list: out, rest: [extra.join("\n"), rest].filter(Boolean).join("\n\n") };
}

/** 采用一条：写进卡（改的是传进来的这张卡的副本） */
export function adoptInto(c, s) {
  if (s.key.startsWith("f:")) { c.fields = c.fields || {}; c.fields[s.key.slice(2)] = s.value; return; }
  if (s.key === "role") { c.role = s.value; return; }
  const have = c[s.key] || [];
  c[s.key] = [...have, ...splitList(s.value).filter((x) => !have.includes(x))];
}

/** 点「AI 补全空着的设定」 */
export async function runFill(env, cardId) {
  const card = env.cards.find((c) => c.id === cardId);
  if (!card) return;
  const input = cardText(card, { meta: env.meta, cards: env.cards, idxOf: env.idxOf });
  const inBook = ws.book && ws.book.id === env.bookId && ws.current;
  const vars = inBook ? ws.varsFor() : { 书名: env.book ? env.book.title : "", 简介: env.book ? env.book.intro || "" : "" };
  const r = await runAI({
    feature: "cards", bookId: env.bookId, ref: cardId,
    input, inputLabel: "这张卡现在的内容", vars,
    title: `补全「${card.name || "未命名"}」`, maxTokens: 1200,
  });
  if (!r || !r.text) return;
  show(env, cardId, r.text, "AI 刚给的");
}

/** 暂存盒里以前的结果拿来补全 */
export function fromStash(env, cardId) {
  const card = env.cards.find((c) => c.id === cardId);
  if (!card) return;
  commands.run("stash.drawer", {
    feature: "cards", bookId: env.bookId, ref: cardId, title: card.name || "未命名",
    useLabel: "拿来补全",
    onUse: (row) => { if (row && row.text) show(env, cardId, row.text, "暂存盒里的"); },
  });
}

function show(env, cardId, text, from) {
  const card = env.cards.find((c) => c.id === cardId);
  if (!card) return;
  const s = suggestionsFrom(text, card, env.meta);
  env.aiFor.set(cardId, { ...s, from, text });
  env.redrawCard(cardId, "ai");
  if (!s.list.length && !s.rest) toast("这次的结果里没有能用的字段");
}

/** 卡上的建议框 */
export function suggestBox(env, cardId) {
  const got = env.aiFor.get(cardId);
  if (!got) return h("div.lr-ai", { hidden: true });
  const box = h("section.lr-ai", { "aria-label": "AI 的建议" });
  const close = h("button.icon-btn.lr-ai-x", { type: "button", "aria-label": "收起建议", title: "收起" }, icon("close"));
  close.addEventListener("click", () => { env.aiFor.delete(cardId); env.redrawCard(cardId, "ai"); });
  const left = got.list.filter((s) => !s.done);
  const head = h("div.lr-ai-head", {}, icon("sparkle"), h("b", {}, got.from + "建议"), h("span.muted", {}, left.length ? `${left.length} 条` : "都看过了"), h("span.spacer"));
  if (left.length > 1) {
    const all = h("button.btn.small.primary.lr-ai-all", { type: "button" }, "全部采用");
    all.addEventListener("click", () => adopt(env, cardId, left, box));
    head.append(all);
  }
  head.append(close);
  box.append(head);
  const list = h("ul.lr-ai-list");
  got.list.forEach((s) => {
    const li = h("li.lr-ai-item" + (s.done ? ".done" : ""), { "data-key": s.key },
      h("span.lr-ai-l", {}, s.label, h("em", {}, { fill: "补上", change: "改成", add: "加上" }[s.mode])),
      h("span.lr-ai-v", {}, s.value),
      s.cur && s.mode === "change" ? h("span.lr-ai-cur", {}, "现在是：" + s.cur) : null);
    if (s.done) li.append(h("span.lr-ai-st", {}, s.done === "yes" ? "已采用" : "不要了"));
    else {
      const yes = h("button.btn.small.primary.lr-ai-yes", { type: "button" }, "采用");
      const no = h("button.btn.small.ghost.lr-ai-no", { type: "button" }, "不要");
      yes.addEventListener("click", () => adopt(env, cardId, [s], li));
      no.addEventListener("click", () => { s.done = "no"; env.redrawCard(cardId, "ai"); });
      li.append(h("span.lr-ai-acts", {}, yes, no));
    }
    list.append(li);
  });
  if (got.list.length) box.append(list);
  if (got.rest) {
    const copy = h("button.btn.small.ghost", { type: "button" }, "复制");
    copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(got.rest); toast("已复制"); } catch (_) { toast("没能复制，可以手动选中复制"); } });
    box.append(h("div.lr-ai-rest", {}, h("div.lr-ai-rest-h", {}, h("span", {}, got.list.length ? "认不出放在哪的部分" : "认不出字段，原文在这里"), copy),
      h("pre.lr-ai-raw", {}, got.rest)));
  }
  return box;
}

async function adopt(env, cardId, items, el) {
  const card = env.cards.find((c) => c.id === cardId);
  if (!card) return;
  const label = items.length === 1 ? `采用 AI 补全：${items[0].label}` : `采用 AI 补全的 ${items.length} 条`;
  const e = await env.updateCard(cardId, label, (c) => items.forEach((s) => adoptInto(c, s)));
  items.forEach((s) => { s.done = "yes"; });
  env.redrawCard(cardId);
  undoToast(items.length === 1 ? `已采用「${items[0].label}」` : `已采用 ${items.length} 条`, e);
  setTimeout(() => items.forEach((s) => flash(env.root.querySelector(`.lr-row[data-key="${s.key}"]`))), 30);
}
