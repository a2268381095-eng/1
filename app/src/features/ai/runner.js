// 调用 AI 的统一入口：确认卡 → 发送（流式）→ 记账 → 进暂存盒；出错给中文说明和能直接点的解决办法。
// AI 永远不替作者做决定：每次调用前显示模型、提示词、发送内容、预估 token 和费用，确认才发送。
// 每个功能记住最近用过的组合排在最前；可以设「同一组合本次会话内不再询问」。
import { getConfig, saveConfig, readyProviders, providerOf, chat, estimateTokens, costOf, record } from "../../core/ai.js";
import { listPrompts, savePrompt, fillPrompt, notePromptUse } from "../../core/prompts.js";
import { addStash, FEATURES } from "../../core/stash.js";
import { db } from "../../core/db.js";
import { bus } from "../../core/bus.js";
import { h, icon, modal, notice, toast } from "../../core/ui.js";
import { setupModal, renderSetup } from "./setup.js";

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
 * 返回 { text, usage, stash, choice } ；取消或失败返回 null
 */
export async function runAI(opts) {
  if (!(await readyProviders()).length) {
    const id = await setupModal();
    if (!id) return null;
  }
  let choice = await confirmCard(opts);
  while (choice) {
    const r = await send(opts, choice);
    if (r && r.retry) { choice = r.retry === "card" ? await confirmCard({ ...opts, ...(r.patch || {}) }, choice) : choice; if (r.patch) opts = { ...opts, ...r.patch }; continue; }
    return r;
  }
  return null;
}

function comboKey(feature, c) { return [feature, c.providerId, c.model, c.promptId || "temp"].join("|"); }

async function recentOf(feature) { return db.getKV("ai:recent:" + feature, []); }
async function noteRecent(feature, c) {
  const list = (await recentOf(feature)).filter((x) => comboKey(feature, x) !== comboKey(feature, c));
  list.unshift({ providerId: c.providerId, model: c.model, promptId: c.promptId || null, maxTokens: c.maxTokens });
  await db.setKV("ai:recent:" + feature, list.slice(0, 5));
}

/** 把提示词和发送内容拼成最终要发的话 */
function compose(promptText, opts) {
  const vars = { ...(opts.vars || {}), 选中文本: opts.input || (opts.vars || {}).选中文本 || "" };
  const f = fillPrompt(promptText, vars);
  let text = f.text;
  const autoAttach = opts.input && !f.used.includes("选中文本");
  if (autoAttach) text += `\n\n【原文】\n${opts.input}\n【/原文】`;
  return { text, missing: f.missing.filter((m) => m !== "选中文本" || !opts.input), autoAttach };
}

// ---------------- 确认卡 ----------------
async function confirmCard(opts, prev = null) {
  const cfg = await getConfig();
  const ready = await readyProviders();
  const prompts = await listPrompts();
  const recent = (await recentOf(opts.feature)).filter((r) => ready.some((p) => p.id === r.providerId));
  const start = prev || recent[0] || { providerId: ready[0].id, model: cfg.providers[ready[0].id].testModel, promptId: prompts[0] ? prompts[0].id : null, maxTokens: opts.maxTokens || 1200 };
  if (!prev && recent[0] && skipThisSession.has(comboKey(opts.feature, recent[0]))) {
    const p = prompts.find((x) => x.id === recent[0].promptId);
    if (p) return { ...recent[0], promptText: p.text };
  }

  return new Promise((resolve) => {
    let result = null;
    // 模型
    const modelSel = h("select.select", { "aria-label": "模型" });
    ready.forEach((p) => {
      const c = cfg.providers[p.id];
      const g = h("optgroup", { label: p.custom ? c.name || "自定义接口" : p.name });
      (c.models || []).forEach((m) => {
        const id = typeof m === "string" ? m : m.id;
        g.append(h("option", { value: p.id + "\u0001" + id, selected: p.id === start.providerId && id === start.model }, id));
      });
      modelSel.append(g);
    });
    // 提示词
    const promptSel = h("select.select", { "aria-label": "提示词" },
      ...prompts.map((p) => h("option", { value: p.id, selected: p.id === start.promptId }, (p.group ? p.group + " / " : "") + p.name)),
      h("option", { value: "__temp", selected: !prompts.length || start.promptId === null }, "临时写一个……"));
    const tempIn = h("textarea.textarea", { rows: "4", placeholder: "写给 AI 的话。可以用 {选中文本}、{本章要点}、{前一章摘要} 这些变量，发送时自动填入。" });
    tempIn.value = (prev && prev.promptText && !prev.promptId) ? prev.promptText : "";
    const saveTemp = h("button.btn.small.ghost", { type: "button" }, "存进提示词库");
    const tempBox = h("div.field", {}, tempIn, h("div.row", {}, saveTemp));
    const preview = h("pre.ai-preview");
    const missingBox = h("div.row.ai-missing");
    const est = h("p.ai-est");
    const maxIn = h("input.input.ai-max", { type: "number", min: "16", max: "64000", step: "16", value: String(start.maxTokens || opts.maxTokens || 1200), "aria-label": "输出长度上限" });
    const priceBox = h("div.row.ai-price", { hidden: true });
    const skip = h("input", { type: "checkbox" });
    const recentRow = h("div.row.ai-recent");
    recent.forEach((r) => {
      const p = prompts.find((x) => x.id === r.promptId);
      const b = h("button.chip.ai-recent-chip", { type: "button" }, `${r.model} · ${p ? p.name : "临时提示词"}`);
      b.addEventListener("click", () => {
        modelSel.value = r.providerId + "\u0001" + r.model;
        promptSel.value = p ? p.id : "__temp";
        maxIn.value = String(r.maxTokens || maxIn.value);
        refresh();
      });
      recentRow.append(b);
    });

    const current = () => {
      const [providerId, model] = modelSel.value.split("\u0001");
      const pid = promptSel.value === "__temp" ? null : promptSel.value;
      const pr = prompts.find((x) => x.id === pid);
      return { providerId, model, promptId: pid, promptText: pr ? pr.text : tempIn.value, maxTokens: Math.max(16, parseInt(maxIn.value, 10) || 1200) };
    };

    async function refresh() {
      const c = current();
      tempBox.hidden = promptSel.value !== "__temp";
      const comp = compose(c.promptText, opts);
      preview.textContent = comp.text.length > 1600 ? comp.text.slice(0, 1600) + `\n……（共 ${comp.text.length} 字）` : comp.text;
      missingBox.replaceChildren(...comp.missing.map((m) => h("span.chip.warn", { title: "这个变量现在没有值，会原样发出去" }, `{${m}} 没有值`)));
      const inTok = estimateTokens(comp.text);
      const cfgNow = await getConfig();
      const price = (cfgNow.prices || {})[c.providerId + "/" + c.model];
      const cost = costOf(price, { input: inTok, output: c.maxTokens });
      est.replaceChildren(
        h("span", {}, `发送约 ${inTok.toLocaleString()} token，最多输出 ${c.maxTokens.toLocaleString()} token`),
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
    [modelSel, promptSel, maxIn].forEach((x) => x.addEventListener("change", refresh));
    tempIn.addEventListener("input", refresh);

    let sendBtn = h("button");   // 弹窗建好后换成底部的「发送」按钮
    const inputInfo = opts.input ? h("details.ai-input", {}, h("summary", {}, `${opts.inputLabel || "发送的文字"}：${[...opts.input].length.toLocaleString()} 字`), h("pre.ai-preview", {}, opts.input.length > 3000 ? opts.input.slice(0, 3000) + "……" : opts.input)) : null;
    const body = h("div.ai-card", {},
      recent.length ? h("div.field", {}, h("span", {}, "最近用过"), recentRow) : null,
      h("label.field", {}, h("span", {}, "模型"), modelSel),
      h("label.field", {}, h("span", {}, "提示词"), promptSel),
      tempBox,
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
        { label: "发送", primary: true, onClick: () => {
          const c = current();
          if (!c.promptText.trim() && !opts.input) return;
          if (skip.checked) skipThisSession.add(comboKey(opts.feature, c));
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
  const comp = compose(c.promptText, opts);
  const cfg = await getConfig();
  const conf = cfg.providers[c.providerId];
  bus.emit("ai:start", { feature: opts.feature });
  try {
    const r = await chat({ providerId: c.providerId, conf, model: c.model, messages: [{ role: "user", content: comp.text }], maxTokens: c.maxTokens, onDelta: opts.onDelta, signal: opts.signal });
    await noteRecent(opts.feature, c);
    if (c.promptId) notePromptUse(c.promptId);
    await record({ providerId: c.providerId, model: c.model, feature: opts.feature, bookId: opts.bookId, usage: r.usage });
    const stash = await addStash({
      bookId: opts.bookId || null, feature: opts.feature, ref: opts.ref || null, title: opts.title || "",
      text: r.text, prompt: comp.text.slice(0, 4000), promptId: c.promptId, providerId: c.providerId, model: c.model,
      input: (opts.input || "").slice(0, 4000),
    });
    bus.emit("ai:done", { feature: opts.feature, text: r.text });
    return { text: r.text, usage: r.usage, stash, choice: c };
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
