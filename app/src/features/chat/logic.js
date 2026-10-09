// 对话的纯逻辑：发给模型的历史、上下文长度估算、标题、分叉。不碰界面和存储，方便测试。
import { estimateTokens } from "../../core/ai.js";

/** 一条消息实际发给模型的文字（作者用了提示词时，存的是拼好的那一份） */
export const sentText = (m) => (m && (m.sent || m.content)) || "";

/** 这个对话之前的消息 → runAI 的 history。空的去掉，连着两条同一方说的话并成一条（有的接口要求一问一答交替） */
export function historyOf(messages = []) {
  const out = [];
  for (const m of messages) {
    const content = sentText(m);
    if (!content.trim() || (m.role !== "user" && m.role !== "assistant")) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + content;
    else out.push({ role: m.role, content });
  }
  return out;
}

/** 当前上下文长度（约）：之前的对话 + 输入框里还没发的字 + 正在流式回来的字 */
export function ctxTokens(messages = [], draft = "", live = "") {
  return messages.reduce((n, m) => n + estimateTokens(sentText(m)), 0) + estimateTokens(draft) + estimateTokens(live);
}

/** 上下文条的刻度：16k 记满，超过 12k 提醒一下 */
export const CTX_FULL = 16000;
export const CTX_BIG = 12000;
export const ctxFill = (n) => Math.max(0, Math.min(100, (n / CTX_FULL) * 100));

/** 用第一句话当标题 */
export function titleFrom(text, max = 18) {
  const t = String(text || "").replace(/【\/?原文】/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "新对话";
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : t;
}

/** runner 在提示词留空时会把这次说的话包成【原文】…【/原文】；和这个一样就不用另存「实际发送」 */
export const wrappedInput = (input) => `【原文】\n${input}\n【/原文】`;
export function extraSent(sent, input) {
  if (!sent) return undefined;
  const s = sent.trim();
  return s === wrappedInput(input).trim() || s === input.trim() ? undefined : sent;
}

/** 从第 index 条（含）分叉：复制到这一条为止的消息 */
export function forkMessages(messages, index) {
  return messages.slice(0, index + 1).map((m) => ({ ...m }));
}

/** 分叉的标题：原标题 · 分叉（第二个起带编号） */
export function forkTitle(title, n) {
  const base = String(title || "新对话").replace(/ · 分叉( \d+)?$/, "");
  return base + " · 分叉" + (n > 1 ? " " + n : "");
}

/** 列表里按最近用过的排 */
export const byRecent = (list) => [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
