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
