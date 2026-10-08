// 小恶魔助手：常驻在右下角，跟着你的操作做动作、接一句话；
// 你找不到功能时点她旁边的「?」，她会问你想做什么，搜一下就能直接点。
// 气泡里只放台词，不显示名字。
import SPRITES from "../../generated/sprites.json";
import { bus } from "../../core/bus.js";
import { h, icon, pushLayer } from "../../core/ui.js";
import { commands, keyOf, prettyKey } from "../../core/commands.js";
import { getSettings, setSettings } from "../../core/settings.js";

const W = 128, H = 224;
const BY_ID = Object.fromEntries(SPRITES.map((s) => [s.id, s]));

// 作者的操作 → 她做哪个动作
const EVENT_ACT = {
  open: "wave", start: "point", idle: "doze", goal: "cheer", chapter: "cheer", delete: "shock",
  ai_wait: "think", ai_error: "shock", lost: "point", late: "doze", foreshadow: "think",
  format: "cheer", save: "idle", back: "wave", poke: "shock", poke_many: "shock",
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

function setStyle(st) {
  if (st === style && images[st.id]) return;
  style = st;
  images[st.id] = images[st.id] || {};
  for (const a of Object.keys(st.actions)) {
    if (!images[st.id][a]) { const im = new Image(); im.src = `sprites/${st.id}/${a}.png`; images[st.id][a] = im; }
  }
  play("idle");
}

// ---------------- 播放 ----------------
function actOf(name) { return style.actions[name] || style.actions.idle; }

/** 播一个动作；不循环的播完回到待机，循环的播 duration 毫秒后回到待机 */
export function play(name, duration = 0) {
  if (!style.actions[name]) name = "idle";
  Object.assign(player, { act: name, f: 0, acc: 0, t: 0, until: duration, then: name === "idle" ? null : "idle" });
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
    player.acc += dt;
    let changed = false;
    while (player.acc >= a.ms[player.f]) {
      player.acc -= a.ms[player.f];
      changed = true;
      if (player.f + 1 >= a.frames) {
        if (!a.loop && player.then) { play(player.then); return requestAnimationFrame(loop); }
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

// ---------------- 挂到界面上 ----------------
export function mountDemon(root) {
  canvas = h("canvas.demon-canvas", { width: W, height: H, "aria-hidden": "true" });
  ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  bubbleText = h("span.demon-text");
  bubble = h("div.demon-bubble", { "aria-hidden": "true" }, bubbleText);
  live = h("span.sr", { role: "status", "aria-live": "polite" });
  const poke = h("button.demon-poke", { type: "button", "aria-label": "戳她一下" }, canvas);
  const helpBtn = h("button.demon-help", { type: "button", title: "找不到功能？问她（F1）", "aria-label": "找功能" }, "?");
  const hideBtn = h("button.demon-hide", { type: "button", title: "收起小恶魔", "aria-label": "收起小恶魔" }, icon("close"));
  const showBtn = h("button.demon-show", { type: "button", title: "叫小恶魔出来", "aria-label": "叫小恶魔出来" }, "小恶魔");
  el = h("div.demon", {}, bubble, live, poke, helpBtn, hideBtn, showBtn);
  root.append(el);

  poke.addEventListener("click", () => {
    const t = Date.now();
    pokes.push(t);
    pokes = pokes.filter((x) => t - x < 1600);
    if (pokes.length >= 3) { pokes = []; react("poke_many", { act: "shock" }); }
    else react("poke", { act: ["shock", "wave", "cheer", "think"][pokeN++ % 4] });
  });
  helpBtn.addEventListener("click", openHelp);
  hideBtn.addEventListener("click", () => setSettings({ demonOn: false }));
  showBtn.addEventListener("click", () => setSettings({ demonOn: true }));
  applySettings();
  bus.on("settings:changed", applySettings);
  setStyle(styleFor(null));
  requestAnimationFrame(loop);
  wireEvents();
  commands.register({ id: "help.open", title: "找功能（问小恶魔）", keywords: "帮助 找不到 怎么 功能", hint: "搜功能名，直接点就能用", key: "F1", run: openHelp });
}

function applySettings() {
  const s = getSettings();
  el.classList.toggle("off", !s.demonOn);
  el.style.setProperty("--demon-scale", s.demonScale || 1);
  if (!s.demonOn) hush();
}

/** 进出作品时换风格（按作品类型，或作品里选定的那套） */
export function setDemonBook(book) {
  bookCtx = book;
  setStyle(styleFor(book));
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
  bus.on("save:failed", () => react("ai_error", { text: "保存出错了！别关窗口，正文还在，我帮你看着。", act: "shock" }));
  bus.on("demon:say", (d) => react(d.event || "tip", { text: d.text, act: d.act, force: true }));
  bus.on("book:created", (d) => { if (!d.restored) setTimeout(() => react("start", { force: true, act: "cheer" }), 300); });
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 10 * 60000) react("back", { force: true });
  });
}
