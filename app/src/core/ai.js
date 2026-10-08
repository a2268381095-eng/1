// AI 接入的底层：各家接口、拉模型列表、测试、调用（流式）、余额、记账、中文报错分类。
// 不预设模型、不预设提示词；调用前的确认卡在 features/ai 里，这里只管发请求。
//
// 桌面版用 Tauri 的 http 插件发请求（不受浏览器跨域限制）；网页版用浏览器 fetch，有的接口会被拦下，报错里会说明。
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { db, uid } from "./db.js";
import { bus } from "./bus.js";

export const isDesktop = () => typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** 提供商顺序按需求文档：ofoxAI → Claude → GPT → Gemini → DeepSeek → Grok，自定义接口折叠在最下面 */
export const PROVIDERS = [
  { id: "ofox", name: "ofoxAI", protocol: "openai", base: "https://api.ofox.ai/v1", keyUrl: "https://app.ofox.ai",
    keyHint: "在 ofoxAI 控制台创建的用户级 Key", balance: "ofox", note: "一个 Key 能用 GPT、Claude、Gemini 等很多家的模型" },
  { id: "anthropic", name: "Claude", protocol: "anthropic", base: "https://api.anthropic.com", keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant- 开头", cache: true },
  { id: "openai", name: "GPT", protocol: "openai", base: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", keyHint: "sk- 开头", cache: true },
  { id: "gemini", name: "Gemini", protocol: "gemini", base: "https://generativelanguage.googleapis.com/v1beta", keyUrl: "https://aistudio.google.com/apikey", keyHint: "AIza 开头" },
  { id: "deepseek", name: "DeepSeek", protocol: "openai", base: "https://api.deepseek.com", keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk- 开头", balance: "deepseek", cache: true },
  { id: "xai", name: "Grok", protocol: "openai", base: "https://api.x.ai/v1", keyUrl: "https://console.x.ai", keyHint: "xai- 开头" },
  { id: "custom", name: "自定义接口", protocol: "openai", base: "", custom: true, keyHint: "兼容 OpenAI 格式的接口地址和 Key" },
];
// 测试用的假接口：localStorage.xemoMock = "1" 时出现，不联网，按固定规则回一段文字（自动测试用）
const MOCK = { id: "mock", name: "测试用假接口", protocol: "mock", base: "mock://local", keyHint: "随便填", mock: true };
const mockOn = () => { try { return localStorage.getItem("xemoMock") === "1"; } catch (_) { return false; } };
export const allProviders = () => (mockOn() ? [...PROVIDERS, MOCK] : PROVIDERS);
export const providerOf = (id) => allProviders().find((p) => p.id === id);

// ---------------- 配置（Key 只存在这台电脑上） ----------------
// kv "ai:config" = { providers: { [id]: { key, base?, name?, models: [id...], ok: bool, testedAt } }, prices: { "<provider>/<model>": { in, out, cur } }, cheap: { provider, model } }
export async function getConfig() {
  return db.getKV("ai:config", { providers: {}, prices: {}, cheap: null });
}
export async function saveConfig(cfg) {
  await db.setKV("ai:config", cfg);
  bus.emit("ai:config", { cfg });
  return cfg;
}
/** 已经配好（测试通过）的提供商 */
export async function readyProviders() {
  const cfg = await getConfig();
  return allProviders().filter((p) => cfg.providers[p.id] && cfg.providers[p.id].key && cfg.providers[p.id].ok);
}

// ---------------- 发请求 ----------------
async function http(url, opts = {}) {
  const f = isDesktop() ? tauriFetch : window.fetch.bind(window);
  return f(url, opts);
}

function endpoint(p, conf) {
  const base = ((conf && conf.base) || p.base || "").replace(/\/+$/, "");
  if (!base) throw aiError("request", { what: "还没填接口地址。", why: "自定义接口需要填兼容 OpenAI 格式的地址，比如 https://example.com/v1。" });
  return base;
}

function headersFor(p, key) {
  if (p.protocol === "anthropic") {
    return { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "content-type": "application/json" };
  }
  if (p.protocol === "gemini") return { "content-type": "application/json", "x-goog-api-key": key };
  return { authorization: "Bearer " + key, "content-type": "application/json" };
}

/** 拉取可用模型列表，返回 [{ id, name }] */
export async function listModels(providerId, conf) {
  const p = providerOf(providerId);
  if (p.mock) {
    if (conf.key === "bad") throw aiError("auth", { what: "测试用假接口不认这个 Key。", why: "Key 填的是 bad。" });
    return [{ id: "mock-small", name: "假模型（小）" }, { id: "mock-large", name: "假模型（大）" }];
  }
  const base = endpoint(p, conf);
  const url = p.protocol === "anthropic" ? base + "/v1/models?limit=1000" : p.protocol === "gemini" ? base + "/models?pageSize=1000" : base + "/models";
  const res = await send(p, () => http(url, { headers: headersFor(p, conf.key) }));
  const j = await res.json();
  let list;
  if (p.protocol === "gemini") {
    list = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name }));
  } else {
    list = (j.data || j.models || []).map((m) => ({ id: m.id || m.name, name: m.display_name || m.name || m.id }));
  }
  return list.filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));
}

/** 查余额（只有支持的几家）：返回 { amount, currency } 或 null */
export async function getBalance(providerId, conf) {
  const p = providerOf(providerId);
  if (!p || !p.balance || !conf || !conf.key) return null;
  const base = endpoint(p, conf);
  const res = await send(p, () => http(base + "/user/balance", { headers: headersFor(p, conf.key) }));
  const j = await res.json();
  if (p.balance === "deepseek") {
    const b = (j.balance_infos || [])[0];
    return b ? { amount: parseFloat(b.total_balance), currency: b.currency } : null;
  }
  // ofoxAI：字段名以文档为准，这里尽量宽松地取
  const d = j.data || j;
  const amount = parseFloat(d.balance ?? d.available_balance ?? d.available ?? d.total_balance);
  return Number.isFinite(amount) ? { amount, currency: d.currency || "USD" } : null;
}

/**
 * 调用模型。messages: [{ role: "user"|"assistant", content }]，system 可选。
 * onDelta(text) 收到一段就回调一次（流式）。返回 { text, usage: { input, output } }。
 * signal 可以中途取消。
 */
export async function chat({ providerId, conf, model, system = "", messages, maxTokens = 1024, temperature, onDelta, signal, cache = true }) {
  const p = providerOf(providerId);
  if (p.mock) return mockChat({ system, messages, maxTokens, onDelta, signal, conf });
  const base = endpoint(p, conf);
  let url, body;
  if (p.protocol === "anthropic") {
    url = base + "/v1/messages";
    const sys = system ? [{ type: "text", text: system, ...(cache && system.length > 2000 ? { cache_control: { type: "ephemeral" } } : {}) }] : undefined;
    body = { model, max_tokens: maxTokens, messages, stream: true, ...(sys ? { system: sys } : {}), ...(temperature != null ? { temperature } : {}) };
  } else if (p.protocol === "gemini") {
    url = `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    body = {
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: maxTokens, ...(temperature != null ? { temperature } : {}) },
    };
  } else {
    url = base + "/chat/completions";
    body = {
      model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens,
      messages: [...(system ? [{ role: "system", content: system }] : []), ...messages],
      ...(temperature != null ? { temperature } : {}),
    };
  }
  const res = await send(p, () => http(url, { method: "POST", headers: headersFor(p, conf.key), body: JSON.stringify(body), signal }));
  let text = "";
  const usage = { input: 0, output: 0 };
  await readSSE(res, (data) => {
    let j;
    try { j = JSON.parse(data); } catch (_) { return; }
    let piece = "";
    if (p.protocol === "anthropic") {
      if (j.type === "content_block_delta" && j.delta && j.delta.text) piece = j.delta.text;
      if (j.type === "message_start" && j.message && j.message.usage) usage.input = (j.message.usage.input_tokens || 0) + (j.message.usage.cache_read_input_tokens || 0) + (j.message.usage.cache_creation_input_tokens || 0);
      if (j.type === "message_delta" && j.usage) usage.output = j.usage.output_tokens || usage.output;
      if (j.type === "error") throw aiError("request", { what: "接口返回了错误。", detail: data });
    } else if (p.protocol === "gemini") {
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      piece = parts.map((x) => x.text || "").join("");
      if (j.usageMetadata) { usage.input = j.usageMetadata.promptTokenCount || usage.input; usage.output = j.usageMetadata.candidatesTokenCount || usage.output; }
    } else {
      const c = j.choices && j.choices[0];
      if (c && c.delta && c.delta.content) piece = c.delta.content;
      if (j.usage) { usage.input = j.usage.prompt_tokens || usage.input; usage.output = j.usage.completion_tokens || usage.output; }
    }
    if (piece) { text += piece; onDelta && onDelta(piece, text); }
  }, signal);
  if (!text.trim()) throw aiError("content", { what: "模型没有返回内容。", why: "可能是内容被模型拒绝生成，或者输出长度上限设得太小。" });
  if (!usage.input) usage.input = estimateTokens(system + messages.map((m) => m.content).join(""));
  if (!usage.output) usage.output = estimateTokens(text);
  return { text, usage };
}

/** 发一条极短的消息测试 Key 和模型能不能用 */
export async function testModel(providerId, conf, model) {
  const r = await chat({ providerId, conf, model, messages: [{ role: "user", content: "你好，回复「好」一个字。" }], maxTokens: 16 });
  return r;
}

/** 假接口：把最后一条消息里的文字原样改写一下（加「（改）」），一段段吐出来 */
async function mockChat({ system, messages, maxTokens, onDelta, signal, conf }) {
  if (conf && conf.key === "bad") throw aiError("auth", { what: "测试用假接口不认这个 Key。", why: "Key 填的是 bad。" });
  const last = messages[messages.length - 1].content;
  if (/【报错】/.test(last)) throw aiError("server", { what: "测试用假接口故意出错。", why: "消息里带了【报错】。" });
  const src = (last.match(/【原文】([\s\S]*?)【\/原文】/) || [, last])[1];
  const out = src.replace(/。/g, "，真的。").slice(0, maxTokens * 2) || "好";
  let text = "";
  for (let i = 0; i < out.length; i += 6) {
    if (signal && signal.aborted) throw aiError("cancel", { what: "已取消。" });
    await new Promise((r) => setTimeout(r, 15));
    const piece = out.slice(i, i + 6);
    text += piece;
    onDelta && onDelta(piece, text);
  }
  return { text, usage: { input: estimateTokens(system + messages.map((m) => m.content).join("")), output: estimateTokens(text) } };
}

// 读 Server-Sent Events：一行行的 "data: {...}"
async function readSSE(res, onData, signal) {
  if (!res.body || !res.body.getReader) {
    const all = await res.text();
    all.split(/\r?\n/).forEach((l) => { if (l.startsWith("data:")) { const d = l.slice(5).trim(); if (d && d !== "[DONE]") onData(d); } });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal && signal.aborted) { reader.cancel(); throw aiError("cancel", { what: "已取消。" }); }
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (d && d !== "[DONE]") onData(d);
      }
    }
  }
  if (buf.startsWith("data:")) { const d = buf.slice(5).trim(); if (d && d !== "[DONE]") onData(d); }
}

// ---------------- 出错：分成连接 / 账号 / 请求 / 内容 几类，给中文说明 ----------------
export function aiError(category, { what, why = "", detail = "", status = 0 } = {}) {
  const e = new Error(what);
  Object.assign(e, { ai: true, category, what, why, detail, status });
  return e;
}

async function send(p, doFetch) {
  let res;
  try {
    res = await doFetch();
  } catch (e) {
    if (e && e.name === "AbortError") throw aiError("cancel", { what: "已取消。" });
    throw aiError("network", {
      what: `连不上 ${p.name}。`,
      why: isDesktop() ? "网络不通，或者接口地址填错了。" : "网络不通、接口地址填错，或者这家接口不让网页直接调用（浏览器的跨域限制）。用桌面版就没有这个限制。",
      detail: String(e && (e.stack || e.message || e)),
    });
  }
  if (res.ok) return res;
  let raw = "";
  try { raw = await res.text(); } catch (_) { /* 读不到正文就算了 */ }
  const low = raw.toLowerCase();
  const s = res.status;
  if (s === 401 || s === 403 || /invalid.{0,20}(api.?key|x-api-key|key)|incorrect api key|permission/.test(low)) {
    throw aiError("auth", { what: `${p.name} 不认这个 Key。`, why: "Key 填错了、过期了，或者被停用了。", status: s, detail: raw });
  }
  if (s === 402 || /insufficient|quota|balance|credit|余额/.test(low)) {
    throw aiError("balance", { what: `${p.name} 的余额或额度不够了。`, why: "账户余额不足，或者这个月的额度用完了。", status: s, detail: raw });
  }
  if (/context|too long|maximum.{0,20}tokens|max_tokens|token limit|超出|过长/.test(low) && s === 400) {
    throw aiError("too_long", { what: "发送的内容太长，超出了这个模型的上限。", why: "选中的文字、附带的设定和前文摘要加起来太多。", status: s, detail: raw });
  }
  if (s === 404 || /model.{0,30}(not found|does not exist|unknown)/.test(low)) {
    throw aiError("model", { what: "找不到这个模型。", why: "模型名写错了，或者这家已经下线了它。可以重新拉取模型列表。", status: s, detail: raw });
  }
  if (s === 429) throw aiError("rate", { what: `${p.name} 说请求太频繁了。`, why: "短时间内调用太多次，或者账户有速率限制。等一会儿再试。", status: s, detail: raw });
  if (s >= 500) throw aiError("server", { what: `${p.name} 那边出错了。`, why: "对方的服务暂时有问题，和你的稿子、Key 无关。", status: s, detail: raw });
  throw aiError("request", { what: `${p.name} 拒绝了这次请求（${s}）。`, why: "请求格式或参数不被接受。", status: s, detail: raw });
}

// ---------------- 估算和记账 ----------------
/** 粗略估算 token：汉字约 1 个、英文单词约 1.3 个 */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[　-鿿＀-￯]/g) || []).length;
  const words = (text.replace(/[　-鿿＀-￯]/g, " ").match(/\S+/g) || []).length;
  return Math.ceil(cjk * 1.05 + words * 1.3);
}

/** 单价（每百万 token），作者自己填；没填返回 null */
export async function priceOf(providerId, model) {
  const cfg = await getConfig();
  return (cfg.prices || {})[providerId + "/" + model] || null;
}
export function costOf(price, usage) {
  if (!price) return null;
  return (usage.input * (price.in || 0) + usage.output * (price.out || 0)) / 1e6;
}

/** 每次调用都记一笔：按天、按作品、按功能统计 */
export async function record({ providerId, model, feature, bookId, usage }) {
  const price = await priceOf(providerId, model);
  const row = { id: uid("u"), at: Date.now(), providerId, model, feature, bookId: bookId || null, input: usage.input, output: usage.output,
    cost: costOf(price, usage), currency: price ? price.cur || "USD" : null };
  await db.put("usage", row);
  bus.emit("ai:usage", { row });
  return row;
}

export async function usageRows() { return db.all("usage"); }
