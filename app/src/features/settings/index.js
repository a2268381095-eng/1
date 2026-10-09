// 设置：独立界面 #/settings（全局），#/settings/<bookId>（多一组「当前作品」）。
// 改了马上生效、马上存好；每一步都能撤销（右上角，或 Ctrl+Z），恢复默认、清空这类批量的算一步。
// 发出的事件：settings:changed（core 发）、book:updated（store 发）、
//   settings:reset { group }、settings:font-added { font }、settings:font-removed { font }、settings:errlog-cleared { count }
import { PALETTES } from "../../core/pattern.js";
import { nextScene } from "../../core/scene.js";
import { resolvePalette } from "../../core/look.js";
import { getBook, updateBook, listChapters, updateChapter, DEFAULT_BOOK } from "../../core/store.js";
import { db, uid } from "../../core/db.js";
import { nav } from "../../core/nav.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { commands, keyName, prettyKey } from "../../core/commands.js";
import { getSettings, setSettings, label, DEFAULT_SETTINGS } from "../../core/settings.js";
import { fmtTime } from "../../core/text.js";
import { h, icon, toast, confirm, choose, notice, helpTip, hasLayers } from "../../core/ui.js";
import { ws } from "../editor/workspace.js";
import { tip, react, setDemonBook, styleFor, allStyles, wantedStyle } from "../demon/demon.js";
import { fontOptions, fontFileInfo, uniqueName, fmtSize, pick, clone, same, resetPatch, clampNum, checkKey, findConflicts,
  withKey, areaOf, mergeLog, removeLog, logText, BOOK_KEYS } from "./logic.js";
import { loadAll, loadFace, unloadFace, readFont, writeFont, removeFont, broken } from "./fonts.js";

const MERGE_MS = 1500;   // 拖滑块、连着打数字时，这么久以内的改动算一步
const ERR_PAGE = 50;

// 界面状态
const S = {
  view: null, main: null, titleEl: null, undoBtn: null, redoBtn: null,
  bookId: null, book: null,
  syncers: [],       // 设置变了以后把控件刷成最新值
  errlog: [], errEl: null, errBar: null, errShown: ERR_PAGE,
  keys: null,        // 快捷键列表 { q, listEl, sig }
  recording: null,   // 正在录快捷键 { id, err, off }
  pending: null,     // 进来以后滚到哪一组
};

const onSettings = () => { const c = nav.current(); return !!(c && c.name === "settings" && S.view && S.view.isConnected); };
const L = () => label("设置");
const showKey = (k) => prettyKey(k);
const titleOf = (id) => { const c = commands.get(id); return c ? c.title : id; };
const DB_WHY = "本地数据库没写进去，可能是存储空间满了，或者另一个窗口正在用。";

async function fail({ what, why, error, actions = [] }) {
  await notice({ what, why, actions, detail: error ? (error.stack || error.message || String(error)) : "" });
  refreshErrlog();
}

// ---------------- 撤销 ----------------
// 撤销栈是全软件共用的。设置推进去的条目自己记着「现在是做了还是撤了」。
const mine = new WeakSet();
const myUndone = [];
let undoing = null, redoing = null, busy = false;

function pushUndo(entry) {
  const { undo, redo } = entry;
  entry.live = true;
  entry.t = Date.now();
  entry.undo = async () => { entry.live = false; undoing = entry; await undo(); };
  entry.redo = async () => { entry.live = true; redoing = entry; await redo(); };
  mine.add(entry);
  appUndo.push(entry);
  return entry;
}

function guard(what, fn) {
  return async () => {
    try { await fn(); }
    catch (e) { fail({ what, why: DB_WHY, error: e }); throw e; }
  };
}

const canUndoHere = () => mine.has(appUndo.peek());
const canRedoHere = () => myUndone.length > 0 && appUndo.canRedo();

async function runUndo(target) {
  if (busy) return;
  if (target ? !target.live : !canUndoHere()) return;
  busy = true;
  try { await (target && appUndo.peek() !== target ? appUndo.undoEntry(target) : appUndo.undo()); }
  catch (_) { /* fail() 已经提示过 */ }
  finally { busy = false; updateUndoBtns(); }
}

async function runRedo() {
  if (busy || !canRedoHere()) return;
  busy = true;
  try { await appUndo.redo(); }
  catch (_) { /* fail() 已经提示过 */ }
  finally { busy = false; updateUndoBtns(); }
}

function updateUndoBtns() {
  if (!S.undoBtn) return;
  S.undoBtn.disabled = !canUndoHere();
  S.redoBtn.disabled = !canRedoHere();
  const top = appUndo.peek();
  S.undoBtn.title = canUndoHere() ? `撤销「${top.label}」（Ctrl+Z）` : "撤销（Ctrl+Z）";
}

// ---------------- 改设置 ----------------
/** 改全局设置并记一步撤销。merge：拖滑块这类连续的改动并成一步 */
async function change(patch, lbl, { merge = false } = {}) {
  const keys = Object.keys(patch);
  const before = pick(getSettings(), keys);
  if (same(before, pick(patch, keys))) return null;
  try { await setSettings(clone(patch)); }
  catch (e) { fail({ what: "设置没存进去。", why: DB_WHY, error: e }); return null; }
  const sig = "s:" + keys.sort().join(",");
  const top = appUndo.peek();
  if (merge && top && mine.has(top) && top.sig === sig && top.live && !appUndo.canRedo() && Date.now() - top.t < MERGE_MS) {
    top.after = clone(patch);
    top.t = Date.now();
    return top;
  }
  const entry = {
    sig, label: lbl, before, after: clone(patch),
    undo: guard(`没能撤销「${lbl}」。`, () => setSettings(clone(entry.before))),
    redo: guard(`没能重做「${lbl}」。`, () => setSettings(clone(entry.after))),
  };
  return pushUndo(entry);
}

// 作品设置一次只写一处：updateBook 是「读出来、改、写回去」，同时改两项会把前一项盖掉
let bookQ = Promise.resolve();
function serial(fn) {
  const run = bookQ.then(fn);
  bookQ = run.catch(() => {});
  return run;
}

/** 改当前作品的设置 */
function changeBook(patch, lbl, { merge = false } = {}) {
  return serial(async () => {
    if (!S.book) return null;
    const id = S.book.id;
    const keys = Object.keys(patch);
    const before = pick(S.book, keys);
    if (same(before, pick(patch, keys))) return null;
    try {
      const b = await updateBook(id, clone(patch));
      if (!b) { bookGone(); return null; }
      S.book = b;
    } catch (e) { fail({ what: "作品设置没存进去。", why: DB_WHY, error: e }); return null; }
    syncAll();
    const sig = "b:" + id + ":" + keys.sort().join(",");
    const top = appUndo.peek();
    if (merge && top && mine.has(top) && top.sig === sig && top.live && !appUndo.canRedo() && Date.now() - top.t < MERGE_MS) {
      top.after = clone(patch);
      top.t = Date.now();
      return top;
    }
    const entry = {
      sig, label: lbl, before, after: clone(patch),
      undo: guard(`没能撤销「${lbl}」。`, () => serial(() => writeBook(id, entry.before))),
      redo: guard(`没能重做「${lbl}」。`, () => serial(() => writeBook(id, entry.after))),
    };
    return pushUndo(entry);
  });
}

async function writeBook(id, patch) {
  const b = await updateBook(id, clone(patch));
  if (!b) throw new Error("这本书已经不在了（可能删进了" + label("回收站") + "）");
  if (S.book && S.book.id === id) { S.book = b; syncAll(); }
  return b;
}

function bookGone() {
  fail({
    what: "这本书找不到了。",
    why: "可能已经删进" + label("回收站") + "，或者在另一个窗口里删掉了。",
    actions: [{ label: "回书架", primary: true, run: () => nav.go("/") }],
  });
}

/** 分卷开关：第一次打开时建一卷，把没分卷的章放进去（和写作界面里的「分卷」一样） */
function setVolumes(on) {
  return serial(async () => {
    const book = S.book;
    if (!book || !!book.useVolumes === on) return;
    const id = book.id;
    const before = { useVolumes: !!book.useVolumes, volumes: clone(book.volumes || []) };
    let volumes = clone(book.volumes || []);
    if (on && !volumes.length) volumes = [{ id: uid("v"), title: "" }];
    const after = { useVolumes: on, volumes };
    const moved = [];   // 放进第一卷的章
    try {
      S.book = await updateBook(id, after);
      if (on) {
        for (const c of await listChapters(id)) {
          if (!c.volumeId) { moved.push(c.id); await updateChapter(c.id, { volumeId: volumes[0].id }); }
        }
      }
    } catch (e) { fail({ what: "分卷没设置好。", why: DB_WHY, error: e }); return; }
    syncAll();
    pushUndo({
      sig: "b:" + id + ":vol", label: on ? "分卷" : "不分卷",
      undo: guard("没能撤销分卷设置。", () => serial(async () => {
        for (const cid of moved) await updateChapter(cid, { volumeId: null });
        await writeBook(id, before);
      })),
      redo: guard("没能重做分卷设置。", () => serial(async () => {
        await writeBook(id, after);
        for (const cid of moved) await updateChapter(cid, { volumeId: volumes[0].id });
      })),
    });
  });
}

// ---------------- 界面同步 ----------------
function syncAll() {
  if (!onSettings()) return;
  for (const fn of S.syncers) fn();
  S.titleEl.textContent = L() + (S.book ? " · 《" + S.book.title + "》" : "");
  updateUndoBtns();
  setDemonBook(S.book || null);
}

function row(title, help, ...controls) {
  return h("div.st-row", {},
    h("div.st-label", {}, h("span.st-name", {}, title), help ? helpTip(help) : null),
    h("div.st-ctl", {}, ...controls));
}

/** 几个选项选一个 */
function seg(name, items, get, set, cls = "") {
  const box = h("div.st-seg" + cls, { role: "group", "aria-label": name });
  const btns = items.map(([v, text, attrs]) => {
    const b = h("button", { type: "button", "data-v": String(v), ...(attrs || {}) }, text);
    b.addEventListener("click", () => { if (!same(get(), v)) set(v); });
    box.append(b);
    return [v, b];
  });
  S.syncers.push(() => btns.forEach(([v, b]) => b.setAttribute("aria-pressed", String(same(get(), v)))));
  return box;
}

function toggle(text, get, set, name) {
  const cb = h("input", { type: "checkbox", "data-name": name });
  cb.addEventListener("change", () => set(cb.checked));
  S.syncers.push(() => { cb.checked = !!get(); });
  return h("label.check.st-check", {}, cb, h("span", {}, text));
}

/** 滑块：拖的时候就生效，一次拖动算一步撤销 */
function slider(name, key, { min, max, step }, fmt, lbl) {
  const input = h("input.st-range", { type: "range", min, max, step, "aria-label": name, "data-key": key });
  const out = h("output.st-out", {});
  input.addEventListener("input", () => {
    const v = clampNum(input.value, min, max, step);
    out.textContent = fmt(v);
    change({ [key]: v }, lbl, { merge: true });
  });
  S.syncers.push(() => { const v = getSettings()[key]; input.value = v; out.textContent = fmt(v); });
  return h("div.st-range-wrap", {}, input, out);
}

/** 数字框：打的时候就生效，打错了离开时改回范围内 */
function numberBox(name, get, set, { min, max, step = 1 }, unit) {
  const input = h("input.input.st-num", { type: "number", min, max, step, inputmode: "numeric", "aria-label": name });
  input.addEventListener("input", () => {
    if (input.value === "") return;
    const n = Number(input.value);
    if (Number.isFinite(n) && n >= min && n <= max) set(Math.round(n));
  });
  input.addEventListener("change", () => {
    const v = clampNum(input.value === "" ? get() : input.value, min, max, 1);
    input.value = v;
    set(v);
  });
  S.syncers.push(() => { if (document.activeElement !== input) input.value = get(); });
  return h("span.st-num-wrap", {}, input, unit ? h("span.muted", {}, unit) : null);
}

// ---------------- 外观 ----------------
const FONT_SAMPLE = "林小满把药篓往肩上提了提。";

/**
 * 选字体。kind "cards"：每张卡片用这个字体写一句样句，下面一行小字是字体名（正文字体）；
 * kind "pills"：一排圆按钮，字体名用它自己的字体写（界面字体）。上传的字体排在后面。
 * 卡片、按钮的样子跟着风格走（settings.css 里 :root[data-paper=…]）。
 */
function fontPicker(name, key, kind) {
  const cards = kind === "cards";
  const box = h(cards ? "div.st-fcards" : "div.st-fpills", { role: "group", "aria-label": name, "data-key": key });
  let sig = null, btns = [];
  const build = (opts) => {
    box.textContent = "";
    btns = opts.map((o, i) => {
      const bad = o.custom && broken.has(o.id);
      const tag = o.custom ? h("span.st-ftag", {}, bad ? "没加载出来" : "上传") : null;
      const b = cards
        ? h("button.st-fcard", { type: "button", "data-v": o.id, title: o.name, "aria-label": o.name },
          h("span.st-fcard-sample", { style: { fontFamily: o.stack }, "aria-hidden": "true" }, FONT_SAMPLE),
          h("span.st-fcard-name", {}, h("span.st-fcard-n", {}, o.name), tag))
        : h("button.st-fpill", { type: "button", "data-v": o.id, title: o.name, style: { fontFamily: o.stack } }, o.name, tag);
      if (bad) b.classList.add("bad");
      b.style.setProperty("--i", String(i));
      b.addEventListener("click", () => {
        if (getSettings()[key] !== o.id) change({ [key]: o.id }, name + "改成" + o.name);
      });
      box.append(b);
      return [o.id, b];
    });
  };
  S.syncers.push(() => {
    const opts = fontOptions(getSettings().customFonts);
    const now = opts.map((o) => o.id + ":" + o.name + (broken.has(o.id) ? "!" : "")).join("|");
    if (now !== sig) { sig = now; build(opts); }
    const v = getSettings()[key];
    btns.forEach(([id, b]) => b.setAttribute("aria-pressed", String(id === v)));
  });
  return box;
}

/** 配色：每套一个色块按钮 */
function palettePicker() {
  const items = [["follow", "跟随小恶魔", null, "按作品换"], ["time", "随时间", null, "早·午·傍晚·夜"], ["season", "随季节", null, "春夏秋冬"], ...PALETTES.map((p) => [p.id, p.name, p])];
  const box = h("div.st-palettes", { role: "group", "aria-label": "配色" });
  const btns = items.map(([v, text, p, sub]) => {
    const sw = p ? h("span.st-sw", {}, ...p.swatch.map((c) => h("i", { style: { background: c } }))) : h("span.st-sw.st-sw-follow", {}, v === "follow" ? "♥" : "↻");
    const b = h("button.st-pal", { type: "button", "data-v": v, title: p ? `${p.name}（${p.style}）` : text + "：" + sub },
      sw, h("span.st-pal-name", {}, text), h("span.st-pal-sub", {}, p ? p.style : sub));
    b.addEventListener("click", () => { if (getSettings().palette !== v) change({ palette: v }, "配色改成" + text); });
    box.append(b);
    return [v, b];
  });
  S.syncers.push(() => btns.forEach(([v, b]) => b.setAttribute("aria-pressed", String(getSettings().palette === v))));
  return box;
}

function renderLook(body) {
  const s = () => getSettings();
  body.append(
    row("主题", "跟随系统：电脑换成深色时，这里也跟着变。",
      seg("主题", [["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"], ["time", "随时间"]], () => s().theme,
        (v) => change({ theme: v }, { auto: "主题跟随系统", light: "换成浅色", dark: "换成深色", time: "明暗随时间" }[v]))),
    row("配色", "「跟随小恶魔」：打开哪本书，界面就换成她这本书穿的那套风格的颜色。选了某一套配色，或者随时间、随季节换时，小恶魔也换上那一套衣服，背景插画也换成那一套。", palettePicker()),
    row("像素底纹", "书架这些空白处铺一层很淡的像素图案，写字的纸面不铺。",
      toggle("铺底纹", () => s().pixelBg, (v) => change({ pixelBg: v }, v ? "铺上像素底纹" : "去掉像素底纹"), "pixelBg")),
    row("背景插画", "书架和写字页四周铺一幅像素插画，每套风格一张外景、一张内景。画里的水、旗子、灯火会动，点画上的灯、水面、花树会有反应，写到里程碑整幅画一起热闹。写字的纸面不铺。",
      toggle("铺背景插画", () => s().sceneBg !== false, (v) => change({ sceneBg: v }, v ? "铺上背景插画" : "去掉背景插画"), "sceneBg")),
    row("背景透出", "写字页的纸、侧栏、顶栏透出多少画。越大画越清楚，越小界面越实。打字时纸会自动浓一点，停笔几秒又变清。",
      slider("背景透出", "sceneVeil", { min: 0, max: 100, step: 5 }, (v) => v + "%", "改背景透出")),
    row("插画像素", "「干净」色块平整；「网点」加一层老游戏机那样的网点。",
      seg("插画像素", [["clean", "干净"], ["dither", "网点"]], () => (s().sceneDither ? "dither" : "clean"),
        (v) => change({ sceneDither: v === "dither" }, "插画改成" + (v === "dither" ? "网点" : "干净") + "像素"))),
    row("内外轮换", "隔一段时间，镜头从外景走进内景，再退回外景，每套风格的转场不一样。正在打字时等你停下来再换。",
      seg("内外轮换", [[0, "不轮换"], [5, "5 分钟"], [10, "10 分钟"], [30, "30 分钟"]], () => Number(s().sceneCycle) || 0,
        (v) => change({ sceneCycle: v }, v ? `背景每 ${v} 分钟换一次` : "背景不再轮换")),
      h("button.btn.small.st-scene-now", { type: "button", onclick: () => { if (!nextScene()) toast("现在这套风格只有一张背景图。"); } }, "现在换一次")),
    row("停笔后变回背景", "写字页停笔、不动鼠标一阵以后，侧栏、顶栏隐去，纸变透明，屏幕只剩动态背景。一动鼠标或打字，界面回来，纸按这套风格的方式复写回来。",
      seg("停笔后变回背景", [[0, "不变"], [15, "15 秒"], [30, "30 秒"], [60, "1 分钟"], [180, "3 分钟"]], () => Number(s().paperRest) || 0,
        (v) => change({ paperRest: v }, v ? `停笔 ${v >= 60 ? v / 60 + " 分钟" : v + " 秒"}后变回背景` : "停笔后不再变回背景"))),
    row("走进作品", "打开一本书，镜头走进内景；回到书架，走回外景。",
      toggle("打开作品时走进室内", () => s().sceneNav !== false, (v) => change({ sceneNav: v }, v ? "打开作品时走进室内" : "打开作品时不换背景"), "sceneNav")),
    row("界面动效", "按钮回弹、弹窗弹出、面板滑入这些动作。「简洁」只淡入淡出；系统设置了减少动态效果时「自动」会关掉。",
      seg("界面动效", [["auto", "自动"], ["full", "完整"], ["simple", "简洁"], ["off", "关闭"]], () => s().motion,
        (v) => change({ motion: v }, "界面动效改成" + { auto: "自动", full: "完整", simple: "简洁", off: "关闭" }[v]))),
    row("点击特效", "点按钮、点空白处时冒出来的小特效。在正文里点击、打字不会冒。",
      seg("点击特效", [["style", "跟随小恶魔"], ["hearts", "像素爱心"], ["ripple", "魔法波纹"], ["ink", "墨点"], ["off", "关闭"]], () => s().clickFx,
        (v) => change({ clickFx: v }, "点击特效改成" + { style: "跟随小恶魔", hearts: "像素爱心", ripple: "魔法波纹", ink: "墨点", off: "关闭" }[v]))),
    row("界面字体", "按钮、菜单、章节列表用的字体。每个按钮上的名字就是用那种字体写的。", fontPicker("界面字体", "uiFont", "pills")),
    row("正文字体", "写正文用的字体。每张卡片用那种字体写一句；霞鹜文楷、悠哉、小赖、站酷小薇跟软件打包在一起，不联网也能用。最下面一行按现在的字号、行高预览。",
      fontPicker("正文字体", "textFont", "cards"),
      h("p.st-preview", { "aria-label": "正文预览" }, "　　雨下到第三天。林栀没有抬头，把窗关小了一点。")),
    row("自己的字体", "上传 ttf、otf、woff、woff2 字体文件。文件存在这台电脑上，换电脑要重新上传。", fontBox()),
    row("正文字号", "正文文字的大小。", slider("正文字号", "textSize", { min: 14, max: 30, step: 1 }, (v) => v + " px", "改正文字号")),
    row("行高", "行与行之间的距离，按字号的倍数算。", slider("行高", "lineHeight", { min: 1.4, max: 2.6, step: 0.1 }, (v) => Number(v).toFixed(1) + " 倍", "改行高")),
    row("正文宽度", "正文一行最宽多少。窗口比这个窄时按窗口宽度。", slider("正文宽度", "textWidth", { min: 480, max: 1200, step: 20 }, (v) => v + " px", "改正文宽度")),
  );
}

let fontInput = null;
function pickFontFile() { if (fontInput && fontInput.isConnected) fontInput.click(); }

function fontBox() {
  const listEl = h("div.st-font-list");
  fontInput = h("input", { type: "file", accept: ".ttf,.otf,.woff,.woff2", hidden: true, "data-role": "font-file" });
  fontInput.addEventListener("change", async () => {
    const f = fontInput.files[0];
    fontInput.value = "";
    if (f) await addFont(f);
  });
  const up = h("button.btn.small.st-font-up", { type: "button", onclick: pickFontFile }, icon("upload"), "上传字体");
  let sig = null;
  S.syncers.push(() => {
    const st = getSettings();
    const fonts = st.customFonts || [];
    const now = JSON.stringify([fonts, st.textFont, st.uiFont, [...broken]]);
    if (now === sig) return;
    sig = now;
    listEl.replaceChildren(...(fonts.length ? fonts.map(fontItem) : [h("p.muted.st-note", {}, "还没有上传字体。")]));
  });
  return h("div.st-font-box", {}, listEl, h("div.row", {}, up, fontInput));
}

function fontItem(f) {
  const st = getSettings();
  const bad = broken.has(f.id);
  const act = (text, cls, fn, disabled) => h("button.btn.small" + cls, { type: "button", disabled: !!disabled, onclick: fn }, text);
  return h("div.st-font-item", { "data-id": f.id },
    h("div.st-font-info", {},
      h("span.st-font-name", {}, f.name),
      bad ? h("span.st-bad", {}, "没加载出来，文件可能坏了")
        : h("span.st-font-sample", { style: { fontFamily: `"${f.id}", var(--f-ui)` } }, "雨下到第三天 Aa 123")),
    h("div.st-font-acts", {},
      act(st.textFont === f.id ? "正文在用" : "用作正文", ".ghost.st-use-text", () => change({ textFont: f.id }, "正文字体改成" + f.name), bad || st.textFont === f.id),
      act(st.uiFont === f.id ? "界面在用" : "用作界面", ".ghost.st-use-ui", () => change({ uiFont: f.id }, "界面字体改成" + f.name), bad || st.uiFont === f.id),
      act("删除", ".ghost.st-font-del", () => deleteFont(f))));
}

async function addFont(file) {
  const info = fontFileInfo(file.name);
  const again = [{ label: "换一个文件", primary: true, run: pickFontFile }];
  if (!info.ok) return fail({ what: `「${file.name}」不是字体文件。`, why: "只能用 ttf、otf、woff、woff2 这几种字体文件。", actions: again });
  let data;
  try { data = await file.arrayBuffer(); }
  catch (e) { return fail({ what: `「${file.name}」读不出来。`, why: "文件可能被移走了，或者没有读取权限。", error: e, actions: again }); }
  const id = uid("uf");
  try { await loadFace(id, data); }
  catch (e) { return fail({ what: `字体「${info.name}」用不了。`, why: "文件可能损坏了，或者扩展名和实际格式对不上。", error: e, actions: again }); }
  const name = uniqueName(info.name, (getSettings().customFonts || []).map((f) => f.name));
  const font = { id, name };
  const rec = { name, file: file.name, size: file.size, data };
  try {
    await writeFont(id, rec);
    await setSettings({ customFonts: [...(getSettings().customFonts || []), font] });
  } catch (e) {
    unloadFace(id);
    removeFont(id).catch(() => {});
    return fail({ what: `字体「${name}」没存进去。`, why: "字体文件比较大，存储空间可能不够了。", error: e });
  }
  let prev = null;
  pushUndo({
    sig: "font:" + id, label: `上传字体「${name}」`,
    undo: guard("没能撤销上传字体。", async () => { prev = await dropFont(font); }),
    redo: guard("没能重做上传字体。", () => restoreFont(font, rec, prev)),
  });
  bus.emit("settings:font-added", { font });
  toast(`已添加字体「${name}」（${fmtSize(file.size)}）`, { action: { label: "用作正文", run: () => change({ textFont: id }, "正文字体改成" + name) } });
  tip("settings-font", "上传的字体存在这台电脑上。点「用作正文」就能换上。");
}

/** 去掉一个字体：列表里删掉、文件删掉；正用着它的地方换回默认。返回之前的样子（撤销用） */
async function dropFont(font) {
  const st = getSettings();
  const list = st.customFonts || [];
  const prev = { index: list.findIndex((f) => f.id === font.id), textFont: st.textFont, uiFont: st.uiFont };
  const patch = { customFonts: list.filter((f) => f.id !== font.id) };
  if (st.textFont === font.id) patch.textFont = DEFAULT_SETTINGS.textFont;
  if (st.uiFont === font.id) patch.uiFont = DEFAULT_SETTINGS.uiFont;
  await setSettings(patch);
  await removeFont(font.id);
  unloadFace(font.id);
  broken.delete(font.id);
  return prev;
}

async function restoreFont(font, rec, prev) {
  if (rec && rec.data) {
    await writeFont(font.id, rec);
    try { await loadFace(font.id, rec.data); } catch (_) { broken.add(font.id); }
  } else broken.add(font.id);
  const st = getSettings();
  const list = (st.customFonts || []).filter((f) => f.id !== font.id);
  list.splice(prev && prev.index >= 0 ? Math.min(prev.index, list.length) : list.length, 0, font);
  const patch = { customFonts: list };
  if (prev && prev.textFont === font.id) patch.textFont = font.id;
  if (prev && prev.uiFont === font.id) patch.uiFont = font.id;
  await setSettings(patch);
}

async function deleteFont(font) {
  let rec = null;
  try { rec = await readFont(font.id); } catch (_) { /* 文件读不出来也照样删 */ }
  let prev;
  try { prev = await dropFont(font); }
  catch (e) { return fail({ what: `字体「${font.name}」没删掉。`, why: DB_WHY, error: e }); }
  const entry = pushUndo({
    sig: "font-del:" + font.id, label: `删除字体「${font.name}」`,
    undo: guard("没能撤销删除字体。", () => restoreFont(font, rec, prev)),
    redo: guard("没能重做删除字体。", async () => { prev = await dropFont(font); }),
  });
  bus.emit("settings:font-removed", { font });
  toast(`已删除字体「${font.name}」`, { action: { label: "撤销", run: () => runUndo(entry) } });
}

// ---------------- 小恶魔 ----------------
/** 风格卡片：缩略图用待机动作的第一帧 */
function styleGrid(name, get, set, withAuto) {
  const box = h("div.st-styles", { role: "group", "aria-label": name });
  const items = [];
  if (withAuto) {
    const auto = styleFor({ ...(S.book || {}), demonStyle: "auto" });
    items.push(["auto", "按作品类型", auto, "现在会穿：" + auto.name.split("·").pop()]);
  }
  for (const st of allStyles()) items.push([st.id, st.name, st, st.genres.join(" · ")]);
  const btns = items.map(([id, nm, st, sub]) => {
    const b = h("button.st-style", { type: "button", "data-v": id },
      h("span.st-thumb" + (id === "auto" ? ".auto" : ""), { style: { backgroundImage: `url("sprites/${st.id}/idle.png")` }, "aria-hidden": "true" }),
      h("span.st-style-name", {}, nm),
      h("span.st-style-sub", {}, sub));
    b.addEventListener("click", () => { if (get() !== id) set(id); });
    box.append(b);
    return [id, b];
  });
  S.syncers.push(() => btns.forEach(([id, b]) => b.setAttribute("aria-pressed", String(get() === id))));
  return box;
}

/** 配色没选「跟随小恶魔」时，她穿配色那一套，这里的选择先不生效：说清楚，给一个就地改的按钮 */
function paletteLockNote() {
  const text = h("span", {});
  const btn = h("button.btn.small", { type: "button" }, "配色改成跟随小恶魔");
  btn.addEventListener("click", () => change({ palette: "follow" }, "配色跟随小恶魔"));
  const box = h("p.st-note.st-lock", {}, text, btn);
  S.syncers.push(() => {
    const p = getSettings().palette;
    box.hidden = !p || p === "follow";
    if (!box.hidden) {
      const name = (PALETTES.find((x) => x.id === resolvePalette(getSettings(), "magical")) || {}).name || "";
      text.textContent = (p === "time" ? "配色随时间换" : p === "season" ? "配色随季节换" : `配色固定成「${name}」`) + "，小恶魔跟着穿那一套，这里的选择等配色改回「跟随小恶魔」再生效。";
    }
  });
  return box;
}

/** 换了风格就让她换上，打个招呼（气泡里只有台词） */
async function withGreeting(fn) {
  const before = wantedStyle(S.book || null).id;
  const entry = await fn();
  const now = wantedStyle(S.book || null);
  if (entry && now.id !== before) {
    setDemonBook(S.book || null);
    react("open", { force: true, act: "wave" });
  }
  return entry;
}

function renderDemon(body) {
  const s = () => getSettings();
  const seen = h("span.muted.st-seen");
  S.syncers.push(() => { seen.textContent = `看过 ${Object.keys(s().tipsSeen || {}).length} 条`; });
  const scaleNow = h("span.muted.st-scale-now");
  S.syncers.push(() => {
    const v = s().demonScale || 1;
    scaleNow.textContent = [0.75, 1, 1.5, 2].includes(v) ? "" : `现在 ${v}×`;
  });
  body.append(
    row("显示小恶魔", "收起以后，右下角留一个「小恶魔」按钮，点一下她就回来。",
      toggle("显示", () => s().demonOn, (v) => change({ demonOn: v }, v ? "显示小恶魔" : "收起小恶魔"), "demonOn")),
    row("大小", "也可以拖她左上角的小角调大小，按住她能换位置。",
      h("div.row", {},
        seg("大小", [[0.75, "0.75×"], [1, "1×"], [1.5, "1.5×"], [2, "2×"]], () => s().demonScale || 1,
          (v) => change({ demonScale: v }, "小恶魔大小改成 " + v + "×")),
        scaleNow,
        h("button.btn.small.ghost.st-demon-home", { type: "button", onclick: () => change({ demonPos: null }, "小恶魔放回右下角") }, "放回右下角"))),
    row("书架上穿哪套", "在书架、设置这些没打开作品的地方，她穿哪一套。打开作品以后按作品自己的设置。",
      styleGrid("书架上穿哪套", () => s().demonStyle, (v) => withGreeting(() => change({ demonStyle: v }, "小恶魔换装")), false), paletteLockNote()),
    row("话多少", "少：只在打开软件、完成字数目标、写完一章时说话。你戳她、出错时照常说。",
      seg("话多少", [["quiet", "少"], ["normal", "正常"], ["chatty", "多"]], () => s().demonChatty,
        (v) => change({ demonChatty: v }, "小恶魔话多少改成" + { quiet: "少", normal: "正常", chatty: "多" }[v]))),
    row("停笔多久算久", "停笔这么久，她会打瞌睡，等你回来。",
      numberBox("停笔多久算久", () => s().idleMinutes, (v) => change({ idleMinutes: v }, "改停笔时间", { merge: true }), { min: 1, max: 120 }, "分钟")),
    row("功能说明", "第一次用某个功能时她会说一句说明，看过就不再说。点这里让说明重新出现。",
      h("div.row", {}, h("button.btn.small.st-tips", { type: "button", onclick: resetTips }, "重新显示"), seen)),
  );
}

async function resetTips() {
  const n = Object.keys(getSettings().tipsSeen || {}).length;
  if (!n) { toast("功能说明都还没看过，用到时会出现。"); return; }
  const entry = await change({ tipsSeen: {} }, "重新显示功能说明");
  if (entry) toast(`${n} 条功能说明会重新出现`, { action: { label: "撤销", run: () => runUndo(entry) } });
}

// ---------------- 书架 ----------------
function renderShelfGroup(body) {
  body.append(row("悬停多久显示详情", "鼠标在书上停这么久，弹出大封面和完整简介。",
    slider("悬停多久显示详情", "hoverDelay", { min: 0, max: 2000, step: 100 }, (v) => (v ? (v / 1000).toFixed(1) + " 秒" : "马上"), "改悬停时间")));
}

// ---------------- 当前作品 ----------------
function renderBookGroup(body) {
  if (!S.book) {
    body.append(h("p.muted.st-note", {}, "这本书找不到了，可能已经删进" + label("回收站") + "。"));
    return;
  }
  const b = () => S.book || {};
  body.append(
    h("p.muted.st-note", {}, "这一组只对这本书有效。"),
    row("章节号", "章节列表、导出时章节号的写法。",
      seg("章节号", [["zh", "第一章"], ["num", "第1章"]], () => b().numbering || "zh",
        (v) => changeBook({ numbering: v }, "章节号改成" + (v === "zh" ? "第一章" : "第1章")))),
    row("分卷", "打开后章节列表按卷分组，能新建卷、把章移到卷里。",
      toggle("分卷", () => b().useVolumes, (v) => setVolumes(v), "useVolumes")),
    row("回车自动空两格", "按回车换段时，新段落开头自动加两个全角空格。",
      toggle("自动空两格", () => b().autoIndent !== false, (v) => changeBook({ autoIndent: v }, v ? "打开自动空两格" : "关掉自动空两格"), "autoIndent")),
    row("段间空行", "按回车换段时，段与段之间空不空一行。",
      seg("段间空行", [[0, "不空行"], [1, "空一行"]], () => b().paraGap || 0, (v) => changeBook({ paraGap: v }, v ? "段间空一行" : "段间不空行"))),
    row("每日字数目标", "状态栏显示今天写了多少；写够了她会说一声。0 表示不设。",
      numberBox("每日字数目标", () => b().dailyGoal || 0, (v) => changeBook({ dailyGoal: v }, "改每日字数目标", { merge: true }), { min: 0, max: 100000, step: 100 }, "字")),
    row("小恶魔穿哪套", "按作品类型：按这本书的类型标签挑一套。也可以指定一套。",
      styleGrid("这本书的小恶魔", () => b().demonStyle || "auto", (v) => withGreeting(() => changeBook({ demonStyle: v }, "这本书的小恶魔换装")), true), paletteLockNote()),
  );
}

// ---------------- 快捷键 ----------------
const AREA_TEXT = { global: () => "随处", book: () => "写作时", trash: () => label("回收站") + "里", settings: () => label("设置") + "里" };

function renderKeys(body) {
  const q = h("input.input.st-key-q", { type: "search", placeholder: "找命令，比如：查找、新建", "aria-label": "找命令" });
  const listEl = h("div.st-keys", { role: "list" });
  q.addEventListener("input", () => drawKeys(true));
  S.keys = { q, listEl, sig: null };
  S.syncers.push(() => drawKeys(false));
  body.append(h("p.muted.st-note", {}, "点「改」以后直接按新的组合键，Esc 取消。要带上 Ctrl 或 Alt，F1–F12 可以单按。"), q, listEl);
}

function keyItems() {
  const custom = getSettings().keys || {};
  return commands.all().map((c) => ({ id: c.id, key: custom[c.id] || c.key || "", area: areaOf(c.id, !!c.when) }));
}

function drawKeys(force) {
  const K = S.keys;
  if (!K || !onSettings()) return;
  const custom = getSettings().keys || {};
  const cmds = commands.all();
  const sig = JSON.stringify(custom) + "|" + cmds.map((c) => c.id).join(",") + "|" + K.q.value + "|" + (S.recording ? S.recording.id + S.recording.err : "");
  if (!force && sig === K.sig) return;
  K.sig = sig;
  const items = keyItems();
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  const conflicts = findConflicts(items);
  const q = K.q.value.trim().toLowerCase();
  const list = cmds.filter((c) => !q || [c.title, c.keywords || "", c.hint || "", showKey(byId[c.id].key)].join(" ").toLowerCase().includes(q));
  list.sort((a, b) => (byId[a.id].key ? 0 : 1) - (byId[b.id].key ? 0 : 1));
  K.listEl.replaceChildren(...(list.length ? list.map((c) => keyRow(c, byId[c.id], conflicts, custom)) : [h("p.muted.st-note", {}, "没找到这个命令。")]));
  if (S.recording) { const b = K.listEl.querySelector(".st-key.rec .st-key-cancel"); if (b) b.focus(); }
}

function keyRow(c, item, conflicts, custom) {
  const rec = S.recording && S.recording.id === c.id;
  const area = AREA_TEXT[item.area];
  const kbd = rec ? h("span.st-rec", {}, "按下新的组合键…")
    : item.key ? h("span.kbd.st-kbd", {}, showKey(item.key)) : h("span.muted.st-nokey", {}, "没有");
  const btn = (text, cls, fn) => h("button.btn.small" + cls, { type: "button", onclick: fn }, text);
  const acts = rec ? [btn("取消", ".st-key-cancel", () => stopRecording())]
    : [btn("改", ".st-key-edit", () => startRecording(c)),
      custom[c.id] ? btn(c.key ? "恢复默认" : "清除", ".ghost.st-key-reset", () => setKey(c, "")) : null];
  return h("div.st-key" + (rec ? ".rec" : ""), { role: "listitem", "data-id": c.id },
    h("div.st-key-info", {},
      h("div.st-key-head", {}, h("span.st-key-t", {}, c.title), area ? h("span.st-area", {}, area()) : null),
      c.hint ? h("span.st-key-h", {}, c.hint) : null,
      conflicts[c.id] ? h("span.st-key-warn", {}, "和「" + conflicts[c.id].map(titleOf).join("」「") + "」用了同一个键") : null,
      rec && S.recording.err ? h("span.st-key-warn.st-key-err", {}, S.recording.err) : null),
    h("div.st-key-k", {}, kbd),
    h("div.st-key-acts", {}, ...acts));
}

const PURE_MODS = ["Control", "Shift", "Alt", "Meta", "CapsLock", "OS"];

function startRecording(c) {
  stopRecording(false);
  const rec = { id: c.id, err: "" };
  const onKey = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (PURE_MODS.includes(e.key)) return;
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { stopRecording(); return; }
    const k = keyName(e);
    const why = checkKey(k);
    if (why) { rec.err = showKey(k) + "：" + why; drawKeys(true); return; }
    stopRecording(false);
    commitKey(c, k);
  };
  const onDown = (e) => { if (!e.target.closest || !e.target.closest(`.st-key[data-id="${CSS.escape(c.id)}"]`)) stopRecording(); };
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  rec.off = () => { window.removeEventListener("keydown", onKey, true); document.removeEventListener("mousedown", onDown, true); };
  S.recording = rec;
  drawKeys(true);
  tip("settings-keys", "直接按想要的组合键就行，比如 Ctrl+Shift+K。按 Esc 不改了。");
}

function stopRecording(redraw = true) {
  if (!S.recording) return;
  S.recording.off();
  S.recording = null;
  if (redraw) drawKeys(true);
}

async function commitKey(c, k) {
  const items = keyItems().map((it) => (it.id === c.id ? { ...it, key: k } : it));
  const hits = findConflicts(items)[c.id];
  if (hits && hits.length) {
    const r = await choose({
      title: "这个快捷键已经有用处了",
      body: `${showKey(k)} 现在是「${hits.map(titleOf).join("」「")}」的快捷键。两个用同一个键，按下去只有一个会生效。`,
      buttons: [{ id: "again", label: "换一个", primary: true }, { id: "use", label: "还是用它" }, { id: "cancel", label: "不改了" }],
    });
    if (r === "again") return startRecording(c);
    if (r !== "use") return drawKeys(true);
  }
  await setKey(c, k);
}

async function setKey(c, k) {
  const next = withKey(getSettings().keys, c.id, k, c.key);
  await change({ keys: next }, k ? `「${c.title}」的快捷键改成 ${showKey(k)}` : `「${c.title}」的快捷键${c.key ? "恢复默认" : "清除"}`);
  drawKeys(true);
}

// ---------------- 主题彩蛋 ----------------
function renderNames(body) {
  body.append(row("改名彩蛋", "只改名字，功能不变。关掉就改回原来的名字。",
    toggle("打开", () => getSettings().themeNames, (v) => change({ themeNames: v }, v ? "打开主题彩蛋" : "关掉主题彩蛋"), "themeNames"),
    h("p.muted.st-note", {}, "设置叫「签订契约」，回收站叫「地狱」，暂存盒叫「恶魔口袋」。")));
}

// ---------------- 报错记录 ----------------
function renderErrlog(body) {
  S.errBar = h("div.st-err-bar");
  S.errEl = h("div.st-errs", { role: "list" });
  S.errShown = ERR_PAGE;
  body.append(h("p.muted.st-note", {}, "出过的错都记在这里，有时间和原文。找人帮忙时可以复制给对方看。"), S.errBar, S.errEl);
  drawErrlog();
}

function drawErrlog() {
  if (!S.errEl) return;
  const log = S.errlog || [];
  const btn = (text, cls, fn) => h("button.btn.small" + cls, { type: "button", disabled: !log.length, onclick: fn }, text);
  S.errBar.replaceChildren(
    h("span.muted.st-err-count", {}, log.length ? `共 ${log.length} 条（最多留 200 条）` : ""),
    h("span.spacer"),
    btn("复制全部", ".ghost.st-err-copy", copyErrlog),
    btn("清空", ".ghost.st-err-clear", clearErrlog));
  if (!log.length) { S.errEl.replaceChildren(h("p.muted.st-note.st-err-none", {}, "还没有出过错。")); return; }
  const shown = log.slice(0, S.errShown);
  const more = log.length > shown.length
    ? h("button.btn.small.ghost.st-err-more", { type: "button", onclick: () => { S.errShown += ERR_PAGE; drawErrlog(); } }, `再显示 ${Math.min(ERR_PAGE, log.length - shown.length)} 条`)
    : null;
  S.errEl.replaceChildren(...shown.map(errItem), ...(more ? [more] : []));
}

function errItem(e) {
  return h("article.st-err", { role: "listitem" },
    h("div.st-err-head", {},
      h("time.st-err-time", { datetime: new Date(e.at).toISOString(), title: new Date(e.at).toLocaleString() }, fmtTime(e.at)),
      h("span.st-err-what", {}, e.what || "（没写是什么错）")),
    e.why ? h("p.st-err-why", {}, "可能的原因：" + e.why) : null,
    e.detail ? h("details.st-err-detail", {}, h("summary", {}, "详细信息"), h("pre", {}, e.detail)) : null);
}

async function refreshErrlog() {
  try { S.errlog = await db.getKV("errlog", []); } catch (_) { /* 读不出来就先显示旧的 */ }
  if (onSettings()) drawErrlog();
}

async function copyErrlog() {
  const text = logText(S.errlog || [], (t) => new Date(t).toLocaleString());
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制 " + (S.errlog || []).length + " 条报错记录");
  } catch (e) {
    fail({ what: "报错记录没复制上。", why: "浏览器不让网页写剪贴板。可以展开「详细信息」自己选中复制。", error: e });
  }
}

async function clearErrlog() {
  let old;
  try {
    old = await db.getKV("errlog", []);
    if (!old.length) return;
    await db.setKV("errlog", []);
  } catch (e) { return fail({ what: "报错记录没清掉。", why: DB_WHY, error: e }); }
  S.errlog = [];
  S.errShown = ERR_PAGE;
  drawErrlog();
  const entry = pushUndo({
    sig: "errlog", label: "清空报错记录",
    undo: guard("没能撤销清空报错记录。", async () => { await db.setKV("errlog", mergeLog(await db.getKV("errlog", []), old)); await refreshErrlog(); }),
    redo: guard("没能重做清空报错记录。", async () => { await db.setKV("errlog", removeLog(await db.getKV("errlog", []), old)); await refreshErrlog(); }),
  });
  bus.emit("settings:errlog-cleared", { count: old.length });
  toast(`已清空 ${old.length} 条报错记录`, { action: { label: "撤销", run: () => runUndo(entry) } });
}

// ---------------- 恢复默认 ----------------
const RESET_TEXT = {
  look: "主题、界面字体、正文字体、字号、行高、正文宽度回到最初的样子。上传的字体文件会留着。",
  demon: "显示、大小、位置、书架上穿哪套、话多少、停笔时间回到最初的样子。",
  shelf: "悬停时间回到 0.5 秒。",
  book: "只改这本书：章节号、分卷、自动空两格、段间空行、字数目标、小恶魔穿哪套。",
  keys: "自己改过的快捷键全部换回默认。",
  names: "设置、回收站、暂存盒换回原来的名字。",
};

async function resetGroup(id, name) {
  if (!(await confirm(`「${name}」恢复默认？`, RESET_TEXT[id] + "恢复以后也能撤销。", "恢复默认"))) return;
  stopRecording();
  const entry = await withGreeting(() => (id === "book"
    ? changeBook(pick(DEFAULT_BOOK, BOOK_KEYS), "当前作品恢复默认")
    : change(resetPatch(id, DEFAULT_SETTINGS), `「${name}」恢复默认`)));
  if (!entry) { toast(`「${name}」本来就是默认的`); return; }
  bus.emit("settings:reset", { group: id });
  toast(`「${name}」已恢复默认`, { action: { label: "撤销", run: () => runUndo(entry) } });
}

// ---------------- 界面 ----------------
function section(id, name, render, { reset = true, sub = "" } = {}) {
  const body = h("div.st-body");
  const resetBtn = reset ? h("button.btn.small.ghost.st-reset", { type: "button", "data-group": id }, "恢复默认") : null;
  if (resetBtn) resetBtn.addEventListener("click", () => resetGroup(id, name));
  const sec = h("section.st-group#st-" + id, { "data-group": id, "aria-labelledby": "st-h-" + id },
    h("div.st-group-head", {}, h("h2.st-group-title#st-h-" + id, {}, name, sub ? h("span.st-group-sub", {}, sub) : null), resetBtn),
    body);
  render(body);
  return sec;
}

function scrollToGroup(id) {
  const el = S.view && S.view.querySelector("#st-" + id);
  if (!el) return;
  el.scrollIntoView({ block: "start" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

async function renderSettings(params, restoreState) {
  stopRecording(false);
  S.bookId = params.bookId || null;
  S.book = null;
  if (S.bookId) { try { S.book = await getBook(S.bookId); } catch (_) { S.book = null; } }
  try { S.errlog = await db.getKV("errlog", []); } catch (_) { S.errlog = []; }
  S.syncers = [];

  const back = h("button.icon-btn", { type: "button", title: "返回（Alt+←）", "aria-label": "返回" }, icon("back"));
  back.addEventListener("click", () => nav.back());
  S.titleEl = h("span.title.st-title", {}, L());
  S.undoBtn = h("button.icon-btn", { type: "button", "aria-label": "撤销", title: "撤销（Ctrl+Z）" }, icon("undo"));
  S.redoBtn = h("button.icon-btn", { type: "button", "aria-label": "重做", title: "重做（Ctrl+Shift+Z）" }, icon("redo"));
  S.undoBtn.addEventListener("click", () => runUndo());
  S.redoBtn.addEventListener("click", () => runRedo());

  const groups = [
    ["look", "外观", renderLook],
    ["demon", "小恶魔", renderDemon],
    ["shelf", "书架", renderShelfGroup],
    S.bookId ? ["book", "当前作品", renderBookGroup, { reset: !!S.book, sub: S.book ? "《" + S.book.title + "》" : "" }] : null,
    ["keys", "快捷键", renderKeys],
    ["names", "主题彩蛋", renderNames],
    ["errlog", "报错记录", renderErrlog, { reset: false }],
  ].filter(Boolean);
  const jump = h("nav.st-jump", { "aria-label": "跳到哪一组" },
    ...groups.map(([id, name]) => h("button.st-jump-btn", { type: "button", "data-group": id, onclick: () => scrollToGroup(id) }, name)));
  S.main = h("main.st-main", {}, h("div.st-wrap", {}, jump, ...groups.map(([id, name, fn, o]) => section(id, name, fn, o))));
  S.view = h("div.view.st", {},
    h("header.topbar", {}, back, S.titleEl, h("span.spacer"), S.undoBtn, S.redoBtn),
    S.main);
  document.getElementById("app").replaceChildren(S.view);
  syncAll();
  if (S.pending) { scrollToGroup(S.pending); S.pending = null; }
  else if (restoreState && restoreState.settingsScroll) S.main.scrollTop = restoreState.settingsScroll;
  tip("settings-first", "这里改了马上生效，也马上存好。改错了点右上角的撤销。每项旁边的「?」能看用途。");
}

/** 打开设置并滚到某一组（从写作界面进来时带上这本书） */
function openAt(group) {
  if (onSettings()) {
    if (group === "book" && !S.bookId && ws.book) return nav.go("/settings/" + ws.book.id);
    return scrollToGroup(group);
  }
  S.pending = group;
  return nav.go(ws.book ? "/settings/" + ws.book.id : "/settings");
}

async function toggleTheme() {
  const s = getSettings();
  const dark = s.theme === "dark" || (s.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  const entry = await change({ theme: next }, next === "dark" ? "换成深色" : "换成浅色");
  if (entry) toast(next === "dark" ? "已换成深色" : "已换成浅色", { action: { label: "撤销", run: () => runUndo(entry) } });
}

async function toggleNames() {
  const on = !getSettings().themeNames;
  const entry = await change({ themeNames: on }, on ? "打开主题彩蛋" : "关掉主题彩蛋");
  if (entry) toast(on ? "主题彩蛋打开了：设置叫「签订契约」" : "名字改回来了", { action: { label: "撤销", run: () => runUndo(entry) } });
}

// ---------------- 注册 ----------------
export async function register() {
  nav.route("settings", "/settings/:bookId?", (params, restoreState) => renderSettings(params, restoreState));
  nav.onLeave(() => (onSettings() ? { settingsScroll: S.main.scrollTop } : {}));
  bus.on("route", ({ name }) => {
    if (name === "settings") return;
    stopRecording(false);
    S.view = null; S.undoBtn = S.redoBtn = null; S.syncers = []; S.keys = null; S.errEl = null;
  });
  bus.on("settings:changed", () => syncAll());
  bus.on("book:updated", ({ book }) => { if (onSettings() && S.book && book && book.id === S.book.id) { S.book = book; syncAll(); } });
  bus.on("undo", () => { if (undoing) myUndone.push(undoing); else myUndone.length = 0; undoing = null; });
  bus.on("redo", () => { if (redoing && myUndone[myUndone.length - 1] === redoing) myUndone.pop(); else myUndone.length = 0; redoing = null; });
  bus.on("undo:changed", () => { if (!appUndo.canRedo()) myUndone.length = 0; updateUndoBtns(); });

  const inBook = () => !!ws.book;
  commands.register({
    id: "nav.settings", get title() { return L(); },
    keywords: "设置 签订契约 选项 偏好 字体 主题 深色 浅色 字号 行高 宽度 快捷键 小恶魔 报错",
    hint: "字体、主题、小恶魔、快捷键都在这里改", run: () => openAt(null),
  });
  commands.register({ id: "settings.look", title: "换字体、字号", keywords: "字体 字号 行高 正文宽度 楷体 宋体 黑体 上传字体 自己的字体 ttf otf woff 外观 主题",
    hint: "界面和正文字体分开设置，也能上传自己的字体", run: () => openAt("look") });
  commands.register({ id: "settings.theme", title: "深色 / 浅色切换", keywords: "深色 夜间 暗色 浅色 白天 主题 黑色背景 护眼",
    hint: "马上换，能撤销", run: toggleTheme });
  commands.register({ id: "settings.demon", title: "小恶魔设置", keywords: "小恶魔 大小 换装 风格 衣服 话多 话少 安静 吵 隐藏 显示 打瞌睡",
    hint: "显示、大小、穿哪套、话多少", run: () => openAt("demon") });
  commands.register({ id: "settings.tips", title: "重新显示功能说明", keywords: "说明 提示 气泡 教程 第一次 新手",
    hint: "看过的说明再出现一次", run: async () => { await resetTips(); } });
  commands.register({ id: "settings.book", title: "本书设置", keywords: "章节号 第一章 第1章 分卷 自动空格 缩进 空两格 段间空行 每日目标 字数目标 这本书",
    hint: "章节号、分卷、自动空两格、每日字数目标", when: inBook, run: () => openAt("book") });
  commands.register({ id: "settings.keys", title: "自定义快捷键", keywords: "快捷键 按键 组合键 键盘 改键 热键",
    hint: "每个命令的快捷键都能改", run: () => openAt("keys") });
  commands.register({ id: "settings.names", title: "主题彩蛋（改名）", keywords: "彩蛋 签订契约 地狱 恶魔口袋 改名 名字",
    hint: "设置叫签订契约，回收站叫地狱", run: toggleNames });
  commands.register({ id: "settings.errlog", title: "报错记录", keywords: "报错 错误 出错 日志 记录 bug 问题",
    hint: "出过的错都记在这里", run: () => openAt("errlog") });

  const typing = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && /^(text|search|number|email|url|)$/.test(a.type || "")));
  };
  const here = () => onSettings() && !hasLayers() && !S.recording && !typing();
  commands.register({ id: "settings.undo", title: "撤销", keywords: "撤回 后悔 改错了", hint: "撤销刚才在设置里的改动", key: "Mod-z", when: () => here() && canUndoHere(), run: () => runUndo() });
  commands.register({ id: "settings.redo", title: "重做", keywords: "重做 撤销错了", key: "Mod-Shift-z", when: () => here() && canRedoHere(), run: () => runRedo() });

  // 上传过的字体：启动时加载好
  const fonts = getSettings().customFonts || [];
  if (fonts.length) {
    const fails = await loadAll(fonts);
    if (fails.length) {
      notice({
        what: `上传的字体「${fails.map((f) => f.font.name).join("」「")}」没加载出来，先用默认字体显示。`,
        why: "字体文件可能损坏了，或者浏览器清理过网站数据。可以在设置里删掉它，再重新上传。",
        detail: fails.map((f) => f.font.name + "：" + ((f.error && (f.error.stack || f.error.message)) || f.error)).join("\n"),
        actions: [{ label: "打开设置", primary: true, run: () => openAt("look") }],
      });
    }
  }
}
