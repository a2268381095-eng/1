// 自己上传的字体：文件存在 kv "font:<id>"（{ name, file, size, data: ArrayBuffer }），
// settings.customFonts 记 { id, name }。字体在 CSS 里的名字就是 id（main.js 的 applyLook 按 id 取）。
import { db } from "../../core/db.js";

const faces = new Map();      // id → FontFace
export const broken = new Set();  // 启动时没加载出来的字体 id

export const fontKey = (id) => "font:" + id;
export const readFont = (id) => db.getKV(fontKey(id), null);
export const writeFont = (id, rec) => db.setKV(fontKey(id), rec);
export const removeFont = (id) => db.del("kv", fontKey(id));

/** 用文件内容加载字体（复制一份给 FontFace，原来的留着存库） */
export async function loadFace(id, data) {
  unloadFace(id);
  const face = new FontFace(id, data.slice(0));
  await face.load();
  document.fonts.add(face);
  faces.set(id, face);
  broken.delete(id);
  return face;
}

export function unloadFace(id) {
  const f = faces.get(id);
  if (f) { document.fonts.delete(f); faces.delete(id); }
}

export const isLoaded = (id) => faces.has(id);

/** 启动时把上传过的字体都加载好，返回没加载出来的 [{ font, error }] */
export async function loadAll(customFonts = []) {
  const fails = [];
  await Promise.all(customFonts.map(async (f) => {
    try {
      const rec = await readFont(f.id);
      if (!rec || !rec.data) throw new Error("字体文件不在了（kv " + fontKey(f.id) + " 是空的）");
      await loadFace(f.id, rec.data);
    } catch (e) {
      broken.add(f.id);
      fails.push({ font: f, error: e });
    }
  }));
  return fails;
}
