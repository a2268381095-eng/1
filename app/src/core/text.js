// 文字工具：字数、章节编号

/** 字数：汉字和中文标点各算 1；连续的英文字母或数字算 1 个词；空白不算。 */
export function countWords(text) {
  if (!text) return 0;
  let n = 0;
  const re = /[A-Za-z0-9_'’\-.]+|[^\sA-Za-z0-9_'’\-.]/g;
  while (re.exec(text)) n++;
  return n;
}

const DIGITS = "零一二三四五六七八九";
const UNITS = ["", "十", "百", "千"];

/** 1 → 一，12 → 十二，105 → 一百零五，2024 → 两千零二十四（章节号常见写法） */
export function zhNumber(num) {
  if (num <= 0) return String(num);
  if (num >= 10000) {
    const high = Math.floor(num / 10000), low = num % 10000;
    return zhNumber(high) + "万" + (low ? (low < 1000 ? "零" : "") + zhNumber(low) : "");
  }
  const s = String(num);
  let out = "", zero = false;
  for (let i = 0; i < s.length; i++) {
    const d = +s[i], unit = UNITS[s.length - 1 - i];
    if (d === 0) { zero = out.length > 0; continue; }
    if (zero) { out += "零"; zero = false; }
    out += (d === 2 && unit === "千" ? "两" : DIGITS[d]) + unit;
  }
  if (out.startsWith("一十")) out = out.slice(1);
  return out;
}

/** 章节号：第一章 / 第1章 */
export function chapterLabel(index, style = "zh") {
  return "第" + (style === "num" ? index : zhNumber(index)) + "章";
}

/** 卷号：第一卷 */
export function volumeLabel(index, style = "zh") {
  return "第" + (style === "num" ? index : zhNumber(index)) + "卷";
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function todayKey(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  if (todayKey(d) === todayKey(now)) return "今天 " + hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (todayKey(d) === todayKey(y)) return "昨天 " + hm;
  return (d.getFullYear() === now.getFullYear() ? "" : d.getFullYear() + "年") + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
}
