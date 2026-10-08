// sailor 这套纸上的像素装饰。每项：{ rows: 字符画, colors: { 字符: 颜色或 "accent"/"ink"/"paper"/"muted"/"faint"/"line"/"surface"/"accent-soft" }, scale: 放大倍数 }
// 在 CSS 里用 var(--pa-<名字>)、var(--pa-<名字>-w)、var(--pa-<名字>-h)。
// 活页本的一页：左边一列打孔（punch 是挖孔的遮罩，rim 是孔边一圈淡影），右上角贴一颗金星贴纸，右下角是小恶魔随手画的尾巴。
// 纸面质感（程序纹理，带透明度）：grain 作业本纸的细颗粒和纤维，dent 孔边的阴影和压痕，erase 页边一块橡皮擦过的痕。

// 孔：一格 12×10（CSS 里按 3 倍是 36×30），孔 5×5 在中间偏左
const HOLE = [".###.", "#####", "#####", "#####", ".###."];
const tile = (fn) => Array.from({ length: 10 }, (_, y) => Array.from({ length: 12 }, (_, x) => fn(x - 3, y - 2)).join(""));
const inHole = (x, y) => HOLE[y] && HOLE[y][x] === "#";

// 剪影 → 描边、亮面、暗面，外面一圈白边
function sticker(sil) {
  const H = sil.length + 2, W = sil[0].length + 2;
  const at = (x, y) => sil[y] && sil[y][x] === "#";
  const rim = (x, y) => !at(x, y) && [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => at(x + dx, y + dy)));
  const rows = [];
  for (let y = 0; y < H; y++) {
    let r = "";
    for (let x = 0; x < W; x++) {
      const sx = x - 1, sy = y - 1, n = sil.length;
      if (at(sx, sy)) r += !at(sx + 1, sy) || !at(sx - 1, sy) || !at(sx, sy + 1) || !at(sx, sy - 1) ? "o" : sx + sy < n - 2 ? "h" : sx + sy > n + 1 ? "d" : "y";
      else if (rim(sx, sy)) r += "w";
      else r += ".";
    }
    rows.push(r);
  }
  return rows;
}

const STAR = [
  ".....#.....",
  "....###....",
  "....###....",
  "...#####...",
  "###########",
  ".#########.",
  "..#######..",
  "..#######..",
  ".####.####.",
  ".###...###.",
  ".#.......#.",
];


// ---------------- 纸面纹理 ----------------
/** 任意 CSS 颜色 → [r, g, b]（借画布换算） */
function rgbOf(g, c) {
  g.fillStyle = "#000"; g.fillStyle = c || "#000";
  const s = String(g.fillStyle);
  if (s[0] === "#") return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const m = s.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}
const isDark = (g, t) => { const [r, gg, b] = rgbOf(g, t.paper); return r * .3 + gg * .59 + b * .11 < 128; };
/** 逐像素写：px(x, y, [r,g,b], a)，a 叠加取大；wrap 为真时越界的点绕回来（平铺用） */
function pixels(g, w, h, fn, wrap = true) {
  const img = g.createImageData(w, h), d = img.data;
  const px = (x, y, c, a) => {
    if (wrap) { x = ((x % w) + w) % w; y = ((y % h) + h) % h; } else if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4, v = Math.round(Math.max(0, Math.min(1, a)) * 255);
    if (v <= d[i + 3]) return;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = v;
  };
  fn(px);
  g.putImageData(img, 0, 0);
}
/** 能无缝平铺的低频噪声：n×n 个随机点插值，返回 (x, y) → 0..1 */
function smooth(rnd, w, h, n) {
  const v = Array.from({ length: n * n }, rnd);
  return (x, y) => {
    const fx = (x / w) * n, fy = (y / h) * n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (i, j) => v[((j % n) + n) % n * n + ((i % n) + n) % n];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
}

// 作业本纸：细密的纸面颗粒，疏密跟着纸浆的云团起伏；零星几根短纤维、几粒再生纸里的灰蓝小点
function grain(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const hi = dark ? [196, 214, 240] : [255, 255, 255], lo = dark ? [4, 8, 18] : [70, 86, 120];
  const n = smooth(rnd, w, h, 6), m = smooth(rnd, w, h, 3);
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = .5 + n(x, y) * .7 + m(x, y) * .3, r = rnd();
      if (r < .045 * k) px(x, y, hi, dark ? .03 + rnd() * .035 : .12 + rnd() * .12);
      else if (r < .16 * k) px(x, y, lo, dark ? .09 + rnd() * .09 : .028 + rnd() * .03);
    }
    // 纤维：3–7 像素的细弯线，横竖都有
    for (let f = 0; f < 34; f++) {
      let x = rnd() * w, y = rnd() * h, a = rnd() * Math.PI * 2;
      const len = 3 + ((rnd() * 5) | 0), c = rnd() < .5 ? lo : hi, al = c === hi ? (dark ? .06 : .22) : (dark ? .16 : .07);
      for (let i = 0; i < len; i++) { px(Math.round(x), Math.round(y), c, al); a += (rnd() - .5) * .7; x += Math.cos(a); y += Math.sin(a); }
    }
    // 再生纸里的小点：灰蓝、浅褐
    const flecks = dark ? [[120, 150, 200], [150, 130, 110]] : [[96, 124, 176], [150, 128, 104]];
    for (let f = 0; f < 7; f++) px((rnd() * w) | 0, (rnd() * h) | 0, flecks[f % 2], dark ? .22 : .16);
  });
}

// 孔边：打孔机压下去，孔四周一圈纸被压低。光从左上来：孔的左上沿背光暗一点，右下沿迎光亮一点；外面再一道浅浅的压痕圈
// 和 punch 同一格（12×10 的格子按 3 倍 = 36×30），这里直接按 36×30 的像素画，边更细
function dent(g, w, h, t) {
  const dark = isDark(g, t);
  const shade = dark ? [0, 0, 0] : [44, 58, 92], light = dark ? [170, 196, 236] : [255, 255, 255];
  const hole = (x, y) => inHole(Math.floor(x / 3) - 3, Math.floor(y / 3) - 2);
  const cx = 16.5, cy = 13.5;
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (hole(x, y)) continue;
      // 到孔的最近距离
      let d = 99;
      for (let yy = 6; yy <= 20; yy++) for (let xx = 9; xx <= 23; xx++) if (hole(xx, yy)) d = Math.min(d, Math.hypot(xx - x, yy - y));
      if (d > 6) continue;
      const vx = x - cx, vy = y - cy, l = Math.hypot(vx, vy) || 1;
      const face = -(vx + vy) / (l * Math.SQRT2); // 1 = 在孔的左上
      if (d <= 1.5) {
        // 紧贴孔的一圈：左上暗、右下亮，像纸的断口
        if (face > -.2) px(x, y, shade, (dark ? .5 : .36) * (.4 + face * .6));
        else px(x, y, light, (dark ? .12 : .55) * -face);
      } else if (d <= 3.2) {
        // 压下去的斜坡：左上坡面朝着光，亮；右下坡背光，暗
        if (face > .2) px(x, y, light, (dark ? .06 : .32) * face);
        else if (face < -.2) px(x, y, shade, (dark ? .24 : .12) * -face);
      } else if (d > 4.4 && d <= 5.6) {
        // 外面一道浅压痕
        px(x, y, face > 0 ? shade : light, face > 0 ? (dark ? .18 : .08) * face : (dark ? .06 : .3) * -face);
      }
    }
  }, false);
}

// 橡皮擦痕：一块来回擦过的地方，纸面被擦得发白发毛，边上留一点铅笔灰的晕，没擦干净的两笔字痕，旁边几粒橡皮屑
function erase(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const white = dark ? [190, 206, 232] : [255, 255, 255], lead = dark ? [150, 166, 196] : [96, 102, 118];
  const crumb = dark ? [210, 160, 176] : [226, 150, 166];
  const cx = w * .46, cy = h * .5, rx = w * .4, ry = h * .34;
  pixels(g, w, h, (px) => {
    // 擦的方向稍微斜一点，一道一道的
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (x - cx) / rx, v = (y - cy + (x - cx) * .14) / ry;
      const r = Math.hypot(u, v);
      if (r > 1.25) continue;
      const streak = .55 + .45 * Math.sin((y + (x - cx) * .14) * 1.9 + Math.sin(x * .3) * .8);
      if (r < 1) {
        const a = (1 - r * r) * streak;
        if (rnd() < .9) px(x, y, white, (dark ? .13 : .62) * Math.min(1, a * 1.4));
        if (rnd() < .05) px(x, y, lead, (dark ? .1 : .06));
      } else if (rnd() < .6) px(x, y, lead, (dark ? .14 : .12) * (1.25 - r) * 4 * streak);
    }
    // 没擦干净的两笔
    for (const [x0, y0, len, dy] of [[cx - rx * .55, cy - 2, rx * .9, -.12], [cx - rx * .2, cy + 3, rx * .7, .08]]) {
      for (let i = 0; i < len; i++) if (rnd() < .7) px(Math.round(x0 + i), Math.round(y0 + i * dy + Math.sin(i * .5)), lead, dark ? .14 : .1);
    }
    // 橡皮屑：小卷，在擦痕右下
    for (let k = 0; k < 6; k++) {
      const x = Math.round(cx + rx * (.7 + rnd() * .5)), y = Math.round(cy + ry * (.2 + rnd() * .9) - k);
      px(x, y, crumb, dark ? .4 : .45); px(x + 1, y, crumb, dark ? .3 : .35);
      if (k % 2) px(x + 1, y + 1, lead, dark ? .2 : .14);
    }
  }, false);
}

export default {
  // 挖孔遮罩：# 是纸，. 是孔
  punch: { rows: tile((x, y) => (inHole(x, y) ? "." : "#")), colors: { "#": "#000000" }, scale: 3 },
  // 孔的上沿、左沿一道淡影，孔看起来有厚度
  rim: {
    rows: tile((x, y) => (inHole(x, y) ? "." : (inHole(x, y + 1) || inHole(x + 1, y)) ? "r" : ".")),
    colors: { r: "line" }, scale: 3,
  },
  star: {
    rows: sticker(STAR),
    colors: { o: "#d18a12", y: "#ffd23f", h: "#fff0a0", d: "#f2b51c", w: "#ffffff" }, scale: 3,
  },
  // 小恶魔的尾巴：圆珠笔一笔画过去，尾巴尖是倒过来的心
  tail: {
    rows: [
      "..........#...",
      ".........###..",
      "........#####.",
      ".......#######",
      ".......#######",
      "........##.##.",
      "..........#...",
      ".........#....",
      "..##....#.....",
      ".#..#..#......",
      "#....##.......",
    ],
    colors: { "#": "#5b7fd6" }, scale: 3,
  },
  // 纸面质感
  grain: { size: [192, 192], scale: 1, texture: grain },
  dent: { size: [36, 30], scale: 1, texture: dent },
  erase: { size: [40, 24], scale: 2, texture: erase },
};
