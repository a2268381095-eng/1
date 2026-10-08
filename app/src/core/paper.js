// 写字的纸：每套风格一种纸（魔法信笺、作业本、宣纸、魔典书页、案卷、羊皮纸），样式在 styles/paper/*.css，
// 纸上的像素小装饰（印章、夹子、蜡封……）在 core/paper-art/*.js，这里把它们画成图，写成 CSS 变量 --pa-<名字>。
// 停笔一阵（设置里「停笔后变回背景」），纸和侧栏淡下去，屏幕交给动态背景；一动鼠标、打字，纸按这套风格的方式复写回来。
import { bus } from "./bus.js";
import { getSettings } from "./settings.js";
import { hasLayers } from "./ui.js";
import magical from "./paper-art/magical.js";
import sailor from "./paper-art/sailor.js";
import hanfu from "./paper-art/hanfu.js";
import gothic from "./paper-art/gothic.js";
import detective from "./paper-art/detective.js";
import adventurer from "./paper-art/adventurer.js";

const ART = { magical, sailor, hanfu, gothic, detective, adventurer };

// ---------------- 纸上的像素装饰 ----------------
const cache = new Map();
/** 一张装饰图：rows 是字符画，colors 把字符对到颜色（"accent" "ink" "paper" "muted" 取当前配色） */
function artURL(a, theme) {
  const key = JSON.stringify([a.rows, a.colors, theme]);
  if (cache.has(key)) return cache.get(key);
  const w = Math.max(...a.rows.map((r) => r.length)), hgt = a.rows.length;
  const c = document.createElement("canvas");
  c.width = w; c.height = hgt;
  const g = c.getContext("2d");
  a.rows.forEach((r, y) => [...r].forEach((ch, x) => {
    const col = a.colors[ch];
    if (!col) return;
    g.fillStyle = theme[col] || col;
    g.fillRect(x, y, 1, 1);
  }));
  const url = c.toDataURL("image/png");
  cache.set(key, url);
  return url;
}

let shownKeys = [];
/** applyLook 调：换上这套纸的装饰图 */
export function applyPaper(style) {
  const root = document.documentElement;
  root.dataset.paper = style;
  const cs = getComputedStyle(root);
  const theme = {};
  for (const k of ["accent", "ink", "paper", "muted", "faint", "line", "surface", "accent-soft"]) theme[k] = cs.getPropertyValue("--" + k).trim();
  for (const k of shownKeys) { root.style.removeProperty(k); root.style.removeProperty(k + "-w"); root.style.removeProperty(k + "-h"); }
  shownKeys = [];
  const art = ART[style] || {};
  for (const [name, a] of Object.entries(art)) {
    if (!a || !a.rows) continue;
    const k = "--pa-" + name, s = a.scale || 3;
    root.style.setProperty(k, `url(${artURL(a, theme)})`);
    root.style.setProperty(k + "-w", Math.max(...a.rows.map((r) => r.length)) * s + "px");
    root.style.setProperty(k + "-h", a.rows.length * s + "px");
    shownKeys.push(k);
  }
}

// ---------------- 停笔变回背景，动一下复写回来 ----------------
let restTimer = 0, wakeTimer = 0, resting = false, inBook = false;
const WAKE_MS = 900;

function canRest() {
  const sec = Number(getSettings().paperRest) || 0;
  return sec > 0 && inBook && document.body.classList.contains("has-scene") && !hasLayers() && !document.querySelector(".modal-back");
}
function arm() {
  clearTimeout(restTimer);
  const sec = Number(getSettings().paperRest) || 0;
  if (sec > 0) restTimer = setTimeout(rest, sec * 1000);
}
function rest() {
  if (resting) return;
  if (!canRest()) { arm(); return; }
  // 正在输入框里打字、选着字的时候不淡
  const a = document.activeElement;
  if (a && a.matches && a.matches("input, textarea, select") && !a.closest(".cm-editor")) { arm(); return; }
  resting = true;
  document.body.classList.remove("paper-wake");
  document.body.classList.add("paper-rest");
  bus.emit("paper:rest", {});
}
/** 有动静：纸复写回来 */
export function wake() {
  if (resting) {
    resting = false;
    document.body.classList.remove("paper-rest");
    document.body.classList.add("paper-wake");
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => document.body.classList.remove("paper-wake"), WAKE_MS);
    bus.emit("paper:wake", {});
  }
  arm();
}

let lastX = -1, lastY = -1;
export function mountPaper() {
  const poke = () => wake();
  for (const ev of ["keydown", "pointerdown", "wheel", "touchstart", "focusin"]) document.addEventListener(ev, poke, { capture: true, passive: true });
  document.addEventListener("pointermove", (e) => {
    if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) < 6) return;
    lastX = e.clientX; lastY = e.clientY;
    wake();
  }, { passive: true });
  bus.on("typing:input", poke);
  bus.on("route", ({ name }) => { inBook = name === "book"; wake(); });
  bus.on("settings:changed", ({ patch }) => { if (patch && "paperRest" in patch) wake(); });
  arm();
}
