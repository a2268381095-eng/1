// AI 生成简介：在弹窗里就地勾章节（章节列表多选过的先勾上）→ 选出几版 → 确认卡（模型、提示词、预估花费）→ 生成。
// 每章优先发摘要，没有摘要的发正文开头 1500 字。几版并排，挑一个写进作品简介（可撤销），其余留在暂存盒。
import { bus } from "../../core/bus.js";
import { db } from "../../core/db.js";
import { h, modal, toast } from "../../core/ui.js";
import { label } from "../../core/settings.js";
import { countWords } from "../../core/text.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { runAI } from "../ai/runner.js";
import { introSource, introLabel } from "./logic.js";
import { promptPlan, setIntro, openStash, chapterPicker, countSeg, motionFull } from "./common.js";

let open = null;

export async function introAI(opts = {}) {
  if (!ws.book) { toast("先打开一本书"); return; }
  if (open) { open.focus(); return; }
  tip("chapterai-intro", "勾几章，有摘要的发摘要，没有的发正文开头。可以一次出几版，并排挑。");
  const bookId = ws.book.id;
  const ids = Array.isArray(opts.ids) && opts.ids.length ? opts.ids : ws.selectedIds();
  const n0 = await db.getKV("chapterai:introCount", 2);

  const picker = chapterPicker({ ids, mode: "intro" });
  const seg = countSeg(n0, (n) => { db.setKV("chapterai:introCount", n); refresh(); });
  const info = h("p.cai-info", { "aria-live": "polite" });
  const warn = h("p.cai-warn", { role: "alert", hidden: true });
  const nowText = h("div.cai-now-text");
  const nowSum = h("summary");
  const now = h("details.cai-now", {}, nowSum, nowText);
  const vers = h("div.cai-vers", { "aria-label": "生成的几版", "aria-live": "polite" });
  const result = h("p.cai-result", { role: "status" });
  const body = h("div.cai-intro", {},
    h("p.cai-lead.muted", {}, ids.length ? "先勾上了章节列表里选中的几章，可以再改。" : "勾几章给 AI 看。有摘要的发摘要，没有的发正文开头 1500 字。"),
    picker.el,
    h("div.cai-opts", {}, h("span.cai-opt-l", {}, "出几版"), seg.el),
    info, warn, now, vers, result);

  let running = false, ctrl = null, chosen = null;   // chosen：作者点过「用这个」的那张（几版文字一样时只标它）
  const cards = [];
  const curIntro = () => (ws.book && ws.book.id === bookId ? ws.book.intro : "") || "";
  const markAll = () => {
    const intro = curIntro();
    const hit = chosen && chosen.text === intro ? chosen : cards.find((c) => c.done && c.text && c.text === intro);
    cards.forEach((c) => c.mark(c === hit));
  };
  const showNow = () => {
    const intro = curIntro();
    nowSum.textContent = intro ? `现在的简介（${countWords(intro).toLocaleString()} 字）` : "现在还没有简介";
    nowText.textContent = intro || "生成以后挑一版放进来。";
    markAll();
  };
  const onIntro = (e) => { if (e.detail.bookId === bookId) showNow(); };
  document.addEventListener("cai:intro", onIntro);
  const offDone = bus.on("ai:done", ({ feature }) => {
    if (feature !== "intro" || !running) return;
    const last = cards[cards.length - 1];
    if (last && !last.done) last.done = true;
  });

  const m = modal({
    title: "AI 生成简介", body, wide: true,
    isDirty: () => running,
    onClose: () => {
      open = null;
      document.removeEventListener("cai:intro", onIntro);
      offDone();
      if (running && ctrl) ctrl.abort();
    },
    actions: [
      { label: "生成", primary: true, onClick: () => generate() },
      { label: label("暂存盒"), onClick: () => openStash({ feature: "intro", bookId, title: "简介", modal: true, useLabel: "用作简介", onUse: (row) => { chosen = null; return setIntro(bookId, String(row.text || "").trim()); } }) },
      { label: "关闭", onClick: () => m.close() },
    ],
  });
  m.el.classList.add("cai-modal", "cai-intro-modal");
  const [genBtn] = m.foot.querySelectorAll(".btn");
  open = { focus: () => genBtn.focus() };

  function source() {
    return introSource(picker.picked().map((c) => ({ id: c.id, label: ws.fullTitle(c), summary: c.summary, text: ws.textOf(c.id) })));
  }
  function refresh() {
    if (running) return;
    const src = source();
    const n = seg.get();
    warn.hidden = true;
    info.textContent = !src.used.length ? "还没勾章节。"
      : `发送 ${introLabel(src)}，约 ${src.chars.toLocaleString()} 字` + (n > 1 ? `；出 ${n} 版，花费约 ×${n}` : "") + "。";
    genBtn.disabled = !src.input;
    genBtn.textContent = cards.length ? "再生成" : "生成";
  }
  picker.onChange(refresh);
  showNow();
  refresh();

  function card(no) {
    const textEl = h("div.cai-ver-text");
    const nEl = h("span.cai-ver-n");
    const use = h("button.btn.small.primary.cai-use", { type: "button", disabled: true }, "用这个");
    const el = h("article.cai-ver" + (motionFull() ? ".cai-in" : ""), { "data-state": "live", style: { "--i": String((no - 1) % 4) } },
      h("header.cai-ver-head", {}, h("span.cai-ver-no", {}, `第 ${no} 版`), nEl), textEl, h("footer.cai-ver-foot", {}, use));
    const c = {
      el, done: false, text: "",
      set(t) { c.text = t; textEl.textContent = t; nEl.textContent = `${countWords(t).toLocaleString()} 字`; },
      final(t) { c.set(t.trim()); c.done = true; el.dataset.state = "ready"; use.disabled = false; },
      mark(on) {
        if (el.dataset.state === "live") return;
        el.dataset.state = on ? "chosen" : "ready";
        use.textContent = on ? "已用作简介" : "用这个";
        use.setAttribute("aria-pressed", String(on));
      },
    };
    use.addEventListener("click", async () => {
      if (el.dataset.state === "chosen") return;
      const prev = chosen;
      chosen = c;
      if (!(await setIntro(bookId, c.text))) chosen = prev;
      markAll();
    });
    vers.append(el);
    cards.push(c);
    return c;
  }

  async function generate() {
    if (running) return;
    const src = source();
    if (!src.input) {
      warn.hidden = false;
      warn.textContent = src.used.length ? "勾的几章都还没写正文，也没有摘要，没东西可发。" : "先勾几章。";
      return;
    }
    const pp = await promptPlan("intro");
    if (!pp || !m.el.isConnected) return;
    const n = seg.get();
    running = true;
    ctrl = new AbortController();
    picker.disable(true);
    genBtn.disabled = true;
    result.textContent = "";
    const stopBtn = h("button.btn.cai-stop", { type: "button" }, "停下");
    stopBtn.addEventListener("click", () => ctrl.abort());
    const start = cards.length;
    const book = ws.book;
    let r = null;
    try {
      r = await runAI({
        feature: "intro", bookId, input: src.input, inputLabel: introLabel(src),
        vars: { ...ws.varsFor(), 书名: book.title, 简介: book.intro || "" },
        count: n, maxTokens: 800, promptId: pp.promptId, temp: pp.temp, title: `《${book.title}》简介`, signal: ctrl.signal,
        onDelta: (piece, all) => {
          if (!m.el.isConnected) return;
          if (!stopBtn.isConnected) m.foot.prepend(stopBtn);
          let cur = cards[cards.length - 1];
          if (!cur || cur.done || cards.length === start) { cur = card(cards.length + 1); cur.el.scrollIntoView({ block: "nearest" }); }
          cur.set(all);
        },
      });
    } finally {
      running = false;
      stopBtn.remove();
    }
    if (!m.el.isConnected) return;
    picker.disable(false);
    const got = r ? r.results : [];
    // 新生成的几张：有结果的换成最终文字，没出完的（停下了）去掉
    const fresh = cards.splice(start);
    fresh.forEach((c, i) => { if (got[i]) { c.final(got[i].text); cards.push(c); } else c.el.remove(); });
    got.slice(fresh.length).forEach((g) => card(cards.length + 1).final(g.text));
    markAll();
    refresh();
    if (!got.length) { result.textContent = ctrl.signal.aborted ? "停下了，这次没出完整的一版。" : ""; return; }
    result.textContent = (got.length < n ? `出了 ${got.length} 版（停下了）。` : `出了 ${got.length} 版。`) + "挑一版点「用这个」写进简介，其余的留在" + label("暂存盒") + "里。";
    const first = vers.querySelector(`.cai-ver:nth-child(${start + 1}) .cai-use`);
    if (first) first.focus();
    bus.emit("chapterai:done", { kind: "intro", count: got.length });
  }
}
