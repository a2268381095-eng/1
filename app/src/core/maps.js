// 分层地图的数据。每本书一条 kv "maps:<书id>" = { root: 最上层地图 id, maps: { id: 地图 } }
//   地图 { id, name, parentId, w, h, bg: { id, w, h } | null, items: [...] }，坐标都是这张图自己的（左上角 0,0）
//   items：pen 画笔 { color, width, points } · area 地形色块 { terrain, points } · line 河流 / 道路 / 边界 { kind, points }
//          text 文字 { x, y, text, size } · pin 图钉 { x, y, cardId?, label? } · portal 子地图入口 { x, y, w, h, mapId }
// 底图存在 kv "mapimg:<id>"（dataURL）。改动都走 edit()：一次算一步撤销，写完发 maps:changed { bookId }。
import { db, uid } from "./db.js";
import { bus } from "./bus.js";
import { undo as appUndo } from "./undo.js";

const key = (bookId) => "maps:" + bookId;
const clone = (x) => JSON.parse(JSON.stringify(x));

export const TERRAINS = [
  { id: "forest", name: "森林", color: "#6f9e6a" }, { id: "water", name: "水域", color: "#7fb0d8" }, { id: "mountain", name: "山地", color: "#a3907c" },
  { id: "plain", name: "平原", color: "#bdd08f" }, { id: "desert", name: "沙漠", color: "#e2c98f" }, { id: "snow", name: "雪原", color: "#dde7ef" },
  { id: "swamp", name: "沼泽", color: "#8d9a6c" }, { id: "city", name: "城镇", color: "#c8b6a5" },
];
export const LINES = [{ id: "river", name: "河流" }, { id: "road", name: "道路" }, { id: "border", name: "边界" }];
export const PEN_COLORS = ["#4a3f3a", "#c86394", "#4f9a90", "#c08f45", "#6f84c8", "#d97f63"];
export const LEVEL_NAMES = ["大陆", "国家", "边境", "村庄"];

export function newMap(name, parentId = null, w = 1600, h = 1000) { return { id: uid("mp"), name, parentId, w, h, bg: null, items: [] }; }
export const newItem = (type, data) => ({ id: uid("mi"), type, ...data });

/** 读这本书的地图；还没有就建一张空的最上层存起来（不算一步撤销），以后每次读到的都是同一张 */
let creating = new Map();
export async function getMaps(bookId) {
  const d = await db.getKV(key(bookId), null);
  if (d && d.root && d.maps && d.maps[d.root]) return d;
  if (!creating.has(bookId)) creating.set(bookId, (async () => {
    const root = newMap(LEVEL_NAMES[0]);
    const fresh = { root: root.id, maps: { [root.id]: root } };
    await db.setKV(key(bookId), fresh);
    return fresh;
  })().finally(() => setTimeout(() => creating.delete(bookId), 0)));
  return JSON.parse(JSON.stringify(await creating.get(bookId)));
}

/** 从最上层到这张图的一串（面包屑） */
export function pathTo(data, mapId) {
  const out = [];
  for (let m = data.maps[mapId]; m && out.length < 50; m = m.parentId ? data.maps[m.parentId] : null) out.unshift(m);
  return out;
}
/** 这张图和它下面所有层的 id（删入口时一起删） */
export function subtree(data, mapId) {
  const out = [mapId];
  for (let i = 0; i < out.length; i++) for (const m of Object.values(data.maps)) if (m.parentId === out[i]) out.push(m.id);
  return out;
}

/** 改地图：fn(data) 直接改副本。前后一样就什么都不做；不一样就写进去、推一步撤销 */
export async function edit(bookId, label, fn, { silent = false } = {}) {
  const before = await getMaps(bookId);
  const after = clone(before);
  const result = await fn(after);
  if (JSON.stringify(before) === JSON.stringify(after)) return { result, entry: null };
  const write = async (d) => { await db.setKV(key(bookId), d); bus.emit("maps:changed", { bookId }); };
  await write(after);
  const entry = silent ? null : appUndo.push({ label, map: true, undo: () => write(before), redo: () => write(after) });
  return { result, entry };
}

export async function putMapImage(dataUrl) { const id = uid("mg"); await db.setKV("mapimg:" + id, dataUrl); return id; }
export const getMapImage = (id) => db.getKV("mapimg:" + id, null);
