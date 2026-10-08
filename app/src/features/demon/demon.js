// 小恶魔助手：常驻在右下角，跟着你的操作做动作、接一句话；
// 你找不到功能时点她旁边的「?」，她会问你想做什么，搜一下就能直接点。
// 气泡里只放台词，不显示名字。
import SPRITES from "../../generated/sprites.json";
import { bus } from "../../core/bus.js";
import { h, icon, pushLayer } from "../../core/ui.js";
import { commands, keyOf, prettyKey } from "../../core/commands.js";
import { getSettings, setSettings } from "../../core/settings.js";
import { burst, burstAt, stream, setFxStyle } from "../../core/fx.js";
import { todayWords } from "../../core/store.js";
import { resolvePalette } from "../../core/look.js";
import { meterFor } from "./meters/index.js";

const W = 128, H = 224;
const BY_ID = Object.fromEntries(SPRITES.map((s) => [s.id, s]));

// 作者的操作 → 她做哪个动作
const EVENT_ACT = {
  open: "wave", start: "point", idle: "doze", goal: "cheer", chapter: "cheer", delete: "shock",
  ai_wait: "think", ai_error: "shock", lost: "point", late: "doze", foreshadow: "think",
  format: "cheer", save: "idle", back: "wave", poke: "shock", poke_many: "shock",
  replace: "cheer", search_none: "think", restore: "wave", import: "cheer", export: "wave",
  combo: "cheer", milestone: "cheer", chapter_len: "cheer", big_delete: "shock", rest: "wave",
  scene_in: "point", scene_out: "wave", scene_poke: "think", dress: "cheer",
};
// 不管多安静都要说的（你主动找她、或者要提醒你的）
const IMPORTANT = new Set(["delete", "ai_error", "lost", "poke", "poke_many", "goal", "tip"]);
const GAP = { quiet: 90000, normal: 25000, chatty: 8000 };

let el, canvas, ctx, bubble, bubbleText, live, palette = null;
let style = SPRITES[0];
let bookCtx = null;
const images = {};
const player = { act: "idle", f: 0, acc: 0, until: 0, t: 0, then: null };
let lastAuto = 0, typeTimer = 0, hideTimer = 0, pokes = [], pokeN = 0;
let speed = 1;   // 动画快慢：码字连击越高越快
const lastLine = {};

// ---------------- 选风格 ----------------
export function styleFor(book) {
  const s = getSettings();
  if (book && book.demonStyle && book.demonStyle !== "auto" && BY_ID[book.demonStyle]) return BY_ID[book.demonStyle];
  if (book && book.tags && book.tags.length) {
    for (const st of SPRITES) if (st.genres.some((g) => book.tags.some((t) => t.includes(g) || g.includes(t)))) return st;
  }
  return BY_ID[s.demonStyle] || SPRITES[0];
}
export const allStyles = () => SPRITES;

/** 她现在该穿哪套：配色选「跟随小恶魔」时按作品；配色固定、随时间、随季节时，换上配色那一套，主题和衣服对得上 */
export function wantedStyle(book = bookCtx) {
  const base = styleFor(book);
  const s = getSettings();
  if (!s.palette || s.palette === "follow") return base;
  return BY_ID[resolvePalette(s, base.id)] || base;
}
/** 配色变了：换衣服。show 时撒一把特效、说一句 */
function syncStyle(show) {
  const st = wantedStyle();
  if (st === style) return;
  setStyle(st);
  if (show && el) {
    burstAt(el.querySelector(".demon-body"), "celebrate", 18);
    react("dress", { force: true, act: "cheer" });
  }
}

export const currentStyleId = () => (style ? style.id : "magical");

function setStyle(st) {
  if (st === style && images[st.id]) return;
  style = st;
  setFxStyle(st.id);
  if (el) el.dataset.style = st.id;
  if (comboEl) comboEl.querySelector(".dc-label").textContent = (WORDS[st.id] || WORDS.magical).combo;
  drawBadge && bookCtx && drawBadge();
  bus.emit("demon:style", { id: st.id });
  images[st.id] = images[st.id] || {};
  for (const a of Object.keys(st.actions)) {
    if (!images[st.id][a]) { const im = new Image(); im.src = `sprites/${st.id}/${a}.png`; images[st.id][a] = im; }
  }
  play("idle");
}

// ---------------- 播放 ----------------
function actOf(name) { return style.actions[name] || style.actions.idle; }

/** 播一个动作；不循环的播完回到待机，循环的播 duration 毫秒后回到待机 */
export function play(name, duration = 0, { hold = false } = {}) {
  if (!style.actions[name]) name = "idle";
  Object.assign(player, { act: name, f: 0, acc: 0, t: 0, until: duration, hold, then: name === "idle" ? null : "idle" });
  draw();
}

function draw() {
  if (!ctx) return;
  const a = actOf(player.act);
  const im = images[style.id] && images[style.id][player.act];
  ctx.clearRect(0, 0, W, H);
  if (im && im.complete && im.naturalWidth) ctx.drawImage(im, player.f * W, 0, W, H, 0, 0, W, H);
  else if (a) { /* 图还没加载好，等下一帧 */ }
}

let last = performance.now();
function loop(t) {
  const dt = Math.min(t - last, 250);
  last = t;
  const a = actOf(player.act);
  if (a && !document.hidden) {
    player.t += dt;
    player.acc += dt * speed;
    let changed = false;
    while (player.acc >= a.ms[player.f]) {
      player.acc -= a.ms[player.f];
      changed = true;
      if (player.f + 1 >= a.frames) {
        if (!a.loop && !player.hold && player.then) { play(player.then); return requestAnimationFrame(loop); }
        player.f = 0;
      } else player.f++;
    }
    if (player.until && player.t >= player.until && player.then) { play(player.then); return requestAnimationFrame(loop); }
    if (changed) draw();
  }
  requestAnimationFrame(loop);
}

// ---------------- 说话 ----------------
function pickLine(event) {
  const lines = (style.persona && style.persona.lines && style.persona.lines[event]) || [];
  if (!lines.length) return "";
  const key = style.id + ":" + event;
  let i = Math.floor(Math.random() * lines.length);
  if (lines.length > 1 && i === lastLine[key]) i = (i + 1) % lines.length;
  lastLine[key] = i;
  return lines[i];
}

export function say(text, { hold = 0 } = {}) {
  if (!bubble) return;
  clearInterval(typeTimer);
  clearTimeout(hideTimer);
  if (!text) { hush(); return; }
  live.textContent = text;
  placeBubble();
  bubble.hidden = false;
  bubble.classList.add("on");
  const chars = [...text];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) bubbleText.textContent = text;
  else {
    let n = 0;
    bubbleText.textContent = "";
    typeTimer = setInterval(() => {
      n++;
      bubbleText.textContent = chars.slice(0, n).join("");
      if (n >= chars.length) clearInterval(typeTimer);
    }, 50);
  }
  hideTimer = setTimeout(hush, hold || Math.max(3600, chars.length * 50 + 3000));
}

export function hush() {
  clearInterval(typeTimer);
  clearTimeout(hideTimer);
  if (bubble) { bubble.classList.remove("on"); }
}

/**
 * 对作者的某个操作做反应：动作 + 台词。
 * opts.text 用自己给的台词（比如功能说明）；opts.act 指定动作；opts.force 不受「少说话」限制。
 */
export function react(event, opts = {}) {
  if (!el || !getSettings().demonOn) return;
  const s = getSettings();
  const nowT = Date.now();
  const important = opts.force || IMPORTANT.has(event);
  if (!important) {
    if (nowT - lastAuto < (GAP[s.demonChatty] || GAP.normal)) return;
    if (s.demonChatty === "quiet" && !["open", "goal", "chapter"].includes(event)) return;
  }
  lastAuto = nowT;
  const act = opts.act || EVENT_ACT[event] || "idle";
  const a = style.actions[act];
  play(act, a && a.loop ? Math.max(3500, (opts.text || "").length * 60 + 2500) : 0);
  const text = opts.text != null ? opts.text : pickLine(event);
  say(text);
}

/** 第一次用某个功能时的说明：同一个 key 只说一次（设置里可以重置） */
export async function tip(key, text) {
  const s = getSettings();
  if (s.tipsSeen && s.tipsSeen[key]) return;
  await setSettings({ tipsSeen: { ...(s.tipsSeen || {}), [key]: Date.now() } });
  react("tip", { text, act: "point", force: true });
}

// ---------------- 你想做什么？（找功能） ----------------
export function openHelp() {
  if (palette) { palette.input.focus(); return; }
  bus.emit("help:open", {});
  react("lost", { force: true });
  const input = h("input.input.help-search", { placeholder: "想做什么？比如：排版、找字、删章节", "aria-label": "搜索功能" });
  const listEl = h("div.help-list", { role: "listbox" });
  const box = h("div.help-pop", { role: "dialog", "aria-label": "找功能" },
    h("div.help-head", {}, h("b", {}, "你想做什么？"), h("button.icon-btn", { type: "button", "aria-label": "关闭", onclick: () => layer.close() }, icon("close"))),
    input, listEl);
  el.append(box);
  let sel = 0, items = [];
  const render = () => {
    items = commands.search(input.value).slice(0, 12);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    listEl.textContent = "";
    if (!items.length) listEl.append(h("div.empty", {}, "没找到……换个说法试试？"));
    items.forEach((c, i) => {
      const k = keyOf(c);
      const b = h("button.help-item" + (i === sel ? ".sel" : ""), { type: "button", role: "option", "aria-selected": String(i === sel) },
        h("span.help-t", {}, c.title), c.hint ? h("span.help-h", {}, c.hint) : null, k ? h("span.kbd", {}, prettyKey(k)) : null);
      b.addEventListener("click", () => runItem(c));
      listEl.append(b);
    });
  };
  const runItem = (c) => { layer.close(true); setTimeout(() => c.run(), 0); };
  input.addEventListener("input", () => { sel = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter" && items[sel]) { runItem(items[sel]); e.preventDefault(); }
  });
  const layer = pushLayer({ onClose: () => { box.remove(); palette = null; } });
  palette = { input, layer };
  render();
  setTimeout(() => input.focus(), 0);
}

// ---------------- 挂到界面上：可以拖着放、变大变小 ----------------
const SIZES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
let pos = { right: 14, bottom: 34 };   // 离窗口右边、下边多远（px）
let scale = 1;
let suppressClick = false;

export function mountDemon(root) {
  canvas = h("canvas.demon-canvas", { width: W, height: H, "aria-hidden": "true" });
  ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  bubbleText = h("span.demon-text");
  bubble = h("div.demon-bubble", { "aria-hidden": "true" }, bubbleText);
  live = h("span.sr", { role: "status", "aria-live": "polite" });
  const poke = h("button.demon-poke", { type: "button", "aria-label": "小恶魔：点一下戳她，按住拖动换位置，方向键挪动，加号减号变大变小" }, canvas);
  const ctl = (cls, title, content, fn) => {
    const b = h("button.demon-btn." + cls, { type: "button", title, "aria-label": title }, content);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  const tools = h("div.demon-tools", {},
    ctl("help", "找不到功能？问她（F1）", "?", openHelp),
    ctl("smaller", "变小", "−", () => stepSize(-1)),
    ctl("bigger", "变大", "+", () => stepSize(1)),
    ctl("hide", "收起小恶魔", icon("close"), () => setSettings({ demonOn: false })));
  const grip = h("div.demon-grip", { title: "拖这里变大变小", "aria-hidden": "true" });
  badge = h("div.demon-badge", { "aria-hidden": "true", hidden: true },
    h("span.db-label"), h("canvas.db-meter"));
  comboEl = h("div.demon-combo", { "aria-hidden": "true" }, h("span.dc-label", {}, "连击"), h("span.dc-num"), h("span.dc-unit", {}, "字"));
  const body = h("div.demon-body", {}, poke, tools, grip, comboEl, badge);
  const showBtn = h("button.demon-show", { type: "button", title: "叫小恶魔出来", "aria-label": "叫小恶魔出来" }, "小恶魔");
  showBtn.addEventListener("click", () => setSettings({ demonOn: true }));
  el = h("div.demon", { "data-style": style ? style.id : "magical" }, bubble, live, body, showBtn);
  root.append(el);

  poke.addEventListener("click", () => {
    if (suppressClick) { suppressClick = false; return; }
    const t = Date.now();
    pokes.push(t);
    pokes = pokes.filter((x) => t - x < 1600);
    if (pokes.length >= 3) { pokes = []; react("poke_many", { act: "shock" }); }
    else react("poke", { act: ["shock", "wave", "cheer", "think"][pokeN++ % 4] });
  });
  wireDrag(poke);
  wireGrip(grip);
  poke.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 50 : 10;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) { e.preventDefault(); setPos(pos.right + moves[e.key][0], pos.bottom + moves[e.key][1]); savePlace(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); stepSize(1); }
    else if (e.key === "-") { e.preventDefault(); stepSize(-1); }
  });
  window.addEventListener("resize", () => setPos(pos.right, pos.bottom));
  bus.on("panel:opened", ({ el: panel }) => avoid(panel));
  bus.on("panel:closed", unavoid);
  applySettings();
  bus.on("settings:changed", applySettings);
  setStyle(wantedStyle(null));
  requestAnimationFrame(loop);
  wireEvents();
  wirePulse();
  commands.register({ id: "help.open", title: "找功能（问小恶魔）", keywords: "帮助 找不到 怎么 功能", hint: "搜功能名，直接点就能用", key: "F1", run: openHelp });
  commands.register({ id: "demon.reset", title: "小恶魔回到右下角", keywords: "小恶魔 位置 大小 找不到她 复位", hint: "位置和大小都恢复默认", run: () => { setSettings({ demonPos: null, demonScale: 1, demonOn: true }); } });
}

/** 按住她拖动：动一点点（5px 以内）还算「戳一下」 */
function wireDrag(handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, right: shown.right, bottom: shown.bottom };
    let moved = false;
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) { moved = true; avoiding = null; el.classList.add("dragging"); hush(); play("shock", 0, { hold: true }); }
      setPos(start.right - dx, start.bottom - dy);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (!moved) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      el.classList.remove("dragging");
      play("wave");
      savePlace();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

/** 拖左上角的小角变大变小（她以右下角为基准长大） */
function wireGrip(grip) {
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const start = { y: e.clientY, x: e.clientX, scale };
    const baseH = H * start.scale;
    const move = (ev) => {
      const gy = start.y - ev.clientY, gx = (start.x - ev.clientX) * (H / W);
      const grow = Math.abs(gy) >= Math.abs(gx) ? gy : gx;   // 往左上拖变大，往右下拖变小，按拖得多的方向算
      setScale(Math.round(((baseH + grow) / H) * 4) / 4);
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      savePlace();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
}

function stepSize(dir) {
  const i = SIZES.findIndex((v) => v >= scale - 0.01);
  const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, (i < 0 ? SIZES.length - 1 : i) + dir))];
  setScale(next);
  savePlace();
}

function setScale(v) {
  scale = Math.max(SIZES[0], Math.min(SIZES[SIZES.length - 1], v));
  el.style.setProperty("--demon-scale", scale);
  setPos(pos.right, pos.bottom);
}

/** 摆到某个位置，不让她跑出窗口 */
function setPos(right, bottom) {
  const w = W * scale, hgt = H * scale;
  pos.right = Math.round(Math.max(0, Math.min(innerWidth - w, right)));
  pos.bottom = Math.round(Math.max(0, Math.min(innerHeight - hgt, bottom)));
  showAt(pos.right, pos.bottom);
}

/** 实际显示的位置（让路时和保存的位置不一样） */
let shown = { right: 14, bottom: 34 };
let avoiding = null;   // 正在躲开的面板元素
function showAt(right, bottom) {
  shown = { right, bottom };
  if (avoiding && avoiding.isConnected) {
    const r = avoiding.getBoundingClientRect();
    const w = W * scale, hgt = H * scale;
    const left = innerWidth - right - w, top = innerHeight - bottom - hgt;
    const overlapX = left < r.right && left + w > r.left;
    const overlapY = top < r.bottom && top + hgt > r.top;
    if (overlapX && overlapY) shown = { right: Math.min(innerWidth - w, innerWidth - r.left + 8), bottom };
  }
  el.style.right = shown.right + "px";
  el.style.bottom = shown.bottom + "px";
  placeBubble();
}

function avoid(panel) {
  if (innerWidth <= 640) { el.classList.add("panel-hidden"); return; }
  avoiding = panel;
  el.classList.add("moving");
  showAt(pos.right, pos.bottom);
  setTimeout(() => el.classList.remove("moving"), 300);
}
function unavoid() {
  avoiding = null;
  el.classList.remove("panel-hidden");
  el.classList.add("moving");
  showAt(pos.right, pos.bottom);
  setTimeout(() => el.classList.remove("moving"), 300);
}

/** 气泡和找功能面板：她在屏幕上半部分时放到身体下面，靠左时往右展开 */
function placeBubble() {
  const top = innerHeight - shown.bottom - H * scale;
  const left = innerWidth - shown.right - W * scale;
  el.classList.toggle("near-top", top < 150);
  el.classList.toggle("near-left", left < 200);
}

let saveTimer = 0;
function savePlace() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => setSettings({ demonPos: { ...pos }, demonScale: scale }), 200);
}

function applySettings() {
  const s = getSettings();
  el.classList.toggle("off", !s.demonOn);
  const small = innerWidth <= 640;
  scale = s.demonScale || 1;
  if (small && !s.demonPos && scale === 1) scale = 0.75;
  el.style.setProperty("--demon-scale", scale);
  const p = s.demonPos || { right: small ? 6 : 14, bottom: 34 };
  setPos(p.right, p.bottom);
  if (!s.demonOn) hush();
}

/** 进出作品时换风格（按作品类型，或作品里选定的那套） */
export function setDemonBook(book) {
  bookCtx = book;
  setStyle(wantedStyle(book));
  refreshBadge();
}

// ---------------- 码字互动：字数牌子、连击 ----------------
// 每套风格的叫法不一样
const WORDS = {
  magical: { combo: "魔力", badge: "魔力" },
  sailor: { combo: "连写", badge: "作业" },
  hanfu: { combo: "墨韵", badge: "墨迹" },
  gothic: { combo: "咒文", badge: "契约" },
  detective: { combo: "线索", badge: "卷宗" },
  adventurer: { combo: "连斩", badge: "赏金" },
};
let badge = null, comboEl = null, todayN = 0, typedSinceSave = 0;

async function refreshBadge(n) {
  if (!badge) return;
  const on = getSettings().demonPulse !== false && bookCtx && bookCtx.dailyGoal;
  badge.hidden = !on;
  if (!on) return;
  if (n == null) { todayN = await todayWords(bookCtx.id); typedSinceSave = 0; } else todayN = n;
  drawBadge();
}

// 进度的样子按风格换（meters/*.js），画在一张小画布上，按 3 倍放大
const meterState = { target: 0, shown: 0, words: 0, goal: 1, done: false, lastGain: -1e9, lastWords: -1, colors: null, styleId: "" };
let meterRaf = 0, meterLast = 0;
function meterColors() {
  const cs = getComputedStyle(el || document.documentElement);
  const v = (k) => cs.getPropertyValue("--" + k).trim();
  return { accent: v("accent"), ink: v("ink"), paper: v("paper"), surface: v("surface"), line: v("line-strong"), side: v("side"),
    muted: v("muted"), faint: v("faint"), accentSoft: v("accent-soft"), bubbleLine: v("bubble-line") };
}
function drawBadge() {
  if (!badge || badge.hidden || !bookCtx) return;
  const goal = bookCtx.dailyGoal;
  const now = Math.max(0, todayN + typedSinceSave);
  const st = meterState;
  if (st.lastWords >= 0 && now > st.lastWords) st.lastGain = performance.now();
  st.lastWords = now;
  Object.assign(st, { target: Math.min(1, now / goal), words: now, goal, done: now >= goal });
  const m = meterFor(style.id);
  const label = m.label ? m.label({ ...st, pct: st.target }) : null;
  badge.querySelector(".db-label").textContent = label || `${(WORDS[style.id] || WORDS.magical).badge} ${now.toLocaleString()}/${goal.toLocaleString()}`;
  badge.classList.toggle("done", st.done);
  kickMeter();
}
function kickMeter() { if (!meterRaf) meterRaf = requestAnimationFrame(meterFrame); }
function meterFrame(now) {
  meterRaf = 0;
  if (!badge || badge.hidden || !bookCtx) return;
  const st = meterState;
  const m = meterFor(style.id);
  const cv = badge.querySelector(".db-meter");
  if (st.styleId !== style.id || cv.width !== m.w) {
    st.styleId = style.id; st.colors = null;
    cv.width = m.w; cv.height = m.h;
    cv.style.width = m.w * 3 + "px"; cv.style.height = m.h * 3 + "px";
  }
  if (!st.colors) st.colors = meterColors();
  const motion = document.documentElement.dataset.motion || "full";
  // 数字涨的时候慢慢长上去
  const diff = st.target - st.shown;
  st.shown = motion === "off" || Math.abs(diff) < 0.002 ? st.target : st.shown + diff * 0.18;
  const g = cv.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
  g.clearRect(0, 0, cv.width, cv.height);
  try {
    m.draw(g, { pct: st.target, shown: st.shown, words: st.words, goal: st.goal, done: st.done, t: motion === "off" ? 0 : now / 1000,
      bump: (now - st.lastGain) / 1000, c: st.colors, motion });
  } catch (e) { console.warn("进度画不出来：", e); }
  const moving = st.shown !== st.target || (motion === "full" && m.animated) || (now - st.lastGain) / 1000 < 2;
  if (moving && !document.hidden) setTimeout(kickMeter, Math.max(0, 90 - (performance.now() - now)));
}
// 换配色、明暗以后重新取颜色
function resetMeterColors() { meterState.colors = null; kickMeter(); }

function setCombo(n, level) {
  if (!comboEl) return;
  if (getSettings().demonPulse === false || n < 30) { comboEl.classList.remove("on"); return; }
  comboEl.classList.add("on");
  comboEl.dataset.level = String(level || 0);
  comboEl.querySelector(".dc-num").textContent = "×" + n;
  comboEl.classList.remove("bump");
  void comboEl.offsetWidth;
  comboEl.classList.add("bump");
}

function wirePulse() {
  bus.on("typing:input", ({ ins, del }) => { typedSinceSave += ins - del; drawBadge(); });
  bus.on("pulse:today", ({ words }) => { typedSinceSave = 0; refreshBadge(words); });
  bus.on("pulse:combo", ({ n }) => {
    const lv = [2000, 1000, 500, 200].find((x) => n >= x) || 0;
    setCombo(n, lv);
    // 连击越高动作越快、头上冒的道具越多
    speed = lv >= 1000 ? 1.8 : lv >= 500 ? 1.5 : lv >= 200 ? 1.25 : 1;
    if (getSettings().demonPulse !== false) stream(lv ? el.querySelector(".demon-body") : null, lv >= 1000 ? 6 : lv >= 500 ? 4 : lv >= 200 ? 2 : 0);
  });
  bus.on("pulse:combo-level", ({ level }) => {
    if (getSettings().demonPulse === false) return;
    burstAt(comboEl, "celebrate", level >= 1000 ? 22 : 12);
    react("combo", { act: "cheer", force: level >= 1000 });
  });
  bus.on("pulse:combo-end", ({ n }) => {
    speed = 1;
    stream(null, 0);
    if (!comboEl || !comboEl.classList.contains("on")) return;
    comboEl.classList.add("end");
    setTimeout(() => { comboEl.classList.remove("on", "end", "bump"); }, 900);
  });
  bus.on("pulse:milestone", () => { burstAt(badge && !badge.hidden ? badge : el.querySelector(".demon-body"), "celebrate", 24); react("milestone", { force: true }); });
  bus.on("pulse:chapterlen", () => { burstAt(el.querySelector(".demon-body"), "celebrate", 14); react("chapter_len", { force: true }); });
  bus.on("pulse:bigdelete", () => react("big_delete", { act: "shock", force: true }));
  bus.on("pulse:rest", () => react("rest", { act: "wave", force: true }));
  bus.on("goal:reached", () => { refreshBadge(); });
  bus.on("book:updated", ({ book }) => { if (bookCtx && book.id === bookCtx.id) { bookCtx = book; refreshBadge(); } });
  bus.on("settings:changed", () => setTimeout(resetMeterColors, 50));
  bus.on("demon:style", () => setTimeout(resetMeterColors, 50));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kickMeter(); });
  bus.on("settings:changed", ({ patch }) => { if (patch && "demonPulse" in patch) { refreshBadge(); if (!patch.demonPulse) { setCombo(0); stream(null, 0); } } });
}

export function setDemonVisible(v) { if (el) el.classList.toggle("focus-hidden", !v); }

// ---------------- 监听作者的操作 ----------------
function wireEvents() {
  bus.on("app:open", () => setTimeout(() => react("open", { force: true }), 600));
  bus.on("typing:start", () => {
    const hr = new Date().getHours();
    if (hr < 5 && !sessionStorage.getItem("demon-late")) {
      try { sessionStorage.setItem("demon-late", "1"); } catch (_) { /* 无痕模式 */ }
      react("late", { force: true });
      return;
    }
    if (player.act === "doze") react("start", { force: true });
    else react("start");
  });
  bus.on("typing:idle", () => react("idle"));
  bus.on("goal:reached", () => react("goal"));
  bus.on("points:all-done", () => react("chapter", { force: true }));
  bus.on("chapter:delete-ask", () => react("delete"));
  bus.on("format:done", () => react("format", { force: true }));
  bus.on("replace:done", (d) => { if (d && d.count) react("replace", { force: true }); });
  bus.on("search:done", (d) => { if (d && d.count === 0 && d.q) react("search_none"); });
  bus.on("version:restored", () => react("restore", { force: true }));
  bus.on("trash:restored", () => react("restore", { force: true }));
  bus.on("io:imported", () => react("import", { force: true }));
  bus.on("io:exported", () => react("export"));
  bus.on("io:backup", () => react("export", { force: true }));
  bus.on("save:failed", () => react("ai_error", { text: "保存出错了！别关窗口，正文还在，我帮你看着。", act: "shock" }));
  // 换了配色就换衣服；随时间、随季节的配色每分钟看一次
  bus.on("settings:changed", ({ patch }) => { if (patch && "palette" in patch) syncStyle(true); });
  setInterval(() => { const p = getSettings().palette; if (p === "time" || p === "season") syncStyle(true); }, 60000);
  // 背景插画：走进、走出时说一句；点了画里的东西，偶尔接一句
  bus.on("scene:changed", ({ dir, style: st }) => { if (st === style.id) react(dir === "in" ? "scene_in" : "scene_out"); });
  bus.on("scene:poke", ({ name }) => { const t = pickLine("scene_poke"); if (t) react("scene_poke", { text: t.replace(/\{name\}/g, name || "它") }); });
  bus.on("demon:say", (d) => react(d.event || "tip", { text: d.text, act: d.act, force: true }));
  bus.on("book:created", (d) => { if (!d.restored) setTimeout(() => react("start", { force: true, act: "cheer" }), 300); });
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 10 * 60000) react("back", { force: true });
  });
}
