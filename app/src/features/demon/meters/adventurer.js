// adventurer 这套的码字进度：RPG 的经验条。左边一面冒险者小盾（剑与罗盘），右边一根皮框镶钉的经验槽。
// 平时：槽里的绿光慢慢流，满格的头上有一颗亮点一闪一闪，盾上的剑尖隔一会儿亮一下；
// 刚涨字：经验槽亮一下，「+XP」从槽头往上飘；写满：整条变金色，光一道道扫过，盾变金，「LV UP!」在上面跳。

// 3×5 像素字
const FONT = {
  E: ["111", "100", "110", "100", "111"], X: ["101", "101", "010", "101", "101"], P: ["110", "101", "110", "100", "100"],
  L: ["100", "100", "100", "100", "111"], V: ["101", "101", "101", "101", "010"], U: ["101", "101", "101", "101", "111"],
  "+": ["000", "010", "111", "010", "000"], "!": ["1", "1", "1", "0", "1"],
};
function text(g, str, x, y, col, edge) {
  const dots = [];
  for (const ch of str) {
    const f = FONT[ch];
    if (!f) { x += 2; continue; }
    f.forEach((r, j) => [...r].forEach((b, i) => { if (b === "1") dots.push([x + i, y + j]); }));
    x += f[0].length + (edge ? 2 : 1);
  }
  // 描一圈边，浅色深色底上都看得清
  if (edge) { g.fillStyle = edge; for (const [a, b] of dots) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.fillRect(a + dx, b + dy, 1, 1); }
  g.fillStyle = col; for (const [a, b] of dots) g.fillRect(a, b, 1, 1);
  return x;
}
const textW = (str, gap = 1) => [...str].reduce((n, ch) => n + (FONT[ch] ? FONT[ch][0].length + gap : 2), -gap);

// 小盾：o 外框、r 盾面、R 盾面暗部、w 剑尖、s 剑身、h 护手、g 剑柄、c 铜钉和剑首
const SHIELD = [
  "ooooooooooo",
  "orrrrwrrrRo",
  "orcrrsrrcRo",
  "orrrrsrrRRo",
  "orrrrsrrRRo",
  "orrrrsrrRRo",
  "orrhhhhhRRo",
  ".orrrgrrRo.",
  ".orrrcrRRo.",
  "..orrrRRo..",
  "...orRRo...",
  "....ooo....",
];
function isDark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) < 110;
}
const px = (g, x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };

const BX = 13, BY = 6, BW = 31, BH = 7; // 经验槽（含皮框）
const IN = BW - 2; // 槽里能装的格子

export default {
  w: 44, h: 14, animated: true,
  draw(g, s) {
    const { c, t, done } = s;
    const dark = isDark(c.surface);
    const fresh = s.bump < 0.6;
    const gold = "#f2b51c", goldD = "#b77a0c", goldL = "#ffe9a0";

    // ---- 盾 ----
    const glint = done ? Math.floor(t * 4) % 2 : (t % 4 < .3);
    const pal = done
      ? { o: "#6b4410", r: gold, R: goldD, s: "#fff6d6", w: "#ffffff", h: "#7a3d12", g: "#7a3d12", c: "#fff2bf" }
      : { o: dark ? "#e8d3a8" : "#3a2410", r: "#b3311f", R: "#7e1e14", s: "#e8e2d2", w: glint ? "#ffffff" : "#e8e2d2", h: "#e8b04a", g: "#6e3f17", c: "#e8b04a" };
    SHIELD.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== ".") px(g, x, y + 1, pal[ch]); }));
    if (fresh && !done) { g.fillStyle = "rgba(255,255,255,.45)"; g.fillRect(1, 2, 4, 3); }

    // ---- 经验槽：皮框 + 四颗铆钉 + 每 1/4 一道刻度 ----
    const frame = dark ? "#c99a5e" : "#5a3a1a", rivet = done ? goldL : dark ? "#fff0c8" : "#d9a466";
    g.fillStyle = frame;
    g.fillRect(BX, BY, BW, 1); g.fillRect(BX, BY + BH - 1, BW, 1); g.fillRect(BX, BY, 1, BH); g.fillRect(BX + BW - 1, BY, 1, BH);
    g.fillStyle = dark ? "#14100a" : "#2e2418";
    g.fillRect(BX + 1, BY + 1, IN, BH - 2);
    const n = Math.round(s.shown * IN);
    // 槽里的光：上亮下暗三层，平时绿光、写满金光
    const rows = done ? [goldL, gold, goldD] : fresh ? ["#d8ffb0", "#9ee05a", "#4f9a2a"] : ["#a8e870", "#5fb83a", "#3b7a22"];
    for (let x = 0; x < n; x++) {
      const wave = Math.floor(t * 6 - x * .5) % 9 === 0; // 慢慢流过去的一道亮
      for (let y = 0; y < BH - 2; y++) {
        const k = y === 0 ? 0 : y >= BH - 3 ? 2 : 1;
        px(g, BX + 1 + x, BY + 1 + y, wave && k === 1 && !fresh ? rows[0] : rows[k]);
      }
    }
    // 刻度（压在光上）
    g.fillStyle = dark ? "rgba(0,0,0,.45)" : "rgba(46,36,24,.55)";
    for (let q = 1; q < 4; q++) g.fillRect(BX + 1 + Math.round(IN * q / 4), BY + 1, 1, BH - 2);
    // 铆钉
    for (const [x, y] of [[BX, BY], [BX + BW - 1, BY], [BX, BY + BH - 1], [BX + BW - 1, BY + BH - 1]]) px(g, x, y, rivet);
    // 槽头：一颗亮点，刚涨字时白光大一点
    if (n > 0 && n < IN) {
      const hx = BX + n, on = fresh || Math.floor(t * 2.5) % 2;
      if (on) { px(g, hx, BY + 2, "#ffffff"); px(g, hx, BY + 3, fresh ? "#ffffff" : "#e6ffd0"); }
      if (fresh) { px(g, hx + 1, BY + 3, "rgba(255,255,255,.7)"); px(g, hx, BY, "#ffffff"); px(g, hx, BY + BH - 1, "#ffffff"); }
    }
    // 写满：一道斜光从左往右扫
    if (done) {
      const sx = ((t * 24) % 60) - 6;
      for (let y = 0; y < BH - 2; y++) {
        const x = Math.floor(sx - y);
        if (x >= 0 && x < IN) px(g, BX + 1 + x, BY + 1 + y, "#ffffff");
        if (x + 1 >= 0 && x + 1 < IN) px(g, BX + 2 + x, BY + 1 + y, "rgba(255,255,255,.55)");
      }
    }

    // ---- 槽上方一行：EXP 字样 / 飘字 / LV UP! ----
    if (done) {
      const s2 = "LV UP!", w = textW(s2, 2), x0 = BX + Math.floor((BW - w) / 2);
      let x = x0;
      [...s2].forEach((ch, i) => {
        const hop = Math.floor(t * 6 + i) % 6 === 0 ? -1 : 0;
        const col = Math.floor(t * 3) % 2 ? "#fff2bf" : gold;
        x = text(g, ch, x, 1 + hop, col, "#5a2e08");
      });
      // 盾边两颗闪星
      const tw = Math.floor(t * 3) % 3;
      if (tw === 0) { px(g, 0, 0, "#fff"); px(g, 1, 0, gold); }
      if (tw === 1) { px(g, 11, 2, "#fff"); px(g, 12, 2, gold); }
    } else {
      text(g, "EXP", BX + 1, 0, dark ? "#a8e870" : "#3b7a22", dark ? "#14100a" : null);
      if (s.bump < 1.2) {
        // 「+XP」从槽头往上飘，越往上越淡
        const p = Math.min(1, s.bump / 1.2), y = Math.round(3 - p * 6);
        const str = "+XP", w = textW(str, 2);
        const x0 = Math.max(BX + 14, Math.min(BX + BW - w, BX + n - 2));
        g.globalAlpha = 1 - p * p;
        text(g, str, x0, y, "#fff2bf", "#2e5a14");
        g.globalAlpha = 1;
      }
    }
  },
  label(s) {
    return `${s.done ? "升级！" : "经验"} ${s.words.toLocaleString()}/${s.goal.toLocaleString()}`;
  },
};
