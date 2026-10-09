// 设定卡的图：没有图时按分类画一个占位（大字 + 线条剪影，各分类一眼分得清），有图时显示图。
// 上传、拖进来、复制图片后按 Ctrl+V 都行；图缩到最长边 1024 存本地，卡上另存一张小缩略图。
import { h, icon, toast } from "../../core/ui.js";
import { vars } from "./bits.js";

const SIL = {
  person: '<circle cx="32" cy="22" r="10"/><path d="M11 60c0-13 9.4-21 21-21s21 8 21 21z"/>',
  place: '<path d="M3 56l17-24 9 11 10-16 22 29z"/><circle cx="48" cy="15" r="6"/>',
  item: '<path d="M10 20h44v10H10z"/><path d="M13 32h38v24H13z"/><path d="M28 28h8v10h-8z" class="cut"/>',
  faction: '<path d="M17 6h4v54h-4z"/><path d="M21 9h32l-7 10 7 10H21z"/>',
  skill: '<path d="M32 5c7 10 17 16 17 30a17 17 0 0 1-34 0c0-8 4-13 9-16 1 6 4 10 8 11-3-9 0-17 0-25z"/>',
  creature: '<ellipse cx="32" cy="44" rx="13" ry="11"/><circle cx="16" cy="29" r="5.5"/><circle cx="26" cy="19" r="5.5"/><circle cx="38" cy="19" r="5.5"/><circle cx="48" cy="29" r="5.5"/>',
  festival: '<path d="M30 4h4v8h-4z"/><path d="M22 12h20l6 8v22l-6 8H22l-6-8V20z"/><path d="M30 50h4v10h-4z"/>',
  other: '<path d="M32 4l7 21 21 7-21 7-7 21-7-21-21-7 21-7z"/>',
};

/** 占位图：分类的颜色、占位字、剪影。big：卡片顶上那一大块 */
export function placeholder(cat, { big = false } = {}) {
  const kind = SIL[cat.kind] ? cat.kind : "other";
  const sil = h("span.lr-ph-sil", { "aria-hidden": "true", html: `<svg viewBox="0 0 64 64" fill="currentColor">${SIL[kind]}</svg>` });
  return h("span.lr-ph" + (big ? ".big" : ""), { "data-kind": kind, style: vars({ "--c": cat.color || "var(--accent)" }), "aria-hidden": big ? null : "true" },
    sil, h("span.lr-ph-g", {}, (cat.glyph || "设").slice(0, 2)));
}

// ---------------- 读图、缩图 ----------------
async function decode(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch (_) { /* 换个办法 */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("这张图打不开"));
      img.src = url;
    });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function encode(src, max, q) {
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  const k = Math.min(1, max / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)), hgt = Math.max(1, Math.round(h0 * k));
  const c = document.createElement("canvas");
  c.width = w; c.height = hgt;
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, hgt);
  let url = c.toDataURL("image/webp", q);
  if (!url.startsWith("data:image/webp")) {
    // 不支持 webp 的浏览器：铺白底存 jpeg
    g.globalCompositeOperation = "destination-over";
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, hgt);
    url = c.toDataURL("image/jpeg", q);
  }
  return { url, w, h: hgt };
}

/** 一张图（文件、剪贴板、dataURL）→ { data 最长边 1024, thumb 最长边 320, w, h } */
export async function readImage(src) {
  let blob = src;
  if (typeof src === "string") blob = await (await fetch(src)).blob();
  if (!blob || !/^image\//.test(blob.type || "image/")) throw new Error("这不是图片");
  const bmp = await decode(blob);
  const big = encode(bmp, 1024, 0.9);
  const small = encode(bmp, 320, 0.84);
  if (bmp.close) bmp.close();
  return { data: big.url, thumb: small.url, w: big.w, h: big.h };
}

export function imageFrom(dt) {
  if (!dt) return null;
  for (const it of dt.items || []) if (it.kind === "file" && /^image\//.test(it.type)) return it.getAsFile();
  for (const f of dt.files || []) if (/^image\//.test(f.type)) return f;
  return null;
}

/**
 * 卡片顶上的形象区。opts:
 *   cat, img（{ id, thumb } 或 null）, label（「原形象」「战斗装」）, loadFull(id) → dataURL
 *   onFile(blob)  选了图 / 拖进来 / 粘贴
 *   onPaint()     点「AI 生成」
 *   onClear()     去掉这张图
 */
export function imageArea(opts) {
  const { cat, img } = opts;
  const file = h("input", { type: "file", accept: "image/*", hidden: true, "aria-hidden": "true", tabindex: "-1" });
  const pick = () => file.click();
  file.addEventListener("change", () => { const f = file.files && file.files[0]; file.value = ""; if (f) opts.onFile(f); });
  const btn = (ico, text, fn, cls = "") => {
    const b = h("button.btn.small" + cls, { type: "button" }, icon(ico), h("span", {}, text));
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  const up = btn("upload", img ? "换一张" : "上传", pick, ".lr-up");
  const ai = btn("sparkle", "AI 生成", () => opts.onPaint(), ".lr-paint");
  const box = h("div.lr-img" + (img ? ".has" : ""), {
    tabindex: "0", role: "group",
    "aria-label": (opts.label || "形象") + "：可以上传、拖进来，或复制图片后在这里按 Ctrl+V",
    style: vars({ "--c": cat.color || "var(--accent)" }),
  });
  if (img) {
    const pic = h("img.lr-img-pic", { alt: opts.label || "形象", src: img.thumb, draggable: "false" });
    if (opts.loadFull) opts.loadFull(img.id).then((u) => { if (u) pic.src = u; }).catch(() => {});
    const clear = h("button.icon-btn.lr-img-x", { type: "button", title: "去掉这张图", "aria-label": "去掉这张图" }, icon("close"));
    clear.addEventListener("click", (e) => { e.stopPropagation(); opts.onClear(); });
    box.append(h("div.lr-img-frame", {}, pic), h("div.lr-img-acts", {}, up, ai), clear);
  } else {
    box.append(h("div.lr-img-frame", {}, placeholder(cat, { big: true })),
      h("div.lr-img-empty", {},
        h("p.lr-img-none", {}, opts.label && opts.label !== "原形象" ? `「${opts.label}」还没有图` : "还没有形象"),
        h("div.lr-img-acts", {}, up, ai),
        h("p.lr-img-hint", {}, "也可以拖进来，或复制图片后在这里按 Ctrl+V")));
  }
  box.append(file);
  // 拖进来
  box.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer.types || [])].includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    box.classList.add("drop");
  });
  box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("drop"); });
  box.addEventListener("drop", (e) => {
    box.classList.remove("drop");
    const f = imageFrom(e.dataTransfer);
    if (!f) return;
    e.preventDefault();
    opts.onFile(f);
  });
  // 选中这一块时粘贴
  box.addEventListener("paste", (e) => {
    const f = imageFrom(e.clipboardData);
    if (!f) { toast("剪贴板里没有图片"); return; }
    e.preventDefault();
    opts.onFile(f);
  });
  box.addEventListener("click", (e) => { if (!img && e.target === box) pick(); });
  return box;
}
