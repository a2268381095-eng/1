// detective 这套纸上的像素装饰和纸纹。在 CSS 里用 var(--pa-<名字>)、var(--pa-<名字>-w)、var(--pa-<名字>-h)。
// 案卷里的打字稿纸：fiber 纸纤维和颗粒，rule 打字机格线（一格一行，底下一道虚线），ring 咖啡杯印，stamp 红色「卷宗」章，
// tab 档案夹顶上的标签耳，clip 回形针。纹理都带透明度，叠在纸色上。

/** 任意 CSS 颜色 → [r, g, b] */
function rgbOf(g, c) {
  g.fillStyle = "#000"; g.fillStyle = c || "#000";
  const s = String(g.fillStyle);
  if (s[0] === "#") return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const m = s.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}
const isDark = (g, t) => { const [r, gg, b] = rgbOf(g, t.paper); return r * .3 + gg * .59 + b * .11 < 128; };
/** 逐像素写：px(x, y, [r,g,b], a)，坐标绕回（能平铺），a 叠加取大 */
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
/** 能平铺的低频噪声 */
function smooth(rnd, w, h, n) {
  const v = Array.from({ length: n * n }, rnd);
  return (x, y) => {
    const fx = (x / w) * n, fy = (y / h) * n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (i, j) => v[((j % n) + n) % n * n + ((i % n) + n) % n];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
}

// 纸纤维：底下一层发黄的斑驳，上面短纤维（深浅两色）、零星墨点和压痕
function fiber(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const brown = dark ? [206, 176, 128] : [126, 92, 48], pale = dark ? [10, 8, 6] : [255, 251, 238], speck = dark ? [230, 210, 170] : [70, 52, 34];
  const lo = smooth(rnd, w, h, 4), mid = smooth(rnd, w, h, 10);
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = lo(x, y) * .55 + mid(x, y) * .45 + rnd() * .14;
      // 斑驳压淡一些：书桌上一页干净的打字稿，旧得不过分
      if (n > .55) px(x, y, brown, (n - .55) * (dark ? .1 : .1));
      else if (n < .3) px(x, y, pale, (.3 - n) * (dark ? .4 : .45));
    }
    // 纤维：一根根短而弯，浅色的多、深色的少
    for (let i = 0; i < 240; i++) {
      let x = rnd() * w, y = rnd() * h, a = rnd() * Math.PI, len = 2 + rnd() * 5;
      const col = rnd() < .6 ? brown : pale, al = col === brown ? (dark ? .04 : .06) + rnd() * .05 : (dark ? .12 : .08) + rnd() * .07;
      for (let k = 0; k < len; k++) { px(x, y, col, al); a += (rnd() - .5) * .5; x += Math.cos(a); y += Math.sin(a); }
    }
    // 墨点和杂屑
    for (let i = 0; i < 46; i++) {
      const x = rnd() * w, y = rnd() * h, al = (dark ? .12 : .16) + rnd() * .16;
      px(x, y, speck, al);
      if (rnd() < .25) px(x + 1, y, speck, al * .6);
    }
  });
}

// 打字机格线：一格对应一行字，底下一道点线（2 点墨、2 点空）
function rule(g, w, h, t) {
  const dark = isDark(g, t);
  g.fillStyle = dark ? "rgba(214, 186, 140, .16)" : "rgba(110, 84, 50, .2)";
  for (let x = 0; x < w; x += 4) g.fillRect(x, h - 1, 2, 1);
}

// 咖啡杯印：一圈边沿深、里面淡，圈不太圆，有一段断开；旁边还有半圈（杯子挪过一次）和一滴
function ring(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const col = dark ? [196, 142, 82] : [136, 86, 38], k = dark ? .3 : .5;
  const wob = [rnd() * 6, rnd() * 6, rnd() * 6];
  const r0 = (a) => 18.5 + Math.sin(a * 2 + wob[0]) * .9 + Math.sin(a * 3 + wob[1]) * .6 + Math.sin(a * 5 + wob[2]) * .3;
  pixels(g, w, h, (px) => {
    const cup = (cx, cy, rs, from, to, f) => {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
        let a = Math.atan2(dy, dx); if (a < 0) a += Math.PI * 2;
        if (a < from || a > to) continue;
        const r = r0(a) * rs, e = d - r;
        let al = 0;
        if (e <= 0 && e > -1.6) al = .9;                       // 边沿那一圈最深
        else if (e > 0 && e < 1) al = .45;
        else if (e <= -1.6 && e > -4) al = .32 + rnd() * .1;
        else if (e <= -4) al = .1 + Math.max(0, .08 - d / r * .06);
        const gap = Math.abs(a - 4.2) < .32 ? .25 : 1;          // 断开的一小段
        if (al) px(x, y, col, al * k * f * gap * (.85 + rnd() * .3));
      }
    };
    cup(30, 30, 1, 0, Math.PI * 2, 1);
    cup(37, 41, .95, 3.4, 5.6, .55);
    for (const [x, y, a] of [[9, 52, .7], [10, 52, .6], [9, 53, .5], [11, 54, .3]]) px(x, y, col, a * k);
  }, false);
}

// 「卷宗」章：方框双线，两个字竖排，盖得歪一点；印泥不匀，有缺口
function stamp(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  g.save();
  g.translate(w / 2, h / 2); g.rotate(-.24);
  g.strokeStyle = "#000"; g.lineWidth = 2; g.strokeRect(-17, -19, 34, 38);
  g.lineWidth = 1; g.strokeRect(-13.5, -15.5, 27, 31);
  g.fillStyle = "#000"; g.font = "bold 13px 'Noto Serif SC', 'Songti SC', 'SimSun', serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("卷", 0, -6.5); g.fillText("宗", 0, 7.5);
  g.restore();
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const red = dark ? [226, 88, 84] : [190, 36, 44];
  const blot = smooth(rnd, w, h, 5);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, a = d[i + 3] / 255;
    if (a < .35) { d[i + 3] = 0; continue; }
    const ink = blot(x, y) * .7 + rnd() * .5;
    d[i] = red[0]; d[i + 1] = red[1]; d[i + 2] = red[2];
    d[i + 3] = ink < .3 ? 0 : Math.round((dark ? .4 : .42) * (1 + Math.min(.6, ink * .5)) * 255);
  }
  g.putImageData(img, 0, 0);
}

// 档案夹的标签耳：牛皮纸梯形，贴一张小白签，上面两行打字的痕迹
function tab(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const kraft = dark ? [92, 70, 44] : [214, 176, 112], edge = dark ? [52, 38, 24] : [150, 112, 62], hi = dark ? [120, 94, 62] : [234, 204, 150];
  const label = dark ? [156, 142, 116] : [246, 238, 214], type = dark ? [60, 48, 36] : [70, 56, 44];
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) {
      const inset = Math.max(0, 3 - y);
      for (let x = inset; x < w - inset; x++) {
        const e = x === inset || x === w - 1 - inset || y === 0;
        px(x, y, e ? edge : y === 1 ? hi : kraft, e ? .95 : .92 + rnd() * .08);
      }
    }
    for (let y = 3; y < 11; y++) for (let x = 8; x < w - 8; x++) px(x, y, label, x === 8 || y === 3 ? .7 : .88);
    for (const [y, a, b] of [[5, 11, 34], [8, 11, 25]]) for (let x = a; x < b; x++) if ((x - a) % 4 < 3 && rnd() < .9) px(x, y, type, 1);
    // 签上一道红杠（归档）
    for (let x = 37; x < w - 11; x++) px(x, 6, [190, 36, 44], .95), px(x, 7, [190, 36, 44], .95);
  }, false);
}

// 回形针：左边亮、右边暗，外圈从底下绕回来变成里圈
const CLIP = [
  "..ooooo..",
  ".h.....m.",
  "h.......m",
  "h..ooo..m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...m.m",
  "h.h...o.m",
  "h.h.....m",
  "h.h.....m",
  "h.h.....m",
  "h.h.....m",
  "..h.....m",
  "..h....m.",
  "...oooo..",
];

export default {
  fiber: { size: [160, 160], scale: 2, texture: fiber },
  rule: { size: [4, 20], scale: 1, texture: rule },
  ring: { size: [60, 60], scale: 2, texture: ring },
  stamp: { size: [54, 54], scale: 1, texture: stamp },
  tab: { size: [60, 13], scale: 2, texture: tab },
  clip: { rows: CLIP, colors: { h: "#eef1f5", m: "#7d8796", o: "#b4bcc8" }, scale: 3 },
};
