// adventurer 这套纸上的像素装饰。每项：{ rows: 字符画, colors: { 字符: 颜色或 "accent"/"ink"/"paper"/"muted"/"faint"/"line"/"surface"/"accent-soft" }, scale: 放大倍数 }
// 在 CSS 里用 var(--pa-<名字>)、var(--pa-<名字>-w)、var(--pa-<名字>-h)。
// 冒险者公会的委托单：一张从委托板上撕下来的羊皮纸。两边是烧焦的毛边（edge 遮罩 + scorch 焦痕），
// 纸面有斑驳（grain）、水渍（stain）、墨点（blot），左上角压着罗盘水印，左下角一块地图格。
// 顶上一颗铁钉把它钉住，右下角一枚红蜡封（剑与罗盘）。醒来时上下两卷羊皮从中间滚开（roll、knob）。

// ---------------- 小工具 ----------------
function rgbOf(g, c) {
  g.fillStyle = "#000"; g.fillStyle = c || "#000";
  const s = String(g.fillStyle);
  if (s[0] === "#") return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const m = s.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}
const isDark = (g, t) => { const [r, gg, b] = rgbOf(g, t.paper); return r * .3 + gg * .59 + b * .11 < 128; };
/** 逐像素写：px(x, y, [r,g,b], a)，a 叠加取大；wrap 为真时越界的点绕回来（平铺无缝） */
function pixels(g, w, h, fn, wrap = true) {
  const img = g.createImageData(w, h), d = img.data;
  const px = (x, y, c, a) => {
    x = Math.round(x); y = Math.round(y);
    if (wrap) { x = ((x % w) + w) % w; y = ((y % h) + h) % h; } else if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4, v = Math.round(Math.max(0, Math.min(1, a)) * 255);
    if (v <= d[i + 3]) return;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = v;
  };
  fn(px);
  g.putImageData(img, 0, 0);
}
/** 能无缝平铺的低频噪声 */
function smooth(rnd, w, h, n) {
  const v = Array.from({ length: n * n }, rnd);
  return (x, y) => {
    const fx = (x / w) * n, fy = (y / h) * n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (i, j) => v[((j % n) + n) % n * n + ((i % n) + n) % n];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
}
/** 固定的整数哈希 → 0..1 */
function hash(n) {
  n = (n ^ 61) ^ (n >>> 16); n = Math.imul(n, 9); n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

// ---------------- 焦边 ----------------
// 一段 64 行往下重复。prof(y) 是这一行烧进去多深（像素），左右两边各一条，相位不同
const P = 64, E = 14;
function prof(y, k) {
  const t = (y / P) * Math.PI * 2;
  let v = 4.6 + 1.7 * Math.sin(t + k) + 1.2 * Math.sin(3 * t + 2 * k + 1) + .8 * Math.sin(7 * t + 3 * k) + (hash(y * 7 + k * 1013) - .5) * 1.8;
  // 两处烧出来的小缺口
  const bite = (c, r, d) => { const q = Math.abs(((y - c + P * 1.5) % P) - P / 2); if (q < r) v += d * (1 - q / r); };
  bite(k ? 40 : 18, 4, 3.5); bite(k ? 9 : 51, 2.5, 2);
  return Math.max(1, Math.min(10, Math.round(v)));
}
/** 遮罩：烧剩下的部分是实的。right 为真时左右翻过来 */
function edge(k, right) {
  return (g, w, h) => pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = right ? w - 1 - x : x;
      if (d >= prof(y, k)) px(x, y, [0, 0, 0], 1);
    }
  }, false);
}
/** 焦痕：贴着毛边一圈黑褐，往里渐成焦黄；深色模式边上留一丝暗红的余烬 */
function scorch(k, right) {
  return (g, w, h, t, rnd) => {
    const dark = isDark(g, t);
    pixels(g, w, h, (px) => {
      for (let y = 0; y < h; y++) {
        const p = prof(y, k);
        for (let d = 0; d < 11; d++) {
          const x = right ? w - 1 - (p + d) : p + d;
          const n = rnd();
          let c, a;
          if (d === 0) { c = dark ? [12, 6, 2] : [34, 18, 6]; a = .92; }
          else if (d === 1) { c = dark ? [118, 46, 18] : [70, 38, 14]; a = dark ? .6 : .74; }
          else if (d === 2) { c = dark ? [40, 22, 10] : [112, 64, 24]; a = .5; }
          else { c = dark ? [30, 18, 8] : [150, 96, 40]; a = (dark ? .42 : .34) * (1 - (d - 3) / 8) * (.6 + n * .7); }
          px(x, y, c, a);
        }
      }
    }, false);
  };
}

// ---------------- 纸面 ----------------
// 斑驳：两层低频噪声叠成一块块的深浅，加细颗粒和几根短纤维
function grain(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const brown = dark ? [8, 5, 2] : [128, 84, 34], light = dark ? [150, 118, 70] : [255, 250, 232];
  const n1 = smooth(rnd, w, h, 5), n2 = smooth(rnd, w, h, 11);
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const m = n1(x, y) * .65 + n2(x, y) * .35;
      if (m > .56) px(x, y, brown, (m - .56) * (dark ? .9 : .42));
      else if (m < .38) px(x, y, light, (.38 - m) * (dark ? .22 : .9));
      const r = rnd();
      if (r < .05) px(x, y, brown, dark ? .22 + rnd() * .14 : .07 + rnd() * .07);
      else if (r < .065) px(x, y, light, dark ? .06 : .3);
    }
    // 纤维：斜着的短线
    for (let k = 0; k < 26; k++) {
      let x = rnd() * w, y = rnd() * h;
      const a = rnd() * Math.PI, L = 4 + rnd() * 9, c = rnd() < .5 ? brown : light;
      for (let i = 0; i < L; i++) { px(x, y, c, dark ? .12 : (c === brown ? .08 : .16)); x += Math.cos(a); y += Math.sin(a) * .6; }
    }
  });
}

// 水渍：不规则的圈，边上一道深色水线，里面淡淡一片
function stain(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const c = dark ? [6, 4, 1] : [140, 92, 36];
  const blobs = [[w * .34, h * .44, 26], [w * .7, h * .6, 17], [w * .58, h * .28, 9]];
  const ph = blobs.map(() => [rnd() * 6.3, rnd() * 6.3, rnd() * 6.3]);
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      blobs.forEach(([cx, cy, R], i) => {
        const dx = x - cx, dy = (y - cy) * 1.25, ang = Math.atan2(dy, dx), [a1, a2, a3] = ph[i];
        const rr = R * (1 + .16 * Math.sin(ang * 2 + a1) + .09 * Math.sin(ang * 5 + a2) + .05 * Math.sin(ang * 9 + a3));
        const d = Math.hypot(dx, dy) - rr;
        if (d > 0 && d < 2.2) px(x, y, c, (dark ? .5 : .3) * (1 - d / 2.2) * (.75 + rnd() * .35));
        else if (d <= 0 && d > -3) px(x, y, c, dark ? .24 : .13);
        else if (d <= -3) px(x, y, c, (dark ? .12 : .055) * (.8 + rnd() * .4));
      });
    }
  }, false);
}

// 墨点：一大滴墨溅开，周围几粒小点，中心有一点反光
function blot(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const ink = dark ? [6, 6, 4] : [36, 26, 18];
  pixels(g, w, h, (px) => {
    const cx = w * .42, cy = h * .5;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy, ang = Math.atan2(dy, dx);
      const R = 4.6 + 1.2 * Math.sin(ang * 3 + 1) + .8 * Math.sin(ang * 7);
      const d = Math.hypot(dx, dy);
      if (d < R) px(x, y, ink, dark ? .7 : .62);
      else if (d < R + 1) px(x, y, ink, .3);
    }
    px(cx - 2, cy - 2, [255, 255, 255], dark ? .1 : .25);
    for (let k = 0; k < 12; k++) {
      const a = rnd() * Math.PI * 2, r = 7 + rnd() * 6, x = cx + Math.cos(a) * r * 1.4, y = cy + Math.sin(a) * r * .8;
      px(x, y, ink, .55);
      if (rnd() < .4) px(x + 1, y, ink, .45);
    }
    // 一道甩出去的墨痕
    for (let i = 0; i < 6; i++) px(cx + 6 + i, cy + 2 + i * .4, ink, .5 - i * .06);
  }, false);
}

// 罗盘水印：双圈、十六道刻度、八角星，N 位置一个小尖。左上浮雕亮、右下压暗
function compass(g, w, h, t) {
  const dark = isDark(g, t);
  const N = Math.min(w, h), c = (N - 1) / 2;
  const grid = Array.from({ length: N }, () => Array(N).fill(0));
  const put = (x, y, v = 1) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < N && y < N) grid[y][x] = Math.max(grid[y][x], v); };
  const ring = (r, v) => { for (let a = 0; a < 720; a++) put(c + Math.cos(a / 720 * Math.PI * 2) * r, c + Math.sin(a / 720 * Math.PI * 2) * r, v); };
  const line = (x0, y0, x1, y1, v) => { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5); for (let i = 0; i <= n; i++) put(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, v); };
  ring(c - 1, 1); ring(c - 4, .7);
  for (let k = 0; k < 32; k++) { const a = k / 32 * Math.PI * 2, r0 = k % 2 ? c - 3 : c - 5.5; line(c + Math.cos(a) * r0, c + Math.sin(a) * r0, c + Math.cos(a) * (c - 1.5), c + Math.sin(a) * (c - 1.5), .8); }
  // 八角星：长尖四个、短尖四个
  const pts = [];
  for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2 - Math.PI / 2, r = k % 4 === 0 ? c - 6 : k % 2 === 0 ? c * .5 : c * .16; pts.push([c + Math.cos(a) * r, c + Math.sin(a) * r]); }
  for (let k = 0; k < 16; k++) line(...pts[k], ...pts[(k + 1) % 16], 1);
  for (let k = 0; k < 16; k += 2) line(c, c, ...pts[k], .55);
  ring(2, 1);
  // 北边那根长尖涂实
  for (let y = 6; y < c - 2; y++) { const half = (y - 6) / (c - 8) * c * .16; for (let x = -half; x <= half; x++) put(c + x, y, .9); }
  const ink = dark ? [200, 170, 120] : [96, 58, 24], hi = dark ? [0, 0, 0] : [255, 248, 226];
  pixels(g, w, h, (px) => {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = grid[y][x];
      if (!v) continue;
      px(x, y, ink, (dark ? .16 : .2) * v);
      if (!(grid[y - 1] && grid[y - 1][x - 1])) px(x - 1, y - 1, hi, dark ? .2 : .45);
    }
  }, false);
}

// 地图格：点线方格、一段海岸线、虚线路线、终点一个红叉；离左下角越远越淡
function mapgrid(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const ink = dark ? [196, 166, 116] : [100, 64, 28], red = dark ? [230, 120, 96] : [176, 52, 34];
  pixels(g, w, h, (px) => {
    const fade = (x, y) => Math.max(0, 1 - Math.hypot(x / w, (h - 1 - y) / h) * .95);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if ((x % 9 === 0 && y % 2 === 0) || (y % 9 === 0 && x % 2 === 0)) px(x, y, ink, (dark ? .2 : .2) * fade(x, y));
    }
    // 海岸线
    let yy = h * .3;
    for (let x = 0; x < w * .75; x++) {
      yy += (rnd() - .48) * 1.6 + Math.sin(x / 5) * .5;
      px(x, yy, ink, .5 * fade(x, yy) + .05);
      if (x % 4 === 0) px(x, yy + 2, ink, .22 * fade(x, yy));
    }
    // 路线：从左下往右上弯过去
    const route = (s) => [6 + s * (w * .62), h - 6 - s * (h * .52) + Math.sin(s * 7) * 5];
    for (let i = 0; i < 80; i++) { const [x, y] = route(i / 80); if (i % 6 < 3) px(x, y, red, .55 * fade(x, y) + .12); }
    const [ex, ey] = route(1);
    for (let i = -2; i <= 2; i++) { px(ex + i, ey + i, red, .7); px(ex + i, ey - i, red, .7); }
    // 小山
    for (const [mx, my] of [[w * .18, h * .6], [w * .27, h * .55]]) for (let i = 0; i < 4; i++) { px(mx - i, my + i, ink, .45 * fade(mx, my)); px(mx + i, my + i, ink, .45 * fade(mx, my)); }
  }, false);
}

// ---------------- 像素装饰 ----------------
// 红蜡封：边缘不规则地溢出来，里面压出一圈凸边，圈里是一把剑竖着穿过罗盘环
function seal() {
  const N = 19, c = 9;
  const g = Array.from({ length: N }, () => Array(N).fill("."));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - c, dy = y - c, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    const R = 8.4 + .7 * Math.sin(a * 5 + 1) + .4 * Math.sin(a * 11);
    if (d > R) continue;
    g[y][x] = d > R - 1.1 ? "r" : Math.abs(d - 6.6) < .55 ? "d" : Math.abs(d - 5.9) < .5 && dy < 0 ? "l" : "R";
  }
  const put = (x, y, ch) => { if (g[y] && g[y][x] !== undefined && g[y][x] !== ".") g[y][x] = ch; };
  // 罗盘环（半径 3.6）和东西两个刻度
  for (let k = 0; k < 64; k++) { const t = k / 64 * Math.PI * 2; put(Math.round(c + Math.cos(t) * 3.6), Math.round(c + Math.sin(t) * 3.6), "h"); }
  put(c - 5, c, "h"); put(c + 5, c, "h");
  // 剑：剑尖在上，护手短，剑柄、剑首在下
  for (let y = c - 6; y <= c + 3; y++) put(c, y, y === c - 6 ? "h" : "w");
  for (let x = c - 2; x <= c + 2; x++) put(x, c + 4, "h");
  put(c, c + 5, "g"); put(c, c + 6, "h");
  return g.map((r) => r.join(""));
}
// 两条垂下来的红缎带，末端剪成燕尾
const SEAL_TAIL = [
  ".....RRR...RRR.....",
  ".....RRd...dRR.....",
  "....RRd.....dRR....",
  "....RRd.....dRR....",
  "...RRd.......dRR...",
  "...R.d.......d.R...",
];
// 铁钉：钉帽 + 钉在纸上压出来的一圈皱
const NAIL = [
  "...ccc...",
  ".cchhgcc.",
  ".chwhggc.",
  "cghhgggdc",
  "cggggggdc",
  ".cgggddc.",
  ".ccdddcc.",
  "...ccc...",
];
// 醒来时上下两卷：羊皮卷成的圆筒（横着重复），两头是木头轴
const ROLL = ["oooooooo", "llllllll", "LLLLLLLL", "mmmmmmmm", "mmmmmmmm", "MMMMMMMM", "ssssssss", "ooOooooO", "dddddddd", "oooooooo"];
const KNOB_L = [
  "..kk..",
  ".kwwk.",
  "kwllwk",
  "kllllk",
  "kllllk",
  "kllllk",
  "klllbk",
  "klllbk",
  "kbbbbk",
  ".kbbk.",
];
const flip = (rows) => rows.map((r) => [...r].reverse().join(""));

export default {
  // 两边的焦边：遮罩和焦痕
  edgeL: { size: [E, P], scale: 2, texture: edge(0, false) },
  edgeR: { size: [E, P], scale: 2, texture: edge(2.3, true) },
  scorchL: { size: [E, P], scale: 2, texture: scorch(0, false) },
  scorchR: { size: [E, P], scale: 2, texture: scorch(2.3, true) },
  // 纸面
  grain: { size: [150, 150], scale: 2, texture: grain },
  stain: { size: [96, 72], scale: 3, texture: stain },
  blot: { size: [26, 18], scale: 2, texture: blot },
  compass: { size: [47, 47], scale: 3, texture: compass },
  map: { size: [64, 50], scale: 3, texture: mapgrid },
  // 纸上的东西
  seal: { rows: seal(), colors: { r: "#6e180f", R: "#b3311f", d: "#82200f", l: "#d4553a", h: "#e8b04a", w: "#f6dc94", g: "#7a4a1c" }, scale: 3 },
  sealTail: { rows: SEAL_TAIL, colors: { R: "#9e2a1a", d: "#6e180f" }, scale: 3 },
  nail: { rows: NAIL, colors: { c: "#2b2520", h: "#9a958a", w: "#e6e0d0", g: "#6d665c", d: "#433c34" }, scale: 3 },
  roll: { rows: ROLL, colors: { o: "#5a3a1a", l: "#fbf1d6", L: "#efdcb0", m: "#e2c78e", M: "#cfae70", s: "#b48d4f", O: "#7a5428", d: "#3a2410" }, scale: 4 },
  knobL: { rows: KNOB_L, colors: { k: "#2e1a0a", w: "#d9a466", l: "#a8692f", b: "#6e3f17" }, scale: 4 },
  knobR: { rows: flip(KNOB_L), colors: { k: "#2e1a0a", w: "#d9a466", l: "#a8692f", b: "#6e3f17" }, scale: 4 },
};
