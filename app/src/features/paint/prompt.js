// 绘画提示词怎么拼（纯函数，node 里能直接测）。
// 封面：开头锁着书名、作者名和一句「写清楚、和画面同一个画风」，作者删不掉，跟着书名、作者名改；
// 后面是作者自己写的画面（{书名} {作者} {简介} 这类变量照样能用）、勾上的常用要求；出高清时再加一句「照草稿重画」。
import { fillPrompt } from "../../core/prompts.js";

/** 用途：封面固定 3:4、裁成 600×800；角色、地点、物品能选 1:1 / 3:4 / 2:3 */
export const PURPOSES = {
  cover: { name: "封面制作", short: "封面", ratios: ["3:4"], out: [600, 800], use: "设为封面" },
  character: { name: "角色形象", short: "角色", ratios: ["3:4", "2:3", "1:1"], use: "用这张" },
  place: { name: "地点", short: "地点", ratios: ["3:4", "2:3", "1:1"], use: "用这张" },
  item: { name: "物品", short: "物品", ratios: ["1:1", "3:4", "2:3"], use: "用这张" },
};
export const purposeOf = (id) => (PURPOSES[id] ? id : "character");

/** 常用要求用在哪：全部 / 某一种用途 */
export const SCOPES = [["all", "全部用途"], ["cover", "封面"], ["character", "角色"], ["place", "地点"], ["item", "物品"]];
export const appliesTo = (p, purpose) => !p.for || p.for === "all" || p.for === purpose;

/** 默认的几条常用要求（给 GPT image 这类模型写的；作者可以改、删、加） */
export const DEFAULT_PRESETS = [
  { id: "body", name: "人体结构", for: "all", text: "人体结构正确：比例协调，每只手五根手指，关节弯曲自然，不多肢、不缺肢，五官端正。" },
  { id: "space", name: "空间透视", for: "all", text: "空间透视统一：远近关系清楚，地平线和消失点一致，物体大小随距离变化。" },
  { id: "light", name: "光影一致", for: "all", text: "光影一致：全图光源方向统一，投影方向和光源对得上。" },
  { id: "logic", name: "事物结构", for: "all", text: "事物结构合理：物体完整，前后遮挡关系对，物体之间不粘连、不穿插，不出现乱码文字和假标志。" },
  { id: "title", name: "书名清楚", for: "cover", text: "书名和作者名清晰可读：字形完整，没有错别字和多余笔画，字体和画风统一，作为封面设计的一部分，不挡住主体。" },
  { id: "layout", name: "封面构图", for: "cover", text: "封面构图：3:4 竖版，主体突出，给书名留出位置，四边留一点余量方便裁切。" },
  { id: "style", name: "画风统一", for: "all", text: "画风统一：全图同一种画风，不把写实和卡通混在一起。" },
  { id: "clean", name: "画质干净", for: "all", text: "画质：细节清楚，线条干净，没有水印、签名和多余的文字。" },
  { id: "figure", name: "角色立绘", for: "character", text: "角色立绘：单人，全身或半身，姿势自然，背景简洁，看得清服装和发型。" },
  { id: "scene", name: "场景层次", for: "place", text: "场景：远、中、近三层，有一眼能认出的地标，人物很小或者没有人物。" },
  { id: "object", name: "物品展示", for: "item", text: "物品展示：单个物品放在画面中间，背景干净，看得清材质和细节，画面里没有人和手。" },
];

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * 封面锁着的部分：[{ k: "title"|"author"|"rule", text, empty? }]。
 * 书名空着时写「（书名还空着）」提醒；作者空着就不写作者那一条。
 */
export function lockParts(meta = {}) {
  const t = clean(meta.title), a = clean(meta.author);
  const parts = [{ k: "title", text: `书名：《${t || "（书名还空着）"}》`, empty: !t }];
  if (a) parts.push({ k: "author", text: `作者：${a}` });
  parts.push({ k: "rule", text: a
    ? "封面上清楚地写出书名和作者名，不写错字；字体和排版跟画面同一个画风，做成封面设计的一部分。"
    : "封面上清楚地写出书名，不写错字；字体和排版跟画面同一个画风，做成封面设计的一部分。" });
  return parts;
}

/** 照草稿出高清时加在最后的一句 */
export const HIRES_LINE = "照参考图重画成高清：构图、人物、配色和文字的位置都不变，把细节、线条和文字画清楚。";

/**
 * 拼出最终发送的提示词。
 * { purpose, meta: { title, author, intro, name }, free（自己写的）, picked（勾上的常用要求）, step: "draft"|"final", useRef }
 * 返回 { text, locks（封面锁着的几条）, rest（锁着的以外）, missing（没有值的变量）}
 */
export function composePrompt({ purpose = "cover", meta = {}, free = "", picked = [], step = "draft", useRef = true } = {}) {
  const vars = { 书名: clean(meta.title), 作者: clean(meta.author), 简介: String(meta.intro || "").trim(), 名字: clean(meta.name) };
  const f = fillPrompt(free, vars);
  const locks = purpose === "cover" ? lockParts(meta) : [];
  const head = locks.length ? [locks.filter((x) => x.k !== "rule").map((x) => x.text).join("　"), locks.find((x) => x.k === "rule").text].join("\n") : "";
  const parts = [];
  if (f.text.trim()) parts.push(f.text.trim());
  const reqs = picked.filter((p) => p && String(p.text || "").trim() && appliesTo(p, purpose));
  if (reqs.length) parts.push("要求：\n" + reqs.map((p) => "- " + String(p.text).trim()).join("\n"));
  if (step === "final" && useRef) parts.push(HIRES_LINE);
  const rest = parts.join("\n\n");
  return { text: [head, rest].filter(Boolean).join("\n\n"), locks, head, rest, missing: f.missing };
}

/** 没起名字时用正文第一行（最多 16 个字），存进提示词库用 */
export function nameOf(text) {
  const line = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  const chars = [...line];
  return chars.length ? chars.slice(0, 16).join("") + (chars.length > 16 ? "…" : "") : "绘画提示词";
}
