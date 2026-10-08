// hanfu 这套纸上的像素装饰。每项：{ rows: 字符画, colors: { 字符: 颜色或 "accent"/"ink"/"paper"/"muted"/"faint"/"line"/"surface"/"accent-soft" }, scale: 放大倍数 }
// 在 CSS 里用 var(--pa-<名字>)、var(--pa-<名字>-w)、var(--pa-<名字>-h)。
// 宣纸：fiber 长纤维和纤维团，mottle 吸墨不匀的斑驳，edgeL/R/T/B 毛边遮罩，bleed 朱砂线洇开的浓淡；
// seal 角上一方白文朱印（「文」），sprig 左下角一小枝墨梅。

// ---------------- 工具 ----------------
function rgbOf(g, c) {
  g.fillStyle = "#000"; g.fillStyle = c || "#000";
  const s = String(g.fillStyle);
  if (s[0] === "#") return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const m = s.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}
const isDark = (g, t) => { const [r, gg, b] = rgbOf(g, t.paper); return r * .3 + gg * .59 + b * .11 < 128; };
/** 逐像素写，坐标绕回（平铺接得上）；mode "max" 透明度取大，"add" 叠加 */
function pixels(g, w, h, fn, mode = "max") {
  const img = g.createImageData(w, h), d = img.data;
  const px = (x, y, c, a) => {
    x = ((Math.round(x) % w) + w) % w; y = ((Math.round(y) % h) + h) % h;
    const i = (y * w + x) * 4;
    const v = Math.round(Math.max(0, Math.min(1, mode === "add" ? d[i + 3] / 255 + a : a)) * 255);
    if (mode === "max" && v <= d[i + 3]) return;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = v;
  };
  fn(px);
  g.putImageData(img, 0, 0);
}
/** 能平铺的低频噪声 (x, y) → 0..1 */
function smooth(rnd, w, h, n) {
  const v = Array.from({ length: n * n }, rnd);
  return (x, y) => {
    const fx = (x / w) * n, fy = (y / h) * n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (i, j) => v[((j % n) + n) % n * n + ((i % n) + n) % n];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
}
/** 一维平铺噪声 */
function wave(rnd, len, n) {
  const v = Array.from({ length: n }, rnd);
  return (i) => {
    const f = (i / len) * n, i0 = Math.floor(f), t = f - i0, s = t * t * (3 - 2 * t);
    return v[((i0 % n) + n) % n] * (1 - s) + v[(((i0 + 1) % n) + n) % n] * s;
  };
}

// ---------------- 宣纸纹理 ----------------
// 长纤维：一根根弯弯的细丝，方向乱，偶尔打个卷；几团纤维绞在一起；再撒一层细颗粒
function fiber(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const lite = dark ? [236, 222, 196] : [255, 255, 255];
  const tan = dark ? [10, 6, 2] : [150, 118, 76];
  pixels(g, w, h, (px) => {
    const strand = (x, y, len, a0, col, alpha) => {
      let a = a0, curl = (rnd() - .5) * .04;
      for (let i = 0; i < len; i++) {
        px(x, y, col, alpha * (1 - Math.abs(i / len - .5) * .9));
        a += curl + (rnd() - .5) * .1;
        if (rnd() < .015) curl = (rnd() - .5) * .08;
        x += Math.cos(a) * .8; y += Math.sin(a) * .8;
      }
    };
    // 细颗粒
    for (let i = 0; i < w * h * .06; i++) px(rnd() * w, rnd() * h, rnd() < .5 ? lite : tan, dark ? .05 + rnd() * .06 : .06 + rnd() * .08);
    // 长纤维：亮的多、黄褐的少
    for (let i = 0; i < 60; i++) {
      const pale = rnd() < .7;
      strand(rnd() * w, rnd() * h, 24 + rnd() * 80, rnd() * Math.PI * 2, pale ? lite : tan,
        pale ? (dark ? .07 + rnd() * .06 : .3 + rnd() * .22) : (dark ? .14 + rnd() * .1 : .08 + rnd() * .08));
    }
    // 纤维团：一小团里十几根短丝绕着
    for (let k = 0; k < 6; k++) {
      const cx = rnd() * w, cy = rnd() * h, r = 1.5 + rnd() * 2.5;
      for (let i = 0; i < 10; i++) {
        const a = rnd() * Math.PI * 2;
        strand(cx + Math.cos(a) * r * rnd(), cy + Math.sin(a) * r * rnd(), 4 + rnd() * 6, rnd() * Math.PI * 2,
          rnd() < .55 ? tan : lite, dark ? .1 + rnd() * .1 : .12 + rnd() * .1);
      }
    }
  });
}

// 斑驳：纸吸墨不匀，一块浓一块淡（两层低频噪声叠起来，只取浓的那一半）
function mottle(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const col = dark ? [0, 0, 0] : [176, 140, 90], hi = dark ? [210, 190, 150] : [255, 255, 255];
  const a = smooth(rnd, w, h, 4), b = smooth(rnd, w, h, 9), c = smooth(rnd, w, h, 16);
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = a(x, y) * .55 + b(x, y) * .3 + c(x, y) * .15;
      if (v > .55) px(x, y, col, (v - .55) * (dark ? .9 : .75));
      else if (v < .38) px(x, y, hi, (.38 - v) * (dark ? .12 : .9));
    }
  });
}

// 朱砂线洇进纸：遮罩，浓的地方 1，淡的地方 0.5
function bleed(g, w, h, t, rnd) {
  const n = smooth(rnd, w, h, 6);
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(x, y, [0, 0, 0], .5 + n(x, y) * .4 + rnd() * .15);
  });
}

// 毛边：左边一条，x=0 是纸外。纤维参差地伸出去，越往外越稀越淡
function edge(g, w, h, rnd, vertical) {
  const L = vertical ? h : w, D = vertical ? w : h;
  const e = wave(rnd, L, 7), f = wave(rnd, L, 23);
  pixels(g, w, h, (px) => {
    const put = (i, d, a) => (vertical ? px(d, i, [0, 0, 0], a) : px(i, d, [0, 0, 0], a));
    for (let i = 0; i < L; i++) {
      const at = 1.5 + e(i) * (D - 5) * .45 + f(i) * 2;
      for (let d = 0; d < D; d++) {
        if (d >= at + 1) put(i, d, 1);
        else if (d >= at) put(i, d, .65);
        else if (d >= at - 1.5) put(i, d, .25 + rnd() * .2);
      }
      // 伸出去的纤维丝
      if (rnd() < .22) {
        const len = 1 + rnd() * (at - 0.5), a = .35 + rnd() * .35;
        for (let k = 0; k < len; k++) put(i + (rnd() < .3 ? 1 : 0), at - k, a * (1 - k / (len + 1)));
      }
    }
  });
}
const flipX = (fn) => (g, w, h, t, rnd) => { g.translate(w, 0); g.scale(-1, 1); const c = document.createElement("canvas"); c.width = w; c.height = h; fn(c.getContext("2d"), w, h, t, rnd); g.drawImage(c, 0, 0); };
const flipY = (fn) => (g, w, h, t, rnd) => { g.translate(0, h); g.scale(1, -1); const c = document.createElement("canvas"); c.width = w; c.height = h; fn(c.getContext("2d"), w, h, t, rnd); g.drawImage(c, 0, 0); };
const edgeV = (g, w, h, t, rnd) => edge(g, w, h, rnd, true);
const edgeH = (g, w, h, t, rnd) => edge(g, w, h, rnd, false);

// ---------------- 像素装饰 ----------------
// 白文朱印「文」：字是刻掉的（透明），r 是印泥没吃满的淡处
const SEAL = [
  ".RRRRRRRRRRRR.",
  "RRRRRRrRRRRRRR",
  "RRRRRR..RRRRRR",
  "RRRRRRR.RRRrRR",
  "RR..........RR",
  "RRR.RRRRRR.RRR",
  "RrRR.RRRR.RRRR",
  "RRRRR.RR.RRRRR",
  "RRRRRR..RRRRrR",
  "RRRRR.RR.RRRRR",
  "RRR..RRRR..RRR",
  "RR.RRRRRrRRR.R",
  "RRRRRrRRRRRRRR",
  ".RRRRRRRRRRRr.",
];

// 一小枝墨梅：k 浓墨枝，g 淡墨，r 朱红花，p 花心
const SPRIG = [
  "..............r.",
  ".............rpr",
  "..........g...r.",
  ".........k......",
  "....r...k.......",
  "...rpr.k........",
  "....r.k.........",
  "......k.....r...",
  ".....k.....rpr..",
  ".....k....gkr...",
  "....k...kk......",
  "....k.kk........",
  "...kkk..........",
  "...k............",
  "..kk............",
  "..k.............",
  "..k.............",
  ".kg.............",
  ".k..............",
  ".g..............",
  "g...............",
];

export default {
  fiber: { size: [200, 200], scale: 2, texture: fiber },
  mottle: { size: [96, 96], scale: 4, texture: mottle },
  bleed: { size: [48, 48], scale: 2, texture: bleed },
  edgeL: { size: [8, 120], scale: 2, texture: edgeV },
  edgeR: { size: [8, 120], scale: 2, texture: flipX(edgeV) },
  edgeT: { size: [120, 8], scale: 2, texture: edgeH },
  edgeB: { size: [120, 8], scale: 2, texture: flipY(edgeH) },
  seal: { rows: SEAL, colors: { R: "accent", r: "accent-soft" }, scale: 3 },
  sprig: { rows: SPRIG, colors: { k: "ink", g: "muted", r: "accent", p: "#f0be46" }, scale: 2 },
};
