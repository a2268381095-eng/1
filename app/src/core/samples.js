// 文风样本：作者存下来的几段文字。调用 AI 时在确认卡里选一段，AI 照着它的语气、句式、用词来写；默认不用。
import { db, uid } from "./db.js";
import { bus } from "./bus.js";

const KEY = "ai:samples";

/** 用得多的排前面，其次是新存的 */
export async function listSamples() {
  const all = await db.getKV(KEY, []);
  return all.slice().sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.at || 0) - (a.at || 0));
}

async function write(all) {
  await db.setKV(KEY, all);
  bus.emit("samples:changed", {});
}

export async function saveSample(s) {
  const all = await db.getKV(KEY, []);
  const text = String(s.text || "").trim();
  const row = { ...s, id: s.id || uid("ss"), name: String(s.name || "").trim() || text.replace(/\s+/g, "").slice(0, 12) || "未命名样本", text, at: s.at || Date.now(), uses: s.uses || 0 };
  const i = all.findIndex((x) => x.id === row.id);
  if (i >= 0) all[i] = row; else all.push(row);
  await write(all);
  return row;
}

/** 删掉一条，返回删掉的那条（撤销时原样放回） */
export async function deleteSample(id) {
  const all = await db.getKV(KEY, []);
  const old = all.find((x) => x.id === id) || null;
  await write(all.filter((x) => x.id !== id));
  return old;
}

export async function noteSampleUse(id) {
  const all = await db.getKV(KEY, []);
  const s = all.find((x) => x.id === id);
  if (s) { s.uses = (s.uses || 0) + 1; await write(all); }
}

/** 拼进发送内容的那一段（确认卡「实际发送的内容」里看得到） */
export function sampleBlock(text) {
  return `【文风样本】\n下面这段只用来参照语气、句式和用词习惯，不要照搬里面的内容和情节：\n${text}\n【/文风样本】`;
}
