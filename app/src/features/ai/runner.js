// 调用 AI 的统一入口：确认卡 → 发送（流式）→ 记账 → 进暂存盒；出错给中文说明和能直接点的解决办法。
// AI 永远不替作者做决定：每次调用前显示模型、提示词、发送内容、预估 token 和费用，确认才发送。
// 每个功能记住最近用过的组合排在最前；可以设「同一组合本次会话内不再询问」。
import { getConfig, saveConfig, readyProviders, providerOf, chat, estimateTokens, costOf, record, thinkingExtra, unsupportedParams, CREATIVITY, THINKING } from "../../core/ai.js";
import { listPrompts, savePrompt, fillPrompt, notePromptUse } from "../../core/prompts.js";
import { addStash, FEATURES } from "../../core/stash.js";
import { db } from "../../core/db.js";
import { bus } from "../../core/bus.js";
import { h, icon, modal, notice, toast } from "../../core/ui.js";
import { commands } from "../../core/commands.js";
import { setupModal, renderSetup } from "./setup.js";
import { levelPicker } from "./levels.js";
import { listSamples, noteSampleUse, sampleBlock } from "../../core/samples.js";
import { samplesModal } from "./samples.js";
import { ctxSource, ctxText, lastCtx, noteCtx, BEFORE_SIZES, CTX_NONE } from "./context.js";

const skipThisSession = new Set();   // "功能|提供商|模型|提示词" 本次会话不再询问

/**
 * opts:
 *   feature       功能 id（暂存盒分类用，见 core/stash.js 的 FEATURES）
 *   bookId, ref   属于哪本书、哪一章 / 哪张卡（暂存盒就地筛选用）
 *   input         主要的发送内容（比如选中的文字）；提示词里没写 {选中文本} 时自动附在后面
 *   inputLabel    发送内容的说明，比如「选中的文字」
 *   vars          其他变量的值 { 本章要点: "...", 前一章摘要: "..." }
 *   maxTokens     默认输出上限
 *   onDelta(piece, text)   流式回调
 *   signal        AbortSignal
 *   title         暂存盒里这条的标题
 *   promptId      预先选好的提示词（比如从选中工具栏点的那一条）
 *   history       之前的对话 [{ role: "user"|"assistant", content }]（继续追问时带上）
 *   count         一次出几个版本（确认一次，连着发 count 次）
 *   simple        简单的活（起章名、写摘要）：作者绑定了便宜模型时默认用它
 *   reuse         上一次的选择（choice），给了就不再弹确认卡（「再出一版」用）
 *   prefer        确认卡先选好的组合 { providerId, model, creativity, thinking }（比如对话面板上选的），作者还能改
 *   temp          true：确认卡直接打开「临时写一个」，也不走「本次不再询问」
 *   raw           true：没写提示词时把 input 原样当作这句话发出去（对话用）
 *   ctx           「带上」区先勾哪些（{ before, prev, points, intro, people… }）；有 history 时默认什么都不带
 * 返回 { text, usage, stash, choice, results }（count > 1 时 results 是每一版）；取消或失败返回 null
 */
export async function runAI(opts) {
  if (!(await readyProviders()).length) {
    const id = await setupModal();
    if (!id) return null;
  }
  let choice = opts.reuse || await confirmCard(opts);
  const count = Math.max(1, Math.min(6, opts.count || 1));
  const results = [];
  while (choice && results.length < count) {
    const r = await send({ ...opts, title: count > 1 ? `${opts.title || ""}（第 ${results.length + 1} 版）` : opts.title }, choice);
    if (r && r.retry) { choice = r.retry === "card" ? await confirmCard({ ...opts, ...(r.patch || {}) }, choice) : choice; if (r.patch) opts = { ...opts, ...r.patch }; continue; }
    if (!r) break;
    results.push(r);
  }
  if (!results.length) return null;
  return { ...results[results.length - 1], results };
}

function comboKey(feature, c) { return [feature, c.providerId, c.model, c.promptId || "temp", c.creativity || 0, c.thinking || 0].join("|"); }
const modelKey = (providerId, model) => providerId + "\u0001" + model;

// 每个功能用过的组合：记次数和最后一次的时间。确认卡默认选上一次，「常用组合」按次数排
async function recentOf(feature) { return db.getKV("ai:recent:" + feature, []); }
async function noteRecent(feature, c) {
  const list = await recentOf(feature);
  const old = list.find((x) => comboKey(feature, x) === comboKey(feature, c));
  const row = { providerId: c.providerId, model: c.model, promptId: c.promptId || null, maxTokens: c.maxTokens,
    creativity: c.creativity || 0, thinking: c.thinking || 0, n: ((old && old.n) || 1) + (old ? 1 : 0), at: Date.now() };
  const rest = list.filter((x) => x !== old);
  // 留次数多的和最近用的，最多 12 组
  const keep = [row, ...rest].sort((a, b) => (b.n || 1) - (a.n || 1) || (b.at || 0) - (a.at || 0)).slice(0, 12);
  await db.setKV("ai:recent:" + feature, keep);
  await db.setKV("ai:last", { providerId: c.providerId, model: c.model, creativity: c.creativity || 0, thinking: c.thinking || 0 });
  const uses = await db.getKV("ai:modelUses", {});
  uses[modelKey(c.providerId, c.model)] = (uses[modelKey(c.providerId, c.model)] || 0) + 1;
  await db.setKV("ai:modelUses", uses);
}
const lastOf = (list) => list.reduce((a, b) => ((b.at || 0) > ((a && a.at) || 0) ? b : a), null);

const promptLabel = (p) => (p.group ? p.group + " / " : "") + p.name + (p.uses ? `　· 用过 ${p.uses} 次` : "");

/** 把提示词和发送内容拼成最终要发的话 */
function compose(promptText, opts, sampleText = "", context = "") {
  const vars = { ...(opts.vars || {}), 选中文本: opts.input || (opts.vars || {}).选中文本 || "" };
  // 对话这类：没写提示词时，作者说的话原样发出去，不包成【原文】
  if (opts.raw && !String(promptText || "").trim()) {
    const parts = [context, sampleText ? sampleBlock(sampleText) : "", opts.input || ""].filter(Boolean);
    return { text: parts.join("\n\n"), missing: [], autoAttach: false };
  }
  const f = fillPrompt(promptText, vars);
  let text = context ? context + "\n\n" + f.text : f.text;
  // 提示词里已经用变量放进了同样的内容（比如 {本章正文}），就不再附一遍
  const autoAttach = opts.input && !f.used.includes("选中文本") && !f.used.some((n) => vars[n] === opts.input);
  if (sampleText) text += "\n\n" + sampleBlock(sampleText);
  if (autoAttach) text += `\n\n【原文】\n${opts.input}\n【/原文】`;
  return { text, missing: f.missing.filter((m) => m !== "选中文本" || !opts.input), autoAttach };
}

// ---------------- 确认卡 ----------------
async function confirmCard(opts, prev = null) {
  const cfg = await getConfig();
  const ready = await readyProviders();
  const prompts = await listPrompts();
  const recent = (await recentOf(opts.feature)).filter((r) => ready.some((p) => p.id === r.providerId));
  const cheap = opts.simple && cfg.cheap && ready.some((p) => p.id === cfg.cheap.providerId) ? cfg.cheap : null;
  const uses = await db.getKV("ai:modelUses", {});
  const globalLast = await db.getKV("ai:last", null);
  const last = lastOf(recent);
  const usable = (c) => c && ready.some((p) => p.id === c.providerId);
  // 默认：这个功能上一次的组合 → 任何功能上一次用的模型 → 便宜模型 / 第一家
  let start = prev || last || { providerId: (cheap || {}).providerId || ready[0].id, model: (cheap || {}).model || cfg.providers[ready[0].id].testModel,
    promptId: prompts[0] ? prompts[0].id : null, maxTokens: opts.maxTokens || 1200, creativity: 0, thinking: 0 };
  if (!prev && !last && !cheap && usable(globalLast)) start = { ...start, ...globalLast };
  if (!prev && usable(opts.prefer)) start = { ...start, ...opts.prefer };
  if (!prev && opts.promptId) start = { ...start, promptId: opts.promptId === "__temp" ? null : opts.promptId };
  if (!prev && opts.temp) start = { ...start, promptId: null };
  if (!prev && !recent.length && cheap) start = { ...start, providerId: cheap.providerId, model: cheap.model };
  if (!prev && !opts.promptId && !opts.temp && last && skipThisSession.has(comboKey(opts.feature, last))) {
    const p = prompts.find((x) => x.id === last.promptId);
    if (p) return { ...last, promptText: p.text };
  }

  const samples = await listSamples();
  const src = await ctxSource(opts);
  // 继续追问时前面已经带过了，默认不再带；opts.ctx 可以直接指定
  const ctx = { ...(prev && prev.ctx ? prev.ctx : opts.ctx ? { ...CTX_NONE, ...opts.ctx } : (opts.history || []).length ? CTX_NONE : await lastCtx(opts.feature)) };
  ctx.people = [...(ctx.people || [])];
  return new Promise((resolve) => {
    let result = null;
    // 模型
    // 模型：用得多的那家排前面，每家里用得多的模型排前面
    const modelSel = h("select.select", { "aria-label": "模型" });
    const idOf = (m) => (typeof m === "string" ? m : m.id);
    const groups = ready.map((p) => {
      const c = cfg.providers[p.id];
      const models = (c.models || []).map(idOf).map((id, i) => ({ id, i, n: uses[modelKey(p.id, id)] || 0 })).sort((a, b) => b.n - a.n || a.i - b.i);
      return { p, c, models, n: models.reduce((t, m) => t + m.n, 0) };
    }).sort((a, b) => b.n - a.n);
    groups.forEach(({ p, c, models }) => {
      const g = h("optgroup", { label: p.custom ? c.name || "自定义接口" : p.name });
      models.forEach((m) => g.append(h("option", { value: modelKey(p.id, m.id), selected: p.id === start.providerId && m.id === start.model }, m.id + (m.n ? `　· 用过 ${m.n} 次` : ""))));
      modelSel.append(g);
    });
    // 提示词
    const promptSel = h("select.select", { "aria-label": "提示词" },
      ...prompts.map((p) => h("option", { value: p.id, selected: p.id === start.promptId }, promptLabel(p))),
      h("option", { value: "__temp", selected: !prompts.length || start.promptId === null }, "临时写一个……"));
    const tempIn = h("textarea.textarea", { rows: "4", placeholder: "写给 AI 的话。可以用 {选中文本}、{本章要点}、{前一章摘要} 这些变量，发送时自动填入。" });
    tempIn.value = (prev && prev.promptText && !prev.promptId) ? prev.promptText : "";
    const saveTemp = h("button.btn.small.ghost", { type: "button" }, "存进提示词库");
    const manage = h("button.btn.small.ghost", { type: "button" }, "管理提示词库");
    manage.addEventListener("click", async () => {
      await commands.run("prompts.manage", { feature: opts.feature });
      const fresh = await listPrompts();
      const keep = promptSel.value;
      promptSel.replaceChildren(...fresh.map((p) => h("option", { value: p.id }, promptLabel(p))), h("option", { value: "__temp" }, "临时写一个……"));
      prompts.splice(0, prompts.length, ...fresh);
      promptSel.value = fresh.some((p) => p.id === keep) ? keep : (fresh[0] ? fresh[0].id : "__temp");
      refresh();
    });
    const tempBox = h("div.field", {}, tempIn, h("div.row", {}, saveTemp));
    const preview = h("pre.ai-preview");
    const missingBox = h("div.row.ai-missing");
    const est = h("p.ai-est");
    const maxIn = h("input.input.ai-max", { type: "number", min: "16", max: "64000", step: "16", value: String(start.maxTokens || opts.maxTokens || 1200), "aria-label": "输出长度上限" });
    const priceBox = h("div.row.ai-price", { hidden: true });
    const skip = h("input", { type: "checkbox" });
    // 文风样本：每次默认不模仿
    const sampleSel = h("select.select", { "aria-label": "文风样本" });
    const fillSamples = (list, keep = "") => {
      sampleSel.replaceChildren(h("option", { value: "" }, "不模仿"), ...list.map((x) => h("option", { value: x.id }, x.name + (x.uses ? `　· 用过 ${x.uses} 次` : ""))));
      sampleSel.value = list.some((x) => x.id === keep) ? keep : "";
    };
    fillSamples(samples, prev && prev.sampleId);
    const manageSamples = h("button.btn.small.ghost", { type: "button" }, "管理");
    manageSamples.addEventListener("click", async () => {
      await samplesModal();
      const fresh = await listSamples();
      samples.splice(0, samples.length, ...fresh);
      fillSamples(fresh, sampleSel.value);
      refresh();
    });
    // 带上哪些内容
    let ctxNow = { text: "", parts: [] };
    const ctxBox = src ? h("div.ai-ctx") : null;
    if (src) {
      const chk = (key, label, extra) => {
        const box = h("input", { type: "checkbox", checked: !!ctx[key] });
        box.addEventListener("change", () => { ctx[key] = box.checked; refresh(); });
        return h("div.ai-ctx-row", {}, h("label.check", {}, box, label), ...(extra || []));
      };
      const sel = (key, items, onPick) => {
        const s = h("select.select.small", { "aria-label": key });
        items.forEach(([v, t]) => s.append(h("option", { value: String(v), selected: String(ctx[key]) === String(v) }, t)));
        s.addEventListener("change", () => { ctx[key] = onPick ? onPick(s.value) : s.value; refresh(); });
        return s;
      };
      const bl = [...src.before].length;
      if (bl) ctxBox.append(chk("before", "本章前文", [sel("beforeLen", BEFORE_SIZES.filter((n) => n < 0 || n < bl).map((n) => [n, n < 0 ? `前面全部（${bl.toLocaleString()} 字）` : `最近 ${n} 字`]), Number)]));
      if (src.prevList.length) ctxBox.append(chk("prev", "前几章", [
        sel("prevN", src.prevList.map((_, i) => [i + 1, `前 ${i + 1} 章`]), Number),
        sel("prevMode", [["summary", "有摘要用摘要"], ["full", "全文"]])]));
      if (src.points.length) ctxBox.append(chk("points", `本章要点（${src.points.length} 条）`));
      if (src.intro.trim()) ctxBox.append(chk("intro", "作品简介"));
      if (src.people === null) ctxBox.append(h("p.ai-ctx-hint", {}, "人物信息：角色卡做好后可以在这里勾人物。"));
      else if (!src.people.length) ctxBox.append(h("p.ai-ctx-hint", {}, "人物信息：这本书还没有角色卡。"));
      else ctxBox.append(h("div.ai-ctx-row.ai-ctx-people", {}, h("span.ai-ctx-k", {}, "人物"), ...src.people.map((pp) => {
        const b = h("button.chip.ai-ctx-p", { type: "button", "aria-pressed": String(ctx.people.includes(pp.id)) }, pp.name);
        b.addEventListener("click", () => {
          ctx.people = ctx.people.includes(pp.id) ? ctx.people.filter((x) => x !== pp.id) : [...ctx.people, pp.id];
          b.setAttribute("aria-pressed", String(ctx.people.includes(pp.id)));
          refresh();
        });
        return b;
      })));
      if (!ctxBox.childElementCount) ctxBox.append(h("p.ai-ctx-hint", {}, "这一章前面还没有内容可带。"));
    }
    const creat = levelPicker({ kind: "creativity", value: start.creativity || 0, onChange: () => refresh() });
    const think = levelPicker({ kind: "thinking", value: start.thinking || 0, onChange: () => refresh() });
    // 常用组合：按用过的次数排，上一次用的标出来
    const recentRow = h("div.row.ai-recent");
    recent.slice(0, 6).forEach((r) => {
      const p = prompts.find((x) => x.id === r.promptId);
      const lv = [r.creativity ? "创意" + CREATIVITY[r.creativity].name : "", r.thinking ? THINKING[r.thinking].name : ""].filter(Boolean).join("、");
      const b = h("button.chip.ai-recent-chip" + (r === last ? ".last" : ""), { type: "button", title: r === last ? "上一次用的" : "" },
        `${r.model} · ${p ? p.name : "临时提示词"}${lv ? " · " + lv : ""}`, h("span.ai-recent-n", {}, `${r.n || 1} 次`));
      b.addEventListener("click", () => {
        modelSel.value = modelKey(r.providerId, r.model);
        promptSel.value = p ? p.id : "__temp";
        maxIn.value = String(r.maxTokens || maxIn.value);
        creat.set(r.creativity || 0);
        think.set(r.thinking || 0);
        refresh();
      });
      recentRow.append(b);
    });

    const current = () => {
      const [providerId, model] = modelSel.value.split("\u0001");
      const pid = promptSel.value === "__temp" ? null : promptSel.value;
      const pr = prompts.find((x) => x.id === pid);
      const sm = samples.find((x) => x.id === sampleSel.value);
      return { providerId, model, promptId: pid, promptText: pr ? pr.text : tempIn.value, maxTokens: Math.max(16, parseInt(maxIn.value, 10) || 1200),
        creativity: creat.value, thinking: think.value, sampleId: sm ? sm.id : null, sampleText: sm ? sm.text : "",
        ctx: src ? { ...ctx, people: [...ctx.people] } : null, ctxText: ctxNow.text };
    };

    async function refresh() {
      if (src) ctxNow = await ctxText(src, ctx);
      const c = current();
      tempBox.hidden = promptSel.value !== "__temp";
      const comp = compose(c.promptText, opts, c.sampleText, c.ctxText);
      preview.textContent = comp.text.length > 1600 ? comp.text.slice(0, 1600) + `\n……（共 ${comp.text.length} 字）` : comp.text;
      missingBox.replaceChildren(...comp.missing.map((m) => h("span.chip.warn", { title: "这个变量现在没有值，会原样发出去" }, `{${m}} 没有值`)));
      const inTok = estimateTokens(comp.text) + estimateTokens((opts.history || []).map((m) => m.content).join(""));
      const n = Math.max(1, Math.min(6, opts.count || 1));
      const cfgNow = await getConfig();
      const price = (cfgNow.prices || {})[c.providerId + "/" + c.model];
      const pv = providerOf(c.providerId) || {};
      const proto = pv.protocol === "anthropic" || pv.protocol === "gemini" ? pv.protocol : "openai";
      const extra = pv.mock ? 0 : thinkingExtra(proto, c.thinking);
      const cost = costOf(price, { input: inTok * n, output: (c.maxTokens + extra) * n });
      const no = c.model ? await unsupportedParams(c.providerId, c.model) : [];
      creat.note(no.includes("temperature") ? "这个模型之前不接受创意度，发送时不带" : "");
      think.note(no.includes("think") ? "这个模型之前不接受思考程度，发送时不带" : "");
      est.replaceChildren(
        ctxNow.parts.length ? h("span.ai-est-ctx", {}, "带上：" + ctxNow.parts.map((x) => `${x.name} ${x.words.toLocaleString()} 字`).join("、") + "。") : "",
        h("span", {}, `发送约 ${inTok.toLocaleString()} token，最多输出 ${c.maxTokens.toLocaleString()} token` + (extra ? `（思考另留 ${extra.toLocaleString()}）` : "") + (n > 1 ? `，出 ${n} 版（花费 ×${n}）` : "") + ((opts.history || []).length ? `，带上前面 ${opts.history.length} 条对话` : "")),
        price ? h("span", {}, ` · 最多约 ${cost.toFixed(4)} ${price.cur || "USD"}`) : h("button.btn.small.ghost", { type: "button", onclick: () => { priceBox.hidden = !priceBox.hidden; } }, "没填单价，填一下"));
      renderPrice(c, price);
      sendBtn.disabled = !c.model || !comp.text.trim();
    }

    function renderPrice(c, price) {
      const inP = h("input.input", { type: "number", step: "0.01", min: "0", value: price ? price.in : "", placeholder: "输入单价", "aria-label": "输入单价（每百万 token）" });
      const outP = h("input.input", { type: "number", step: "0.01", min: "0", value: price ? price.out : "", placeholder: "输出单价", "aria-label": "输出单价（每百万 token）" });
      const cur = h("select.select", { "aria-label": "币种" }, ...["USD", "CNY"].map((x) => h("option", { value: x, selected: (price && price.cur) === x }, x === "USD" ? "美元" : "人民币")));
      const save = h("button.btn.small", { type: "button" }, "保存单价");
      save.addEventListener("click", async () => {
        const all = await getConfig();
        all.prices = all.prices || {};
        all.prices[c.providerId + "/" + c.model] = { in: parseFloat(inP.value) || 0, out: parseFloat(outP.value) || 0, cur: cur.value };
        await saveConfig(all);
        priceBox.hidden = true;
        refresh();
      });
      priceBox.replaceChildren(h("span.muted", {}, c.model + " 每百万 token："), inP, outP, cur, save);
    }

    saveTemp.addEventListener("click", async () => {
      if (!tempIn.value.trim()) return;
      const p = await savePrompt({ name: tempIn.value.trim().slice(0, 16), text: tempIn.value, feature: opts.feature });
      prompts.unshift(p);
      promptSel.prepend(h("option", { value: p.id }, p.name));
      promptSel.value = p.id;
      toast("已存进提示词库");
      refresh();
    });
    [modelSel, promptSel, maxIn, sampleSel].forEach((x) => x.addEventListener("change", refresh));
    tempIn.addEventListener("input", refresh);

    let sendBtn = h("button");   // 弹窗建好后换成底部的「发送」按钮
    const inputInfo = opts.input ? h("details.ai-input", {}, h("summary", {}, `${opts.inputLabel || "发送的文字"}：${[...opts.input].length.toLocaleString()} 字`), h("pre.ai-preview", {}, opts.input.length > 3000 ? opts.input.slice(0, 3000) + "……" : opts.input)) : null;
    const body = h("div.ai-card", {},
      recent.length ? h("div.field", {}, h("span", {}, "常用组合"), recentRow) : null,
      h("label.field", {}, h("span", {}, "模型"), modelSel),
      h("div.field", {}, h("span", {}, "提示词", manage), promptSel),
      tempBox,
      h("div.ai-lvs", {}, creat, think),
      h("div.field.ai-sample", {}, h("span", {}, "文风样本", manageSamples), sampleSel),
      ctxBox ? h("div.field", {}, h("span", {}, "带上"), ctxBox) : null,
      inputInfo,
      h("details.ai-full", {}, h("summary", {}, "实际发送的内容"), preview),
      missingBox,
      h("div.row", {}, h("label.field.ai-max-f", {}, h("span", {}, "输出上限（token）"), maxIn), h("span.spacer")),
      est, priceBox,
      h("label.check", {}, skip, "这个组合本次打开软件期间不再询问"));
    const m = modal({
      title: "确认调用 · " + (FEATURES[opts.feature] || opts.feature || "AI"),
      body, wide: false,
      onClose: () => resolve(result),
      actions: [
        { label: "发送", primary: true, onClick: async () => {
          await refresh();
          const c = current();
          if (!c.promptText.trim() && !opts.input) return;
          if (skip.checked && !opts.temp) skipThisSession.add(comboKey(opts.feature, c));
          result = c;
          m.close(true);
        } },
        { label: "取消", onClick: () => m.close(true) },
      ],
    });
    sendBtn = m.foot.querySelector(".btn.primary");
    refresh();
  });
}

// ---------------- 发送 ----------------
async function send(opts, c) {
  const comp = compose(c.promptText, opts, c.sampleText, c.ctxText);
  const cfg = await getConfig();
  const conf = cfg.providers[c.providerId];
  bus.emit("ai:start", { feature: opts.feature });
  try {
    const messages = [...(opts.history || []), { role: "user", content: comp.text }];
    const r = await chat({ providerId: c.providerId, conf, model: c.model, messages, maxTokens: c.maxTokens, creativity: c.creativity || 0, thinking: c.thinking || 0, onDelta: opts.onDelta, signal: opts.signal });
    if (r.adjusted && r.adjusted.length) toast(r.adjusted.join("；"));
    await noteRecent(opts.feature, c);
    if (c.promptId) notePromptUse(c.promptId);
    if (c.sampleId) noteSampleUse(c.sampleId);
    if (c.ctx) noteCtx(opts.feature, c.ctx);
    await record({ providerId: c.providerId, model: c.model, feature: opts.feature, bookId: opts.bookId, usage: r.usage });
    const stash = await addStash({
      bookId: opts.bookId || null, feature: opts.feature, ref: opts.ref || null, title: opts.title || "",
      text: r.text, prompt: comp.text.slice(0, 4000), promptId: c.promptId, providerId: c.providerId, model: c.model,
      input: (opts.input || "").slice(0, 4000),
    });
    bus.emit("ai:done", { feature: opts.feature, text: r.text });
    return { text: r.text, usage: r.usage, stash, choice: c, sent: comp.text };
  } catch (e) {
    if (e.category === "cancel") { bus.emit("ai:cancel", {}); return null; }
    bus.emit("ai:error", { feature: opts.feature, error: e });
    return explain(e, opts, c);
  }
}

/** 中文报错卡：出了什么事 / 可能的原因 / 现在可以点什么。返回下一步 { retry: "same"|"card", patch } 或 null */
function explain(e, opts, c) {
  return new Promise((resolve) => {
    let settled = false, busy = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const act = (label, fn, primary) => ({ label, primary, run: async () => { busy = true; finish(await fn()); } });
    const p = providerOf(c.providerId);
    const actions = [];
    if (["network", "server", "rate"].includes(e.category)) actions.push(act("重试", () => ({ retry: "same" }), true));
    if (e.category === "auth") actions.push(act("重新填 Key", () => new Promise((res) => {
      let ok = false;
      const body = h("div");
      const m = modal({ title: "重新填 " + p.name + " 的 Key", body, wide: true, onClose: () => res(ok ? { retry: "same" } : null) });
      renderSetup(body, { only: c.providerId, onDone: () => { ok = true; setTimeout(() => m.close(true), 600); } });
    }), true));
    if (["balance", "model", "content", "auth", "rate"].includes(e.category)) actions.push(act("换个模型", () => ({ retry: "card" })));
    if (e.category === "too_long" && opts.input) actions.push(act("自动截短到一半再试", () => ({ retry: "same", patch: { input: opts.input.slice(0, Math.floor(opts.input.length / 2)) } }), true));
    if (e.category === "too_long") actions.push(act("换长上下文的模型", () => ({ retry: "card" })));
    notice({ what: e.what || "调用失败。", why: e.why || "", detail: e.detail || e.stack || "", actions }).then((m) => {
      const prev = m.layer.onClose;
      m.layer.onClose = () => { prev && prev(); setTimeout(() => { if (!busy) finish(null); }, 0); };
    });
  });
}

export { icon };
