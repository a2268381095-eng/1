// gothic 这套纸上的像素装饰和纸纹。在 CSS 里用 var(--pa-<名字>)、var(--pa-<名字>-w)、var(--pa-<名字>-h)。
// 魔典书页：犊皮纸（vellum 斑驳的皮纹）、边缘发暗起斑（edge* 焦边 + 霉斑，bite* 是剪毛边用的遮罩）、
// 一道酒红双线框、四角铁艺包角（深色是银的）、顶上一只蝙蝠、底下一枚契约蜡封、烛光那角溅了几滴蜡。
// 连击用的表盘（罗马数字）和指针、复写时飞走的蝙蝠也在这里。

// ---------------- 小工具 ----------------
/** 固定种子的随机数（毛边和焦边要用同一条轮廓，不能用 paper.js 给的 rnd） */
function prng(seed) {
  return () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** 任意 CSS 颜色 → [r, g, b] */
function rgbOf(g, c) {
  g.fillStyle = "#000"; g.fillStyle = c || "#000";
  const s = String(g.fillStyle);
  if (s[0] === "#") return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const m = s.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}
const isDark = (g, t) => { const [r, gg, b] = rgbOf(g, t.paper); return r * .3 + gg * .59 + b * .11 < 128; };
/** 逐像素写：px(x, y, [r,g,b], a)，同一格取更不透明的那次 */
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
/** 能无缝平铺的低频噪声：n×m 个随机点平滑插值，返回 (x, y) → 0..1 */
function smooth(rnd, w, h, n, m = n) {
  const v = Array.from({ length: n * m }, rnd);
  return (x, y) => {
    const fx = (x / w) * n, fy = (y / h) * m, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (i, j) => v[((j % m) + m) % m * n + ((i % n) + n) % n];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
}
/** 字符画 → 纹理：按深浅色各用一套颜色（"." 透明） */
function sprite(rows, light, dark, scale = 3) {
  const w = Math.max(...rows.map((r) => r.length)), h = rows.length;
  return {
    size: [w, h], scale,
    texture(g, _w, _h, t) {
      const pal = isDark(g, t) ? dark : light;
      rows.forEach((r, y) => [...r].forEach((ch, x) => {
        const col = pal[ch];
        if (!col) return;
        g.fillStyle = col;
        g.fillRect(x, y, 1, 1);
      }));
    },
  };
}
const flipX = (rows) => rows.map((r) => [...r].reverse().join(""));
const flipY = (rows) => [...rows].reverse();

/** 形状（0/1 格子）→ 金属上色：左上受光、右下背光，外面落一点影子 */
function metal(m) {
  const H = m.length, W = m[0].length;
  const at = (x, y) => y >= 0 && y < H && x >= 0 && x < W && m[y][x] === 1;
  const stud = (x, y) => y >= 0 && y < H && x >= 0 && x < W && m[y][x] === 2;
  return m.map((r, y) => r.map((v, x) => {
    if (v === 2) return "r";
    if (v === 3) return "b";
    if (v === 1) {
      const up = at(x, y - 1) || stud(x, y - 1), lf = at(x - 1, y) || stud(x - 1, y), dn = at(x, y + 1) || stud(x, y + 1), rt = at(x + 1, y) || stud(x + 1, y);
      if (!dn || !rt) return up && lf ? "s" : "o";
      if (!up || !lf) return "h";
      return "b";
    }
    return at(x - 1, y - 1) || at(x - 1, y) && at(x, y - 1) ? "d" : ".";
  }).join(""));
}

// ---------------- 铁艺包角（左上角那只，其余三只翻过来） ----------------
function cornerShape() {
  const N = 30, m = Array.from({ length: N }, () => Array(N).fill(0));
  const put = (x, y, v = 1) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < N && y < N && m[y][x] !== 2) m[y][x] = v; };
  // 角片：直角三角，斜边挖成一道内凹的弧
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (x + y <= 12 && (x - 12.5) ** 2 + (y - 12.5) ** 2 >= 9.2 ** 2) put(x, y);
  // 沿两条边的铁条，末端一个小矛尖
  for (let x = 0; x <= 21; x++) { put(x, 0); put(x, 1); }
  for (let y = 0; y <= 21; y++) { put(0, y); put(1, y); }
  for (const [a, b] of [[22, 0], [22, 1], [23, 0], [23, 1], [24, 0], [22, 2], [23, 2]]) { put(a, b); put(b, a); }
  // 对角线上一根铁杆，尖上是百合花
  for (let k = 5; k <= 15; k += 0.5) { put(k, k); put(k + 1, k); }
  const lily = [[16, 16], [17, 17], [16, 17], [17, 16], [18, 18], [19, 19], [15, 18], [14, 19], [18, 15], [19, 14], [13, 19], [19, 13], [17, 18], [18, 17]];
  for (const [x, y] of lily) put(x, y);
  // 两道卷草：从铁杆上分出去，各卷一个圈
  const scroll = (sx, sy, ex, ey, cx, cy, r, a0, turns, dir) => {
    for (let t = 0; t <= 1; t += 0.02) put(sx + (ex - sx) * t, sy + (ey - sy) * t);
    for (let t = 0; t <= turns; t += 0.01) {
      const a = a0 + dir * t * Math.PI * 2, rr = r * (1 - t / (turns + .35));
      put(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
  };
  scroll(10, 10, 16, 5, 19, 6.5, 3, Math.PI, 1.1, 1);
  scroll(10, 10, 5, 16, 6.5, 19, 3, -Math.PI / 2, 1.1, -1);
  // 铆钉
  m[3][3] = 2; m[3][4] = 1; m[4][3] = 1;
  m[0][12] = 1; m[12][0] = 1;
  return m;
}
const CORNER = metal(cornerShape());
const IRON_L = { o: "#1a1220", b: "#3a2c42", h: "#6f5c79", s: "#2a1f30", r: "#d9cde0", d: "rgba(60, 30, 20, .28)" };
const IRON_D = { o: "#6d6480", b: "#a49cb4", h: "#ece7f4", s: "#857c96", r: "#ffffff", d: "rgba(0, 0, 0, .55)" };

// ---------------- 顶上的蝙蝠（翅膀张开，压在框线中间） ----------------
const BAT = [
  "..........k...k..........",
  ".kk.......kk.kk.......kk.",
  ".kkkk.....kkkkk.....kkkk.",
  "..kkkkk..kkekekk..kkkkk..",
  "..kkkkkkkkkkkkkkkkkkkkk..",
  "...kkkkkkkkkkkkkkkkkkk...",
  "...kkkkk.kkkkkkk.kkkkk...",
  "....kkk...kkkkk...kkk....",
  "....kk.....kkk.....kk....",
  "...........k.k...........",
];
// 底下的契约蜡封：一滩血红的蜡，中间压着一朵玫瑰
const SEAL = [
  ".....wwwww.....",
  "...wwRRRRRww...",
  "..wRRRRRRRRRw..",
  ".wRRRllllRRRRw.",
  ".wRRlRpppRlRRw.",
  "wRRlRpPppRRlRRw",
  "wRRlpPPPpRRlRRw",
  "wRRRlpppplRRRRw",
  "wRRRRlllRRRRRRw",
  ".wRRRRRgRRRRRw.",
  ".wRRRRggRRRRw..",
  "..wRRRRgRRRw...",
  "...wwRRRRRww...",
  ".....wwwwww....",
];

// ---------------- 纸纹 ----------------
// 犊皮纸：大块的云状斑驳、细颗粒、零星的毛孔小点、几道很淡的皮纹；字所在的地方都很淡
function vellum(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  const n1 = smooth(rnd, w, h, 5), n2 = smooth(rnd, w, h, 11);
  const lo = dark ? [4, 0, 8] : [120, 78, 40], hi = dark ? [92, 66, 104] : [255, 250, 236];
  pixels(g, w, h, (px) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = n1(x, y) * .65 + n2(x, y) * .35;
      // 云斑：暗的地方压一层深色，亮的地方提一点
      if (v < .45) px(x, y, lo, (.45 - v) * (dark ? .55 : .2));
      else if (v > .58) px(x, y, hi, (v - .58) * (dark ? .35 : .5));
      const r = rnd();
      if (r < .05) px(x, y, lo, dark ? .12 + rnd() * .1 : .035 + rnd() * .03);
      else if (r < .08) px(x, y, hi, dark ? .05 + rnd() * .05 : .1 + rnd() * .1);
    }
    // 毛孔：两三个一组的小点
    for (let k = 0; k < 40; k++) {
      const x = (rnd() * w) | 0, y = (rnd() * h) | 0, c = dark ? [0, 0, 0] : [96, 60, 34];
      px(x, y, c, dark ? .22 : .1);
      if (rnd() < .6) px(x + 2, y + 1, c, dark ? .16 : .08);
      if (rnd() < .4) px(x + 1, y + 3, c, dark ? .14 : .07);
    }
    // 皮纹：几道弯弯的细线
    for (let k = 0; k < 3; k++) {
      let x = rnd() * w, y = rnd() * h, a = rnd() * Math.PI * 2;
      for (let s = 0; s < 70; s++) {
        a += (rnd() - .5) * .5;
        x += Math.cos(a); y += Math.sin(a);
        px(Math.round(x), Math.round(y), dark ? [0, 0, 0] : [110, 70, 40], dark ? .14 : .05);
      }
    }
    // 深色：零星几点银色云母
    if (dark) for (let k = 0; k < 22; k++) px((rnd() * w) | 0, (rnd() * h) | 0, [214, 204, 230], .14 + rnd() * .14);
  });
}

// 全页零星的小霉斑（很淡，压不住字）
function foxSparse(g, w, h, t, rnd) {
  const dark = isDark(g, t);
  pixels(g, w, h, (px) => {
    for (let k = 0; k < 9; k++) {
      const x = (rnd() * w) | 0, y = (rnd() * h) | 0, big = rnd() < .4;
      spot(px, x, y, big ? 1.6 : .8, dark, rnd, .55);
    }
  });
}
/** 一个霉斑：深色的芯 + 一圈淡的锈晕，形状不规则 */
function spot(px, x, y, r, dark, rnd, k = 1) {
  const core = dark ? [0, 0, 0] : [128, 64, 28], halo = dark ? [70, 22, 36] : [168, 104, 54];
  const R = Math.ceil(r + 1.5);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const d = Math.hypot(dx, dy * 1.15) + (rnd() - .5) * .9;
    if (d <= r) px(x + dx, y + dy, core, (dark ? .42 : .34) * k * (1 - d / (r + .6) * .45));
    else if (d <= r + 1.6) px(x + dx, y + dy, halo, (dark ? .22 : .16) * k);
  }
}

// ---------------- 毛边和焦边：四条边共用一条轮廓 ----------------
const EDGE_LEN = 320, EDGE_W = 30;
/** 一条边的轮廓：每格往里缺 0–2 像素，偶尔一个小缺口；首尾接得上 */
function contour(seed) {
  const r = prng(seed), n = smooth(r, EDGE_LEN, 1, 23, 1), n2 = smooth(r, EDGE_LEN, 1, 61, 1);
  const d = [];
  for (let i = 0; i < EDGE_LEN; i++) d.push(Math.max(0, Math.round(n(i, 0) * 2.6 + n2(i, 0) * 1.2 - 1.3)));
  for (let k = 0; k < 5; k++) { const i = (r() * EDGE_LEN) | 0; d[i] = Math.max(d[i], 3); d[(i + 1) % EDGE_LEN] = Math.max(d[(i + 1) % EDGE_LEN], 2); }
  return d;
}
const CUTS = { L: contour(11), R: contour(23), T: contour(37), B: contour(53) };
/** 剪掉的那一小条（遮罩里不透明 = 剪掉） */
function bite(side) {
  const d = CUTS[side], vert = side === "L" || side === "R", W = 4;
  const rows = [];
  if (vert) for (let y = 0; y < EDGE_LEN; y++) { let s = ""; for (let x = 0; x < W; x++) s += x < d[y] ? "#" : "."; rows.push(side === "R" ? [...s].reverse().join("") : s); }
  else for (let y = 0; y < W; y++) { let s = ""; for (let x = 0; x < EDGE_LEN; x++) s += y < d[x] ? "#" : "."; rows.push(s); }
  return { rows: side === "B" ? flipY(rows) : rows, colors: { "#": "#000" }, scale: 2 };
}
/** 焦边：沿轮廓一道深线，往里一片不均匀的发暗，越靠边霉斑越多 */
function edge(side) {
  const vert = side === "L" || side === "R";
  const size = vert ? [EDGE_W, EDGE_LEN] : [EDGE_LEN, EDGE_W];
  return {
    size, scale: 2,
    texture(g, w, h, t, rnd) {
      const dark = isDark(g, t), cut = CUTS[side];
      const tone = dark ? [0, 0, 0] : [92, 50, 22], rim = dark ? [0, 0, 0] : [70, 36, 16];
      const n = vert ? smooth(rnd, 1, EDGE_LEN, 1, 17) : smooth(rnd, EDGE_LEN, 1, 17, 1);
      const n2 = vert ? smooth(rnd, 1, EDGE_LEN, 1, 47) : smooth(rnd, EDGE_LEN, 1, 47, 1);
      // (i 沿边, j 离边) → 画布坐标
      const at = (i, j) => {
        if (side === "L") return [j, i];
        if (side === "R") return [w - 1 - j, i];
        if (side === "T") return [i, j];
        return [i, h - 1 - j];
      };
      pixels(g, w, h, (px) => {
        for (let i = 0; i < EDGE_LEN; i++) {
          const c = cut[i], k = vert ? n(0, i) * .7 + n2(0, i) * .3 : n(i, 0) * .7 + n2(i, 0) * .3;
          const reach = 8 + k * 22;
          for (let j = c; j < EDGE_W; j++) {
            const d = j - c;
            if (d === 0) { px(...at(i, j), rim, dark ? .75 : .5); continue; }
            if (d === 1) { px(...at(i, j), rim, dark ? .5 : .3); continue; }
            const f = Math.max(0, 1 - d / reach);
            const a = f * f * (dark ? .62 : .34) * (.75 + rnd() * .5);
            if (a > .01) px(...at(i, j), tone, a);
          }
        }
        // 霉斑：一簇一簇，靠边多
        for (let k = 0; k < 26; k++) {
          const i = (rnd() * EDGE_LEN) | 0, j = 2 + Math.floor(Math.pow(rnd(), 1.8) * (EDGE_W - 6));
          const near = 1 - j / EDGE_W;
          spot(px, ...at(i, j + cut[i]), .6 + rnd() * 1.6 * near, dark, rnd, .6 + near * .5);
          if (rnd() < .5) spot(px, ...at(i + 2 + ((rnd() * 4) | 0), j + cut[i] + 1 + ((rnd() * 3) | 0)), .5 + rnd() * .6, dark, rnd, .6);
        }
      });
    },
  };
}

export default {
  // 纸纹
  vellum: { size: [160, 160], scale: 2, texture: vellum },
  fox: { size: [211, 197], scale: 2, texture: foxSparse },
  // 毛边遮罩（不透明 = 剪掉）和焦边
  biteL: bite("L"), biteR: bite("R"), biteT: bite("T"), biteB: bite("B"),
  edgeL: edge("L"), edgeR: edge("R"), edgeT: edge("T"), edgeB: edge("B"),
  // 四角铁艺
  cornerTL: sprite(CORNER, IRON_L, IRON_D, 2),
  cornerTR: sprite(flipX(CORNER), IRON_L, IRON_D, 2),
  cornerBL: sprite(flipY(CORNER), IRON_L, IRON_D, 2),
  cornerBR: sprite(flipY(flipX(CORNER)), IRON_L, IRON_D, 2),
  bat: sprite(BAT, { k: "#2a1a30", e: "#d23a5a" }, { k: "#0c070e", e: "#ff5a7a" }, 2),
  seal: sprite(SEAL, { w: "#6a0f22", R: "#a3182f", l: "#c8384c", p: "#7c1023", P: "#5e0a1a", g: "#3f7a46" },
    { w: "#5a0b1c", R: "#93162c", l: "#c43a50", p: "#6e0e20", P: "#4e0816", g: "#4f8a56" }, 2),
};
