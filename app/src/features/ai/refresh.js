// 模型列表自动刷新：每家一天最多拉一次（打开软件过一会儿在后台拉），新出的模型记下第一次见到的时间，
// 确认卡里标「新」（七天内）。拉不到（断网、跨域、Key 失效）就安静地跳过，下次再试；手动「拉取模型列表」照旧。
import { getConfig, saveConfig, listModels, providerOf } from "../../core/ai.js";
import { db } from "../../core/db.js";
import { toast } from "../../core/ui.js";

const DAY = 864e5;
const NEW_FOR = 7 * DAY;
const idOf = (m) => (typeof m === "string" ? m : m.id);
const keyOf = (providerId, model) => providerId + "\u0001" + model;
let running = null;

/** 拉一遍。force：不管上次什么时候拉的；返回 [{ providerId, name, models: [新模型 id] }] */
export function refreshModels({ force = false, quiet = false } = {}) {
  if (running) return running;
  running = (async () => {
    const cfg = await getConfig();
    const seen = await db.getKV("ai:newModels", {});
    const found = [];
    let changed = false;
    for (const [id, c] of Object.entries(cfg.providers || {})) {
      const p = providerOf(id);
      if (!p || !c || !c.key || !c.ok) continue;
      if (p.mock && !force) continue;                       // 测试用的假接口不自动拉
      if (!force && c.modelsAt && Date.now() - c.modelsAt < DAY) continue;
      let list;
      try { list = await listModels(id, c); } catch (_) { continue; }
      if (!list || !list.length) continue;
      const old = (c.models || []).map((m) => (typeof m === "string" ? { id: m, name: m } : m));
      const had = new Set(old.map(idOf));
      const got = new Set(list.map((m) => m.id));
      const added = list.filter((m) => !had.has(m.id));
      // 新拉到的按提供商给的顺序；以前有、这次没拉到的（手动加的、下架的）留在后面
      cfg.providers[id] = { ...c, models: [...list, ...old.filter((m) => !got.has(m.id))], modelsAt: Date.now() };
      changed = true;
      if (added.length && old.length) {
        added.forEach((m) => { seen[keyOf(id, m.id)] = Date.now(); });
        found.push({ providerId: id, name: p.custom ? c.name || "自定义接口" : p.name, models: added.map((m) => m.id) });
      }
    }
    if (changed) await saveConfig(cfg);
    if (found.length) {
      for (const k of Object.keys(seen)) if (Date.now() - seen[k] > NEW_FOR * 2) delete seen[k];
      await db.setKV("ai:newModels", seen);
      if (!quiet) {
        const f = found[0], n = found.reduce((t, x) => t + x.models.length, 0);
        toast(`${f.name} 有新模型：${f.models.slice(0, 2).join("、")}${n > 2 ? ` 等 ${n} 个` : ""}。调用 AI 时在模型列表里标着「新」。`, { timeout: 6000 });
      }
    }
    return found;
  })().finally(() => { running = null; });
  return running;
}

/** 七天内第一次见到的模型：确认卡里标「新」 */
export async function newModelSet() {
  const seen = await db.getKV("ai:newModels", {});
  return new Set(Object.keys(seen).filter((k) => Date.now() - seen[k] < NEW_FOR));
}
export const newKey = keyOf;

/** 打开软件 10 秒后拉一次，之后每 6 小时看一下（一天之内拉过的跳过） */
export function startModelRefresh() {
  setTimeout(() => refreshModels().catch(() => {}), 10000);
  setInterval(() => refreshModels().catch(() => {}), 6 * 3600e3);
}
