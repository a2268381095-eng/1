// magical 这套纸上的像素装饰。每项：{ rows: 字符画, colors: { 字符: 颜色或 "accent"/"ink"/"paper"/"muted"/"faint"/"line"/"surface"/"accent-soft" }, scale: 放大倍数 }
// 在 CSS 里用 var(--pa-<名字>)、var(--pa-<名字>-w)、var(--pa-<名字>-h)。
// 魔法信笺：两边是镂空蕾丝花边（cut 是剪纸用的遮罩，lace 是花边的线），顶上一枚带翅膀的心，角上小星星，醒来时一圈魔法阵。

const flip = (rows) => rows.map((r) => [...r].reverse().join(""));

// 左边的花边，一段 8 行往下重复，x=0 是纸的外沿。CUT 是剪纸的形状（# 留下），中间一个小孔
const CUT = [
  "....####",
  "...#####",
  ".#######",
  "########",
  "##.#####",
  "########",
  ".#######",
  "...#####",
];
// 花边的线：剪口外沿描一道亮边（小孔不描），里面缝一行虚线
const LACE = CUT.map((r, y) => [...r].map((ch, x) => {
  if (ch !== "#") return ".";
  const out = (xx, yy) => { const row = CUT[(yy + 8) % 8]; return xx < 0 || xx < row.indexOf("#"); };
  if (out(x - 1, y) || out(x, y - 1) || out(x, y + 1)) return "o";
  return x === 6 && y % 2 === 0 ? "d" : ".";
}).join(""));

// 魔法阵：外圈双环、八颗菱形刻度、四角星、中间一颗心。用中点画圆和 Bresenham 画线，线都是一像素宽
function circle() {
  const N = 41, c = 20;
  const g = Array.from({ length: N }, () => Array(N).fill("."));
  const put = (x, y, ch) => { if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = ch; };
  const ring = (r, ch) => {
    let x = r, y = 0, e = 1 - r;
    while (x >= y) {
      for (const [a, b] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) put(c + a, c + b, ch);
      y++;
      if (e < 0) e += 2 * y + 1; else { x--; e += 2 * (y - x) + 1; }
    }
  };
  const line = (x0, y0, x1, y1, ch) => {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      put(x0, y0, ch);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  };
  ring(20, "a"); ring(16, "l");
  for (let k = 0; k < 8; k++) {
    const t = (k * Math.PI) / 4 + Math.PI / 8, x = Math.round(c + Math.cos(t) * 18), y = Math.round(c + Math.sin(t) * 18);
    put(x, y, "w"); put(x - 1, y, "l"); put(x + 1, y, "l"); put(x, y - 1, "l"); put(x, y + 1, "l");
  }
  // 四角星：尖在上下左右，凹处在斜 45°
  const pts = [];
  for (let k = 0; k < 8; k++) {
    const t = (k * Math.PI) / 4 - Math.PI / 2, r = k % 2 ? 4 : 14;
    pts.push([Math.round(c + Math.cos(t) * r), Math.round(c + Math.sin(t) * r)]);
  }
  for (let k = 0; k < 8; k++) line(...pts[k], ...pts[(k + 1) % 8], "s");
  const heart = [".hh.hh.", "hwhhhhh", "hhhhhhh", ".hhhhh.", "..hhh..", "...h..."];
  heart.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== ".") g[c - 2 + y][c - 3 + x] = ch; }));
  return g.map((r) => r.join(""));
}

// 带翅膀的心：左翅膀 + 心 + 右翅膀（左翅膀翻过来）
const WING = [
  ".........",
  "kkkkk....",
  "kwwwwkkk.",
  ".kkkwwwwk",
  "kwwwwwwwk",
  ".kkkkswwk",
  "..kwwwwk.",
  "...kkkk..",
  ".........",
];
const HEART = [
  ".ooo.ooo.",
  "ohlhohhho",
  "olhhhhhho",
  "ohhhhhhho",
  ".ohhhhho.",
  "..ohhho..",
  "...oho...",
  "....o....",
];
function emblem() {
  return WING.map((w, y) => w + (HEART[y - 1] || ".........") + [...w].reverse().join(""));
}

const PINK = "#ff7fb8", LIGHT = "#ffd3e8", WHITE = "#fffafd";

export default {
  cutL: { rows: CUT, colors: { "#": "#000" }, scale: 3 },
  cutR: { rows: flip(CUT), colors: { "#": "#000" }, scale: 3 },
  laceL: { rows: LACE, colors: { o: LIGHT, d: PINK }, scale: 3 },
  laceR: { rows: flip(LACE), colors: { o: LIGHT, d: PINK }, scale: 3 },
  // 纸顶上那枚带翅膀的心（像别在信纸上的胸针）
  emblem: { rows: emblem(), colors: { k: "accent", w: WHITE, s: LIGHT, o: "accent", h: PINK, l: WHITE }, scale: 3 },
  // 角上的小星星
  star: {
    rows: ["...a...", "...l...", "..lwl..", "alwwwla", "..lwl..", "...l...", "...a..."],
    colors: { a: "accent", l: PINK, w: WHITE },
    scale: 3,
  },
  spark: { rows: [".l.", "lwl", ".l."], colors: { l: PINK, w: WHITE }, scale: 3 },
  // 醒来时转出来的魔法阵
  circle: { rows: circle(), colors: { a: "accent", l: PINK, w: WHITE, s: PINK, h: PINK }, scale: 4 },
};
