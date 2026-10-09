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

// ---------------- 创意度、思考程度 ----------------
// 两样都分 5 档，另有第 0 档「默认」：不发这个参数，按模型自己的默认。各家参数名和取值不同，下面换算。
export const CREATIVITY = [
  { name: "默认", desc: "不指定，按模型自己的默认" },
  { name: "严谨", desc: "贴着原文和要求写，少发挥" },
  { name: "稳妥", desc: "小处换说法，整体不走样" },
  { name: "平衡", desc: "有自己的写法，不跑题" },
  { name: "活泼", desc: "多换说法、多加细节" },
  { name: "放飞", desc: "大胆发挥，每次出来差别大" },
];
export const THINKING = [
  { name: "默认", desc: "不指定，按模型自己的默认" },
  { name: "快答", desc: "几乎不想，最快最省" },
  { name: "浅想", desc: "想一下再写" },
  { name: "细想", desc: "理清前后再写" },
  { name: "深想", desc: "反复推敲，慢一些、贵一些" },
  { name: "想透", desc: "能想多久想多久，最慢最贵" },
];
const TEMP = { anthropic: [0.1, 0.3, 0.5, 0.75, 1], gemini: [0.2, 0.5, 0.9, 1.3, 1.7], openai: [0.2, 0.5, 0.8, 1.1, 1.4] };
const EFFORT = { anthropic: ["low", "medium", "high", "xhigh", "max"], openai: ["minimal", "low", "medium", "high", "xhigh"] };
const BUDGET = [0, 1024, 4096, 12288, 24576];   // Gemini 的 thinkingBudget
/** 思考也算在输出里：按档位多留的输出额度（第 0 档时 Claude 新模型默认也会想，留一点） */
export function thinkingExtra(protocol, level) {
  if (!level) return protocol === "anthropic" ? 1024 : 0;
  return [0, 512, 2048, 6144, 12288, 24576][level];
}
export function temperatureOf(protocol, level) { return level ? (TEMP[protocol] || TEMP.openai)[level - 1] : null; }

// 某个模型不接受的参数记下来（"temperature" / "think"），下次直接不发
async function unsupportedOf(providerId, model) { return ((await db.getKV("ai:unsupported", {}))[providerId + "/" + model]) || []; }
async function noteUnsupported(providerId, model, what) {
  const all = await db.getKV("ai:unsupported", {});
  const k = providerId + "/" + model;
  all[k] = [...new Set([...(all[k] || []), what])];
  await db.setKV("ai:unsupported", all);
}
export async function unsupportedParams(providerId, model) { return unsupportedOf(providerId, model); }

/**
 * 调用模型。messages: [{ role: "user"|"assistant", content }]，system 可选。
 * creativity、thinking：0–5 档（见 CREATIVITY、THINKING），0 不发参数。
 * onDelta(text) 收到一段就回调一次（流式）。返回 { text, usage: { input, output }, adjusted: [说明] }。
 * 模型不接受某一档时自动降一档，降不了就去掉这个参数再发，adjusted 里写明。
 * signal 可以中途取消。
 */
export async function chat({ providerId, conf, model, system = "", messages, maxTokens = 1024, temperature, creativity = 0, thinking = 0, onDelta, signal, cache = true }) {
  const p = providerOf(providerId);
  if (p.mock) return mockChat({ system, messages, maxTokens, creativity, thinking, onDelta, signal, conf });
  const base = endpoint(p, conf);
  const proto = p.protocol === "anthropic" || p.protocol === "gemini" ? p.protocol : "openai";
  const known = await unsupportedOf(providerId, model);
  let cLv = known.includes("temperature") ? 0 : creativity, tLv = known.includes("think") ? 0 : thinking;
  let useCompletionTokens = false;
  const adjusted = [];
  const build = () => {
    const temp = temperature != null ? temperature : temperatureOf(proto, cLv);
    const max = maxTokens + thinkingExtra(proto, tLv);
    if (proto === "anthropic") {
      const sys = system ? [{ type: "text", text: system, ...(cache && system.length > 2000 ? { cache_control: { type: "ephemeral" } } : {}) }] : undefined;
      return { url: base + "/v1/messages", body: { model, max_tokens: max, messages, stream: true, ...(sys ? { system: sys } : {}), ...(temp != null ? { temperature: temp } : {}),
        ...(tLv ? { thinking: { type: "adaptive" }, output_config: { effort: EFFORT.anthropic[tLv - 1] } } : {}) } };
    }
    if (proto === "gemini") {
      return { url: `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, body: {
        contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: max, ...(temp != null ? { temperature: temp } : {}), ...(tLv ? { thinkingConfig: { thinkingBudget: BUDGET[tLv - 1] } } : {}) },
      } };
    }
    return { url: base + "/chat/completions", body: {
      model, stream: true, stream_options: { include_usage: true }, ...(useCompletionTokens ? { max_completion_tokens: max } : { max_tokens: max }),
      messages: [...(system ? [{ role: "system", content: system }] : []), ...messages],
      ...(temp != null ? { temperature: temp } : {}), ...(tLv ? { reasoning_effort: EFFORT.openai[tLv - 1] } : {}),
    } };
  };
  let res;
  for (let tries = 0; ; tries++) {
    const { url, body } = build();
    try {
      res = await send(p, () => http(url, { method: "POST", headers: headersFor(p, conf.key), body: JSON.stringify(body), signal }));
      break;
    } catch (e) {
      if (e.category !== "param" || tries >= 5) throw e;
      if (e.param === "maxtok" && !useCompletionTokens) { useCompletionTokens = true; continue; }
      if (e.param === "temperature" && cLv && temperature == null) {
        cLv = 0; adjusted.push("这个模型不接受「创意度」，这次按模型默认发了");
        await noteUnsupported(providerId, model, "temperature");
        continue;
      }
      if (e.param === "think" && tLv) {
        // 报错里点名了现在这一档的取值：往中间挪一档再试；没点名就是整个参数不认
        const val = String(proto === "gemini" ? BUDGET[tLv - 1] : EFFORT[proto][tLv - 1]);
        if (tLv !== 3 && e.detail && e.detail.includes(val)) {
          tLv += tLv > 3 ? -1 : 1;
          adjusted.push(`这个模型不接受这一档思考程度，这次按「${THINKING[tLv].name}」发了`);
          continue;
        }
        tLv = 0; adjusted.push("这个模型不接受「思考程度」，这次按模型默认发了");
        await noteUnsupported(providerId, model, "think");
        continue;
      }
      throw e;
    }
  }
  let text = "";
  const usage = { input: 0, output: 0 };
  await readSSE(res, (data) => {
    let j;
    try { j = JSON.parse(data); } catch (_) { return; }
    let piece = "";
    if (p.protocol === "anthropic") {
      // 思考的内容（thinking_delta）不显示，只取正文
      if (j.type === "content_block_delta" && j.delta && j.delta.type !== "thinking_delta" && j.delta.text) piece = j.delta.text;
      if (j.type === "message_start" && j.message && j.message.usage) usage.input = (j.message.usage.input_tokens || 0) + (j.message.usage.cache_read_input_tokens || 0) + (j.message.usage.cache_creation_input_tokens || 0);
      if (j.type === "message_delta" && j.usage) usage.output = j.usage.output_tokens || usage.output;
      if (j.type === "error") throw aiError("request", { what: "接口返回了错误。", detail: data });
    } else if (p.protocol === "gemini") {
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      piece = parts.filter((x) => !x.thought).map((x) => x.text || "").join("");
      if (j.usageMetadata) { usage.input = j.usageMetadata.promptTokenCount || usage.input; usage.output = (j.usageMetadata.candidatesTokenCount || 0) + (j.usageMetadata.thoughtsTokenCount || 0) || usage.output; }
    } else {
      const c = j.choices && j.choices[0];
      if (c && c.delta && c.delta.content) piece = c.delta.content;
      if (j.usage) { usage.input = j.usage.prompt_tokens || usage.input; usage.output = j.usage.completion_tokens || usage.output; }
    }
    if (piece) { text += piece; onDelta && onDelta(piece, text); }
  }, signal);
  if (!text.trim()) throw aiError("content", { what: "模型没有返回内容。", why: tLv >= 3 ? "思考程度调得高时，输出额度可能都花在想上了。调大输出上限，或者降一档思考程度再试。" : "可能是内容被模型拒绝生成，或者输出长度上限设得太小。" });
  if (!usage.input) usage.input = estimateTokens(system + messages.map((m) => m.content).join(""));
  if (!usage.output) usage.output = estimateTokens(text);
  return { text, usage, adjusted };
}

/** 发一条极短的消息测试 Key 和模型能不能用 */
export async function testModel(providerId, conf, model) {
  const r = await chat({ providerId, conf, model, messages: [{ role: "user", content: "你好，回复「好」一个字。" }], maxTokens: 16 });
  return r;
}

/** 假接口：把最后一条消息里的文字原样改写一下（加「（改）」），一段段吐出来 */
async function mockChat({ system, messages, maxTokens, creativity = 0, thinking = 0, onDelta, signal, conf }) {
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
  // 消息里带【拒绝创意度】时假装不接受创意度（测试降档提示用）
  const adjusted = creativity && /【拒绝创意度】/.test(last) ? ["这个模型不接受「创意度」，这次按模型默认发了"] : [];
  return { text, usage: { input: estimateTokens(system + messages.map((m) => m.content).join("")), output: estimateTokens(text) }, adjusted, levels: { creativity, thinking } };
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
export function aiError(category, { what, why = "", detail = "", status = 0, param = "" } = {}) {
  const e = new Error(what);
  Object.assign(e, { ai: true, category, what, why, detail, status, param });
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
  // 参数不被接受：创意度、思考程度、输出上限的字段名（chat 里会自动调整后重发）
  if (s === 400 || s === 422) {
    if (/max_completion_tokens/.test(low)) throw aiError("param", { what: "这个模型要换一种输出上限的写法。", param: "maxtok", status: s, detail: raw });
    if (/temperature|top_p/.test(low)) throw aiError("param", { what: "这个模型不接受「创意度」。", param: "temperature", status: s, detail: raw });
    if (/reasoning|effort|thinking/.test(low) && !/context|too long/.test(low)) throw aiError("param", { what: "这个模型不接受这一档「思考程度」。", param: "think", status: s, detail: raw });
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

// ---------------- 绘画 ----------------
// 每家的「绘画接口」和「绘画模型」存在 providers[id].image = { api: "openai"|"gemini"|"none", models: [模型名] }。
// OpenAI 图片接口：POST {base}/images/generations（照草稿出高清时用 /images/edits 带上草稿图），ofoxAI 这类中转也一样；
// Gemini：generateContent，responseModalities 只要图片。单价按张算，和文字单价放在一起：prices["<提供商>/<模型>"] = { perImage（草稿每张）, perImageHd（高清每张，可空）, cur }。
export const IMAGE_APIS = [
  { id: "openai", name: "OpenAI 图片接口（/images）" },
  { id: "gemini", name: "Gemini 出图（generateContent）" },
  { id: "none", name: "不画图" },
];

/** 这一家默认用哪种绘画接口：Claude、DeepSeek 不画图，Gemini 用自己的，其余按 OpenAI 的走 */
export function defaultImageApi(providerId) {
  const p = providerOf(providerId);
  if (!p) return "none";
  if (p.protocol === "gemini") return "gemini";
  if (p.protocol === "anthropic" || providerId === "deepseek") return "none";
  return "openai";
}

const IMAGE_RE = /image|dall-?e|imagen|flux|seedream|seededit|cogview|kolors|recraft|ideogram|midjourney|stable-?diffusion|sdxl|hidream|wanx|jimeng/i;
/** 模型名看起来能画图（名字里带 image、dall-e、imagen、flux 这些） */
export const looksLikeImageModel = (id) => IMAGE_RE.test(String(id || ""));
/** 从拉到的模型列表里挑出能画图的，给「绘画模型」做候选 */
export function imageModelChoices(providerId, models) {
  if ((providerOf(providerId) || {}).mock) return ["mock-image"];
  return [...new Set((models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(looksLikeImageModel))];
}
/** 这一家的配置能不能画图：有 Key、选了绘画接口、至少一个绘画模型 */
export const paintReady = (c) => !!(c && c.key && c.image && c.image.api && c.image.api !== "none" && (c.image.models || []).length);
/** 能画图的几家 */
export async function paintProviders() {
  const cfg = await getConfig();
  return allProviders().filter((p) => paintReady(cfg.providers[p.id]));
}

const QUALITY = {
  gpt: { list: [["low", "低"], ["medium", "中"], ["high", "高"]], draft: "low", final: "high" },
  dalle3: { list: [["standard", "标准"], ["hd", "高清"]], draft: "standard", final: "hd" },
};
const px = (list) => list.map((id) => { const [w, h] = id.split("x").map(Number); return { id, w, h }; });
/**
 * 这个模型能出哪些尺寸、分不分画质。
 * 返回 { kind, sizes: [{ id, w, h, ratio? }], quality: { list, draft, final } | null, free（能自己填尺寸）, draftSize/finalSize（不分画质时草稿用小图） }
 */
export function imageCaps(providerId, model, api) {
  const p = providerOf(providerId) || {};
  const m = String(model || "").toLowerCase();
  if (p.mock) return { kind: "mock", sizes: px(["1024x1536", "1024x1024", "1536x1024", "768x1024"]), quality: QUALITY.gpt };
  if ((api || defaultImageApi(providerId)) === "gemini") {
    return { kind: "gemini", quality: null, sizes: ["3:4", "2:3", "1:1", "4:3", "3:2", "9:16", "16:9"].map((id) => { const [w, h] = id.split(":").map(Number); return { id, w, h, ratio: true }; }) };
  }
  if (/dall-?e-?3/.test(m)) return { kind: "dalle3", sizes: px(["1024x1792", "1024x1024", "1792x1024"]), quality: QUALITY.dalle3 };
  if (/dall-?e-?2/.test(m)) return { kind: "dalle2", sizes: px(["256x256", "512x512", "1024x1024"]), quality: null, draftSize: "512x512", finalSize: "1024x1024" };
  return { kind: "gpt", sizes: px(["1024x1536", "1024x1024", "1536x1024"]), quality: QUALITY.gpt, free: true };
}
/** 挑最接近目标比例（比如封面 3:4）的尺寸；不分画质的模型草稿用小图 */
export function pickSize(caps, ratio = "3:4", step = "draft") {
  if (caps.draftSize && caps.finalSize) return step === "final" ? caps.finalSize : caps.draftSize;
  const [rw, rh] = String(ratio).split(":").map(Number);
  const want = Math.log((rw || 3) / (rh || 4));
  const off = (s) => Math.abs(Math.log(s.w / s.h) - want);
  return caps.sizes.reduce((a, b) => (off(b) < off(a) - 1e-9 ? b : a), caps.sizes[0]).id;
}
/** 每张多少钱：高清没单独填就按草稿的算；没填返回 null */
export function imageUnitPrice(price, step = "draft") {
  if (!price) return null;
  const hd = Number(price.perImageHd), lo = Number(price.perImage);
  if (step === "final" && price.perImageHd !== "" && price.perImageHd != null && Number.isFinite(hd)) return hd;
  return price.perImage !== "" && price.perImage != null && Number.isFinite(lo) ? lo : null;
}

/**
 * 画图。返回 [{ dataUrl, w, h }]，数组上另挂 adjusted（自动调整过什么，给作者看的说明）。
 * size：OpenAI 是 "1024x1536" 这样，Gemini 是比例 "3:4"；quality：low/medium/high 或 standard/hd，不分画质的模型不给；
 * refImage：参考图的 dataUrl（照草稿出高清时带上）；signal 可以中途取消。
 * 模型不接受画质、尺寸、参考图时自动去掉再发，adjusted 里写明；内容被拦、账号没认证这些给中文说明。
 */
export async function image({ providerId, conf, model, prompt, size, quality, refImage, signal }) {
  const p = providerOf(providerId);
  if (!p) throw aiError("request", { what: "找不到这一家接口。", why: "可能已经删掉了它的接入。" });
  if (p.mock) return mockImage({ prompt, size, quality, refImage, signal, conf });
  const api = (conf && conf.image && conf.image.api) || defaultImageApi(providerId);
  if (api === "none") throw aiError("request", { what: `${p.name} 没有设绘画接口。`, why: "在「AI 接入」里给这一家选一个绘画接口。" });
  const known = await unsupportedOf(providerId, model);
  const args = { p, providerId, conf, model, prompt, size, quality, refImage, signal, known };
  try {
    return await (api === "gemini" ? geminiImage(args) : openaiImage(args));
  } catch (e) {
    throw imageError(e, p) || e;
  }
}

// 画图特有的几种拒绝：内容被拦、账号没做组织认证
function imageError(e, p) {
  if (!e || !e.ai) return null;
  const low = String(e.detail || "").toLowerCase();
  if ((e.status === 400 || e.status === 422 || e.category === "content") && /content.?policy|moderation|safety|blocked|violat|sensitive|不安全|违规/.test(low)) {
    return aiError("content", { what: "这张图被接口拦下了。", why: "提示词里可能有接口不让画的内容（真人、版权角色、暴力、露骨这类）。换个说法再试。", status: e.status, detail: e.detail });
  }
  if (e.category === "auth" && /verif|organization/.test(low)) {
    return aiError("auth", { what: `${p.name} 这个账号还不能用这个绘画模型。`, why: "OpenAI 的 gpt-image 模型要先在后台完成组织认证（Verify Organization）。也可以换一家中转接口。", status: e.status, detail: e.detail });
  }
  return null;
}

async function openaiImage({ p, providerId, conf, model, prompt, size, quality, refImage, signal, known }) {
  const base = endpoint(p, conf);
  const adjusted = [];
  let q = quality && !known.includes("quality") ? quality : null;
  let sz = size || "1024x1024";
  let ref = refImage && !known.includes("edit") ? refImage : null;
  let fmt = /dall-?e/i.test(model) ? "b64_json" : null;
  let res;
  for (let tries = 0; ; tries++) {
    try {
      if (ref) {
        // 照草稿重画：/images/edits，表单上传草稿图
        const fd = new FormData();
        fd.append("model", model); fd.append("prompt", prompt); fd.append("n", "1"); fd.append("size", sz);
        if (q) fd.append("quality", q);
        if (fmt) fd.append("response_format", fmt);
        const blob = dataUrlToBlob(ref);
        fd.append("image", blob, "draft." + (blob.type.split("/")[1] || "png").replace("jpeg", "jpg"));
        res = await send(p, () => http(base + "/images/edits", { method: "POST", headers: { authorization: "Bearer " + conf.key }, body: fd, signal }));
      } else {
        const body = { model, prompt, n: 1, size: sz, ...(q ? { quality: q } : {}), ...(fmt ? { response_format: fmt } : {}) };
        res = await send(p, () => http(base + "/images/generations", { method: "POST", headers: headersFor(p, conf.key), body: JSON.stringify(body), signal }));
      }
      break;
    } catch (e) {
      if (tries >= 4 || ["cancel", "network", "auth", "balance", "rate", "server"].includes(e.category)) throw e;
      const low = String(e.detail || "").toLowerCase();
      // 照草稿重画被拒（没有 /images/edits、模型不支持带图……）：去掉草稿图按普通出图再发一次；画质、尺寸、内容的问题另说
      if (ref && [400, 404, 405, 415, 422].includes(e.status) && !/quality|size|dimension|content.?policy|moderation|safety/.test(low)) {
        ref = null;
        adjusted.push("这个接口不能照草稿重画，这次按同一段提示词重新画了，画面会和草稿不一样");
        await noteUnsupported(providerId, model, "edit");
        continue;
      }
      if (q && /quality/.test(low)) {
        q = null;
        adjusted.push("这个模型不分画质，这次没带画质参数");
        await noteUnsupported(providerId, model, "quality");
        continue;
      }
      if (fmt && /response_format/.test(low)) { fmt = null; continue; }
      if (/size|dimension|resolution/.test(low) && sz !== "1024x1024") {
        adjusted.push(`这个模型不接受 ${sz.replace("x", "×")}，这次按 1024×1024 画了，裁剪时再调`);
        sz = "1024x1024";
        continue;
      }
      throw e;
    }
  }
  const j = await res.json();
  const mime = j.output_format ? "image/" + String(j.output_format).replace("jpg", "jpeg") : "image/png";
  const out = [];
  for (const d of j.data || []) {
    let url = "";
    if (d.b64_json) url = `data:${mime};base64,${d.b64_json}`;
    else if (d.url) url = /^data:/.test(d.url) ? d.url : await fetchAsDataUrl(p, d.url, signal);
    if (url) out.push(await measureImage(url));
  }
  if (!out.length) throw aiError("content", { what: "接口没有返回图片。", why: "可能是内容被拦下了，或者这个模型不能出图。", detail: JSON.stringify(j).slice(0, 2000) });
  out.adjusted = adjusted;
  return out;
}

async function geminiImage({ p, providerId, conf, model, prompt, size, refImage, signal, known }) {
  const base = endpoint(p, conf);
  const adjusted = [];
  let ratio = /^\d+:\d+$/.test(size || "") && !known.includes("ratio") ? size : null;
  let modalities = ["IMAGE"];
  let res;
  for (let tries = 0; ; tries++) {
    const parts = [];
    const m = refImage ? /^data:([^;,]+);base64,(.*)$/.exec(refImage) : null;
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    parts.push({ text: prompt });
    const body = { contents: [{ role: "user", parts }], generationConfig: { responseModalities: modalities, ...(ratio ? { imageConfig: { aspectRatio: ratio } } : {}) } };
    try {
      res = await send(p, () => http(`${base}/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: headersFor(p, conf.key), body: JSON.stringify(body), signal }));
      break;
    } catch (e) {
      if (tries >= 3 || ["cancel", "network", "auth", "balance", "rate", "server"].includes(e.category)) throw e;
      const low = String(e.detail || "").toLowerCase();
      if (ratio && /image_?config|aspect/.test(low)) {
        ratio = null;
        adjusted.push("这个模型不能指定比例，这次按它默认的比例画了，裁剪时再调");
        await noteUnsupported(providerId, model, "ratio");
        continue;
      }
      if (modalities.length === 1 && /modalit/.test(low)) { modalities = ["TEXT", "IMAGE"]; continue; }
      throw e;
    }
  }
  const j = await res.json();
  const cand = (j.candidates || [])[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const out = [];
  for (const part of parts) {
    const d = part.inlineData || part.inline_data;
    if (d && d.data) out.push(await measureImage(`data:${d.mimeType || d.mime_type || "image/png"};base64,${d.data}`));
  }
  if (!out.length) {
    const block = (j.promptFeedback && j.promptFeedback.blockReason) || (cand && cand.finishReason) || "";
    const said = parts.map((x) => x.text || "").join("").trim();
    throw aiError("content", {
      what: "模型没有画出图。",
      why: /SAFETY|BLOCK|PROHIBITED/i.test(block) ? "被安全规则拦下了。换个说法再试。"
        : said ? "模型只回了文字：" + said.slice(0, 80) : "这个模型可能不能出图。换一个名字里带 image 的模型。",
      detail: JSON.stringify(j).slice(0, 2000),
    });
  }
  out.adjusted = adjusted;
  return out;
}

function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(dataUrl || "");
  if (!m) return new Blob([], { type: "image/png" });
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

async function fetchAsDataUrl(p, url, signal) {
  try {
    const res = await http(url, { signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
  } catch (e) {
    if (e && e.name === "AbortError") throw aiError("cancel", { what: "已取消。" });
    throw aiError("network", {
      what: "图片画好了，但下载不下来。",
      why: isDesktop() ? "网络不通，或者图片链接已经过期。" : "图片链接不让网页直接读取（浏览器的跨域限制）。用桌面版就没有这个限制。",
      detail: url + "\n" + String(e && (e.stack || e.message || e)),
    });
  }
}

/** 读出图片的宽高：{ dataUrl, w, h } */
export function measureImage(dataUrl) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ dataUrl, w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => resolve({ dataUrl, w: 0, h: 0 });
    im.src = dataUrl;
  });
}

/** 假接口画图：按提示词的字挑颜色铺渐变，写上书名（或开头几个字）。提示词里带【报错】就出错，带【慢】就慢慢画（测试取消用） */
async function mockImage({ prompt, size, quality, refImage, signal, conf }) {
  if (conf && conf.key === "bad") throw aiError("auth", { what: "测试用假接口不认这个 Key。", why: "Key 填的是 bad。" });
  if (/【报错】/.test(prompt)) throw aiError("server", { what: "测试用假接口故意出错。", why: "提示词里带了【报错】。" });
  const wait = /【慢】/.test(prompt) ? 2500 : 160 + Math.random() * 160;
  const t0 = Date.now();
  while (Date.now() - t0 < wait) {
    if (signal && signal.aborted) throw aiError("cancel", { what: "已取消。" });
    await new Promise((r) => setTimeout(r, 30));
  }
  if (signal && signal.aborted) throw aiError("cancel", { what: "已取消。" });
  const [W, H] = /^\d+x\d+$/.test(size || "") ? size.split("x").map(Number) : [1024, 1024];
  const hd = /high|hd/.test(quality || "") || !!refImage;
  const k = hd ? 0.5 : 0.25;
  const w = Math.max(32, Math.round(W * k)), hh = Math.max(32, Math.round(H * k));
  const c = document.createElement("canvas");
  c.width = w; c.height = hh;
  const g = c.getContext("2d");
  let x = 7;
  for (const ch of prompt) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  const hue = (x + Math.floor(Math.random() * 40)) % 360;
  const grad = g.createLinearGradient(0, 0, w, hh);
  grad.addColorStop(0, `hsl(${hue} 55% 82%)`);
  grad.addColorStop(1, `hsl(${(hue + 50) % 360} 45% 60%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, hh);
  if (refImage) {
    const ref = await new Promise((resolve) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => resolve(null); im.src = refImage; });
    if (ref) { g.globalAlpha = 0.8; g.drawImage(ref, 0, 0, w, hh); g.globalAlpha = 1; }
  }
  g.fillStyle = "rgba(255, 255, 255, .9)";
  g.beginPath(); g.arc(w / 2, hh * 0.56, Math.min(w, hh) * 0.2, 0, Math.PI * 2); g.fill();
  const title = (prompt.match(/《([^》]{1,20})》/) || [])[1] || prompt.replace(/\s+/g, "").slice(0, 6) || "画";
  g.fillStyle = "#3a2a36";
  g.textAlign = "center";
  g.font = `600 ${Math.max(10, Math.round(w / 9))}px sans-serif`;
  g.fillText(title, w / 2, hh * 0.2);
  g.font = `${Math.max(9, Math.round(w / 14))}px sans-serif`;
  g.fillText(hd ? "高清" : "草稿", w / 2, hh * 0.9);
  const out = [{ dataUrl: c.toDataURL("image/png"), w, h: hh }];
  out.adjusted = [];
  return out;
}

/** 画图记一笔：按张算钱 */
export async function recordImage({ providerId, model, feature, bookId, count, step }) {
  const price = await priceOf(providerId, model);
  const unit = imageUnitPrice(price, step);
  const row = { id: uid("u"), at: Date.now(), providerId, model, feature, bookId: bookId || null, kind: "image", images: count, input: 0, output: 0,
    cost: unit != null ? unit * count : null, currency: unit != null ? price.cur || "USD" : null };
  await db.put("usage", row);
  bus.emit("ai:usage", { row });
  return row;
}
