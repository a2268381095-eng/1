// 界面小特效：点击时冒一小团像素特效（爱心星星 / 魔法波纹 / 墨点），达成目标时撒一把。
// 画在一张盖满窗口、不挡鼠标的画布上，没有粒子时不跑动画。正文里点击、打字、选字时不冒，免得写作分心。
import { getSettings } from "./settings.js";
import { bus } from "./bus.js";

const COLORS = { "#": "#3a1a2c", r: "#ec4870", p: "#f796ba", w: "#ffffff", y: "#ffd666", v: "#786ec8",
  b: "#5b7fd6", n: "#1f2a3d", k: "#2b2622", g: "#6aa84f", G: "#3f7a2c", o: "#e8a33d", O: "#b8741c", m: "#8e2a4f", u: "#4a2a5e" };
const SPRITES = {
  heart: [".##.##.", "#pp#pp#", "#pwppp#", ".#ppp#.", "..#p#..", "...#..."],
  heartR: [".##.##.", "#rr#rr#", "#rwrrr#", ".#rrr#.", "..#r#..", "...#..."],
  star: ["...#...", "..#y#..", "##yyy##", ".#ywy#.", "..#y#..", ".#...#."],
  spark: ["..#..", ".#y#.", "#ywy#", ".#y#.", "..#.."],
  twinkle: [".w.", "wyw", ".w."],
  // 各套风格自己的道具
  note: ["...##.", "...#b#", "...#..", "...#..", ".###..", "#bb#..", ".##..."],
  petal: [".##..", "#pp#.", "#ppp#", ".#pp#", "..##."],
  inkdot: [".#.", "#k#", ".#."],
  bat: ["#.......#", "##.#.#.##", "#mmmmmmm#", ".#mm.mm#.", "..#...#.."],
  ques: [".###.", "#...#", "...#.", "..#..", ".....", "..#.."],
  glint: ["..#..", "..w..", "#wyw#", "..w..", "..#.."],
  coin: [".####.", "#oooO#", "#oyoO#", "#oyoO#", "#oooO#", ".####."],
  leaf: ["...##", ".##g#", "#ggG#", "#gG#.", ".#..."],
  star2: ["..#..", ".#v#.", "#vwv#", ".#v#.", "..#.."],
};

// 各套风格的粒子：点击（跟随小恶魔）、连击、庆祝都用这一套
const STYLE_SETS = {
  magical: ["heart", "star", "spark", "heartR"],
  sailor: ["note", "star", "spark", "note"],
  hanfu: ["petal", "inkdot", "petal", "twinkle"],
  gothic: ["bat", "heartR", "star2", "twinkle"],
  detective: ["ques", "glint", "twinkle", "ques"],
  adventurer: ["coin", "leaf", "coin", "spark"],
};
let styleId = "magical";
export function setFxStyle(id) { if (STYLE_SETS[id]) styleId = id; }
const cache = {};
function sprite(name) {
  if (cache[name]) return cache[name];
  const rows = SPRITES[name];
  const c = document.createElement("canvas");
  c.width = rows[0].length; c.height = rows.length;
  const g = c.getContext("2d");
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (COLORS[ch]) { g.fillStyle = COLORS[ch]; g.fillRect(x, y, 1, 1); } }));
  cache[name] = c;
  return c;
}

let canvas, ctx, raf = 0, dpr = 1;
const parts = [];

function ensure() {
  if (canvas) return;
  canvas = document.createElement("canvas");
  canvas.className = "fx-layer";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  ctx = canvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize);
}
function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

const rnd = (a, b) => a + Math.random() * (b - a);

/** 在 (x, y) 冒一团特效。kind：hearts / ripple / ink / celebrate */
export function burst(x, y, kind = "hearts", n = 0) {
  if (motionOff()) return;
  ensure();
  if (kind === "ripple") {
    parts.push({ type: "ring", x, y, r: 3, life: 0, max: 20 });
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i + Math.PI / 4;
      parts.push({ type: "sprite", name: "twinkle", x: x + Math.cos(a) * 10, y: y + Math.sin(a) * 10, vx: Math.cos(a) * 1.2, vy: Math.sin(a) * 1.2, g: 0, life: -6, max: 18, s: 2 });
    }
  } else if (kind === "ink") {
    const count = n || 7;
    for (let i = 0; i < count; i++) {
      const a = rnd(-Math.PI, 0) + rnd(-0.4, 0.4);
      const sp = rnd(1.2, 3.2);
      parts.push({ type: "dot", x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0.18, life: 0, max: rnd(22, 34), size: Math.round(rnd(2, 4)) });
    }
  } else {
    const count = n || (kind === "celebrate" ? 18 : 6);
    const set = STYLE_SETS[styleId] || STYLE_SETS.magical;
    const names = kind === "hearts" ? ["heart", "spark", "twinkle", "heartR"] : kind === "celebrate" ? [...set, "spark", "twinkle"] : set;
    for (let i = 0; i < count; i++) {
      const a = kind === "celebrate" ? rnd(-Math.PI * 0.95, -Math.PI * 0.05) : rnd(-Math.PI * 0.85, -Math.PI * 0.15);
      const sp = kind === "celebrate" ? rnd(2.5, 5.5) : rnd(1.6, 3.2);
      parts.push({ type: "sprite", name: names[i % names.length], x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: kind === "celebrate" ? 0.12 : 0.09,
        life: 0, max: rnd(30, kind === "celebrate" ? 60 : 44), s: 2 });
    }
  }
  if (!raf) raf = requestAnimationFrame(tick);
}

let streamEl = null, streamRate = 0, streamTimer = 0;
/** 从元素上方连续冒粒子；rate 每秒几个，0 停止 */
export function stream(el, rate) {
  streamEl = el; streamRate = rate;
  clearInterval(streamTimer);
  if (!el || !rate || motionOff()) return;
  streamTimer = setInterval(() => {
    if (!streamEl || !streamEl.isConnected || document.hidden) return;
    const r = streamEl.getBoundingClientRect();
    if (!r.width) return;
    ensure();
    const set = STYLE_SETS[styleId] || STYLE_SETS.magical;
    const name = set[Math.floor(Math.random() * set.length)];
    parts.push({ type: "sprite", name, x: r.left + r.width * rnd(0.25, 0.75), y: r.top + r.height * 0.12, vx: rnd(-0.6, 0.6), vy: rnd(-1.6, -0.8),
      g: -0.005, life: 0, max: rnd(40, 64), s: 3 });
    if (!raf) raf = requestAnimationFrame(tick);
  }, Math.max(60, 1000 / rate));
}

/** 在某个元素上方撒一把（打勾、达成目标时用） */
export function burstAt(el, kind = "celebrate", n = 0) {
  if (!el || !el.getBoundingClientRect) return;
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, kind, n);
}

function tick() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life++;
    if (p.life > p.max) { parts.splice(i, 1); continue; }
    if (p.life < 0) continue;
    const fade = Math.min(1, (p.max - p.life) / 10);
    ctx.globalAlpha = Math.max(0, fade);
    if (p.type === "ring") {
      p.r += 1.1;
      drawRing(p.x, p.y, p.r);
    } else {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.98;
      if (p.type === "dot") {
        ctx.fillStyle = "rgba(58, 26, 44, 0.75)";
        ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      } else {
        const sp = sprite(p.name);
        ctx.drawImage(sp, Math.round(p.x - (sp.width * p.s) / 2), Math.round(p.y - (sp.height * p.s) / 2), sp.width * p.s, sp.height * p.s);
      }
    }
  }
  ctx.globalAlpha = 1;
  raf = parts.length ? requestAnimationFrame(tick) : 0;
  if (!raf) ctx.clearRect(0, 0, innerWidth, innerHeight);
}

/** 像素风的圆圈：按 2px 一格画 */
function drawRing(cx, cy, r) {
  ctx.fillStyle = "#ec82b1";
  const step = 2;
  const pts = Math.max(12, Math.round(r * 1.6));
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    ctx.fillRect(Math.round((cx + Math.cos(a) * r) / step) * step, Math.round((cy + Math.sin(a) * r) / step) * step, step, step);
  }
}

function motionOff() {
  const s = getSettings();
  return s.motion === "off" || (s.motion !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** 点击特效：正文里、输入框里不冒 */
export function mountFx() {
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const kind = getSettings().clickFx || "style";
    if (kind === "off") return;
    const t = e.target;
    if (t.closest && t.closest(".cm-editor, input, textarea, select, [contenteditable], .fx-skip")) return;
    burst(e.clientX, e.clientY, kind);
  }, true);
  // 值得庆祝的时候撒一把
  bus.on("goal:reached", () => burstAt(document.querySelector(".statusbar .goal-done") || document.querySelector(".demon-body"), "celebrate"));
  bus.on("points:all-done", () => burstAt(document.querySelector(".pt-count") || document.querySelector(".demon-body"), "celebrate"));
}
