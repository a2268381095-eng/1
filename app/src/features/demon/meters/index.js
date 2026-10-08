// 码字进度的样子：每套风格一种（不只是换名字的进度条）。
// 每种：{ w, h（内部像素尺寸，按 3 倍画）, animated（平时也要动）, draw(g, s), label?(s) }
// s：{ pct 0–1, shown 动画中的 pct, words 今天写了多少, goal 目标, done 达成, t 秒, bump 离上次涨字过了几秒, c 颜色 { accent, ink, paper, surface, line, side, muted, faint, accentSoft } }
import magical from "./magical.js";
import sailor from "./sailor.js";
import hanfu from "./hanfu.js";
import gothic from "./gothic.js";
import detective from "./detective.js";
import adventurer from "./adventurer.js";

/** 通用：像素进度条，末端一颗心 */
const bar = {
  w: 40, h: 6, animated: true,
  draw(g, s) {
    const { c } = s;
    g.fillStyle = c.side; g.fillRect(0, 1, 40, 4);
    g.fillStyle = c.ink; g.fillRect(0, 0, 40, 1); g.fillRect(0, 5, 40, 1); g.fillRect(0, 0, 1, 6); g.fillRect(39, 0, 1, 6);
    const n = Math.round(s.shown * 38);
    for (let x = 0; x < n; x++) { g.fillStyle = x % 3 === 2 ? c.accentSoft : s.done ? "#f2b51c" : c.accent; g.fillRect(1 + x, 1, 1, 4); }
    const sh = (s.t % 7) / 7 * 60 - 10;
    if (sh > 0 && sh < n) { g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect(1 + Math.floor(sh), 1, 2, 4); }
  },
};

export const METERS = { magical, sailor, hanfu, gothic, detective, adventurer };
export const meterFor = (id) => METERS[id] || bar;
