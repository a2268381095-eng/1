// 绘画 / 封面制作：一个就地打开的大弹窗，从写提示词到设为封面都在这里做完，不跳到别处。
// 左边写提示词：封面时书名、作者锁在提示词开头（改这里的书名、作者名，作品信息跟着改）；自己写的画面；勾上的常用要求；实际发送的提示词。
// 右边是画板：先出几张便宜的草稿 → 点图挑中几张出高清 → 拖框裁剪 → 设为封面（一步撤销）/ 用这张（交回给调用的模块）。
// 画出来的图都自动进暂存盒（功能 paint，ref 是书或设定卡），右上角的暂存盒按钮能把以前画的拿回来用。
// 关掉时有没用上的图、改过的提示词，问「保留草稿 / 丢弃」；草稿存在 kv（paint:draft:<书>:<用途>:<卡>），图本身在暂存盒里。
import { h, icon, modal, toast, pushLayer } from "../../core/ui.js";
import { db } from "../../core/db.js";
import { bus } from "../../core/bus.js";
import { undo } from "../../core/undo.js";
import { commands } from "../../core/commands.js";
import { getBook, updateBook } from "../../core/store.js";
import { listPrompts, savePrompt } from "../../core/prompts.js";
import { paintProviders } from "../../core/ai.js";
import { label } from "../../core/settings.js";
import { fmtTime } from "../../core/text.js";
import { burstAt } from "../../core/fx.js";
import { runImage } from "../ai/image.js";
import { tip } from "../demon/demon.js";
import { ws } from "../editor/workspace.js";
import { PURPOSES, purposeOf, composePrompt, nameOf } from "./prompt.js";
import { presetBox } from "./presets.js";
import { cropper } from "./crop.js";

let current = null;   // 开着的那一个（同一时间只开一个）
const motionFull = () => document.documentElement.dataset.motion === "full";

/** 作品里开着这本书时，书名、作者名、封面跟着改（顶栏上的书名也换掉） */
function syncWs(bookId, patch) {
  if (!ws.book || ws.book.id !== bookId) return;
  Object.assign(ws.book, patch);
  const el = document.querySelector(".ws .book-name");
  if (el && patch.title) el.textContent = patch.title;
}

/**
 * 打开绘画界面。opts：
 *   purpose   "cover" | "character" | "place" | "item"
 *   bookId    哪本书（新建作品还没存时可以不给）
 *   cardId    设定卡（角色、地点、物品时）；outfitId 卡上的哪套服装；name 卡上的名字
 *   prompt    画面一栏先填上的话（比如角色卡的外貌）
 *   title / author / intro   封面时作品信息表单里正在填的（不给就读这本书的）
 *   cover     表单里现在的封面（新建作品时撤销用）
 *   onMeta({ title, author })   这里改了书名、作者名时通知（作品信息表单跟着改）
 *   onCover(dataUrl)            换了封面时通知（表单里的预览跟着换；撤销时也会调）
 *   onDone(dataUrl)             用了某一张（角色、地点、物品）
 * 返回 Promise：用了的那张图的 dataURL；没用就关掉是 null
 */
export async function openPaint(opts = {}) {
  if (current) { current.focus(); return null; }
  const purpose = purposeOf(opts.purpose || "cover");
  const P = PURPOSES[purpose];
  const bookId = opts.bookId || null;
  let book = null;
  try { book = bookId ? await getBook(bookId) : null; } catch (_) { book = null; }
  const meta = {
    title: opts.title != null ? String(opts.title).trim() : book ? book.title || "" : "",
    author: opts.author != null ? String(opts.author).trim() : book ? book.author || "" : "",
    intro: opts.intro != null ? String(opts.intro) : book ? book.intro || "" : "",
    name: opts.name || "",
  };
  if (!meta.name && opts.cardId && commands.get("cards.list")) {
    try { const c = ((await commands.run("cards.list", { bookId })) || []).find((x) => x.id === opts.cardId); if (c) meta.name = c.name || ""; } catch (_) { /* 拿不到名字就不显示 */ }
  }
  const ref = purpose === "cover" ? bookId : opts.cardId || bookId;
  // 草稿按「书、用途、卡（和卡上的哪套服装）」分开存
  const slot = `${bookId || "none"}:${purpose}:${opts.cardId || "-"}${opts.outfitId ? "~" + opts.outfitId : ""}`;
  const dkey = "paint:draft:" + slot;
  let draft = null, lastFree = "";
  try { draft = await db.getKV(dkey, null); lastFree = await db.getKV("paint:lastfree:" + slot, ""); } catch (_) { draft = null; }
  const hasPainter = (await paintProviders().catch(() => [])).length > 0;

  return new Promise((resolve) => {
    let result = null, kept = false, drawer = null, timer = 0, seq = 0, metaTimer = 0, metaPending = null;
    const S = { free: "", promptId: null, prompts: [], ratio: P.ratios[0], drafts: [], finals: [], crop: null, busy: null, done: false };
    const ratioNums = () => S.ratio.split(":").map(Number);

    // ---------------- 左边：提示词 ----------------
    const side = h("div.paint-side");
    const draftNote = h("div.paint-draft-note", { hidden: true });

    // 封面：书名、作者锁在提示词里
    const titleIn = h("input.input.paint-title-in", { value: meta.title, maxlength: "60", placeholder: "书名", "aria-label": "书名" });
    const authorIn = h("input.input.paint-author-in", { value: meta.author, maxlength: "40", placeholder: "作者名（可空）", "aria-label": "作者" });
    const lockSec = purpose === "cover" ? h("section.paint-sec.paint-lock", {},
      h("div.paint-sec-h", {}, h("span.paint-sec-ico", {}, icon("lock")), h("h3", {}, "锁在提示词里"), h("span.paint-sec-note", {}, "改这里，作品信息跟着改")),
      h("div.paint-lock-row", {}, h("label.field", {}, h("span", {}, "书名"), titleIn), h("label.field", {}, h("span", {}, "作者"), authorIn))) : null;

    // 画面：自己写，或者从提示词库挑一条
    const psel = h("select.select.paint-psel", { "aria-label": "从提示词库挑一条" });
    const manageBtn = h("button.btn.small.ghost.paint-manage", { type: "button", title: "管理提示词库（绘画）" }, "管理");
    const keepBtn = h("button.btn.small.ghost.paint-keep", { type: "button", title: "把画面这一栏存进提示词库" }, "存进提示词库");
    const freeIn = h("textarea.textarea.paint-free-in", { rows: "5", autofocus: true, "aria-label": "画面",
      placeholder: purpose === "cover" ? "画风、人物、场景、气氛……想写什么写什么。可以用 {书名} {作者} {简介}。" : "长相、衣服、姿势、场景、画风……想写什么写什么。可以用 {书名} {简介}。" });
    const varNames = purpose === "cover" ? ["书名", "作者", "简介"] : ["书名", "简介", ...(meta.name ? ["名字"] : [])];
    const vars = h("div.paint-vars", { role: "group", "aria-label": "插入变量" }, ...varNames.map((v) => {
      const b = h("button.paint-var", { type: "button", title: `插入 {${v}}，发送时换成${v === "名字" ? "卡上的名字" : v}` }, `{${v}}`);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => insertVar(v));
      return b;
    }));
    const freeSec = h("section.paint-sec.paint-free", {},
      h("div.paint-sec-h", {}, h("h3", {}, "画面"), h("span.spacer"), manageBtn),
      h("div.paint-psel-row", {}, psel, keepBtn), freeIn, vars);

    // 常用要求（勾选）
    const presets = presetBox({ purpose, onChange: () => renderPrompt() });

    // 比例：封面固定 3:4，别的三选一
    const ratioSec = h("section.paint-sec.paint-ratio-sec", {},
      h("div.paint-sec-h", {}, h("h3", {}, "比例")),
      purpose === "cover"
        ? h("p.paint-ratio-fixed", {}, h("span.paint-ratio-chip", {}, "3:4 竖版"), "出来后拖框裁成 600×800")
        : h("div.paint-ratio", { role: "group", "aria-label": "比例" }, ...P.ratios.map((r) => {
          const b = h("button", { type: "button", "aria-pressed": String(r === S.ratio), "data-v": r }, h("span.paint-ratio-box", { style: `aspect-ratio: ${r.replace(":", " / ")}` }), r);
          b.addEventListener("click", () => { S.ratio = r; ratioSec.querySelectorAll(".paint-ratio button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === r))); renderEmpty(); });
          return b;
        })));

    // 实际发送的提示词：锁着的几条做成带锁的签，后面是其余的
    const locksEl = h("div.paint-locks");
    const pre = h("pre.paint-pre");
    const missEl = h("div.paint-miss");
    const countEl = h("span.paint-sec-note");
    const prevSec = h("section.paint-sec.paint-preview", {},
      h("div.paint-sec-h", {}, h("h3", {}, "实际发送的提示词"), h("span.spacer"), countEl), locksEl, pre, missEl);

    const goBtn = h("button.btn.primary.paint-go-btn", { type: "button" }, icon("brush"), h("span.paint-go-t", {}, "先出草稿"));
    const goNote = h("p.paint-go-note", {}, hasPainter ? "草稿用低画质，便宜；挑中的再出高清。" : "还没接能画图的接口，点了先带你接上。");
    side.append(draftNote, lockSec || "", freeSec, presets.el, ratioSec, prevSec, h("div.paint-go", {}, goBtn, goNote));

    // ---------------- 右边：画板 ----------------
    const steps = h("ol.paint-steps", { "aria-label": "步骤" },
      ...["出草稿", "挑几张出高清", purpose === "cover" ? "裁好设为封面" : "裁好拿去用"].map((t, i) =>
        h("li.paint-step", { "data-i": String(i + 1) }, h("span.paint-step-n", {}, String(i + 1)), h("span.paint-step-t", {}, t))));
    const busyBar = h("div.paint-busy", { hidden: true, role: "status", "aria-live": "polite" });
    const draftGrid = h("div.paint-grid.paint-grid-draft", { role: "list", "aria-label": "草稿" });
    const finalGrid = h("div.paint-grid.paint-grid-final", { role: "list", "aria-label": "高清" });
    const finalSec = h("section.paint-sect.paint-sect-final", { hidden: true },
      h("div.paint-sect-h", {}, h("h4", {}, "高清"), h("span.paint-sect-note", {}, `点「${P.use === "设为封面" ? "用这张" : P.use}」去裁剪`)), finalGrid);
    const draftSec = h("section.paint-sect.paint-sect-draft", { hidden: true },
      h("div.paint-sect-h", {}, h("h4", {}, "草稿"), h("span.paint-sect-note", {}, "点图挑中，挑好了出高清")), draftGrid);
    const empty = h("div.paint-empty");
    const gallery = h("div.paint-gallery", {}, empty, finalSec, draftSec);
    const cropBox = h("div.paint-cropview", { hidden: true });
    const acts = h("div.paint-acts");
    const stage = h("div.paint-stage", {}, h("div.paint-stage-top", {}, steps), busyBar, gallery, cropBox, acts);

    const root = h("div.paint", { "data-purpose": purpose }, side, stage);
    const stashBtn = h("button.tool-btn.paint-stash-btn", { type: "button", "data-cmd": "stash.drawer", title: `以前画的${P.short}图都在这里，能拿回来用` }, icon("box"), h("span.tb-t", {}, label("暂存盒")));

    const m = modal({
      title: purpose === "cover" ? "封面制作" : P.name + (meta.name ? " · " + meta.name : ""),
      body: root, wide: true,
      isDirty: () => dirty(),
      onKeepDraft: async () => { kept = true; await saveDraft(); },
      onClose: () => cleanup(),
    });
    m.el.classList.add("paint-modal");
    m.el.dataset.purpose = purpose;
    m.body.classList.add("paint-body");
    m.el.querySelector(".modal-head").insertBefore(stashBtn, m.el.querySelector(".modal-x"));
    current = { focus: () => freeIn.focus() };

    // ---------------- 提示词 ----------------
    const compose = (step = "draft", useRef = true) => composePrompt({ purpose, meta, free: S.free, picked: presets.picked(), step, useRef });
    function renderPrompt() {
      const c = compose();
      locksEl.replaceChildren(...c.locks.map((l) => h("span.paint-lockchip.k-" + l.k + (l.empty ? ".warn" : ""), { title: "锁在提示词开头，删不掉；改书名、作者名时跟着变" },
        icon("lock"), h("span.paint-lockchip-t", {}, l.text))));
      locksEl.hidden = !c.locks.length;
      pre.textContent = c.rest || "（画面还空着，也没勾常用要求）";
      pre.classList.toggle("empty", !c.rest);
      countEl.textContent = `${[...c.text].length.toLocaleString()} 字`;
      missEl.replaceChildren(...c.missing.map((x) => h("span.chip.warn", { title: "这个变量现在没有值，会原样发出去" }, `{${x}} 没有值`)));
    }
    function flashLock(k) {
      if (!motionFull()) return;
      const el = locksEl.querySelector(".k-" + k);
      if (!el) return;
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    }
    function insertVar(name) {
      const tok = "{" + name + "}";
      const s = freeIn.selectionStart ?? freeIn.value.length, e = freeIn.selectionEnd ?? s;
      freeIn.focus();
      freeIn.setSelectionRange(s, e);
      let ok = false;
      try { ok = document.execCommand("insertText", false, tok); } catch (_) { ok = false; }
      if (!ok || !freeIn.value.includes(tok)) { freeIn.setRangeText(tok, s, e, "end"); freeIn.dispatchEvent(new Event("input", { bubbles: true })); }
    }
    freeIn.addEventListener("input", () => {
      S.free = freeIn.value;
      if (S.promptId) {
        const p = S.prompts.find((x) => x.id === S.promptId);
        if (!p || p.text !== S.free) { S.promptId = null; psel.value = ""; }
      }
      renderPrompt();
    });

    // 书名、作者：改了马上进提示词；停手一会儿存进作品信息（表单开着时表单也跟着改）
    function metaChanged(k) {
      meta.title = titleIn.value.trim();
      meta.author = authorIn.value.trim();
      renderPrompt();
      flashLock(k);
      if (opts.onMeta) { try { opts.onMeta({ title: titleIn.value, author: authorIn.value }); } catch (_) { /* 表单关了就算了 */ } }
      if (!bookId) return;
      metaPending = { ...(meta.title ? { title: meta.title } : {}), author: meta.author };
      clearTimeout(metaTimer);
      metaTimer = setTimeout(flushMeta, 400);
    }
    async function flushMeta() {
      clearTimeout(metaTimer);
      if (!metaPending || !bookId) return;
      const patch = metaPending;
      metaPending = null;
      try {
        const b = await updateBook(bookId, patch);
        if (b) syncWs(bookId, { title: b.title, author: b.author || "" });
      } catch (e) { toast("书名、作者名没能保存：" + ((e && e.message) || e)); }
    }
    titleIn.addEventListener("input", () => metaChanged("title"));
    authorIn.addEventListener("input", () => metaChanged(authorIn.value.trim() ? "author" : "rule"));

    // 提示词库：只列绘画的在前，别的放「其他」
    async function fillPsel() {
      let list = [];
      try { list = await listPrompts(); } catch (_) { list = []; }
      S.prompts = list;
      const opt = (p) => h("option", { value: p.id }, (p.group ? p.group + " / " : "") + p.name + (p.uses ? `　· 用过 ${p.uses} 次` : ""));
      const paint = list.filter((p) => p.feature === "paint"), other = list.filter((p) => p.feature !== "paint");
      psel.replaceChildren(h("option", { value: "" }, list.length ? "临时写（下拉挑提示词库里的）" : "临时写（提示词库还是空的）"),
        ...(paint.length ? [h("optgroup", { label: "绘画" }, ...paint.map(opt))] : []),
        ...(other.length ? [h("optgroup", { label: "其他提示词" }, ...other.map(opt))] : []));
      psel.value = S.promptId && list.some((p) => p.id === S.promptId) ? S.promptId : "";
    }
    psel.addEventListener("change", () => {
      const p = S.prompts.find((x) => x.id === psel.value);
      if (!p) { S.promptId = null; renderPrompt(); return; }
      const before = S.free, beforeId = S.promptId;
      S.free = p.text;
      S.promptId = p.id;
      freeIn.value = p.text;
      renderPrompt();
      if (before.trim() && before !== p.text) {
        toast(`画面换成了「${p.name}」`, { action: { label: "撤销", run: () => { S.free = before; S.promptId = beforeId; freeIn.value = before; psel.value = beforeId || ""; renderPrompt(); } } });
      }
    });
    manageBtn.addEventListener("click", async () => { await commands.run("prompts.manage", { feature: "paint" }); await fillPsel(); });
    keepBtn.addEventListener("click", async () => {
      if (!freeIn.value.trim()) { toast("画面一栏还空着"); freeIn.focus(); return; }
      try {
        const p = await savePrompt({ name: nameOf(freeIn.value), text: freeIn.value, feature: "paint" });
        S.promptId = p.id;
        await fillPsel();
        toast(`已存进提示词库：「${p.name}」`);
      } catch (e) { toast("没能存进提示词库：" + ((e && e.message) || e)); }
    });

    // ---------------- 草稿、高清 ----------------
    const item = (kind, x) => ({ key: kind[0] + (++seq), kind, n: 0, state: "done", picked: false, el: null, ...x });
    const doneOf = (list) => list.filter((x) => x.state === "done");
    const sig = () => JSON.stringify([S.free, doneOf(S.drafts).map((d) => [d.id, !!d.picked]), doneOf(S.finals).map((f) => f.id)]);
    let savedSig = "";
    const dirty = () => !S.done && (!!S.busy || sig() !== savedSig);

    function cardEl(it) {
      const [rw, rh] = it.w && it.h ? [it.w, it.h] : ratioNums();
      const el = h("article.paint-card.is-" + it.kind + ".st-" + it.state + (it.picked ? ".picked" : ""), { role: "listitem", "data-key": it.key, style: `--ar: ${rw} / ${rh}; --i: ${it.state === "wait" ? it.i || 0 : 0}` });
      if (it.state === "wait") {
        el.setAttribute("aria-busy", "true");
        el.append(h("div.paint-card-img.paint-wait", {}, h("span.paint-wait-a", { "aria-hidden": "true" }), h("span.paint-wait-b", { "aria-hidden": "true" }),
          h("span.paint-wait-t", {}, `画第 ${it.n} 张……`)));
        return el;
      }
      if (it.state === "fail") {
        const x = h("button.btn.small.ghost", { type: "button" }, "收起");
        x.addEventListener("click", () => removeItem(it));
        el.append(h("div.paint-card-img.paint-fail", {}, h("p.paint-fail-t", {}, "这张没画出来"), h("p.paint-fail-why", {}, it.why || "")),
          h("div.paint-card-bar", {}, h("span.paint-card-no", {}, `${it.kind === "draft" ? "草稿" : "高清"} ${it.n}`), h("span.spacer"), x));
        return el;
      }
      const img = h("img", { src: it.dataUrl, alt: `${it.kind === "draft" ? "草稿" : "高清"} ${it.n}`, draggable: "false" });
      const zoomBtn = h("button.icon-btn.paint-zoom-btn", { type: "button", "aria-label": "放大看", title: "放大看" }, icon("zoom"));
      zoomBtn.addEventListener("click", () => zoomView(it));
      if (it.kind === "draft") {
        const pick = h("button.paint-card-img.paint-pick", { type: "button", "aria-pressed": String(!!it.picked), "aria-label": `草稿 ${it.n}：${it.picked ? "已挑中，再点取消" : "点一下挑中"}` },
          img, h("span.paint-pick-mark", { "aria-hidden": "true" }));
        pick.addEventListener("click", () => togglePick(it));
        const use = h("button.btn.small.ghost.paint-use-draft", { type: "button", title: "不出高清，直接拿草稿去裁剪" }, "直接用");
        use.addEventListener("click", () => enterCrop(it));
        el.append(pick, h("div.paint-card-bar", {}, h("span.paint-card-no", {}, `草稿 ${it.n}`), h("span.spacer"), zoomBtn, use));
      } else {
        const view = h("button.paint-card-img.paint-view", { type: "button", "aria-label": `高清 ${it.n}：放大看` }, img);
        view.addEventListener("click", () => zoomView(it));
        const use = h("button.btn.small.primary.paint-use-final", { type: "button" }, P.use === "设为封面" ? "用这张" : P.use);
        use.addEventListener("click", () => enterCrop(it));
        el.append(view, h("div.paint-card-bar", {}, h("span.paint-card-no", {}, `高清 ${it.n}`), it.size ? h("span.paint-card-size", {}, `${it.w}×${it.h}`) : null, h("span.spacer"), zoomBtn, use));
      }
      return el;
    }
    function redraw(it) {
      const old = it.el;
      it.el = cardEl(it);
      if (old && old.isConnected) old.replaceWith(it.el);
    }
    function removeItem(it) {
      S.drafts = S.drafts.filter((x) => x !== it);
      S.finals = S.finals.filter((x) => x !== it);
      if (it.el) it.el.remove();
      renderGallery();
    }
    function togglePick(it) {
      it.picked = !it.picked;
      redraw(it);
      if (it.picked && motionFull()) it.el.classList.add("pick-pop");
      const btn = it.el.querySelector(".paint-pick");
      if (btn) btn.focus({ preventScroll: true });
      renderActs();
      renderSteps();
    }

    function renderEmpty() {
      const [rw, rh] = ratioNums();
      const go = h("button.btn.primary.paint-empty-go", { type: "button" }, icon("brush"), "先出草稿");
      go.addEventListener("click", startDrafts);
      empty.replaceChildren(
        h("div.paint-empty-frame", { style: `aspect-ratio: ${rw} / ${rh}`, "aria-hidden": "true" }, h("span.paint-empty-ico", {}, icon("image"))),
        h("p.paint-empty-t", {}, "先出几张便宜的草稿，挑中的再出高清。"),
        h("p.paint-empty-s", {}, purpose === "cover" ? "书名、作者名一直在提示词开头，改了跟着变。" : "画好的会自动放进暂存盒。"),
        go);
    }
    function renderGallery() {
      empty.hidden = !!(S.drafts.length || S.finals.length);
      draftSec.hidden = !S.drafts.length;
      finalSec.hidden = !S.finals.length;
      renderActs();
      renderSteps();
    }
    function renderSteps() {
      const hasDraft = doneOf(S.drafts).length > 0, hasFinal = doneOf(S.finals).length > 0;
      const cur = S.crop ? 3 : hasDraft ? 2 : 1;
      steps.querySelectorAll(".paint-step").forEach((li) => {
        const i = Number(li.dataset.i);
        li.dataset.state = i === cur ? "cur" : i < cur || (i === 2 && hasFinal) ? "done" : "todo";
      });
      root.dataset.step = String(cur);
    }
    function renderActs() {
      const picked = doneOf(S.drafts).filter((d) => d.picked).length;
      goBtn.querySelector(".paint-go-t").textContent = S.busy ? "正在画……" : S.drafts.length ? "再出一批草稿" : "先出草稿";
      goBtn.disabled = !!S.busy;
      acts.replaceChildren();
      if (S.crop) return;
      if (S.drafts.length) {
        const hi = h("button.btn.primary.paint-hi-btn", { type: "button", disabled: !picked || !!S.busy }, icon("sparkle"), picked ? `出高清（${picked} 张）` : "出高清（先挑几张）");
        hi.addEventListener("click", startFinals);
        const again = h("button.btn.paint-again", { type: "button", disabled: !!S.busy }, "再出一批草稿");
        again.addEventListener("click", startDrafts);
        acts.append(h("span.paint-acts-note", {}, picked ? `挑中 ${picked} 张` : "点草稿挑中，再出高清"), h("span.spacer"), again, hi);
      }
      acts.hidden = !acts.childElementCount;
    }

    // 正在画：上面一条显示画了几张、等了多久，能取消
    function setBusy(step, ctrl, n) {
      S.busy = { step, ctrl, n, got: 0, t0: Date.now() };
      clearInterval(timer);
      const cancel = h("button.btn.small.paint-cancel", { type: "button" }, "取消");
      cancel.addEventListener("click", () => ctrl.abort());
      const txt = h("span.paint-busy-t");
      const tick = () => {
        if (!S.busy) return;
        const s = Math.round((Date.now() - S.busy.t0) / 1000);
        txt.textContent = `正在画${step === "final" ? "高清" : "草稿"}：${S.busy.got} / ${S.busy.n} 张 · 已等 ${s} 秒`;
      };
      busyBar.replaceChildren(h("span.paint-busy-ico", { "aria-hidden": "true" }), txt, h("span.spacer"), cancel);
      busyBar.hidden = false;
      tick();
      timer = setInterval(tick, 1000);
      renderActs();
    }
    function clearBusy() {
      S.busy = null;
      clearInterval(timer);
      busyBar.hidden = true;
      busyBar.replaceChildren();
      renderActs();
    }

    /** 一次画几张：先放占位卡，画好一张换一张 */
    async function paintBatch(step) {
      if (S.busy || S.done) return null;
      const picked = doneOf(S.drafts).filter((d) => d.picked);
      if (step === "final" && !picked.length) return null;
      const c = compose(step === "final" ? "final" : "draft");
      if (!c.text.trim()) { toast("先写几句画面，或者勾几条常用要求"); freeIn.focus(); return null; }
      const ctrl = new AbortController();
      let slots = [];
      const list = step === "final" ? S.finals : S.drafts;
      const grid = step === "final" ? finalGrid : draftGrid;
      const clearSlots = () => { slots.forEach((s) => { if (s.state !== "done") { const i = list.indexOf(s); if (i >= 0) list.splice(i, 1); if (s.el) s.el.remove(); } }); slots = []; };
      const promptName = (S.prompts.find((p) => p.id === S.promptId) || {}).name || "";
      const r = await runImage({
        feature: "paint", bookId, ref, purpose, step,
        prompt: c.text, promptFor: (ch) => compose(step, ch.useRef).text, promptId: S.promptId, promptName, missing: c.missing,
        ratio: S.ratio, count: 4, refImages: step === "final" ? picked.map((d) => d.dataUrl) : [],
        title: `${P.short}${step === "final" ? "高清" : "草稿"}`, label: `${P.short}${step === "final" ? "高清" : "草稿"}`,
        signal: ctrl.signal,
        onStart: (n) => {
          clearSlots();
          setBusy(step, ctrl, n);
          const base = list.filter((x) => x.state === "done").length;
          slots = [...Array(n)].map((_, i) => item(step === "final" ? "final" : "draft", { state: "wait", n: base + i + 1, i, from: step === "final" ? picked[i] && picked[i].key : null }));
          // 新的一批放在最前面
          list.unshift(...slots);
          slots.forEach((s) => { s.el = cardEl(s); });
          grid.prepend(...slots.map((s) => s.el));
          renderGallery();
          (step === "final" ? finalSec : draftSec).scrollIntoView({ block: "nearest", behavior: motionFull() ? "smooth" : "auto" });
        },
        onImage: (i, img) => {
          const s = slots[i];
          if (!s) return;
          Object.assign(s, { state: "done", dataUrl: img.dataUrl, w: img.w, h: img.h, id: img.stash ? img.stash.id : null, size: true });
          redraw(s);
          if (S.busy) S.busy.got++;
          if (motionFull()) { s.el.classList.add("arrive"); burstAt(s.el, "celebrate", 6); }
        },
        onFail: (i, e) => {
          const s = slots[i];
          if (!s || e.category === "cancel") return;
          Object.assign(s, { state: "fail", why: e.what || "" });
          redraw(s);
        },
      });
      clearBusy();
      // 取消了、全失败了：没画出来的占位卡收掉
      slots.forEach((s) => { if (s.state === "wait") removeItem(s); });
      if (!r) slots.forEach((s) => { if (s.state === "fail") removeItem(s); });
      renderGallery();
      if (r && r.images.length) {
        goNote.textContent = "草稿用低画质，便宜；挑中的再出高清。";
        try { await db.setKV("paint:lastfree:" + slot, S.free); } catch (_) { /* 记不住上次写的不要紧 */ }
        if (step === "final") {
          picked.forEach((d) => { d.picked = false; redraw(d); });
          renderActs();
        }
      }
      return r;
    }
    const startDrafts = () => paintBatch("draft");
    const startFinals = () => paintBatch("final");
    goBtn.addEventListener("click", startDrafts);
    // 写画面时 Ctrl+Enter 直接出草稿
    freeIn.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); startDrafts(); }
    });

    // 放大看
    function zoomView(it) {
      const im = h("img.paint-zoom-img", { src: it.dataUrl, alt: "" });
      const actions = it.kind === "draft"
        ? [{ label: it.picked ? "不挑这张" : "挑中这张", primary: !it.picked, onClick: () => { z.close(true); togglePick(it); } },
          { label: "直接用", onClick: () => { z.close(true); enterCrop(it); } }]
        : [{ label: P.use === "设为封面" ? "用这张" : P.use, primary: true, onClick: () => { z.close(true); enterCrop(it); } }];
      const z = modal({ title: `${it.kind === "draft" ? "草稿" : it.kind === "final" ? "高清" : "图"} ${it.n || ""}`.trim() + (it.w ? `　${it.w}×${it.h}` : ""), body: im, wide: true, actions });
      z.el.classList.add("paint-zoom");
    }

    // ---------------- 裁剪 ----------------
    let crop = null, cropLayer = null;
    async function enterCrop(it) {
      if (S.busy) { toast("等这一批画完，或者先取消"); return; }
      if (crop) exitCrop();
      S.crop = it;
      const [rw, rh] = ratioNums();
      const pw = 132, ph = Math.round((pw * rh) / rw);
      const prevCanvas = h("canvas.paint-crop-prev", { width: String(pw * 2), height: String(ph * 2), style: `width: ${pw}px; height: ${ph}px`, "aria-label": "裁出来的样子" });
      const info = h("p.paint-crop-info");
      let raf = 0;
      crop = cropper({ src: it.dataUrl, ratio: [rw, rh], onChange: () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (!crop) return;
          crop.drawTo(prevCanvas);
          const a = crop.area();
          const ow = purpose === "cover" ? 600 : Math.round(a.w), oh = purpose === "cover" ? 800 : Math.round(a.h);
          info.textContent = purpose === "cover"
            ? (a.w < 590 ? `框里这块原图 ${Math.round(a.w)}×${Math.round(a.h)}，放大到 600×800 会糊一点。` : `框里这块原图 ${Math.round(a.w)}×${Math.round(a.h)}，缩成 600×800。`)
            : `框里这块 ${ow}×${oh}` + (Math.max(ow, oh) > 1024 ? "，存的时候缩到长边 1024。" : "。");
        });
      } });
      const useBtn = h("button.btn.primary.paint-crop-use", { type: "button" }, icon(purpose === "cover" ? "book" : "check"), P.use);
      const backBtn = h("button.btn.ghost.paint-crop-back", { type: "button" }, icon("back"), "回去挑");
      useBtn.addEventListener("click", async () => {
        if (!crop) return;
        const a = crop.area();
        const k = purpose === "cover" ? 1 : Math.min(1, 1024 / Math.max(a.w, a.h));
        const [ow, oh] = purpose === "cover" ? P.out : [Math.max(1, Math.round(a.w * k)), Math.max(1, Math.round(a.h * k))];
        useBtn.disabled = true;
        try { await finish(crop.result(ow, oh, "image/jpeg", purpose === "cover" ? 0.88 : 0.9)); }
        catch (e) { useBtn.disabled = false; toast("没能用上这张：" + ((e && e.message) || e)); }
      });
      backBtn.addEventListener("click", () => { if (cropLayer) cropLayer.close(true); else exitCrop(); });
      cropBox.replaceChildren(h("div.paint-crop-wrap", {}, crop.el,
        h("aside.paint-crop-side", {},
          h("div.paint-crop-book", {}, prevCanvas),
          h("p.paint-crop-cap", {}, purpose === "cover" ? "裁出来 600×800" : "裁出来的样子"),
          info, useBtn, backBtn)));
      gallery.hidden = true;
      cropBox.hidden = false;
      renderSteps();
      renderActs();
      // Esc 先回到挑图，不直接关掉整个界面
      cropLayer = pushLayer({ onClose: () => { cropLayer = null; exitCrop(); } });
      await crop.ready;
      if (crop) crop.focus();
    }
    function exitCrop() {
      if (crop) crop.destroy();
      crop = null;
      S.crop = null;
      cropBox.hidden = true;
      cropBox.replaceChildren();
      gallery.hidden = false;
      if (cropLayer) { const l = cropLayer; cropLayer = null; l.close(true); }
      renderGallery();
    }

    // 用上了：封面写进作品（一步撤销），别的交回给调用的模块
    async function finish(dataUrl) {
      if (purpose === "cover") await applyCover(dataUrl);
      S.done = true;
      result = dataUrl;
      try { await db.del("kv", dkey); } catch (_) { /* 草稿删不掉不要紧 */ }
      bus.emit("paint:done", { purpose, bookId, cardId: opts.cardId || null, dataUrl });
      if (opts.onDone) { try { opts.onDone(dataUrl); } catch (_) { /* 调用方出错不影响这边关掉 */ } }
      if (cropLayer) { const l = cropLayer; cropLayer = null; l.close(true); }
      m.close(true);
    }
    async function applyCover(dataUrl) {
      const tell = (v) => { if (opts.onCover) { try { opts.onCover(v); } catch (_) { /* 表单关了 */ } } };
      if (bookId) {
        await flushMeta();
        const b = await getBook(bookId);
        const before = b ? b.cover || "" : "";
        await updateBook(bookId, { cover: dataUrl });
        syncWs(bookId, { cover: dataUrl });
        tell(dataUrl);
        const entry = undo.push({
          label: "换封面",
          undo: async () => { await updateBook(bookId, { cover: before }); syncWs(bookId, { cover: before }); tell(before); },
          redo: async () => { await updateBook(bookId, { cover: dataUrl }); syncWs(bookId, { cover: dataUrl }); tell(dataUrl); },
        });
        toast("已换封面", { action: { label: "撤销", run: () => undo.undoEntry(entry) } });
      } else {
        const before = opts.cover || "";
        tell(dataUrl);
        const entry = undo.push({ label: "换封面", undo: async () => tell(before), redo: async () => tell(dataUrl) });
        toast("已换封面（保存作品后生效）", { action: { label: "撤销", run: () => undo.undoEntry(entry) } });
      }
      // 换上了：在看得见的封面上撒一把
      setTimeout(() => {
        const at = document.querySelector(".modal .cover-prev") || (bookId && document.querySelector(`.book-card[data-id="${bookId}"] .book-cover`));
        if (at && motionFull()) burstAt(at, "celebrate", 18);
      }, 120);
    }

    // ---------------- 暂存盒：以前画的拿回来用 ----------------
    stashBtn.addEventListener("click", () => {
      drawer = commands.run("stash.drawer", {
        feature: "paint", bookId: bookId || null, ref: ref || undefined, title: P.short + "的图", useLabel: "用这张", modal: true,
        onUse: (row) => {
          const src = row.dataUrl || row.src || row.url || row.image;
          if (!src) { toast("这一条没有图"); return; }
          const d = drawer;
          drawer = null;
          if (d) d.close(true);
          enterCrop({ kind: "stash", key: "s" + (++seq), dataUrl: src, w: row.w, h: row.h, id: row.id, n: 0, state: "done" });
        },
      });
    });

    // ---------------- 草稿：保留 / 丢弃 ----------------
    async function saveDraft() {
      try {
        await db.setKV(dkey, { free: S.free, promptId: S.promptId, ratio: S.ratio, at: Date.now(),
          drafts: doneOf(S.drafts).map((d) => ({ id: d.id, picked: !!d.picked })).filter((d) => d.id),
          finals: doneOf(S.finals).map((f) => ({ id: f.id })).filter((f) => f.id) });
        savedSig = sig();
      } catch (e) { toast("草稿没能保存：" + ((e && e.message) || e)); }
    }
    async function restore(d) {
      S.free = d.free || "";
      S.promptId = d.promptId || null;
      if (P.ratios.includes(d.ratio)) S.ratio = d.ratio;
      const load = async (list, kind) => {
        const out = [];
        for (const x of list || []) {
          let row = null;
          try { row = await db.get("stash", x.id); } catch (_) { row = null; }
          const src = row && (row.dataUrl || row.src || row.url);
          if (src) out.push(item(kind, { id: row.id, dataUrl: src, w: row.w, h: row.h, picked: !!x.picked, size: true }));
        }
        return out;
      };
      S.drafts = await load(d.drafts, "draft");
      S.finals = await load(d.finals, "final");
      S.drafts.forEach((x, i) => { x.n = S.drafts.length - i; });
      S.finals.forEach((x, i) => { x.n = S.finals.length - i; });
    }
    function showAll() {
      freeIn.value = S.free;
      draftGrid.replaceChildren(...S.drafts.map((x) => (x.el = cardEl(x))));
      finalGrid.replaceChildren(...S.finals.map((x) => (x.el = cardEl(x))));
      if (purpose !== "cover") ratioSec.querySelectorAll(".paint-ratio button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === S.ratio)));
      renderEmpty();
      renderPrompt();
      renderGallery();
    }

    function cleanup() {
      const discard = !S.done && !kept && sig() !== savedSig;
      if (S.busy) S.busy.ctrl.abort();
      clearInterval(timer);
      if (crop) crop.destroy();
      if (cropLayer) { const l = cropLayer; cropLayer = null; l.close(true); }
      presets.destroy();
      flushMeta();
      if (drawer) { const d = drawer; drawer = null; d.close(true); }
      if (discard) db.del("kv", dkey).catch(() => {});
      current = null;
      resolve(result);
    }

    // ---------------- 开始 ----------------
    (async () => {
      if (draft && ((draft.drafts || []).length || (draft.finals || []).length || (draft.free || "").trim())) {
        await restore(draft);
        const again = h("button.btn.small.ghost", { type: "button" }, "重新开始");
        again.addEventListener("click", async () => {
          S.free = opts.prompt || "";
          S.promptId = null;
          S.drafts = []; S.finals = [];
          try { await db.del("kv", dkey); } catch (_) { /* 删不掉也不影响 */ }
          draftNote.hidden = true;
          psel.value = "";
          showAll();
          savedSig = sig();
        });
        draftNote.replaceChildren(h("span", {}, `接着上次没做完的（${fmtTime(draft.at || Date.now())}）`), again);
        draftNote.hidden = false;
      } else {
        S.free = opts.prompt != null && String(opts.prompt).trim() ? String(opts.prompt) : lastFree || "";
      }
      await fillPsel();
      await presets.ready;
      showAll();
      savedSig = sig();
      tip("paint", "先出几张便宜的草稿，挑中的再出高清。");
    })();
  });
}

