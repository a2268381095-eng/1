// 背景插画：每套风格一张外景、一张内景（GPT 出图后转成 384×256 的像素画，见 assets/bg/PROMPTS.md）。
// 画在窗口最底下的一张画布上。画布内部就是 384×256，按整数倍放大，像素不糊；上面叠小动效（花瓣、星光、灯火、蝙蝠……）。
// 外景和内景轮换：镜头推向外景里的门窗，按这套风格自己的转场走进内景（魔法星光圈、古风墨晕、哥特蝙蝠群、
// 侦探放大镜、水手服百叶窗、冒险者菱形格），过一阵再退回外景。只在同一套风格的外景、内景之间换。
// 正在打字时动效放轻，轮换也等停笔以后再换。
import SCENES from "../generated/scenes.json";
import { bus } from "./bus.js";
import { getSettings } from "./settings.js";

const W = 384, H = 256;
const AMBIENT_MS = 83;      // 平时 12 帧/秒，像素动画的节奏
const TRANS_MS = 2600;      // 走进、走出
const SWAP_MS = 1100;       // 换风格、换像素版本

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeIn = (t) => t * t * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const metaOf = (style, kind) => (SCENES[style] && SCENES[style][kind]) || null;
/** 这套风格有哪些图："out" 外景、"in" 内景 */
export const sceneKinds = (style) => ["out", "in"].filter((k) => metaOf(style, k));

// ---------------- 小像素图 ----------------
const SPR = {
  petal: [["##", "#."], ["##"], ["#.", ".#"], ["#", "#"]],
  bat: [["#.....#", "##.#.##", ".#####.", "...#..."], ["...#...", ".#####.", "##...##", "#.....#"]],
  bird: [["#...#", ".#.#.", "..#.."], ["##.##", "..#.."]],
};
function rows(g, r, x, y) {
  for (let j = 0; j < r.length; j++) for (let i = 0; i < r[j].length; i++) if (r[j][i] === "#") g.fillRect(x + i, y + j, 1, 1);
}
/** 像素圆：一行一行填，边缘不发虚 */
function disc(g, cx, cy, r) {
  r = Math.round(r); cx = Math.round(cx); cy = Math.round(cy);
  if (r <= 0) return;
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.floor(Math.sqrt(r * r - dy * dy));
    g.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
  }
}
/** 像素圆环 */
function ring(g, cx, cy, r, color, alpha = 1) {
  g.fillStyle = color; g.globalAlpha = alpha;
  const n = Math.max(24, Math.round(r * 7));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 1, 1);
  }
  g.globalAlpha = 1;
}
function star(g, x, y, size, alpha, color) {
  g.fillStyle = color; g.globalAlpha = alpha;
  g.fillRect(x, y, 1, 1);
  for (let k = 1; k <= size; k++) { g.fillRect(x - k, y, 1, 1); g.fillRect(x + k, y, 1, 1); g.fillRect(x, y - k, 1, 1); g.fillRect(x, y + k, 1, 1); }
  g.globalAlpha = 1;
}

// ---------------- 叠在图上的小动效 ----------------
// 每种动效：init(定义) → 状态；update(定义, 状态, dt 秒, calm 正在打字)；draw(画笔, 定义, 状态, now, 原图)
const FX = {
  // 一闪一闪的星光
  twinkle: {
    init: (d) => ({ ph: d.pts.map(() => Math.random()), per: d.pts.map(() => rnd(2200, 4400)) }),
    draw(g, d, s, now) {
      g.fillStyle = d.color;
      d.pts.forEach(([x, y, size = 1], i) => {
        const b = Math.pow(Math.max(0, Math.sin((now / s.per[i] + s.ph[i]) * Math.PI * 2)), 3);
        if (b < 0.12) return;
        g.globalAlpha = b;
        g.fillRect(x, y, 1, 1);
        if (b > 0.45) {
          g.globalAlpha = b * 0.7;
          for (let k = 1; k <= size; k++) { g.fillRect(x - k, y, 1, 1); g.fillRect(x + k, y, 1, 1); g.fillRect(x, y - k, 1, 1); g.fillRect(x, y + k, 1, 1); }
        }
        if (b > 0.85 && size >= 2) {
          g.globalAlpha = b * 0.35;
          g.fillRect(x - 1, y - 1, 1, 1); g.fillRect(x + 1, y - 1, 1, 1); g.fillRect(x - 1, y + 1, 1, 1); g.fillRect(x + 1, y + 1, 1, 1);
        }
      });
      g.globalAlpha = 1;
    },
  },
  // 慢慢呼吸的光晕（月亮、水晶球、太阳）
  glow: {
    draw(g, d, s, now) {
      const a = d.amp * (0.5 + 0.5 * Math.sin((now / d.period) * Math.PI * 2));
      g.globalCompositeOperation = "screen"; g.fillStyle = d.color;
      for (let k = 0; k < 3; k++) { g.globalAlpha = a * 0.45; disc(g, d.at[0], d.at[1], d.r * (1 - k * 0.22) + 2); }
      g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    },
  },
  // 灯火、窗户：不规则地明暗
  flicker: {
    init: (d) => ({ ph: d.pts.map(() => Math.random() * 100) }),
    draw(g, d, s, now) {
      g.globalCompositeOperation = "screen"; g.fillStyle = d.color;
      const amp = d.amp == null ? 0.3 : d.amp;
      d.pts.forEach(([x, y, r], i) => {
        const t = now / 1000 + s.ph[i];
        const n = clamp(0.55 + 0.25 * Math.sin(t * 7.3) + 0.15 * Math.sin(t * 13.1 + 1.7) + 0.05 * Math.sin(t * 29.3));
        if (r <= 2) { g.globalAlpha = n * 0.7; const q = r > 1 ? 1 : 0; g.fillRect(x - q, y - q, 1 + q, 1 + q); return; }
        for (let k = 0; k < 3; k++) { g.globalAlpha = amp * n * 0.5; disc(g, x, y, r * (1 - k * 0.3)); }
      });
      g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    },
  },
  // 一条横着飘的薄雾
  mist: {
    init(d) {
      const c = document.createElement("canvas");
      c.width = W; c.height = d.h;
      const g = c.getContext("2d");
      g.fillStyle = d.color;
      const k1 = rnd(0, 6.28), k2 = rnd(0, 6.28);
      for (let x = 0; x < W; x++) {
        const n = 0.5 + 0.3 * Math.sin((x / W) * Math.PI * 6 + k1) + 0.2 * Math.sin((x / W) * Math.PI * 14 + k2);   // 首尾接得上
        for (let y = 0; y < d.h; y++) {
          const v = n * Math.sin((Math.PI * (y + 0.5)) / d.h);
          const q = v > 0.62 ? 1 : v > 0.38 ? 0.55 : v > 0.2 ? 0.25 : 0;
          if (q) { g.globalAlpha = q; g.fillRect(x, y, 1, 1); }
        }
      }
      return { c, off: Math.random() * W };
    },
    update(d, s, dt) { s.off = (((s.off + d.speed * dt) % W) + W) % W; },
    draw(g, d, s) {
      g.globalAlpha = d.alpha;
      const o = Math.round(s.off);
      g.drawImage(s.c, o - W, d.y); g.drawImage(s.c, o, d.y);
      g.globalAlpha = 1;
    },
  },
  // 水面上的碎光
  glint: {
    init: () => ({ list: [], acc: 0 }),
    update(d, s, dt, calm, mult = 1) {
      s.acc += d.rate * dt * (calm ? 0.4 : 1) * mult;
      const [x, y, w, h] = d.rect;
      while (s.acc >= 1) { s.acc--; s.list.push({ x: Math.round(rnd(x, x + w)), y: Math.round(rnd(y, y + h)), len: Math.round(rnd(2, 6)), t: 0, max: rnd(0.5, 1.1) }); }
      s.list = s.list.filter((p) => (p.t += dt) < p.max);
    },
    draw(g, d, s) {
      g.fillStyle = d.color;
      for (const p of s.list) { g.globalAlpha = Math.sin((p.t / p.max) * Math.PI) * 0.7; g.fillRect(p.x, p.y, p.len, 1); }
      g.globalAlpha = 1;
    },
  },
  // 画里的水自己动：一行一行左右错开，老游戏机那种水波
  wave: {
    draw(g, d, s, now, img) {
      const [x, y, w, h] = d.rect;
      const t = now / 1000, amp = d.amp || 1, sp = d.speed || 2, k = d.k || 0.55;
      for (let j = 0; j < h; j++) {
        const dx = Math.round(Math.sin(j * k + t * sp) * amp * (d.grow ? (j + 1) / h : 1));
        if (dx) g.drawImage(img, x, y + j, w, 1, x + dx, y + j, w, 1);
      }
    },
  },
  // 旗子、窗帘、树冠、树枝：一头固定，另一头摆。pin：top 挂着的（旗子、窗帘）/ bottom 长在地上的（树冠、草）左右摆；
  // left / right 从一边横着伸出来的（树枝）上下摆。rect 在摆动方向上要留出不少于 amp 的背景，不然边上会有重影
  sway: {
    init: () => ({ ph: rnd(0, 6.28) }),
    draw(g, d, s, now, img) {
      const [x, y, w, h] = d.rect;
      const t = now / 1000, amp = d.amp || 2, per = (d.period || 3000) / 1000;
      const base = Math.sin((t / per) * Math.PI * 2 + s.ph) * 0.8 + Math.sin((t / per) * Math.PI * 4.7 + s.ph * 2) * 0.2;
      if (d.pin === "left" || d.pin === "right") {
        // 横着伸出去的树枝：一列一列上下错开，离树干越远摆得越多
        for (let i = 0; i < w; i++) {
          const f = d.pin === "left" ? (i + 1) / w : 1 - i / w;
          const dy = Math.round(base * amp * f * f + Math.sin(i * 0.35 + t * 3) * (d.ripple || 0) * f);
          if (dy) g.drawImage(img, x + i, y, 1, h, x + i, y + dy, 1, h);
        }
        return;
      }
      for (let j = 0; j < h; j++) {
        const f = d.pin === "bottom" ? 1 - j / h : (j + 1) / h;
        const dx = Math.round(base * amp * f * f + Math.sin(j * 0.35 + t * 3) * (d.ripple || 0) * f);
        if (dx) g.drawImage(img, x, y + j, w, 1, x + dx, y + j, w, 1);
      }
    },
  },
  // 小船之类的上下晃（rect 上下要留出背景，挪开的地方露出来的是原图）
  bob: {
    draw(g, d, s, now, img) {
      const [x, y, w, h] = d.rect;
      const dy = Math.round(Math.sin((now / d.period) * Math.PI * 2) * d.amp);
      if (dy) g.drawImage(img, x, y, w, h, x, y + dy, w, h);
    },
  },
  // 飘落的花瓣
  fall: {
    init: () => ({ list: [], acc: Math.random() }),
    update(d, s, dt, calm, mult = 1) {
      s.acc += d.rate * dt * (calm ? 0.35 : 1) * mult;
      const [x, y, w, h] = d.from;
      while (s.acc >= 1) {
        s.acc--;
        s.list.push({ x: rnd(x, x + w), y: rnd(y, y + h), vx: rnd(d.vx[0], d.vx[1]), vy: rnd(d.vy[0], d.vy[1]), ph: rnd(0, 6.28), c: pick(d.colors), f: 0, ft: rnd(0, 0.2) });
      }
      for (const p of s.list) {
        p.ph += dt * 2;
        p.x += (p.vx + Math.sin(p.ph) * d.sway) * dt; p.y += p.vy * dt;
        if ((p.ft += dt) > 0.2) { p.ft = 0; p.f++; }
      }
      s.list = s.list.filter((p) => p.y < H + 4 && p.x > -10 && p.x < W + 10);
      if (s.list.length > 60) s.list.splice(0, s.list.length - 60);
    },
    draw(g, d, s) {
      const fr = SPR[d.sprite] || SPR.petal;
      for (const p of s.list) { g.fillStyle = p.c; rows(g, fr[p.f % fr.length], Math.round(p.x), Math.round(p.y)); }
    },
  },
  // 偶尔飞过的一小群（鸟、蝙蝠）
  fly: {
    init: (d) => ({ next: rnd(2, d.every[1] * 0.6), flock: null }),
    update(d, s, dt, calm, mult = 1) {
      if (s.flock) { s.flock.t += dt; if (s.flock.t > s.flock.dur) s.flock = null; return; }
      if (mult >= 2) s.next = Math.min(s.next, 0.3);   // 热闹的时候马上飞一群
      s.next -= dt;
      if (s.next > 0 || calm) return;
      s.next = rnd(d.every[0], d.every[1]);
      const n = Math.round(rnd(d.count[0], d.count[1]));
      const dist = Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]);
      s.flock = { t: 0, dist, dur: dist / d.speed + 2, members: Array.from({ length: n }, (_, i) => ({ dy: i ? rnd(-9, 9) : 0, ph: rnd(0, 6), delay: i * rnd(0.25, 0.6) })) };
    },
    draw(g, d, s) {
      if (!s.flock) return;
      const fr = SPR[d.sprite] || SPR.bird;
      const flap = d.sprite === "bat" ? 7 : 3.5;
      g.save();
      if (d.clip) { g.beginPath(); g.rect(...d.clip); g.clip(); }
      g.fillStyle = d.color;
      for (const m of s.flock.members) {
        const tt = s.flock.t - m.delay;
        if (tt < 0) continue;
        const p = (tt * d.speed) / s.flock.dist;
        if (p > 1) continue;
        const x = lerp(d.from[0], d.to[0], p), y = lerp(d.from[1], d.to[1], p) + Math.sin(tt * 2.6 + m.ph) * 3 + m.dy;
        const r = fr[Math.floor(tt * flap + m.ph) % 2];
        rows(g, r, Math.round(x - r[0].length / 2), Math.round(y));
      }
      g.restore();
    },
  },
  // 茶杯上的热气
  steam: {
    init: () => ({ list: [], acc: 0 }),
    update(d, s, dt, calm, mult = 1) {
      s.acc += d.rate * dt * mult;
      while (s.acc >= 1) { s.acc--; s.list.push({ x: d.at[0] + rnd(-3, 3), y: d.at[1], t: 0, max: rnd(1.6, 2.6), ph: rnd(0, 6) }); }
      for (const p of s.list) { p.t += dt; p.y -= 7 * dt; }
      s.list = s.list.filter((p) => p.t < p.max);
    },
    draw(g, d, s) {
      g.fillStyle = d.color;
      for (const p of s.list) {
        g.globalAlpha = Math.sin((p.t / p.max) * Math.PI) * 0.45;
        g.fillRect(Math.round(p.x + Math.sin(p.t * 2.2 + p.ph) * 2), Math.round(p.y), 1, 1);
      }
      g.globalAlpha = 1;
    },
  },
  // 灯光里浮着的灰尘
  dust: {
    init: (d) => ({ list: Array.from({ length: d.n }, () => ({ x: rnd(d.rect[0], d.rect[0] + d.rect[2]), y: rnd(d.rect[1], d.rect[1] + d.rect[3]), vx: rnd(-1.5, 1.5), vy: rnd(-1.5, 1.5), ph: rnd(0, 6) })) }),
    update(d, s, dt) {
      const [x, y, w, h] = d.rect;
      for (const p of s.list) {
        p.vx = clamp(p.vx + rnd(-2, 2) * dt, -2, 2); p.vy = clamp(p.vy + rnd(-2, 2) * dt, -2, 2);
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < x) p.x += w; if (p.x > x + w) p.x -= w; if (p.y < y) p.y += h; if (p.y > y + h) p.y -= h;
      }
    },
    draw(g, d, s, now) {
      g.fillStyle = d.color;
      for (const p of s.list) { g.globalAlpha = 0.3 + 0.3 * Math.sin(now / 700 + p.ph); g.fillRect(Math.round(p.x), Math.round(p.y), 1, 1); }
      g.globalAlpha = 1;
    },
  },
  // 流星
  meteor: {
    init: (d) => ({ next: rnd(3, d.every[1] * 0.6), m: null }),
    update(d, s, dt, calm, mult = 1) {
      if (s.m) { s.m.t += dt; if (s.m.t > 0.7) s.m = null; return; }
      if (mult >= 2) s.next = Math.min(s.next, rnd(0.2, 1.5));
      s.next -= dt;
      if (s.next > 0 || calm) return;
      s.next = rnd(d.every[0], d.every[1]);
      const [x, y, w, h] = d.area;
      s.m = { x: rnd(x, x + w), y: rnd(y, y + h), t: 0 };
    },
    draw(g, d, s) {
      if (!s.m) return;
      const p = s.m.t / 0.7;
      const hx = s.m.x - p * 54, hy = s.m.y + p * 27;
      g.fillStyle = d.color;
      for (let k = 0; k < 9; k++) { g.globalAlpha = Math.sin(p * Math.PI) * (1 - k / 9); g.fillRect(Math.round(hx + k * 2), Math.round(hy - k), 1, 1); }
      g.globalAlpha = 1;
    },
  },
};

const MOVERS = new Set(["wave", "sway", "bob"]);

// ---------------- 场景 ----------------
const imgs = new Map();
function loadImg(url) {
  if (!imgs.has(url)) {
    imgs.set(url, new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => { imgs.delete(url); rej(new Error("背景图读不到：" + url)); };
      im.src = url;
    }));
  }
  return imgs.get(url);
}
function urlOf(style, kind) {
  const m = metaOf(style, kind);
  return `bg/${style}_${kind}${getSettings().sceneDither && m.dither ? "_dither" : ""}.png`;
}
async function makeScene(style, kind) {
  const meta = metaOf(style, kind);
  const url = urlOf(style, kind);
  const img = await loadImg(url);
  // 先挪画里的东西（水波、摆动、晃），再在上面叠粒子
  const fx = (meta.fx || []).filter((d) => FX[d.type]).map((d) => ({ d, s: FX[d.type].init ? FX[d.type].init(d) : {} }))
    .sort((a, b) => (MOVERS.has(b.d.type) ? 1 : 0) - (MOVERS.has(a.d.type) ? 1 : 0));
  return { style, kind, meta, img, url, fx, bursts: [], boost: null, shiver: null };
}
let resting = false;   // 纸淡下去的时候，背景热闹一点
function update(sc, dt, calm, now) {
  const b = Math.max(sc.boost && now < sc.boost.until ? sc.boost.mult : 1, resting ? 1.4 : 1);
  for (const f of sc.fx) { const u = FX[f.d.type].update; if (u) u(f.d, f.s, dt, calm && b === 1, b); }
  updateBursts(sc, dt);
  if (sc.shiver && (sc.shiver.t += dt) > sc.shiver.max) sc.shiver = null;
}

// ---------------- 点一下、写到里程碑时冒出来的东西 ----------------
// 粒子都按原图坐标算，跟着镜头一起放大
function lighten(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * k));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
function updateBursts(sc, dt) {
  for (const p of sc.bursts) {
    if (p.delay > 0) { p.delay -= dt; continue; }
    p.t += dt;
    if (p.vx != null) { p.vy += (p.g || 0) * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    if (p.k === "petal" && (p.ft = (p.ft || 0) + dt) > 0.18) { p.ft = 0; p.f = (p.f || 0) + 1; }
  }
  sc.bursts = sc.bursts.filter((p) => p.t < p.max);
  if (sc.bursts.length > 260) sc.bursts.splice(0, sc.bursts.length - 260);
}
function drawBursts(g, sc, now) {
  for (const p of sc.bursts) {
    if (p.delay > 0) continue;
    const life = p.t / p.max, fade = clamp((1 - life) * 3);
    const x = Math.round(p.x), y = Math.round(p.y);
    switch (p.k) {
      case "flash":
        g.globalCompositeOperation = "screen"; g.fillStyle = p.color;
        for (let k = 0; k < 3; k++) { g.globalAlpha = 0.5 * Math.sin(life * Math.PI) * (1 - k * 0.15); disc(g, x, y, p.r * (0.45 + k * 0.3) * (0.7 + life * 0.5)); }
        g.globalCompositeOperation = "source-over";
        break;
      case "spark":
        g.fillStyle = p.color; g.globalAlpha = fade; g.fillRect(x, y, p.size || 1, p.size || 1);
        break;
      case "star":
        star(g, x, y, life < 0.5 ? 2 : 1, fade, p.color);
        break;
      case "petal": {
        g.fillStyle = p.color; g.globalAlpha = fade;
        const fr = SPR.petal; rows(g, fr[(p.f || 0) % fr.length], x, y);
        break;
      }
      case "ring": {
        const r = 2 + life * p.r;
        g.fillStyle = p.color; g.globalAlpha = (1 - life) * 0.8;
        const n = Math.max(16, Math.round(r * 5));
        for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; g.fillRect(Math.round(p.x + Math.cos(a) * r), Math.round(p.y + Math.sin(a) * r * 0.35), 1, 1); }
        break;
      }
      case "puff":
        g.fillStyle = p.color; g.globalAlpha = Math.sin(life * Math.PI) * 0.55; g.fillRect(x, y, 2, 2);
        break;
      case "bird":
      case "bat": {
        g.fillStyle = p.color; g.globalAlpha = 1;
        const fr = SPR[p.k], r = fr[Math.floor(now / (p.k === "bat" ? 70 : 140) + p.ph) % 2];
        rows(g, p.vx < 0 ? r : r.map((row) => [...row].reverse().join("")), x - 3, y);
        break;
      }
      case "meteor":
        g.fillStyle = p.color;
        for (let k = 0; k < 10; k++) { g.globalAlpha = Math.sin(life * Math.PI) * (1 - k / 10); g.fillRect(Math.round(p.x - p.vx * 0.012 * k), Math.round(p.y - p.vy * 0.012 * k), 1, 1); }
        break;
    }
  }
  g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
}

/** 点到画里的东西：灯亮一下、水起波纹、花落一阵…… */
const ACTS = {
  flare(sc, sp) {
    const [x, y, w, h] = sp.rect, cx = x + w / 2, cy = y + h / 2, c = sp.color || "#ffd890";
    sc.bursts.push({ k: "flash", x: cx, y: cy, r: clamp(Math.max(w, h) * 0.8, 6, 30), color: c, t: 0, max: 1.1 });
    for (let i = 0; i < 9; i++) sc.bursts.push({ k: "spark", x: cx + rnd(-w / 3, w / 3), y: cy + rnd(-h / 4, h / 4), vx: rnd(-10, 10), vy: rnd(-34, -14), g: 14, color: pick([c, "#fff3c0", "#ffffff"]), t: 0, max: rnd(0.7, 1.4), delay: rnd(0, 0.25) });
  },
  ripple(sc, sp, px, py) {
    const c = sp.color || "#ffffff";
    for (let k = 0; k < 3; k++) sc.bursts.push({ k: "ring", x: px, y: py, r: 16 + k * 4, color: k ? lighten(c, 0.3) : c, t: 0, max: 1.4, delay: k * 0.3 });
    for (let i = 0; i < 6; i++) sc.bursts.push({ k: "spark", x: px + rnd(-14, 14), y: py + rnd(-4, 4), vx: 0, vy: 0, color: "#ffffff", t: 0, max: rnd(0.4, 0.9), delay: rnd(0.1, 0.8) });
  },
  shower(sc, sp) {
    const [x, y, w, h] = sp.rect, c = sp.color || "#f7a8c8";
    for (let i = 0; i < 24; i++) sc.bursts.push({ k: "petal", x: rnd(x, x + w), y: rnd(y, y + h * 0.7), vx: rnd(-12, 16), vy: rnd(10, 28), g: 4, color: pick([c, lighten(c, 0.35), c]), t: 0, max: rnd(2.2, 3.8), delay: rnd(0, 0.6), f: Math.floor(rnd(0, 4)) });
  },
  puff(sc, sp) {
    const [x, y, w, h] = sp.rect, c = sp.color || "#ffffff";
    for (let i = 0; i < 16; i++) sc.bursts.push({ k: "puff", x: x + w / 2 + rnd(-w / 4, w / 4), y: y + h * 0.3, vx: rnd(-6, 6), vy: rnd(-24, -10), g: 3, color: c, t: 0, max: rnd(1.2, 2.3), delay: rnd(0, 0.5) });
  },
  sparkle(sc, sp, px, py) {
    const c = sp.color || "#ffe08a";
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 + rnd(-0.2, 0.2), v = rnd(22, 46); sc.bursts.push({ k: "star", x: px, y: py, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0, color: pick([c, "#ffffff", "#ffe08a"]), t: 0, max: rnd(0.6, 1.0) }); }
  },
  flock(sc, sp) {
    const [x, y, w, h] = sp.rect, dir = x + w / 2 < W / 2 ? -1 : 1, k = sp.sprite === "bat" ? "bat" : "bird";
    const n = Math.round(rnd(3, 6));
    for (let i = 0; i < n; i++) sc.bursts.push({ k, x: rnd(x, x + w), y: rnd(y, y + h), vx: dir * rnd(30, 52), vy: rnd(-26, -10), g: 4, color: sp.color || (k === "bat" ? "#1c1020" : "#3a3a36"), ph: rnd(0, 6), t: 0, max: 4, delay: i * rnd(0.05, 0.2) });
  },
  meteor(sc, sp, px, py) {
    sc.bursts.push({ k: "meteor", x: px, y: py, vx: -90, vy: 45, g: 0, color: sp.color || "#ffffff", t: 0, max: 0.9 });
  },
};
function act(sc, sp, px, py) {
  const f = ACTS[sp.act];
  if (!f) return;
  const [x, y, w, h] = sp.rect;
  f(sc, sp, px == null ? x + w / 2 : px, py == null ? y + h / 2 : py);
  kickLoop();
}

// 每套风格自己的庆祝：魔法少女流星雨、水手服一阵樱花风、古风梅花风、哥特一群蝙蝠绕过月亮、侦探全街的灯一起亮、冒险者从天上撒金光
const PARTY = {
  magical(sc) { for (let i = 0; i < 6; i++) sc.bursts.push({ k: "meteor", x: rnd(140, 384), y: rnd(0, 50), vx: -90, vy: 45, color: "#ffffff", t: 0, max: 0.9, delay: i * 0.35 }); },
  sailor(sc) { gust(sc, ["#f7b8cf", "#ffd8e6", "#f39ab9"], 1); },
  hanfu(sc) { gust(sc, ["#c8323c", "#e0564f", "#a8242c"], 1); },
  gothic(sc) { for (let i = 0; i < 12; i++) sc.bursts.push({ k: "bat", x: W + rnd(0, 40), y: rnd(10, 90), vx: -rnd(60, 90), vy: rnd(-8, 8), color: "#1c1020", ph: rnd(0, 6), t: 0, max: 7, delay: i * 0.12 }); },
  detective(sc) { (sc.meta.spots || []).filter((sp) => sp.act === "flare").forEach((sp, i) => setTimeout(() => act(sc, sp), i * 160)); },
  adventurer(sc) { for (let i = 0; i < 34; i++) sc.bursts.push({ k: "star", x: rnd(0, W), y: rnd(-20, 0), vx: rnd(-6, 6), vy: rnd(30, 60), g: 8, color: pick(["#ffd666", "#ffe9a8", "#ffffff"]), t: 0, max: rnd(2.5, 4), delay: rnd(0, 1.2) }); },
};
function gust(sc, colors, dir) {
  for (let i = 0; i < 40; i++) sc.bursts.push({ k: "petal", x: dir > 0 ? rnd(-30, 0) : rnd(W, W + 30), y: rnd(0, H * 0.8), vx: dir * rnd(55, 95), vy: rnd(8, 26), g: 2, color: pick(colors), t: 0, max: 6, delay: rnd(0, 1.4), f: Math.floor(rnd(0, 4)) });
}
/** 热闹一下。big：里程碑、达成目标；不 big：连击升级 */
function party(big) {
  const sc = cur;
  if (!sc || motion() === "off") return;
  const now = performance.now();
  sc.boost = { until: now + (big ? 8000 : 4000), mult: big ? 3 : 2 };
  if (big) {
    (sc.meta.spots || []).forEach((sp, i) => setTimeout(() => { if (cur === sc) act(sc, sp); }, 300 + i * 240));
    if (PARTY[sc.style]) PARTY[sc.style](sc);
  } else {
    const sp = pick(sc.meta.spots || [null]);
    if (sp) act(sc, sp);
  }
  kickLoop();
}

// ---------------- 画 ----------------
let canvas = null, ctx = null;
let bufA, gA, bufB, gB, maskC, gM;
let cur = null, trans = null;
let timer = 0, raf = 0, lastFrame = 0;
let lastType = -1e9, lastSwitch = 0;
let routeName = "", token = 0, dark = false;

const motion = () => document.documentElement.dataset.motion || "full";

function newCanvas() { const c = document.createElement("canvas"); c.width = W; c.height = H; return c; }
function g2d(c) { const g = c.getContext("2d"); g.imageSmoothingEnabled = false; return g; }

/** 画一张场景。cam：{ z 放大倍数, fx/fy 原图上的点, px/py 这个点落在画面上的位置 } */
function paint(g, sc, now, cam) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; g.imageSmoothingEnabled = false;
  if (cam && cam.z > 1.001) {
    const z = cam.z;
    const sx = clamp(cam.fx - cam.px / z, 0, W - W / z), sy = clamp(cam.fy - cam.py / z, 0, H - H / z);
    g.drawImage(sc.img, sx, sy, W / z, H / z, 0, 0, W, H);
    g.setTransform(z, 0, 0, z, -sx * z, -sy * z);
  } else {
    g.drawImage(sc.img, 0, 0);
  }
  if (motion() !== "off") {
    for (const f of sc.fx) FX[f.d.type].draw(g, f.d, f.s, now, sc.img);
    drawBursts(g, sc, now);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
  // 一下删了很多字：画面暗一下、抖一下
  if (sc.shiver) {
    const a = Math.sin((sc.shiver.t / sc.shiver.max) * Math.PI);
    g.fillStyle = "#000"; g.globalAlpha = 0.28 * a; g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
  }
}

// 转场的镜头：走进（外景推向门窗 → 内景从稍微放大落定）、走出（内景推向窗口 → 外景从门窗拉远）
function cams(tr, t) {
  const C = [W / 2, H / 2];
  const F1 = tr.from.meta.focus || C, F2 = tr.to.meta.focus || C;
  if (tr.dir === "in") {
    const a = clamp(t / 0.62), sl = easeInOut(a);
    const lt = clamp((t - 0.36) / 0.64);
    return {
      from: { z: 1 + 1.9 * easeIn(a), fx: F1[0], fy: F1[1], px: lerp(F1[0], C[0], sl), py: lerp(F1[1], C[1], sl) },
      to: { z: 1 + 0.35 * (1 - easeOut(lt)), fx: C[0], fy: C[1], px: C[0], py: C[1] },
      p: easeInOut(clamp((t - 0.34) / 0.5)),
    };
  }
  if (tr.dir === "out") {
    const a = clamp(t / 0.6), sl = easeInOut(a);
    const lt = easeOut(clamp((t - 0.28) / 0.72));
    return {
      from: { z: 1 + 0.6 * easeIn(a), fx: F1[0], fy: F1[1], px: lerp(F1[0], C[0], sl), py: lerp(F1[1], C[1], sl) },
      to: { z: 1 + 1.9 * (1 - lt), fx: F2[0], fy: F2[1], px: lerp(C[0], F2[0], lt), py: lerp(C[1], F2[1], lt) },
      p: easeInOut(clamp((t - 0.28) / 0.45)),
    };
  }
  return { from: null, to: null, p: easeInOut(t) };
}

const maxR = (o) => Math.max(Math.hypot(o[0], o[1]), Math.hypot(W - o[0], o[1]), Math.hypot(o[0], H - o[1]), Math.hypot(W - o[0], H - o[1]));
function hash(i, j, seed) { const x = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453; return x - Math.floor(x); }
/** 一张平滑的随机图（墨晕边缘用） */
function noiseField(cols, rowsN, cell, seed) {
  const gw = Math.ceil(cols / cell) + 2, gh = Math.ceil(rowsN / cell) + 2;
  const grid = new Float32Array(gw * gh).map((_, i) => hash(i % gw, Math.floor(i / gw), seed));
  const out = new Float32Array(cols * rowsN);
  for (let y = 0; y < rowsN; y++) for (let x = 0; x < cols; x++) {
    const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const v = (a, b) => grid[(y0 + b) * gw + x0 + a];
    out[y * cols + x] = lerp(lerp(v(0, 0), v(1, 0), sx), lerp(v(0, 1), v(1, 1), sx), sy);
  }
  return out;
}

// 各套风格的转场：mask 在 gM 上画出新画面露出来的部分，deco 在最上面加装饰
const lensR = (p, o) => (p < 0.3 ? easeOut(p / 0.3) * 26 : p < 0.5 ? 26 + Math.sin((p - 0.3) * 40) : 26 + easeIn((p - 0.5) / 0.5) * (maxR(o) - 20));
const TRANS = {
  // 魔法少女：星光圈从门口张开，圈边上一路闪星星
  sparkle: {
    mask(g, p, o) { disc(g, o[0], o[1], p * maxR(o)); },
    deco(g, p, o) {
      if (p <= 0 || p >= 1) return;
      const R = p * maxR(o);
      ring(g, o[0], o[1], R, "#fff4fb", 0.8);
      const cols = ["#ffffff", "#ffd666", "#f796ba"];
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * Math.PI * 2;
        star(g, Math.round(o[0] + Math.cos(a) * R), Math.round(o[1] + Math.sin(a) * R), Math.random() < 0.3 ? 2 : 1, rnd(0.6, 1), pick(cols));
      }
    },
  },
  // 古风：墨在宣纸上晕开，边上一圈深色墨痕
  ink: {
    prep(tr) { tr.noise = noiseField(W / 2, H / 2, 10, tr.seed); },
    mask(g, p, o, tr) {
      const mr = maxR(o), th = p * 1.35 - 0.05, cols = W / 2;
      tr.edge = [];
      for (let by = 0; by < H / 2; by++) for (let bx = 0; bx < cols; bx++) {
        const d = Math.hypot(bx * 2 + 1 - o[0], by * 2 + 1 - o[1]) / mr + (tr.noise[by * cols + bx] - 0.5) * 0.55;
        if (d < th) { g.fillRect(bx * 2, by * 2, 2, 2); if (d > th - 0.05) tr.edge.push(bx * 2, by * 2); }
      }
    },
    deco(g, p, o, tr) {
      if (!tr.edge || p >= 1) return;
      g.fillStyle = "#2b2622"; g.globalAlpha = 0.55 * (1 - p * 0.6);
      for (let i = 0; i < tr.edge.length; i += 2) g.fillRect(tr.edge[i], tr.edge[i + 1], 2, 2);
      g.globalAlpha = 1;
    },
  },
  // 哥特：一群蝙蝠从左往右扫过去，扫过的地方换成新画面；先压暗，再亮起来
  bats: {
    prep(tr) { tr.bats = Array.from({ length: 22 }, (_, i) => ({ y: (i / 22) * H + rnd(-6, 6), off: rnd(-34, 10), ph: rnd(0, 6) })); tr.noise = noiseField(1, H / 4, 4, tr.seed); },
    dim: (p) => 0.55 * Math.sin(Math.min(1, p * 1.2) * Math.PI),
    mask(g, p, o, tr) {
      const front = -40 + p * (W + 80);
      for (let by = 0; by < H / 4; by++) { const e = Math.round(front + (tr.noise[by] - 0.5) * 40); if (e > 0) g.fillRect(0, by * 4, e, 4); }
    },
    deco(g, p, o, tr, now) {
      if (p <= 0 || p >= 1) return;
      const front = -40 + p * (W + 80);
      g.fillStyle = "#1c1020";
      for (const b of tr.bats) rows(g, SPR.bat[Math.floor(now / 70 + b.ph) % 2], Math.round(front + b.off), Math.round(b.y + Math.sin(now / 160 + b.ph) * 3));
    },
  },
  // 侦探：放大镜先在门窗上停一下，镜片里是新画面，然后镜片撑满整个画面
  lens: {
    mask(g, p, o) { disc(g, o[0], o[1], lensR(p, o)); },
    deco(g, p, o) {
      if (p <= 0 || p >= 1) return;
      const R = lensR(p, o);
      const fade = p < 0.55 ? 1 : clamp(1 - (p - 0.55) / 0.3);
      if (fade <= 0) return;
      // 木柄，斜向右下
      g.fillStyle = "#4a2a18"; g.globalAlpha = fade;
      for (let k = 0; k < 20; k++) g.fillRect(Math.round(o[0] + (R + 2 + k) * 0.707) - 1, Math.round(o[1] + (R + 2 + k) * 0.707) - 1, 4, 3);
      ring(g, o[0], o[1], R + 2, "#5a3c18", fade);
      ring(g, o[0], o[1], R + 1, "#c9a050", fade);
      ring(g, o[0], o[1], R, "#e8c878", fade * 0.9);
      // 镜片上的高光
      g.fillStyle = "#ffffff"; g.globalAlpha = 0.45 * fade;
      for (let k = 0; k < 6; k++) g.fillRect(Math.round(o[0] - R * 0.55 + k), Math.round(o[1] - R * 0.5 - k * 0.6), 1, 1);
      g.globalAlpha = 1;
    },
  },
  // 水手服：百叶窗一片一片从上往下翻开
  blinds: {
    mask(g, p) {
      const sl = 16, n = H / sl;
      for (let i = 0; i < n; i++) { const q = clamp(p * 1.7 - (i / n) * 0.7); if (q > 0) g.fillRect(0, i * sl, W, Math.round(q * sl)); }
    },
    deco(g, p) {
      const sl = 16, n = H / sl;
      for (let i = 0; i < n; i++) {
        const q = clamp(p * 1.7 - (i / n) * 0.7);
        if (q <= 0 || q >= 1) continue;
        const y = i * sl + Math.round(q * sl);
        g.fillStyle = "#ffffff"; g.globalAlpha = 0.6; g.fillRect(0, y, W, 1);
        g.fillStyle = "#1f2a3d"; g.globalAlpha = 0.25; g.fillRect(0, y + 1, W, 1);
      }
      g.globalAlpha = 1;
    },
  },
  // 冒险者：老 RPG 那种菱形格，从门口一格一格翻过去
  tiles: {
    mask(g, p, o) {
      const T = 16, mr = maxR(o);
      for (let ty = 0; ty < H / T; ty++) for (let tx = 0; tx < W / T; tx++) {
        const cx = tx * T + T / 2, cy = ty * T + T / 2;
        const q = clamp((p - (Math.hypot(cx - o[0], cy - o[1]) / mr) * 0.55) / 0.45);
        if (q <= 0) continue;
        if (q >= 1) { g.fillRect(tx * T, ty * T, T, T); continue; }
        const r = Math.round(q * T);
        for (let dy = -T / 2; dy < T / 2; dy++) { const w = r - Math.abs(dy + 0.5); if (w > 0) g.fillRect(cx - w, cy + dy, w * 2, 1); }
      }
    },
  },
  // 换风格：方块随机翻
  mosaic: {
    mask(g, p, o, tr) {
      const B = 8;
      for (let by = 0; by < H / B; by++) for (let bx = 0; bx < W / B; bx++) if (hash(bx, by, tr.seed) < p) g.fillRect(bx * B, by * B, B, B);
    },
  },
};

function render(now) {
  if (!cur) return;
  if (!trans) { paint(ctx, cur, now, null); return; }
  const tr = trans;
  const t = clamp((now - tr.start) / tr.dur);
  if (t >= 1) { finish(); paint(ctx, cur, now, null); return; }
  const c = cams(tr, t);
  paint(gA, tr.from, now, c.from);
  paint(gB, tr.to, now, c.to);
  const T = TRANS[tr.type];
  if (tr.type === "bats") { gA.fillStyle = "#120818"; gA.globalAlpha = T.dim(c.p); gA.fillRect(0, 0, W, H); gA.globalAlpha = 1; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(bufA, 0, 0);
  const o = c.from ? [c.from.px, c.from.py] : [W / 2, H / 2];
  if (!T) { ctx.globalAlpha = c.p; ctx.drawImage(bufB, 0, 0); ctx.globalAlpha = 1; return; }   // fade：淡入
  gM.clearRect(0, 0, W, H); gM.fillStyle = "#fff";
  T.mask(gM, c.p, o, tr);
  gB.globalCompositeOperation = "destination-in"; gB.drawImage(maskC, 0, 0); gB.globalCompositeOperation = "source-over";
  ctx.drawImage(bufB, 0, 0);
  if (T.deco) T.deco(ctx, c.p, o, tr, now);
}

function finish() {
  if (!trans) return;
  cur = trans.to;
  trans = null;
  canvas.removeAttribute("data-transition");
  markCanvas();
}

function markCanvas() {
  canvas.dataset.scene = cur.style + "_" + cur.kind;
  canvas.classList.toggle("night", !!cur.meta.night);
  canvas.classList.toggle("dim", dark);
}

// ---------------- 帧循环 ----------------
function schedule() {
  if (raf || timer || !cur || document.hidden) return;
  const m = motion();
  const animated = trans || (m !== "off" && (cur.fx.length || cur.bursts.length || m === "full"));
  if (!animated) return;
  if (trans) { raf = requestAnimationFrame(frame); return; }
  timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, m === "simple" ? AMBIENT_MS * 2 : AMBIENT_MS);
}
function frame(now) {
  raf = 0;
  if (!cur || !canvas.isConnected) return;
  const dt = Math.min(0.25, (now - (lastFrame || now)) / 1000);
  lastFrame = now;
  if (motion() !== "off") {
    const calm = now - lastType < 4000;
    update(cur, dt, calm, now);
    if (trans) update(trans.to, dt, calm, now);
    else drift(now);
  }
  render(now);
  schedule();
}
function kickLoop() { if (!raf && !timer) schedule(); }
function redraw() {
  if (!cur) return;
  cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); timer = 0;
  lastFrame = performance.now();
  render(lastFrame);
  schedule();
}

// ---------------- 摆放：整数倍放大，盖满窗口 ----------------
let lay = null;
function layout(sc = cur, smooth = false) {
  if (!canvas || !sc) return;
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth, vh = window.innerHeight;
  const s = Math.max(1, Math.ceil(Math.max((vw * dpr) / W, (vh * dpr) / H) - 0.001));
  const cw = (W * s) / dpr, ch = (H * s) / dpr;
  const [ax, ay] = sc.meta.anchor || [0.5, 0.5];
  const left = clamp(vw / 2 - ax * cw, vw - cw, 0), top = clamp(vh / 2 - ay * ch, vh - ch, 0);
  // 镜头慢慢漂：在盖得住窗口的范围里左右上下挪一点
  const R = 28;
  lay = { dpr, left, top, lx: [Math.max(vw - cw, left - R), Math.min(0, left + R)], ly: [Math.max(vh - ch, top - R * 0.6), Math.min(0, top + R * 0.6)] };
  canvas.style.width = cw + "px";
  canvas.style.height = ch + "px";
  canvas.style.transition = smooth ? "transform 1.6s ease-in-out" : "none";
  lay.at = performance.now();
  const [l, t] = driftPos(lay.at);
  place(l, t);
}
function driftPos(now) {
  if (motion() !== "full") return [lay.left, lay.top];
  const t = now / 1000;
  const fx = 0.5 + 0.5 * Math.sin((t / 70) * Math.PI * 2), fy = 0.5 + 0.5 * Math.sin((t / 53) * Math.PI * 2 + 1.3);
  return [lerp(lay.lx[0], lay.lx[1], fx), lerp(lay.ly[0], lay.ly[1], fy)];
}
function place(left, top) {
  const d = lay.dpr;
  canvas.style.transform = `translate(${Math.round(left * d) / d}px, ${Math.round(top * d) / d}px)`;
}
let drifted = "";
function drift(now) {
  if (!lay || motion() !== "full" || performance.now() - lay.at < 1700) return;
  const [l, tp] = driftPos(now);
  const key = Math.round(l * lay.dpr) + "," + Math.round(tp * lay.dpr);
  if (key === drifted) return;
  drifted = key;
  if (canvas.style.transition !== "none") canvas.style.transition = "none";
  place(l, tp);
}

// ---------------- 换场景 ----------------
/** 换到某套风格的外景 / 内景。dir："in" 走进、"out" 走出、"swap" 换风格、null 直接换 */
async function go(style, kind, dir) {
  const my = ++token;
  let sc;
  try { sc = await makeScene(style, kind); } catch (e) { console.warn(e.message); if (my === token) hide(); return; }
  if (my !== token) return;
  show();
  const m = motion();
  if (trans) finish();
  lastSwitch = performance.now();
  if (!cur || !dir || m === "off") {
    cur = sc; markCanvas(); layout(); redraw();
    return;
  }
  const type = m === "simple" ? "fade" : dir === "swap" ? "mosaic" : (SCENES[style] && SCENES[style].transition) || "mosaic";
  trans = { from: cur, to: sc, dir: m === "simple" ? "swap" : dir, type, start: performance.now(), dur: m === "simple" ? 700 : dir === "swap" ? SWAP_MS : TRANS_MS, seed: Math.random() * 100 };
  if (TRANS[type] && TRANS[type].prep) TRANS[type].prep(trans);
  canvas.dataset.transition = type;
  canvas.dataset.scene = style + "_" + kind;
  layout(sc, true);
  redraw();
  if (dir === "in" || dir === "out") bus.emit("scene:changed", { style, kind, dir });
}

function preferKind(style) {
  const kinds = sceneKinds(style);
  const s = getSettings();
  let k = cur && cur.style === style ? cur.kind : s.sceneNav !== false && routeName === "book" ? "in" : "out";
  if (cur && cur.style !== style && kinds.includes(cur.kind)) k = cur.kind;
  return kinds.includes(k) ? k : kinds[0];
}

function show() {
  canvas.hidden = false;
  document.body.classList.add("has-scene");
}
function hide() {
  token++;
  if (trans) finish();
  cur = null;
  if (!canvas) return;
  canvas.hidden = true;
  delete canvas.dataset.scene;
  document.body.classList.remove("has-scene");
  cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); timer = 0;
}

/** 鼠标下面是不是露出来的背景，是的话点到了哪个东西 */
function overBackground(e) {
  const t = e.target;
  if (!(t instanceof Element)) return false;
  if (t === document.body || t === document.documentElement || t.id === "app") return true;
  if (t.closest(".modal-back, .demon, .look-pop, .menu, .book-pop, .toast, .help-pop")) return false;
  if (t.matches(".shelf-main, .shelf-grid, .view.shelf, .ws-body")) return true;
  const center = t.closest(".center");
  if (center && (t === center || t.matches(".ed-host, .cm-editor, .cm-scroller"))) {
    const r = center.getBoundingClientRect();
    const tw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-width")) || 720;
    const sheet = Math.min(r.width, tw + 64), left = r.left + (r.width - sheet) / 2;
    return e.clientX < left || e.clientX > left + sheet;
  }
  return false;
}
function hitSpot(e) {
  if (!cur || trans || canvas.hidden || motion() === "off" || !cur.meta.spots || !overBackground(e)) return null;
  const r = canvas.getBoundingClientRect();
  if (!r.width) return null;
  const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
  const sp = cur.meta.spots.find((s) => x >= s.rect[0] && x <= s.rect[0] + s.rect[2] && y >= s.rect[1] && y <= s.rect[1] + s.rect[3]);
  return sp ? { sp, x, y } : null;
}

let wantStyle = null;
/** applyLook 每次调：配色（= 用哪套风格的背景）、明暗 */
export function syncScene(palette, isDark) {
  if (!canvas) return;
  dark = !!isDark;
  wantStyle = palette || "magical";
  const s = getSettings();
  if (s.sceneBg === false || !sceneKinds(wantStyle).length) { hide(); return; }
  canvas.classList.toggle("dim", dark);
  const kind = preferKind(wantStyle);
  if (cur && cur.style === wantStyle && cur.kind === kind && cur.url === urlOf(wantStyle, kind)) { redraw(); return; }
  if (trans && trans.to.style === wantStyle && trans.to.url === urlOf(wantStyle, kind)) return;
  go(wantStyle, kind, cur ? "swap" : null);
}

/** 换景：外景 ↔ 内景。这套只有一张时返回 false */
export function nextScene() {
  const sc = trans ? trans.to : cur;
  if (!sc || sceneKinds(sc.style).length < 2) return false;
  const k = sc.kind === "out" ? "in" : "out";
  go(sc.style, k, k === "in" ? "in" : "out");
  return true;
}

/** 现在的背景：{ style, kind, kinds } 或 null */
export function sceneInfo() {
  const sc = trans ? trans.to : cur;
  return sc ? { style: sc.style, kind: sc.kind, kinds: sceneKinds(sc.style) } : null;
}

export function mountScene() {
  if (canvas) return;
  canvas = document.createElement("canvas");
  canvas.className = "scene-layer";
  canvas.width = W; canvas.height = H;
  canvas.hidden = true;
  canvas.setAttribute("aria-hidden", "true");
  ctx = g2d(canvas);
  bufA = newCanvas(); gA = g2d(bufA);
  bufB = newCanvas(); gB = g2d(bufB);
  maskC = newCanvas(); gM = g2d(maskC);
  document.body.prepend(canvas);
  window.addEventListener("resize", () => layout(trans ? trans.to : cur));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) redraw(); });
  // 打字时纸浓一点，停笔 3 秒变回来
  let typingTimer = 0;
  bus.on("typing:input", () => {
    lastType = performance.now();
    document.body.classList.add("scene-typing");
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => document.body.classList.remove("scene-typing"), 3000);
  });
  // 打开作品：走进室内；回到书架：走到外面
  bus.on("route", ({ name }) => {
    const prev = routeName;
    routeName = name;
    if (getSettings().sceneNav === false || prev === name || (prev !== "book" && name !== "book")) return;
    const sc = trans ? trans.to : cur;
    if (!sc) return;
    const k = name === "book" ? "in" : "out";
    if (sc.kind !== k && sceneKinds(sc.style).includes(k)) go(sc.style, k, prev ? (k === "in" ? "in" : "out") : null);
  });
  bus.on("paper:rest", () => { resting = true; kickLoop(); });
  bus.on("paper:wake", () => { resting = false; });
  // 点背景上的东西
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const hit = hitSpot(e);
    if (!hit) return;
    act(cur, hit.sp, hit.x, hit.y);
    bus.emit("scene:poke", { name: hit.sp.name || "", id: hit.sp.id, style: cur.style });
  });
  let hoverRaf = 0, hoverEv = null;
  document.addEventListener("pointermove", (e) => {
    hoverEv = e;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const hit = hoverEv && hitSpot(hoverEv);
      document.body.classList.toggle("scene-hot", !!hit);
    });
  }, { passive: true });
  // 码字联动：连击升级热闹一下，里程碑、达成目标整幅画一起庆祝，一下删很多字时暗一下
  bus.on("pulse:combo-level", ({ level }) => party(level >= 3));
  bus.on("pulse:milestone", () => party(true));
  bus.on("pulse:chapterlen", () => party(true));
  bus.on("goal:reached", () => party(true));
  bus.on("points:all-done", () => party(true));
  bus.on("pulse:bigdelete", () => {
    const sc = cur;
    if (!sc || motion() === "off") return;
    sc.shiver = { t: 0, max: 0.9 };
    for (const f of sc.fx) if (f.d.type === "fall") for (const p of f.s.list) p.vx = -rnd(50, 90);
    kickLoop();
  });
  // 隔一段时间轮换；正在打字、开着弹窗时等一等
  setInterval(() => {
    const sc = cur;
    const cycle = Number(getSettings().sceneCycle) || 0;
    if (!sc || trans || !cycle || document.hidden || sceneKinds(sc.style).length < 2) return;
    const now = performance.now();
    if (now - lastSwitch < cycle * 60000 || now - lastType < 10000 || document.querySelector(".modal-back")) return;
    nextScene();
  }, 4000);
}
