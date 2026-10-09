// 画图的统一入口：确认卡 → 几张一起画（画好一张显示一张）→ 记账 → 进暂存盒；出错给中文说明（和文字的 runAI 用同一张报错卡）。
// 确认卡显示：绘画模型（按用过的次数排，默认上一次的）、尺寸、张数、画质、每张多少钱和总价、实际发送的提示词。
// 没确认不发送；勾了「这个组合本次打开软件期间不再询问」的，同一个组合下次直接画。
import { getConfig, saveConfig, paintProviders, providerOf, image, recordImage, imageCaps, pickSize, imageUnitPrice, aiError } from "../../core/ai.js";
import { addStash, FEATURES } from "../../core/stash.js";
import { notePromptUse } from "../../core/prompts.js";
import { db } from "../../core/db.js";
import { bus } from "../../core/bus.js";
import { h, modal, toast } from "../../core/ui.js";
import { explain } from "./runner.js";
import { renderSetup } from "./setup.js";

const skipThisSession = new Set();
const modelKey = (pid, model) => pid + "\u0001" + model;
const stepOf = (o) => (o.step === "final" ? "final" : "draft");
const comboKey = (o, c) => [o.feature, o.purpose || "", stepOf(o), c.providerId, c.model, c.size, c.quality || "",
  stepOf(o) === "draft" ? c.count || 1 : "n", c.useRef ? 1 : 0].join("|");
const money = (v) => String(Number(Number(v).toFixed(4)));

/**
 * opts:
 *   feature, bookId, ref   暂存盒分类：功能、属于哪本书、哪张卡（封面就是书的 id）
 *   purpose               用途（cover / character / place / item），记常用组合用
 *   step                  "draft" 草稿 | "final" 高清
 *   prompt                最终发送的提示词；promptFor(choice) 给了就按确认卡上的选择重新拼（比如勾掉「照草稿画」）
 *   promptId, promptName  用的是库里的哪条提示词（临时写的不给）
 *   missing               没有值的变量名（确认卡上标出来）
 *   ratio                 想要的比例，比如 "3:4"（尺寸默认挑最接近的）
 *   count                 草稿默认几张（1–4）
 *   refImages             出高清时挑中的草稿（dataUrl），各出一张
 *   title, label          暂存盒里的标题、确认卡标题上的说明
 *   signal                AbortSignal
 *   onStart(n, choice)、onImage(i, item)、onFail(i, error)   一张张的进度
 *   reuse                 上一次的选择，给了就不弹确认卡
 * 返回 { images: [{ dataUrl, w, h, stash }], choice }；取消、失败返回 null
 */
export async function runImage(opts) {
  if (!(await paintProviders()).length) {
    const id = await paintSetupModal();
    if (!id) return null;
  }
  let choice = opts.reuse || await imageCard(opts);
  while (choice) {
    const r = await sendImages(opts, choice);
    if (r && r.retry) { choice = r.retry === "card" ? await imageCard(opts, choice) : choice; continue; }
    return r ? { ...r, choice } : null;
  }
  return null;
}

/** 还没有能画图的接口：就地弹出接入流程，在「绘画」里选接口、加模型后接着画 */
export function paintSetupModal() {
  return new Promise((resolve) => {
    let done = null;
    const body = h("div.ai-setup-modal");
    const m = modal({
      title: "先接一个能画图的接口",
      body: h("div", {}, h("p.modal-text", {}, "选一家，粘贴 Key，在下面的「绘画」里选接口、加一个绘画模型。接好后接着画。"), body),
      wide: true,
      onClose: () => resolve(done),
    });
    renderSetup(body, { onPaintReady: (id) => { done = id; setTimeout(() => m.close(true), 700); } });
  });
}

// ---------------- 常用组合 ----------------
const recentKey = (o) => `ai:imgRecent:${o.feature}:${stepOf(o)}`;
async function noteRecent(o, c) {
  const k = recentKey(o);
  const list = await db.getKV(k, []);
  const same = (x) => x.providerId === c.providerId && x.model === c.model && x.size === c.size && (x.quality || "") === (c.quality || "")
    && (stepOf(o) === "final" || (x.count || 1) === (c.count || 1));
  const old = list.find(same);
  const row = { providerId: c.providerId, model: c.model, size: c.size, quality: c.quality || "", count: c.count || 1, useRef: !!c.useRef,
    n: old ? (old.n || 1) + 1 : 1, at: Date.now() };
  const keep = [row, ...list.filter((x) => x !== old)].sort((a, b) => (b.n || 1) - (a.n || 1) || (b.at || 0) - (a.at || 0)).slice(0, 8);
  await db.setKV(k, keep);
  await db.setKV("ai:imgLast", { providerId: c.providerId, model: c.model });
  const uses = await db.getKV("ai:imgModelUses", {});
  uses[modelKey(c.providerId, c.model)] = (uses[modelKey(c.providerId, c.model)] || 0) + 1;
  await db.setKV("ai:imgModelUses", uses);
}

function sizeLabel(s, best, ratio) {
  if (s.ratio) return `${s.w === s.h ? "方形" : s.w < s.h ? "竖版" : "横版"} ${s.id}` + (best ? `（最接近 ${ratio}）` : "");
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(s.w, s.h);
  const r = `${s.w / d}:${s.h / d}`;
  const nice = r.length <= 5 ? r + " · " : "";
  return `${s.w === s.h ? "方形" : s.w < s.h ? "竖版" : "横版"} ${nice}${s.w}×${s.h}` + (best ? `（最接近 ${ratio}）` : "");
}

/** 一排胶囊按钮选一个：el.value 读，el.set(v) 改 */
function seg(items, value, label, onPick) {
  const el = h("div.ai-img-seg", { role: "group", "aria-label": label });
  let cur = value;
  const btns = items.map(([v, t]) => {
    const b = h("button", { type: "button", "aria-pressed": "false", "data-v": String(v) }, t);
    b.addEventListener("click", () => { set(v); onPick && onPick(v); });
    return b;
  });
  el.append(...btns);
  function set(v) {
    cur = v;
    btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === String(v))));
  }
  set(value);
  Object.defineProperty(el, "value", { get: () => cur });
  el.set = set;
  return el;
}

// ---------------- 确认卡 ----------------
async function imageCard(o, prev = null) {
  const step = stepOf(o);
  const cfg = await getConfig();
  const ready = await paintProviders();
  if (!ready.length) return null;
  const modelsOf = (pid) => (((cfg.providers[pid] || {}).image || {}).models || []);
  const usable = (c) => c && ready.some((p) => p.id === c.providerId) && modelsOf(c.providerId).includes(c.model);
  const recent = (await db.getKV(recentKey(o), [])).filter(usable);
  const last = recent.reduce((a, b) => ((b.at || 0) > ((a && a.at) || 0) ? b : a), null);
  const fixedN = Math.max(1, (o.refImages || []).length);
  if (!prev && last && skipThisSession.has(comboKey(o, last))) {
    return { ...last, count: step === "final" ? fixedN : last.count || 1, useRef: step === "final" ? last.useRef !== false : false, promptId: o.promptId || null };
  }
  const uses = await db.getKV("ai:imgModelUses", {});
  const gl = await db.getKV("ai:imgLast", null);
  const start = prev || last || (usable(gl) ? gl : null) || { providerId: ready[0].id, model: modelsOf(ready[0].id)[0] };

  return new Promise((resolve) => {
    let result = null;
    // 模型：用得多的那家排前面，每家里用得多的模型排前面
    const modelSel = h("select.select", { "aria-label": "绘画模型" });
    ready.map((p) => {
      const models = modelsOf(p.id).map((id, i) => ({ id, i, n: uses[modelKey(p.id, id)] || 0 })).sort((a, b) => b.n - a.n || a.i - b.i);
      return { p, models, n: models.reduce((t, m) => t + m.n, 0) };
    }).sort((a, b) => b.n - a.n).forEach(({ p, models }) => {
      const g = h("optgroup", { label: p.custom ? (cfg.providers[p.id] || {}).name || "自定义接口" : p.name });
      models.forEach((m) => g.append(h("option", { value: modelKey(p.id, m.id), selected: p.id === start.providerId && m.id === start.model }, m.id + (m.n ? `　· 用过 ${m.n} 次` : ""))));
      modelSel.append(g);
    });

    const sizeSel = h("select.select", { "aria-label": "尺寸" });
    const sizeIn = h("input.input.ai-img-size-in", { placeholder: "宽x高，比如 768x1024", "aria-label": "自己填尺寸", hidden: true });
    const sizeNote = h("p.ai-img-note");
    const countSeg = step === "draft" ? seg([1, 2, 3, 4].map((n) => [n, `${n} 张`]), Math.max(1, Math.min(4, (prev && prev.count) || start.count || o.count || 4)), "张数", () => refresh()) : null;
    const qualBox = h("div.ai-img-qual");
    const qualNote = h("p.ai-img-note");
    let qualSeg = null;
    const refChk = step === "final" ? h("input", { type: "checkbox", checked: prev ? !!prev.useRef : start.useRef !== false }) : null;
    const preview = h("pre.ai-preview.ai-img-prompt");
    const pinfo = h("div.row.ai-img-pinfo");
    const est = h("p.ai-est.ai-img-est");
    const priceBox = h("div.row.ai-price", { hidden: true });
    const skip = h("input", { type: "checkbox" });
    let caps = null;

    // 换了模型：尺寸、画质跟着这个模型能用的来
    function fillCaps(keepSize, keepQ) {
      const [pid, model] = modelSel.value.split("\u0001");
      caps = imageCaps(pid, model, ((cfg.providers[pid] || {}).image || {}).api);
      const best = pickSize(caps, o.ratio || "3:4", step);
      sizeSel.replaceChildren(...caps.sizes.map((s) => h("option", { value: s.id }, sizeLabel(s, s.id === best && !caps.draftSize, o.ratio || "3:4"))),
        ...(caps.free ? [h("option", { value: "__free" }, "自己填……")] : []));
      const free = caps.free && /^\d{2,5}x\d{2,5}$/.test(keepSize || "") && !caps.sizes.some((s) => s.id === keepSize);
      sizeSel.value = caps.sizes.some((s) => s.id === keepSize) ? keepSize : free ? "__free" : best;
      if (free) sizeIn.value = keepSize;
      sizeIn.hidden = sizeSel.value !== "__free";
      qualSeg = null;
      if (caps.quality) {
        const q = caps.quality.list.some(([v]) => v === keepQ) ? keepQ : caps.quality[step];
        qualSeg = seg(caps.quality.list.map(([v, t]) => [v, t + (v === caps.quality.draft ? "（草稿）" : v === caps.quality.final ? "（高清）" : "")]), q, "画质", () => refresh());
        qualBox.replaceChildren(qualSeg);
        qualNote.textContent = "";
      } else {
        qualBox.replaceChildren();
        qualNote.textContent = caps.draftSize ? `这个模型不分画质：草稿用 ${caps.draftSize.replace("x", "×")} 的小图，高清用 ${caps.finalSize.replace("x", "×")}。`
          : "这个模型不分画质，草稿和高清一个价；出高清时照着草稿重画细节。";
      }
    }

    const current = () => {
      const [providerId, model] = modelSel.value.split("\u0001");
      const size = sizeSel.value === "__free" ? sizeIn.value.trim().toLowerCase().replace(/[×*＊]/g, "x").replace(/\s+/g, "") : sizeSel.value;
      return { providerId, model, size, quality: qualSeg ? qualSeg.value : "", count: step === "final" ? fixedN : countSeg.value,
        useRef: step === "final" ? !!(refChk && refChk.checked) : false, promptId: o.promptId || null };
    };

    let sendBtn = h("button");
    async function refresh() {
      const c = current();
      const text = o.promptFor ? o.promptFor(c) : o.prompt || "";
      preview.textContent = text;
      pinfo.replaceChildren(
        h("span.ai-img-src", {}, o.promptName ? `用提示词库里的「${o.promptName}」` : "临时写的"),
        h("span.muted", {}, `${[...text].length.toLocaleString()} 字`),
        ...(o.missing || []).map((m) => h("span.chip.warn", { title: "这个变量现在没有值，会原样发出去" }, `{${m}} 没有值`)));
      sizeNote.textContent = sizeSel.value === "__free" ? "宽、高按这个模型接受的写，比如 768x1024。" : caps && caps.sizes.some((s) => s.ratio) ? "按比例出图，出来后再裁。" : "出来后再拖框裁剪。";
      const cfgNow = await getConfig();
      const price = (cfgNow.prices || {})[c.providerId + "/" + c.model];
      const unit = imageUnitPrice(price, step);
      const cur = price && price.cur === "CNY" ? "元" : "美元";
      const what = `${step === "final" ? "出高清" : "出草稿"} ${c.count} 张`;
      est.replaceChildren(h("span", {}, what),
        unit != null ? h("span.ai-img-cost", {}, `每张约 ${money(unit)} ${cur}，${c.count} 张约 ${money(unit * c.count)} ${cur}`) : h("span.muted", {}, "还没填单价"),
        h("button.btn.small.ghost.ai-img-price-btn", { type: "button", onclick: () => { priceBox.hidden = !priceBox.hidden; } }, unit != null ? "改单价" : "填一下单价"));
      renderPrice(c, price);
      const badSize = sizeSel.value === "__free" && !/^\d{2,5}x\d{2,5}$/.test(c.size);
      sizeIn.classList.toggle("bad", badSize);
      sendBtn.disabled = !c.model || !text.trim() || badSize;
    }

    function renderPrice(c, price) {
      const num = (v, label) => h("input.input", { type: "number", step: "0.001", min: "0", value: v == null ? "" : v, placeholder: label, "aria-label": label });
      const lo = num(price && price.perImage, "草稿每张"), hd = num(price && price.perImageHd, "高清每张");
      const cur = h("select.select", { "aria-label": "币种" }, ...["USD", "CNY"].map((x) => h("option", { value: x, selected: (price && price.cur) === x }, x === "USD" ? "美元" : "人民币")));
      const save = h("button.btn.small", { type: "button" }, "保存单价");
      save.addEventListener("click", async () => {
        const all = await getConfig();
        all.prices = all.prices || {};
        const k = c.providerId + "/" + c.model;
        const v = (x) => (x.value.trim() === "" ? null : Math.max(0, parseFloat(x.value) || 0));
        all.prices[k] = { ...(all.prices[k] || {}), perImage: v(lo), perImageHd: v(hd), cur: cur.value };
        await saveConfig(all);
        priceBox.hidden = true;
        refresh();
      });
      priceBox.replaceChildren(h("span.muted", {}, c.model + " 每张："), lo, hd, cur, save,
        h("span.muted.ai-img-price-hint", {}, "高清空着就按草稿的价算"));
    }

    // 常用组合：按用过的次数排，上一次用的标出来
    const recentRow = h("div.row.ai-recent");
    recent.slice(0, 6).forEach((r) => {
      const b = h("button.chip.ai-recent-chip" + (r === last ? ".last" : ""), { type: "button", title: r === last ? "上一次用的" : "" },
        `${r.model} · ${String(r.size).replace("x", "×")}${r.quality ? " · " + r.quality : ""}${step === "draft" ? ` · ${r.count || 1} 张` : ""}`,
        h("span.ai-recent-n", {}, `${r.n || 1} 次`));
      b.addEventListener("click", () => {
        modelSel.value = modelKey(r.providerId, r.model);
        fillCaps(r.size, r.quality);
        if (countSeg) countSeg.set(r.count || 1);
        if (refChk) refChk.checked = r.useRef !== false;
        refresh();
      });
      recentRow.append(b);
    });

    modelSel.addEventListener("change", () => { fillCaps(sizeSel.value === "__free" ? sizeIn.value.trim() : sizeSel.value, qualSeg && qualSeg.value); refresh(); });
    sizeSel.addEventListener("change", () => { sizeIn.hidden = sizeSel.value !== "__free"; if (!sizeIn.hidden) sizeIn.focus(); refresh(); });
    sizeIn.addEventListener("input", refresh);
    if (refChk) refChk.addEventListener("change", refresh);

    const purposeName = o.label || (step === "final" ? "高清" : "草稿");
    const body = h("div.ai-card.ai-img-card", { "data-step": step },
      recent.length ? h("div.field", {}, h("span", {}, "常用组合"), recentRow) : null,
      h("label.field", {}, h("span", {}, "绘画模型"), modelSel),
      h("div.ai-img-grid", {},
        h("div.field", {}, h("span", {}, "尺寸"), sizeSel, sizeIn, sizeNote),
        h("div.field", {}, h("span", {}, "张数"), countSeg || h("p.ai-img-fixed", {}, `挑中的 ${fixedN} 张，各出一张高清`))),
      h("div.field", {}, h("span", {}, "画质"), qualBox, qualNote),
      refChk ? h("label.check.ai-img-ref", {}, refChk, "照挑中的草稿画（带上草稿图，构图不变）") : null,
      h("div.field", {}, h("span", {}, "提示词"), pinfo),
      h("details.ai-full", { open: true }, h("summary", {}, "实际发送的提示词"), preview),
      est, priceBox,
      h("label.check", {}, skip, "这个组合本次打开软件期间不再询问"));
    const m = modal({
      title: "确认调用 · " + (FEATURES[o.feature] || "绘画") + " · " + purposeName,
      body, wide: false,
      onClose: () => resolve(result),
      actions: [
        { label: "发送", primary: true, onClick: async () => {
          await refresh();
          if (sendBtn.disabled) return;
          const c = current();
          if (skip.checked) skipThisSession.add(comboKey(o, c));
          result = c;
          m.close(true);
        } },
        { label: "取消", onClick: () => m.close(true) },
      ],
    });
    m.el.classList.add("ai-img-modal");
    sendBtn = m.foot.querySelector(".btn.primary");
    fillCaps(start.size, start.quality);
    refresh();
  });
}

// ---------------- 发送：几张一起画 ----------------
/** 存进暂存盒前压一压：PNG 换成 JPEG（插画看不出差别，小很多） */
export function compactImage(dataUrl, quality = 0.92) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const w = im.naturalWidth, hh = im.naturalHeight;
      if (/^data:image\/jpeg/.test(dataUrl)) { resolve({ dataUrl, w, h: hh }); return; }
      try {
        const c = document.createElement("canvas");
        c.width = w; c.height = hh;
        const g = c.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, w, hh);
        g.drawImage(im, 0, 0);
        resolve({ dataUrl: c.toDataURL("image/jpeg", quality), w, h: hh });
      } catch (_) { resolve({ dataUrl, w, h: hh }); }
    };
    im.onerror = () => resolve({ dataUrl, w: 0, h: 0 });
    im.src = dataUrl;
  });
}

async function sendImages(o, c) {
  const step = stepOf(o);
  const cfg = await getConfig();
  const conf = cfg.providers[c.providerId];
  const n = step === "final" ? Math.max(1, (o.refImages || []).length) : Math.max(1, Math.min(4, c.count || 1));
  const refs = step === "final" && c.useRef ? o.refImages || [] : [];
  const prompt = o.promptFor ? o.promptFor(c) : o.prompt || "";
  bus.emit("ai:start", { feature: o.feature });
  o.onStart && o.onStart(n, c);
  const got = new Array(n).fill(null);
  const errs = [];
  const notes = new Set();
  await Promise.all([...Array(n)].map(async (_, i) => {
    try {
      const list = await image({ providerId: c.providerId, conf, model: c.model, prompt, size: c.size, quality: c.quality || null, refImage: refs[i] || null, signal: o.signal });
      (list.adjusted || []).forEach((x) => notes.add(x));
      if (!list[0]) throw aiError("content", { what: "接口没有返回图片。" });
      const img = await compactImage(list[0].dataUrl);
      const stash = await addStash({
        kind: "image", bookId: o.bookId || null, feature: o.feature, ref: o.ref || null,
        title: `${o.title || "图片"} ${i + 1}`, text: "", dataUrl: img.dataUrl, w: img.w, h: img.h,
        prompt: prompt.slice(0, 4000), promptId: o.promptId || null, providerId: c.providerId, model: c.model,
        purpose: o.purpose || null, step, size: c.size, quality: c.quality || "",
      });
      got[i] = { ...img, stash };
      o.onImage && o.onImage(i, got[i]);
    } catch (e) {
      const err = e && e.ai ? e : aiError("request", { what: "这张没画出来。", detail: String(e && (e.stack || e.message || e)) });
      errs.push(err);
      o.onFail && o.onFail(i, err);
    }
  }));
  const ok = got.filter(Boolean);
  if (ok.length) {
    await noteRecent(o, c);
    await recordImage({ providerId: c.providerId, model: c.model, feature: o.feature, bookId: o.bookId, count: ok.length, step });
    if (o.promptId) notePromptUse(o.promptId);
  }
  if (notes.size) toast([...notes].join("；"));
  const real = errs.filter((e) => e.category !== "cancel");
  if (!ok.length) {
    if (!real.length) { bus.emit("ai:cancel", {}); return null; }
    bus.emit("ai:error", { feature: o.feature, error: real[0] });
    return explain(real[0], { ...o, input: "" }, c);
  }
  bus.emit("ai:done", { feature: o.feature, text: "" });
  if (real.length) toast(`${n} 张里有 ${real.length} 张没画出来：${real[0].what || "出错了"}`);
  return { images: ok };
}

export { providerOf };
