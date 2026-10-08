// 暂存盒：所有 AI 生成的文字（以后还有图片）自动进来，按作品、时间、功能分类。
// 每个功能界面里有自己的暂存盒抽屉，只列这个功能产生的结果；总的暂存盒负责汇总、搜索和清理。
import { db, uid } from "./db.js";
import { bus } from "./bus.js";

/** 功能名（暂存盒里按这个分类） */
export const FEATURES = {
  rewrite: "选中调用",
  chapterName: "起章名",
  intro: "生成简介",
  summary: "章节摘要",
  chat: "对话",
  other: "其他",
};

export async function addStash(item) {
  const row = { id: uid("s"), at: Date.now(), kind: "text", pinned: false, tags: [], ...item };
  await db.put("stash", row);
  bus.emit("stash:changed", { added: row });
  return row;
}

/** filter: { bookId, feature, ref（比如某一章、某张卡）, q 关键词, tag, pinnedOnly } */
export async function listStash(filter = {}) {
  let rows = filter.bookId ? await db.byIndex("stash", "bookId", filter.bookId) : await db.all("stash");
  if (filter.feature) rows = rows.filter((r) => r.feature === filter.feature);
  if (filter.ref) rows = rows.filter((r) => r.ref === filter.ref);
  if (filter.tag) rows = rows.filter((r) => (r.tags || []).includes(filter.tag));
  if (filter.pinnedOnly) rows = rows.filter((r) => r.pinned);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    rows = rows.filter((r) => [r.text, r.title, r.prompt, (r.tags || []).join(" ")].join("\n").toLowerCase().includes(q));
  }
  return rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.at - a.at);
}

export async function updateStash(id, patch) {
  const row = await db.get("stash", id);
  if (!row) return null;
  Object.assign(row, patch);
  await db.put("stash", row);
  bus.emit("stash:changed", { updated: row });
  return row;
}

/** 删除几条，返回被删的原样（撤销时用 restoreStash 放回去） */
export async function deleteStash(ids) {
  const rows = [];
  await db.tx(["stash"], async (s) => {
    for (const id of ids) {
      const r = await new Promise((res) => { const q = s.stash.get(id); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
      if (r) { rows.push(r); s.stash.delete(id); }
    }
  });
  bus.emit("stash:changed", { deleted: ids });
  return rows;
}

export async function restoreStash(rows) {
  await db.tx(["stash"], (s) => rows.forEach((r) => s.stash.put(r)));
  bus.emit("stash:changed", { restored: rows.map((r) => r.id) });
}
