// 对话界面：消息列表、输入框、常驻的「继续追问」「新开对话」、实时的上下文长度、流式回复和停止、
// 顶上的模型小牌子（模型、创意度、思考程度，记住上一次，发送时作为确认卡的预选）、
// 回复的复制 / 插入正文 / 从这里分叉，对话列表（切换、改标题、删除带撤销），本功能的暂存盒就地打开。
// 在作品里放右侧栏（ws.openPanel wide），不在作品里用弹窗。同一时间只开一个。
import { runAI } from "../ai/runner.js";
import { levelPicker } from "../ai/levels.js";
import { ws } from "../editor/workspace.js";
import { tip } from "../demon/demon.js";
import { bus } from "../../core/bus.js";
import { getConfig, readyProviders, CREATIVITY, THINKING } from "../../core/ai.js";
import { listPrompts } from "../../core/prompts.js";
import { commands } from "../../core/commands.js";
import { undo as appUndo } from "../../core/undo.js";
import { label } from "../../core/settings.js";
import { fmtTime } from "../../core/text.js";
import { h, icon, modal, prompt, pushLayer, toast } from "../../core/ui.js";
import { historyOf, ctxTokens, ctxFill, CTX_BIG, titleFrom, extraSent, forkMessages, forkTitle } from "./logic.js";
import { blankChat, listChats, getChat, putChat, dropChat, lastChatId, setLastChat, getDraft, setDraft, getPrefer, setPrefer, modelUses, failed, pushUndo, runUndo } from "./data.js";

let inst = null;   // 开着的对话界面
export const currentChat = () => (inst && !inst.closed ? inst : null);

const motionFull = () => document.documentElement.dataset.motion === "full";
const later = (ms) => new Promise((r) => setTimeout(r, ms));
/** 显示时去掉开头的空行和结尾的空白（段首的全角空格留着）；复制、插入用原文 */
const shown = (t) => String(t || "").replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");

// 核心图标里没有的几个
const PATHS = {
  chat: "M4 5h16v11H10l-5 4v-4H4z",
  stop: "M7 7h10v10H7z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  fork: "M7 4v16M17 4v3a5 5 0 0 1-5 5H7",
  pen: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  insert: "M12 4v10M8 10l4 4 4-4M5 20h14",
};
export function ico(name) {
  if (!PATHS[name]) return icon(name);
  const s = icon("close");
  s.querySelector("path").setAttribute("d", PATHS[name]);
  return s;
}

/** 复制到剪贴板（拿不到剪贴板权限时退回老办法） */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* 退回老办法 */ }
  const ta = h("textarea", { style: { position: "fixed", left: "-9999px", top: "0" } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}

/** 撤销、重做之后让开着的界面跟上 */
async function afterChange(info) { const c = currentChat(); if (c) await c.sync(info); }

/**
 * 打开对话。opts: { bookId, ref, history, title, fresh }
 *   history  带着它新建一个对话（从暂存盒、对比面板「继续追问」过来）
 *   fresh    开一个新的空对话（「和 AI 聊聊」）
 *   都没有   接着上次看的那个对话
 */
export async function openChat(opts = {}) {
  const bookId = opts.bookId !== undefined ? opts.bookId || null : (ws.book ? ws.book.id : null);
  const c = currentChat();
  if (c && c.bookId === bookId) { await c.handle(opts, false); return c; }
  if (c) await c.close(true);
  inst = createChat({ bookId, ref: opts.ref || null });
  await inst.handle(opts, true);
  return inst;
}

function createChat({ bookId, ref }) {
  const st = { chat: blankChat({ bookId, ref }), saved: false, list: [], running: null, lastChoice: null, listLayer: null, pickLayer: null, drawer: null, kept: false, prefer: null };
  const canInsert = () => !!(ws.book && ws.book.id === bookId && ws.editor && ws.current);

  // ---------------- 界面 ----------------
  const listBtn = h("button.chat-list-btn", { type: "button", "aria-expanded": "false", title: "这本书的所有对话" }, ico("list"), h("span.chat-list-n", {}, "对话"));
  const titleBtn = h("button.chat-title", { type: "button", title: "改标题" }, h("span.chat-title-t", {}, "新对话"), ico("pen"));
  const stashBtn = h("button.btn.small.ghost.chat-stash", { type: "button", title: "对话生成的结果" }, icon("box"), h("span.chat-stash-t", {}, label("暂存盒")));
  const pickM = h("span.chat-pick-m"), pickLv = h("span.chat-pick-lv");
  const pickBtn = h("button.chat-pick", { type: "button", "aria-expanded": "false" }, pickM, pickLv);
  const pickPop = h("div.chat-pickpop", { hidden: true, role: "dialog", "aria-label": "对话用的模型" });
  const bar = h("div.chat-bar", {}, listBtn, titleBtn, pickBtn, stashBtn);
  const msgs = h("div.chat-msgs", { role: "log", "aria-live": "polite", "aria-label": "对话内容" });
  const listPop = h("div.chat-list", { hidden: true, role: "dialog", "aria-label": "对话列表" });

  const ctxN = h("span.chat-ctx-n");
  const ctxK = h("span.chat-ctx-k");
  const gauge = h("span.chat-gauge", { "aria-hidden": "true" }, h("i"));
  const ctx = h("div.chat-ctx", { title: "按字数粗略估算：前面的对话加上输入框里的字。「继续追问」会把这些一起发出去，「新开对话」从零开始。" }, ctxN, gauge, ctxK);
  const input = h("textarea.textarea.chat-in", { rows: "3", placeholder: "想问什么？Enter 换行，Ctrl+Enter 发送", "aria-label": "这次说的话" });
  const askBtn = h("button.btn.primary.chat-ask", { type: "button", title: "带上前面的对话一起发（Ctrl+Enter）" }, h("span.chat-ask-t", {}, "继续追问"));
  const newBtn = h("button.btn.chat-new", { type: "button", title: "清空上下文，开一个新对话" }, icon("plus"), "新开对话");
  const stopBtn = h("button.btn.chat-stop", { type: "button", hidden: true, title: "停在这里，已经回来的字留着" }, ico("stop"), "停止");
  const reuseIn = h("input", { type: "checkbox" });
  const reuseT = h("span");
  const reuseLbl = h("label.check.chat-reuse", { hidden: true, title: "勾上以后，在这个面板里接着问就不再弹确认卡：用顶上选的模型和档位、上一次的提示词直接发送" }, reuseIn, reuseT);
  const foot = h("div.chat-foot", {}, ctx, input, h("div.chat-acts", {}, askBtn, newBtn, stopBtn, h("span.spacer"), reuseLbl));
  const root = h("div.chat", {}, bar, msgs, listPop, pickPop, foot);

  const self = { bookId, closed: false, root, handle, sync, focus: () => input.focus(),
    close: (force) => { if (force) st.forced = true; return box.close(force); } };

  let box;
  const isDirty = () => !!input.value.trim();
  const onKeepDraft = async () => { st.kept = true; await setDraft(bookId, input.value); };
  if (ws.book && ws.book.id === bookId && ws.els()) {
    self.mode = "panel";
    box = ws.openPanel({ title: "AI 对话", wide: true, isDirty, onKeepDraft, onClose: (forced) => cleanup(forced),
      render: (body) => { body.classList.add("chat-body"); body.append(root); } });
    const v = document.querySelector(".ws");
    if (v) v.classList.add("has-chat");
  } else {
    self.mode = "modal";
    box = modal({ title: "AI 对话", body: root, wide: true, isDirty, onKeepDraft, onClose: () => cleanup(false) });
    box.el.classList.add("chat-modal");
  }
  root.dataset.mode = self.mode;
  document.body.classList.add("chat-open");

  // ---------------- 状态 ----------------
  function setBusy(on) {
    askBtn.disabled = on; newBtn.disabled = on;
    stopBtn.hidden = !on; stopBtn.disabled = false;
    root.classList.toggle("busy", on);
  }
  const busyGuard = () => { if (!st.running) return false; toast("正在回复。先点「停止」，或者等它说完"); return true; };

  function updateCtx() {
    const run = st.running;
    const n = ctxTokens(st.chat.messages, input.value + (run ? run.input : ""), run ? run.text : "");
    ctxN.textContent = `上下文约 ${n.toLocaleString()} token`;
    const k = st.chat.messages.length + (run ? 1 : 0);
    ctxK.textContent = k ? `${k} 条` : "空的";
    gauge.style.setProperty("--fill", ctxFill(n).toFixed(1) + "%");
    root.classList.toggle("ctx-big", n >= CTX_BIG);
  }

  function renderBar() {
    titleBtn.querySelector(".chat-title-t").textContent = st.chat.title || "新对话";
    listBtn.querySelector(".chat-list-n").textContent = st.list.length ? `对话 ${st.list.length}` : "对话";
    askBtn.querySelector(".chat-ask-t").textContent = st.chat.messages.length ? "继续追问" : "发送";
  }

  function renderReuse() {
    reuseLbl.hidden = !st.lastChoice;
    if (st.lastChoice) reuseT.textContent = `沿用 ${(st.prefer && st.prefer.model) || st.lastChoice.model}，接着问不再确认`;
  }

  // ---------------- 模型小牌子 ----------------
  function renderPick() {
    const p = st.prefer;
    pickM.textContent = p && p.model ? p.model : "选模型";
    const lv = [];
    if (p && p.creativity) lv.push(CREATIVITY[p.creativity].name);
    if (p && p.thinking) lv.push(THINKING[p.thinking].name);
    pickLv.textContent = lv.join(" · ");
    pickLv.hidden = !lv.length;
    pickBtn.title = p && p.model
      ? `${p.model}，创意度「${CREATIVITY[p.creativity || 0].name}」，思考程度「${THINKING[p.thinking || 0].name}」。点这里换，发送前的确认卡里也能改`
      : "选对话用的模型。发送前的确认卡里也能改";
    pickBtn.setAttribute("aria-label", "对话用的模型：" + pickBtn.title);
    renderReuse();
  }

  async function openPick() {
    if (st.pickLayer) { st.pickLayer.close(); return; }
    closeList();
    let cfg, ready, uses;
    try { [cfg, ready, uses] = await Promise.all([getConfig(), readyProviders(), modelUses()]); }
    catch (e) { failed("模型列表读不出来。", e, openPick); return; }
    if (self.closed || st.pickLayer) return;
    st.pickLayer = pushLayer({ onClose: () => { st.pickLayer = null; pickPop.hidden = true; pickBtn.setAttribute("aria-expanded", "false"); } });
    pickBtn.setAttribute("aria-expanded", "true");
    const p = st.prefer || {};
    const done = h("button.btn.small.chat-pick-ok", { type: "button" }, "好");
    done.addEventListener("click", () => closePick());
    const parts = [h("div.chat-pick-h", {}, h("span.grow", {}, "对话用的模型"), done)];
    if (!ready.length) parts.push(h("p.chat-pick-note", {}, "还没接入 AI。第一次发送时会先带你接好，不用离开这里。"));
    else {
      // 用得多的那家排前面，每家里用得多的模型排前面（和确认卡一样）
      const key = (pid, m) => pid + "\u0001" + m;
      const sel = h("select.select.chat-pick-sel", { "aria-label": "模型" });
      ready.map((pv) => {
        const c = cfg.providers[pv.id];
        const models = (c.models || []).map((m) => (typeof m === "string" ? m : m.id)).map((id, i) => ({ id, i, n: uses[key(pv.id, id)] || 0 })).sort((a, b) => b.n - a.n || a.i - b.i);
        return { pv, c, models, n: models.reduce((t, m) => t + m.n, 0) };
      }).sort((a, b) => b.n - a.n).forEach(({ pv, c, models }) => {
        const g = h("optgroup", { label: pv.custom ? c.name || "自定义接口" : pv.name });
        models.forEach((m) => g.append(h("option", { value: key(pv.id, m.id), selected: pv.id === p.providerId && m.id === p.model }, m.id + (m.n ? `　· 用过 ${m.n} 次` : ""))));
        sel.append(g);
      });
      const creat = levelPicker({ kind: "creativity", value: p.creativity || 0, onChange: () => save() });
      const think = levelPicker({ kind: "thinking", value: p.thinking || 0, onChange: () => save() });
      const save = () => {
        const [providerId, model] = sel.value.split("\u0001");
        st.prefer = { ...(st.prefer || {}), providerId, model, creativity: creat.value, thinking: think.value };
        setPrefer(st.prefer).catch(() => {});
        renderPick();
      };
      sel.addEventListener("change", save);
      parts.push(h("label.field", {}, h("span", {}, "模型"), sel), h("div.ai-lvs", {}, creat, think),
        h("p.chat-pick-note", {}, "每次发送前的确认卡里还能改，改了也会记在这里。"));
    }
    pickPop.replaceChildren(...parts);
    pickPop.hidden = false;
    const f = pickPop.querySelector("select, .ai-lv-b.cur") || done;
    f.focus();
  }
  const closePick = () => { if (st.pickLayer) st.pickLayer.close(true); };

  /** 发送时给确认卡的预选：模型和档位、上次的提示词（第一次或上次是临时写的：直接打开「临时写一个」） */
  async function presets(history) {
    const pf = st.prefer;
    const [ready, prompts] = await Promise.all([readyProviders().catch(() => []), listPrompts().catch(() => [])]);
    const ok = !!(pf && pf.model && ready.some((x) => x.id === pf.providerId));
    const prefer = ok ? { providerId: pf.providerId, model: pf.model, creativity: pf.creativity || 0, thinking: pf.thinking || 0 } : undefined;
    const out = { prefer };
    if (pf && pf.promptId && prompts.some((x) => x.id === pf.promptId)) out.promptId = pf.promptId; else out.temp = true;
    if (reuseIn.checked && st.lastChoice) {
      // 不再确认：用顶上选的模型和档位；接着问时参考内容和文风样本前面已经发过，不再重复带
      out.reuse = { ...st.lastChoice, ...(prefer || {}), ...(history.length ? { ctxText: "", sampleText: "", sampleId: null } : {}) };
    }
    return out;
  }

  const forksOf = (chatId, i) => st.list.filter((c) => c.forkOf && c.forkOf.chatId === chatId && c.forkOf.index === i);

  // ---------------- 消息 ----------------
  function msgEl(m, i, { pending = false, live = false, fresh = false, order = 0 } = {}) {
    const ai = m.role === "assistant";
    const who = h("div.chat-who", {},
      h("span.chat-who-n", {}, ai ? "AI" : "你"),
      ai && m.model ? h("span.chat-model", {}, m.model) : null,
      live ? h("span.chat-state", {}, "正在回复") : pending ? h("span.chat-state", {}, "等你确认") : m.at ? h("span.chat-time", {}, fmtTime(m.at)) : null,
      m.stopped ? h("span.chat-stopped", {}, "中途停了") : null);
    const text = h("div.chat-text", {}, shown(m.content));
    const el = h("article.chat-msg." + (ai ? "ai" : "user"), { "data-i": String(i), "aria-label": ai ? "AI 的回复" : "你说的话" }, who);
    if (live) {
      el.classList.add("live");
      el.append(text, h("span.chat-wait", { "aria-label": "等回复" }, h("i"), h("i"), h("i")));
    } else el.append(text);
    if (pending) el.classList.add("pending");
    if (m.sent) el.append(h("details.chat-sent", {}, h("summary", {}, "实际发送的内容（加了提示词或参考内容）"), h("pre", {}, m.sent)));
    if (!pending && !live) {
      const acts = h("div.chat-macts");
      const b = (cls, text, ic, run, title) => {
        const x = h("button.btn.small.ghost." + cls, { type: "button", title: title || text }, ico(ic), h("span", {}, text));
        x.addEventListener("click", run);
        return x;
      };
      acts.append(b("chat-copy", "复制", "copy", async () => toast((await copyText(m.content)) ? "已复制" : "没能复制，选中文字后按 Ctrl+C")));
      if (ai) {
        if (canInsert()) acts.append(b("chat-insert", "插入正文", "insert", () => insert(m.content, el), "插到正文光标处，可以撤销"));
        acts.append(b("chat-fork", "从这里分叉", "fork", () => fork(i), "复制到这一条为止的对话，另开一个往别的方向问，两边互不影响"));
        for (const f of forksOf(st.chat.id, i)) {
          const chip = h("button.chat-forkchip", { type: "button", title: "去这个分叉" }, ico("fork"), h("span", {}, f.title || "分叉"));
          chip.addEventListener("click", () => switchTo(f.id));
          acts.append(chip);
        }
      }
      el.append(acts);
    }
    if (fresh) { el.classList.add("chat-enter"); el.style.setProperty("--i", String(order)); }
    return el;
  }

  function emptyEl() {
    const recent = st.list.filter((c) => c.id !== st.chat.id).slice(0, 3);
    const box2 = h("div.chat-empty.chat-enter", {},
      h("p.chat-empty-t", {}, st.chat.forkOf ? "分叉出来的对话" : "新对话"),
      h("p.muted", {}, "写下想问的，Ctrl+Enter 发送。每次发送前都会让你确认模型和内容。"),
      input.value.trim() && st.chat.messages.length === 0 ? h("p.muted.chat-empty-keep", {}, "输入框里的话还在，发出去就是这个对话的第一句。") : null);
    if (recent.length) {
      const list = h("div.chat-recent", {}, h("span.chat-recent-h", {}, "接着聊："));
      recent.forEach((c) => {
        const b = h("button.chat-recent-i", { type: "button" }, h("span.chat-li-t", {}, c.title || "新对话"), h("span.chat-li-s", {}, `${c.messages.length} 条 · ${fmtTime(c.updatedAt)}`));
        b.addEventListener("click", () => switchTo(c.id));
        list.append(b);
      });
      box2.append(list);
    }
    return box2;
  }

  async function forkNoteEl() {
    const f = st.chat.forkOf;
    if (!f) return null;
    const src = st.list.find((c) => c.id === f.chatId) || await getChat(f.chatId).catch(() => null);
    const note = h("div.chat-forknote.chat-enter", {}, ico("fork"));
    if (src) {
      note.append(h("span", {}, `从「${src.title || "新对话"}」第 ${f.index + 1} 条分叉出来`));
      const back = h("button.btn.small.ghost.chat-forkback", { type: "button" }, "回到原对话");
      back.addEventListener("click", () => switchTo(src.id));
      note.append(back);
    } else note.append(h("span", {}, `从第 ${f.index + 1} 条分叉出来（原对话已删除）`));
    return note;
  }

  let renderSeq = 0;
  async function renderMsgs(animate) {
    const my = ++renderSeq;
    const ms = st.chat.messages;
    const note = await forkNoteEl();
    if (my !== renderSeq || self.closed) return;
    const from = Math.max(0, ms.length - 6);   // 长对话只让最后几条播出场
    const els = ms.map((m, i) => msgEl(m, i, { fresh: animate && i >= from, order: i - from }));
    msgs.replaceChildren(...[note, ...(els.length ? els : [emptyEl()])].filter(Boolean));
    msgs.scrollTop = msgs.scrollHeight;
  }

  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
  const scrollEnd = (force) => { if (force || nearBottom()) msgs.scrollTop = msgs.scrollHeight; };

  function setChat(c, saved, animate = true) {
    st.chat = c; st.saved = saved;
    if (saved) setLastChat(bookId, c.id).catch(() => {});
    renderBar(); updateCtx();
    renderMsgs(animate);
    if (st.listLayer) renderList();
  }

  async function refreshList() {
    try { st.list = await listChats(bookId); } catch (e) { failed("对话列表读不出来。", e, refreshList); return; }
    if (self.closed) return;
    renderBar();
    if (st.listLayer) renderList();
    if (!st.chat.messages.length && !st.running) renderMsgs(false);
  }

  // ---------------- 发送 ----------------
  function varsNow() {
    if (!ws.book || ws.book.id !== bookId) return {};
    const id = st.chat.ref && ws.chapters.some((c) => c.id === st.chat.ref) ? st.chat.ref : ws.current && ws.current.id;
    return id ? ws.varsFor(id) : {};
  }

  function showLive(run) {
    if (run.el || self.closed || st.chat !== run.chat) return;
    run.userEl.classList.remove("pending");
    const s = run.userEl.querySelector(".chat-state");
    if (s) s.replaceWith(h("span.chat-time", {}, fmtTime(Date.now())));
    run.el = msgEl({ role: "assistant", content: "" }, run.chat.messages.length + 1, { live: true, fresh: true });
    run.textEl = run.el.querySelector(".chat-text");
    msgs.append(run.el);
    scrollEnd(true);
  }

  async function ask() {
    if (busyGuard()) return;
    const text = input.value;
    if (!text.trim()) { toast("先写点想问的"); input.focus(); return; }
    const chat = st.chat;
    const history = historyOf(chat.messages);
    const userMsg = { role: "user", content: text, at: Date.now() };
    msgs.querySelector(".chat-empty")?.remove();
    const userEl = msgEl(userMsg, chat.messages.length, { pending: true, fresh: true });
    msgs.append(userEl);
    scrollEnd(true);
    input.value = "";
    saveDraftSoon();
    const run = st.running = { ctrl: new AbortController(), input: text, text: "", el: null, textEl: null, raf: 0, chat, userEl };
    setBusy(true); updateCtx(); renderBar();
    let r = null;
    try {
      r = await runAI({
        feature: "chat", bookId, ref: chat.ref || null, title: chat.title || titleFrom(text),
        history, input: text, inputLabel: "这次说的话", vars: varsNow(),
        signal: run.ctrl.signal, ...(await presets(history)),
        onDelta: (piece, full) => {
          run.text = full;
          showLive(run);
          if (!run.raf) run.raf = requestAnimationFrame(() => {
            run.raf = 0;
            if (!run.textEl) return;
            const t = shown(run.text);
            if (t) run.el.querySelector(".chat-wait")?.remove();
            run.textEl.textContent = t;
            updateCtx(); scrollEnd();
          });
        },
      });
    } catch (e) {
      failed("这次没发出去。", e);
    }
    cancelAnimationFrame(run.raf);
    if (st.running === run) st.running = null;
    if (!self.closed) setBusy(false);
    const reply = r ? r.text : run.text;
    if (!reply || !reply.trim()) {
      // 没回来东西（取消了确认卡、出错后没重试、一个字都没回就停了）：这句话放回输入框
      userEl.remove();
      if (run.el) run.el.remove();
      if (!input.value.trim()) input.value = text;
      if (self.closed) setDraft(bookId, text).catch(() => {});
      else { saveDraftSoon(); if (!chat.messages.length) renderMsgs(false); updateCtx(); renderBar(); }
      return;
    }
    const sent = extraSent(r && r.sent, text);
    if (sent) userMsg.sent = sent;
    const aiMsg = { role: "assistant", content: reply, at: Date.now(), model: r ? r.choice.model : (st.lastChoice && st.lastChoice.model) || "" };
    if (!r) aiMsg.stopped = true;
    chat.messages.push(userMsg, aiMsg);
    if (!chat.title) chat.title = titleFrom(text);
    chat.updatedAt = Date.now();
    if (r) {
      st.lastChoice = r.choice;
      const c = r.choice;
      st.prefer = { providerId: c.providerId, model: c.model, creativity: c.creativity || 0, thinking: c.thinking || 0, promptId: c.promptId || null };
      setPrefer(st.prefer).catch(() => {});
    }
    try {
      await putChat(chat);
      if (st.chat === chat) st.saved = true;
      setLastChat(bookId, chat.id).catch(() => {});
    } catch (e) { failed("这段对话没存上。", e, () => putChat(chat)); }
    if (self.closed || st.chat !== chat) return;
    const i = chat.messages.length - 2;
    userEl.replaceWith(msgEl(userMsg, i));
    const done = msgEl(aiMsg, i + 1);
    done.classList.add("done");
    if (run.el) run.el.replaceWith(done); else msgs.append(done);
    scrollEnd();
    renderBar(); updateCtx(); renderPick();
    if (!r) toast("停住了，已经回来的部分留在对话里");
    refreshList();
  }

  function stop() {
    if (!st.running) return;
    stopBtn.disabled = true;
    st.running.ctrl.abort();
  }

  // ---------------- 回复：插入正文、分叉 ----------------
  async function insert(text, el) {
    if (!canInsert()) { toast("先打开一章"); return; }
    const head = ws.editor.view.state.selection.main.head;
    const before = ws.editor.getText();
    let u;
    try { u = await ws.applyBatch("插入 AI 回复", [{ chapterId: ws.current.id, after: before.slice(0, head) + text + before.slice(head) }]); }
    catch (e) { failed("没能插入正文。", e); return; }
    if (!u) return;
    ws.editor.select(head + text.length);
    el.classList.remove("used"); void el.offsetWidth; el.classList.add("used");
    toast("已插入正文", { action: { label: "撤销", run: () => appUndo.undoEntry(u) } });
  }

  async function fork(i) {
    if (busyGuard()) return;
    const src = st.chat;
    if (!st.saved) return;
    const n = st.list.filter((c) => c.forkOf && c.forkOf.chatId === src.id).length + 1;
    const c = blankChat({ bookId, ref: src.ref, title: forkTitle(src.title, n), messages: forkMessages(src.messages, i), forkOf: { chatId: src.id, index: i } });
    try { await putChat(c); } catch (e) { failed("没能分叉。", e, () => fork(i)); return; }
    const u = pushUndo({
      label: "分叉对话",
      undo: async () => { await dropChat(c.id); await afterChange({ gone: c.id, back: src.id }); },
      redo: async () => { await putChat(c); await afterChange({ show: c.id }); },
    });
    await refreshList();
    setChat(c, true);
    toast("已分叉，往别的方向问吧", { action: { label: "撤销", run: () => runUndo(u) } });
    input.focus();
  }

  // ---------------- 对话列表 ----------------
  function openList() {
    if (st.listLayer) { st.listLayer.close(); return; }
    closePick();
    st.listLayer = pushLayer({ onClose: () => { st.listLayer = null; listPop.hidden = true; listBtn.setAttribute("aria-expanded", "false"); } });
    listBtn.setAttribute("aria-expanded", "true");
    listPop.hidden = false;
    renderList();
    refreshList();
    const f = listPop.querySelector(".chat-li[aria-current='true'] .chat-li-main") || listPop.querySelector(".chat-li-main, button");
    if (f) f.focus();
  }
  const closeList = () => { if (st.listLayer) st.listLayer.close(true); };

  function renderList() {
    const add = h("button.btn.small.ghost.chat-list-new", { type: "button" }, icon("plus"), "新开对话");
    add.addEventListener("click", () => { closeList(); startFresh(); });
    const head = h("div.chat-list-h", {}, h("span.grow", {}, (bookId ? "这本书的对话" : "没放进作品的对话") + (st.list.length ? ` · ${st.list.length}` : "")), add);
    const items = st.list.map((c, i) => {
      const main = h("button.chat-li-main", { type: "button" },
        h("span.chat-li-t", {}, c.title || "新对话"),
        h("span.chat-li-s", {}, `${c.messages.length} 条 · ${fmtTime(c.updatedAt)}` + (c.forkOf ? " · 分叉" : "")));
      main.addEventListener("click", () => switchTo(c.id));
      const ren = h("button.icon-btn.chat-li-ren", { type: "button", "aria-label": "改标题", title: "改标题" }, ico("pen"));
      ren.addEventListener("click", () => rename(c.id));
      const del = h("button.icon-btn.chat-li-del", { type: "button", "aria-label": "删除", title: "删除（可以撤销）" }, icon("trash"));
      const li = h("div.chat-li", { role: "listitem", "data-id": c.id, "aria-current": String(c.id === st.chat.id) }, main, ren, del);
      del.addEventListener("click", () => remove(c.id, li));
      li.style.setProperty("--i", String(Math.min(i, 8)));
      return li;
    });
    listPop.replaceChildren(head, items.length ? h("div.chat-lis", { role: "list" }, ...items) : h("p.chat-li-none", {}, "还没有对话。发出第一句就会出现在这里。"));
  }

  async function switchTo(id) {
    if (busyGuard()) return;
    closeList();
    if (id === st.chat.id) return;
    let c;
    try { c = await getChat(id); } catch (e) { failed("这个对话读不出来。", e, () => switchTo(id)); return; }
    if (!c) { toast("这个对话已经不在了"); refreshList(); return; }
    setChat(c, true);
    input.focus();
  }

  function startFresh(r = st.ref) {
    if (busyGuard()) return;
    if (!st.saved && !st.chat.messages.length && !st.chat.forkOf) { input.focus(); return; }
    setChat(blankChat({ bookId, ref: r }), false);
    input.focus();
  }

  async function rename(id) {
    const row = id === st.chat.id ? st.chat : st.list.find((c) => c.id === id);
    if (!row) return;
    const v = await prompt("改对话标题", row.title || "", "对话标题");
    if (v == null) return;
    const t = v.trim().slice(0, 60);
    const before = row.title || "";
    if (!t || t === before) return;
    const apply = async (title) => {
      const r = await getChat(id);
      if (r) { r.title = title; await putChat(r); }
      await afterChange({ renamed: id, title });
    };
    try { await apply(t); } catch (e) { failed("没能改标题。", e, () => rename(id)); return; }
    const u = pushUndo({ label: "改对话标题", undo: () => apply(before), redo: () => apply(t) });
    toast("标题改好了", { action: { label: "撤销", run: () => runUndo(u) } });
  }

  async function remove(id, li) {
    if (st.running && st.chat.id === id) { busyGuard(); return; }
    let row;
    try { row = await getChat(id); } catch (e) { failed("没能删除。", e); return; }
    if (!row) { refreshList(); return; }
    if (li && motionFull()) { li.classList.add("chat-li-out"); await later(260); }
    try { await dropChat(id); } catch (e) { failed("没能删除。", e, () => remove(id)); return; }
    const t = row.title || "新对话";
    const u = pushUndo({
      label: "删除对话「" + t + "」",
      undo: async () => { await putChat(row); await afterChange({ show: row.id }); },
      redo: async () => { await dropChat(row.id); await afterChange({ gone: row.id }); },
    });
    await sync({ gone: id });
    toast("已删除对话「" + t + "」", { action: { label: "撤销", run: () => runUndo(u) }, timeout: 9000 });
  }

  /** 数据被撤销 / 重做改过之后：当前对话没了就换走，空着时换成刚恢复的那个 */
  async function sync({ gone, back, show, renamed, title } = {}) {
    if (self.closed) return;
    if (renamed && st.chat.id === renamed) { st.chat.title = title; renderBar(); }
    if (gone && st.chat.id === gone && !st.running) {
      const b = back ? await getChat(back).catch(() => null) : null;
      setChat(b || blankChat({ bookId, ref: st.ref }), !!b);
    }
    if (show && !st.running && !st.saved && !st.chat.messages.length) {
      const c = await getChat(show).catch(() => null);
      if (c) setChat(c, true);
    }
    await refreshList();
  }

  // ---------------- 打开时 / 再次打开时 ----------------
  async function handle(opts, first) {
    if (first) {
      const [list, draft, prefer] = await Promise.all([listChats(bookId).catch(() => []), getDraft(bookId).catch(() => ""), getPrefer().catch(() => null)]);
      st.list = list;
      st.prefer = prefer;
      if (draft && !input.value) input.value = draft;
    }
    if (self.closed) return;
    if (opts.history && opts.history.length) {
      if (st.drawer) { try { st.drawer.close(true); } catch (_) { /* 抽屉已经关了 */ } st.drawer = null; }
      if (busyGuard()) return;
      const messages = opts.history.filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
        .map((m) => ({ role: m.role, content: String(m.content), at: Date.now() }));
      const firstUser = messages.find((m) => m.role === "user");
      const c = blankChat({ bookId, ref: opts.ref || null, title: (opts.title || titleFrom(firstUser ? firstUser.content : "")).slice(0, 60), messages });
      try { await putChat(c); } catch (e) { failed("没能新建对话。", e); return; }
      st.list = [c, ...st.list.filter((x) => x.id !== c.id)];
      setChat(c, true);
      refreshList();
    } else if (opts.fresh) {
      if (first) setChat(st.chat, false); else startFresh(opts.ref || st.ref);
    } else if (first) {
      const id = await lastChatId(bookId).catch(() => null);
      const c = id ? st.list.find((x) => x.id === id) : null;
      setChat(c || st.chat, !!c);
    }
    renderPick();
    tip("chat", "「继续追问」会带上前面的对话一起发，「新开对话」从零开始。上面的数字是现在的上下文长度。");
    setTimeout(() => { if (!self.closed) input.focus(); }, 0);
  }

  // ---------------- 收尾 ----------------
  let draftT = 0;
  function saveDraftSoon() { clearTimeout(draftT); draftT = setTimeout(() => setDraft(bookId, input.value).catch(() => {}), 500); }

  const unbind = [bus.on("ai:start", ({ feature }) => { if (feature === "chat" && st.running) showLive(st.running); })];
  function cleanup(forced) {
    self.closed = true;
    clearTimeout(draftT);
    if (st.running) st.running.ctrl.abort();
    if (st.listLayer) st.listLayer.close(true);
    if (st.pickLayer) st.pickLayer.close(true);
    if (st.drawer) { try { st.drawer.close(true); } catch (_) { /* 已经关了 */ } st.drawer = null; }
    unbind.forEach((f) => f());
    // 被别的面板顶掉时草稿自动留着；作者自己关的，选了「丢弃」就清掉
    if (forced || st.forced || st.kept) { if (input.value.trim()) setDraft(bookId, input.value).catch(() => {}); }
    else setDraft(bookId, "").catch(() => {});
    document.body.classList.remove("chat-open");
    const v = document.querySelector(".ws");
    if (v) v.classList.remove("has-chat");
    if (inst === self) inst = null;
  }

  // ---------------- 事件 ----------------
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); ask(); }
  });
  input.addEventListener("input", () => { updateCtx(); saveDraftSoon(); });
  askBtn.addEventListener("click", ask);
  newBtn.addEventListener("click", () => startFresh());
  stopBtn.addEventListener("click", stop);
  listBtn.addEventListener("click", openList);
  pickBtn.addEventListener("click", openPick);
  titleBtn.addEventListener("click", () => rename(st.chat.id));
  stashBtn.addEventListener("click", () => {
    if (!commands.get("stash.drawer")) { toast(label("暂存盒") + "还没装好"); return; }
    st.drawer = commands.run("stash.drawer", { feature: "chat", bookId, ref: st.chat.ref || undefined, title: "对话", modal: true }) || null;
  });
  reuseIn.addEventListener("change", () => { if (reuseIn.checked) toast("接着问时直接用 " + ((st.prefer && st.prefer.model) || st.lastChoice.model) + " 发送，取消勾选就恢复确认"); });
  // 列表、模型牌子外面点一下就收起
  root.addEventListener("pointerdown", (e) => {
    if (st.listLayer && !listPop.contains(e.target) && !listBtn.contains(e.target)) closeList();
    if (st.pickLayer && !pickPop.contains(e.target) && !pickBtn.contains(e.target)) closePick();
  });

  renderBar(); updateCtx(); renderPick();
  return self;
}
