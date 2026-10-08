// magical 这套纸上的像素装饰。每项：{ rows: 字符画, colors: { 字符: 颜色或 "accent"/"ink"/"paper"/"muted"/"faint"/"line"/"surface"/"accent-soft" }, scale: 放大倍数 }
// 在 CSS 里用 var(--pa-<名字>)、var(--pa-<名字>-w)、var(--pa-<名字>-h)。
// 魔法信笺：两边是镂空蕾丝花边（cut 是剪纸用的遮罩，lace 是花边的线），顶上一枚带翅膀的心，角上小星星，醒来时一圈魔法阵。
// 纸本身是珠光纸：grain 珠光颗粒、dust 星屑、mark 压在纸里的魔法阵水印、shine 右上角一道高光（都是程序画的纹理，带透明度）。

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

// ---------------- 珠光纸的纹理 ----------------
/** 任意 CSS 颜色 → [r, g, b]（借画布换算） */
function rgbOf(g, c) {
  g.fillStyle = "#000"; g.fillStyle = c || "#000";
  const s = String(g.fillStyle);
  if (s[0] === "#") return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const m = s.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}
const isDark = (g, t) => { const [r, gg, b] = rgbOf(g, t.paper); return r * .3 + gg * .59 + b * .11 < 128; };
/** 逐像素写：px(x, y, [r,g,b], a)，a 叠加取大 */
function pixels(g, w, h, fn) {
  const img = g.createImageData(w, h), d = img.data;
  const px = (x, y, c, a) => {
    x = ((x % w) + w) % w; y = ((y % h) + h) % h;
    const i = (y * w + x) * 4, v = Math.round(Math.max(0, Math.min(1, a)) * 255);
    if (v <= d[i + 3]) return;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = v;
  };
  fn(px);
  g.putImageData(img, 0, 0);
}
/** 能无缝平铺的低频噪声：n×n 个随机点双线性插值，返回 (x, y) → 0..1 */
function smooth(rnd, w, h, n) {
  const v = Array.from({ length: n * n }, rnd);
  return (x, y) => {
    const fx = (x / w) * n, fy = (y / h) * n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (i, j) => v[((j % n) + n) % n * n + ((i % n) + n) % n];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
}

// 珠光颗粒：细密的亮点和一点点暗点，疏密跟着低频噪声起伏，像纸面上刷的那层云母
function grain(g, w, h, t, rnd) {
  const dark = isDark(g, t), acc = rgbOf(g, t.accent);
  const hi = dark ? [226, 206, 246] : [255, 255, 255], lo = dark ? [6, 2, 12] : acc;
  const tints = dark ? [[255, 150, 205], [176, 150, 255], [130, 214, 222]] : [[255, 150, 198], [182, 154, 255], [126, 196, 232]];
  const n = smooth(rnd, w, h, 4);
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = .55 + n(x, y) * .9, r = rnd();
      if (r < .09 * k) px(x, y, hi, dark ? .05 + rnd() * .07 : .2 + rnd() * .22);   // 白颗粒少一点、淡一点，不和字抢
      else if (r < .22 * k) px(x, y, lo, dark ? .16 + rnd() * .12 : .035 + rnd() * .035);
      else if (r < .25 * k) px(x, y, tints[(rnd() * 3) | 0], dark ? .1 + rnd() * .08 : .1 + rnd() * .08);
    }
  });
}

// 星屑：零星几颗亮点，带一圈彩色的晕；少数是小十字星
function dust(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const core = [255, 255, 255];
  const halos = dark ? [[255, 150, 205], [190, 160, 255], [140, 226, 236], [255, 214, 140]] : [[255, 120, 182], [172, 136, 255], [110, 190, 236], [236, 176, 64]];
  pixels(g, w, h, (px) => {
    for (let k = 0; k < 16; k++) {
      const x = (rnd() * w) | 0, y = (rnd() * h) | 0, c = halos[(rnd() * halos.length) | 0], big = k < 3, mid = k < 7;
      px(x, y, core, dark ? .9 : .95);
      const a = dark ? .5 : .55;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) px(x + dx, y + dy, c, mid ? a : a * .55);
      if (big) for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) px(x + dx, y + dy, c, a * .6);
      if (!mid) for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) px(x + dx, y + dy, c, a * .25);
    }
  });
}

// 水印：醒来时那圈魔法阵压在纸里，留下一道浮雕（左上亮、右下暗）
function mark(g, w, h, t, rnd) {
  const dark = isDark(g, t), acc = rgbOf(g, t.accent);
  const rows = circle(), o = 1;
  const on = (x, y) => rows[y] && rows[y][x] && rows[y][x] !== ".";
  pixels(g, w, h, (px) => {
    rows.forEach((r, y) => [...r].forEach((ch, x) => {
      if (ch === ".") return;
      if (!on(x + 1, y + 1)) px(x + o + 1, y + o + 1, dark ? [0, 0, 0] : acc, dark ? .34 : .16);
      if (!on(x - 1, y - 1)) px(x + o - 1, y + o - 1, dark ? [236, 214, 255] : [255, 255, 255], dark ? .1 : .7);
      px(x + o, y + o, dark ? [196, 150, 230] : acc, dark ? .08 : .07);
    }));
  });
}

// 高光：右上角斜着两道（一宽一窄），两头用棋盘格点渐隐，像珠光纸迎着光的那一下
function shine(g, w, h, t) {
  const dark = isDark(g, t), c = dark ? [232, 214, 255] : [255, 255, 255];
  const B = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = (w - 1 - x) + y; // 离右上角的斜距
      const band = d >= 10 && d < 18 ? 1 : d >= 22 && d < 24 ? .8 : d === 27 ? .55 : 0;
      if (!band) continue;
      const along = Math.abs((w - 1 - x) - y) / d; // 0 在对角线上，1 在纸边
      const fade = Math.max(0, 1 - along * 1.15);
      if (fade * 16 <= B[y % 4][x % 4]) continue;
      px(x, y, c, (dark ? .1 : .5) * band);
    }
  });
}

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
  // 珠光纸
  grain: { size: [128, 128], scale: 2, texture: grain },
  dust: { size: [151, 133], scale: 2, texture: dust },
  mark: { size: [43, 43], scale: 3, texture: mark },
  shine: { size: [44, 44], scale: 3, texture: shine },
};
