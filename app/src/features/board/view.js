// 看板页面：顶上主线一句话；一段（卷 / 幕）一列，列里是分镜卡，按住拖动换顺序、换列（也能 Alt+方向键）；
// 卡上能看到目标、冲突、转折、谁出场、挂了哪几章、写了多少字，空着的一眼能看出来。点卡打开编辑：字段、出场人物、挂章节、删除。
import { h, icon, toast, modal, confirm } from "../../core/ui.js";
import { commands } from "../../core/commands.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { listChapters } from "../../core/store.js";
import { chapterLabel } from "../../core/text.js";
import { readMeta, listCards, catOf } from "../../core/lore.js";
import { getBoard, edit, newAct, newCard, FIELDS, TEMPLATES, filled, indexOf } from "../../core/board.js";

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const roman = (n) => { let s = ""; for (const [v, r] of [[50, "L"], [40, "XL"], [10, "X"]]) while (n >= v) { s += r; n -= v; } return s + ROMAN[n]; };
const CN = "〇一二三四五六七八九";
const cn = (n) => (n <= 10 ? (n === 10 ? "十" : CN[n]) : n < 20 ? "十" + CN[n - 10] : n < 100 ? CN[Math.floor(n / 10)] + "十" + (n % 10 ? CN[n % 10] : "") : String(n));
const composing = (e) => e.isComposing || e.keyCode === 229;
const undoToast = (msg, entry) => toast(msg, entry ? { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } } : {});

export function mountBoard(root, { bookId, book }) {
  const env = { board: null, chapters: [], people: [], meta: null, destroyed: false, watch: new Set() };
  const offs = [];
  const lineIn = h("textarea.bd-line-in", { rows: 1, placeholder: "一句话写清整本书讲什么。比如：被退婚的少女进了魔法学院，一路查清母亲失踪的真相。", "aria-label": "主线" });
  const acts = h("div.bd-acts", { role: "list", "aria-label": "大段落" });
  const wrap = h("div.bd-root", {},
    h("section.bd-line", {}, h("span.bd-line-k", {}, "主线"), lineIn),
    acts);
  root.replaceChildren(wrap);

  const fit = () => { lineIn.style.height = "auto"; lineIn.style.height = Math.min(120, lineIn.scrollHeight) + "px"; };
  lineIn.addEventListener("input", fit);
  lineIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); lineIn.blur(); } });
  lineIn.addEventListener("blur", async () => {
    const v = lineIn.value.trim();
    if (v === env.board.line) return;
    const { entry } = await edit(bookId, "改主线", (b) => { b.line = v; });
    if (entry) undoToast("主线改好了", entry);
  });

  async function load() {
    const [board, chapters, meta, cards] = await Promise.all([getBoard(bookId), listChapters(bookId), readMeta(bookId), listCards(bookId)]);
    if (env.destroyed) return;
    env.board = board; env.chapters = chapters; env.meta = meta;
    env.people = cards.filter((c) => c.name).map((c) => { const cat = catOf(meta, c); return { id: c.id, name: c.name, color: cat.color, kind: cat.kind, thumb: c.img ? c.img.thumb : null }; });
    paint();
  }
  const chapterOf = (id) => env.chapters.find((c) => c.id === id);
  const chapterNo = (id) => env.chapters.findIndex((c) => c.id === id) + 1;
  const chapterName = (c) => chapterLabel(chapterNo(c.id), (book && book.numbering) || "zh");

  // ---------------- 画 ----------------
  function paint() {
    const b = env.board;
    if (document.activeElement !== lineIn) { lineIn.value = b.line || ""; fit(); }
    const sx = acts.scrollLeft;
    if (!b.acts.length) { acts.replaceChildren(starter()); return; }
    acts.replaceChildren(...b.acts.map((a, i) => actCol(a, i)), addActCol());
    acts.scrollLeft = sx;
  }

  function starter() {
    const pick = (t) => {
      const go = h("button.bd-tpl", { type: "button" }, h("b", {}, t.name), h("span", {}, t.acts.map((x) => x[0].replace(/^.+ · /, "")).join(" → ")));
      go.addEventListener("click", async () => {
        const { entry } = await edit(bookId, "用「" + t.name + "」开始看板", (bb) => { bb.acts = t.acts.map(([title, goal]) => newAct(title, goal)); });
        undoToast(`按「${t.name}」排好了 ${t.acts.length} 段，段名和目标都能改`, entry);
      });
      return go;
    };
    return h("div.bd-start", {}, h("p.bd-start-t", {}, "先分几段（卷或幕），每段里放分镜卡。"),
      h("p.bd-start-s", {}, "这几种分法只是起点，段名、目标、段数以后都能改。"), h("div.bd-tpls", {}, ...TEMPLATES.map(pick)));
  }

  function actCol(a, i) {
    const title = h("input.bd-act-t", { value: a.title, placeholder: "第 " + (i + 1) + " 段", "aria-label": "段名" });
    const goal = h("textarea.bd-act-g", { rows: 2, placeholder: "这一段的阶段目标", "aria-label": "阶段目标" }, a.goal || "");
    const saveText = async (field, el, name) => {
      const v = el.value.trim();
      if (v === (a[field] || "")) return;
      const { entry } = await edit(bookId, `改「${a.title || "第 " + (i + 1) + " 段"}」的${name}`, (b) => { const x = b.acts.find((y) => y.id === a.id); if (x) x[field] = v; });
      if (entry) undoToast(name + "改好了", entry);
    };
    title.addEventListener("blur", () => saveText("title", title, "段名"));
    title.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); title.blur(); } });
    goal.addEventListener("blur", () => saveText("goal", goal, "阶段目标"));
    const menuB = h("button.icon-btn.bd-act-more", { type: "button", title: "这一段：左移、右移、删除", "aria-label": "这一段的更多操作", "aria-haspopup": "menu" }, icon("more"));
    menuB.addEventListener("click", () => actMenu(menuB, a, i));
    const cards = h("div.bd-cards", { role: "list", "data-act": a.id });
    a.cards.forEach((id, j) => { const c = env.board.cards[id]; if (c) cards.append(cardEl(c, a, j)); });
    const words = a.cards.reduce((t, id) => t + (env.board.cards[id].chapters || []).reduce((s, ch) => s + ((chapterOf(ch) || {}).words || 0), 0), 0);
    const add = h("input.bd-add", { placeholder: "+ 分镜卡：写个标题，回车", "aria-label": "新分镜卡的标题" });
    add.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || composing(e)) return;
      e.preventDefault();
      const t = add.value.trim();
      add.value = "";
      const { result } = await edit(bookId, "加分镜卡", (b) => { const c = newCard({ title: t }); b.cards[c.id] = c; b.acts.find((x) => x.id === a.id).cards.push(c.id); return c; });
      env.fresh = result.id;
      setTimeout(() => { const n = acts.querySelector(`[data-act="${a.id}"]`); const inp = n && n.parentElement.querySelector(".bd-add"); if (inp) inp.focus(); }, 30);
    });
    return h("section.bd-act", { role: "listitem", "data-act-id": a.id, "data-n": String(i + 1), "data-roman": roman(i + 1), "data-cn": cn(i + 1) },
      h("header.bd-act-head", {}, h("span.bd-act-no", { "aria-hidden": "true", "data-n": String(i + 1), "data-roman": roman(i + 1), "data-cn": cn(i + 1) }), title, menuB),
      goal,
      h("div.bd-act-sum", {}, `${a.cards.length} 张卡`, words ? ` · 写了 ${words.toLocaleString()} 字` : ""),
      cards, add);
  }
  function addActCol() {
    const b = h("button.bd-act-add", { type: "button" }, icon("plus"), "加一段");
    b.addEventListener("click", async () => {
      const { entry } = await edit(bookId, "加一段", (bb) => { bb.acts.push(newAct("第 " + (bb.acts.length + 1) + " 段", "")); });
      undoToast("加了一段", entry);
      setTimeout(() => { const t = acts.querySelectorAll(".bd-act-t"); const last = t[t.length - 1]; if (last) { last.focus(); last.select(); } acts.scrollLeft = acts.scrollWidth; }, 40);
    });
    return h("div.bd-act-new", {}, b);
  }
  function actMenu(anchor, a, i) {
    const n = env.board.acts.length;
    const items = [
      i > 0 ? ["往左挪", () => moveAct(a, -1)] : null,
      i < n - 1 ? ["往右挪", () => moveAct(a, 1)] : null,
      ["删掉这一段", () => delAct(a)],
    ].filter(Boolean);
    const m = h("div.bd-menu", { role: "menu" }, ...items.map(([t, fn]) => { const x = h("button.bd-menu-i", { type: "button", role: "menuitem" }, t); x.addEventListener("click", () => { close(); fn(); }); return x; }));
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + "px";
    m.style.top = r.bottom + 4 + "px";
    const close = () => { m.remove(); document.removeEventListener("pointerdown", out, true); document.removeEventListener("keydown", esc, true); };
    const out = (e) => { if (!m.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    setTimeout(() => { document.addEventListener("pointerdown", out, true); document.addEventListener("keydown", esc, true); }, 0);
    m.querySelector("button").focus();
  }
  async function moveAct(a, d) {
    await edit(bookId, "挪动一段", (b) => { const i = b.acts.findIndex((x) => x.id === a.id); const j = i + d; if (j < 0 || j >= b.acts.length) return; const [x] = b.acts.splice(i, 1); b.acts.splice(j, 0, x); });
  }
  async function delAct(a) {
    if (a.cards.length && !(await confirm("删掉这一段？", `里面的 ${a.cards.length} 张分镜卡一起删，挂着的章节会解开（正文不动）。删了可以撤销。`, "删掉", true))) return;
    const { entry } = await edit(bookId, `删掉「${a.title || "这一段"}」`, (b) => { const x = b.acts.find((y) => y.id === a.id); if (!x) return; x.cards.forEach((id) => delete b.cards[id]); b.acts = b.acts.filter((y) => y.id !== a.id); });
    undoToast("删掉了一段", entry);
  }

  // ---------------- 分镜卡 ----------------
  function stateOf(c) {
    const chs = (c.chapters || []).map(chapterOf).filter(Boolean);
    const words = chs.reduce((t, x) => t + (x.words || 0), 0);
    const pts = chs.flatMap((x) => (x.points || []).filter((p) => p.board && p.board.startsWith(c.id + ":")));
    if (!chs.length) return { key: filled(c) ? "idea" : "empty", label: filled(c) ? "还没写" : "空着", words: 0, chs };
    if (pts.length && pts.every((p) => p.done)) return { key: "done", label: "写完了", words, chs };
    return { key: "writing", label: `写了 ${words.toLocaleString()} 字`, words, chs };
  }
  function cardEl(c, a, j) {
    const n = indexOf(env.board, c.id);
    const st = stateOf(c);
    const lines = FIELDS.filter((f) => String(c[f.id] || "").trim()).slice(0, 3).map((f) => h("p.bd-c-l", {}, h("b", {}, f.name), " ", c[f.id]));
    const cast = (c.cast || []).map((id) => env.people.find((p) => p.id === id)).filter(Boolean);
    const el = h("article.bd-card.st-" + st.key + (env.fresh === c.id ? ".fresh" : ""), {
      role: "listitem", tabindex: "0", "data-card": c.id, "data-n": String(n), "data-roman": roman(n), "data-cn": cn(n), "data-pad": String(n).padStart(3, "0"),
      "aria-label": `第 ${n} 张分镜卡：${c.title || "没有标题"}，${st.label}。回车打开，Alt+方向键挪动`,
    },
      h("header.bd-c-head", {}, h("span.bd-c-no", { "aria-hidden": "true", "data-n": String(n), "data-roman": roman(n), "data-cn": cn(n), "data-pad": String(n).padStart(3, "0") }), h("b.bd-c-t", {}, c.title || "（没有标题）"), h("span.bd-c-st", {}, st.label)),
      lines.length ? h("div.bd-c-lines", {}, ...lines) : h("p.bd-c-empty", {}, "目标、冲突、转折、透露都还空着，点开填。"),
      cast.length ? h("div.bd-c-cast", {}, ...cast.slice(0, 6).map((p) => h("span.bd-c-p", { style: "--c:" + p.color }, p.thumb ? h("img", { src: p.thumb, alt: "" }) : null, p.name))) : null,
      st.chs.length ? h("div.bd-c-chs", {}, ...st.chs.map((x) => h("span.bd-c-ch", { title: (x.words || 0) + " 字" }, chapterName(x)))) : null,
      h("div.bd-c-dots", { title: `填了 ${filled(c)} / 5 项`, "aria-hidden": "true" }, ...[0, 1, 2, 3, 4].map((k) => h("i" + (k < filled(c) ? ".on" : "")))),
    );
    if (env.fresh === c.id) setTimeout(() => { el.classList.remove("fresh"); if (env.fresh === c.id) env.fresh = null; }, 900);
    el.addEventListener("click", (e) => { if (el.dataset.dragged) { delete el.dataset.dragged; return; } if (!e.target.closest("button")) openCard(c.id); });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); openCard(c.id); return; }
      if (!e.altKey) return;
      const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
      if (!d) return;
      e.preventDefault();
      nudge(c.id, d[0], d[1]);
    });
    wireDrag(el, c.id);
    return el;
  }
  async function nudge(cardId, dx, dy) {
    await edit(bookId, "挪动分镜卡", (b) => {
      const ai = b.acts.findIndex((a) => a.cards.includes(cardId));
      if (ai < 0) return;
      const from = b.acts[ai], i = from.cards.indexOf(cardId);
      if (dx) {
        const to = b.acts[ai + dx];
        if (!to) return;
        from.cards.splice(i, 1);
        to.cards.splice(Math.min(i, to.cards.length), 0, cardId);
      } else {
        const j = i + dy;
        if (j < 0 || j >= from.cards.length) return;
        from.cards.splice(i, 1);
        from.cards.splice(j, 0, cardId);
      }
    });
    setTimeout(() => { const el = acts.querySelector(`[data-card="${cardId}"]`); if (el) el.focus(); }, 30);
  }

  // 按住拖：卡跟着走，松手的地方插进去（同一列换顺序，别的列就换段）
  function wireDrag(el, cardId) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input, textarea, a")) return;
      const start = { x: e.clientX, y: e.clientY };
      let ghost = null, holder = null, target = null;
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
          const r = el.getBoundingClientRect();
          ghost = el.cloneNode(true);
          ghost.classList.add("bd-ghost");
          ghost.style.width = r.width + "px";
          ghost._dx = start.x - r.left; ghost._dy = start.y - r.top;
          document.body.append(ghost);
          holder = h("div.bd-holder", { style: `height:${r.height}px` });
          el.classList.add("bd-lifted");
          el.after(holder);
          document.body.classList.add("bd-dragging");
        }
        ghost.style.left = ev.clientX - ghost._dx + "px";
        ghost.style.top = ev.clientY - ghost._dy + "px";
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const col = under && under.closest(".bd-act");
        if (!col) return;
        const list = col.querySelector(".bd-cards");
        const items = [...list.querySelectorAll(".bd-card:not(.bd-lifted)")];
        const before = items.find((x) => { const r = x.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        if (before) before.before(holder); else list.append(holder);
        target = { actId: col.dataset.actId, index: [...list.children].filter((x) => x.classList.contains("bd-card") && !x.classList.contains("bd-lifted") || x === holder).indexOf(holder) };
        // 拖到边上自动横着滚
        const ar = acts.getBoundingClientRect();
        if (ev.clientX > ar.right - 40) acts.scrollLeft += 18; else if (ev.clientX < ar.left + 40) acts.scrollLeft -= 18;
      };
      const up = async () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("keydown", esc, true);
        if (!ghost) return;
        el.dataset.dragged = "1";
        ghost.remove(); holder.remove(); el.classList.remove("bd-lifted"); document.body.classList.remove("bd-dragging");
        if (!target) return;
        const t = target;
        await edit(bookId, "挪动分镜卡", (b) => {
          const from = b.acts.find((a) => a.cards.includes(cardId));
          const to = b.acts.find((a) => a.id === t.actId);
          if (!from || !to) return;
          from.cards.splice(from.cards.indexOf(cardId), 1);
          to.cards.splice(Math.max(0, Math.min(t.index, to.cards.length)), 0, cardId);
        });
        env.fresh = cardId;
        paint();
      };
      const esc = (ev) => { if (ev.key === "Escape" && ghost) { ev.stopPropagation(); target = null; up(); paint(); } };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("keydown", esc, true);
    });
  }

  // ---------------- 编辑一张卡 ----------------
  function openCard(cardId) {
    const c0 = env.board.cards[cardId];
    if (!c0) return;
    const body = h("div.bd-ed");
    let off = null;
    const m = modal({ title: "分镜卡", body, wide: true, onClose: () => { if (off) off(); }, actions: [{ label: "完成", primary: true, onClick: (layer) => layer.close() }] });
    if (m.el) m.el.classList.add("bd-ed-modal");
    const save = async (label, fn) => {
      const { entry } = await edit(bookId, label, (b) => { const c = b.cards[cardId]; if (c) fn(c, b); });
      await refresh();
      render();
      if (entry) noteSaved(entry);
    };
    const note = h("p.bd-ed-note", { "aria-live": "polite" });
    const noteSaved = (entry) => {
      const u = h("button.bd-undo", { type: "button" }, "撤销");
      u.addEventListener("click", async () => { await appUndo.undoEntry(entry); await refresh(); note.textContent = "撤销了"; });
      note.replaceChildren("存好了 · ", u);
    };
    const render = () => {
      const c = env.board.cards[cardId];
      if (!c) { m.close(); return; }
      const act = env.board.acts.find((a) => a.cards.includes(cardId));
      const titleIn = h("input.input.bd-ed-title", { value: c.title, placeholder: "这张卡叫什么（比如：退婚宴）", "aria-label": "标题" });
      titleIn.addEventListener("blur", () => { const v = titleIn.value.trim(); if (v !== c.title) save("改分镜卡标题", (x) => { x.title = v; }); });
      titleIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); titleIn.blur(); } });
      const field = (f) => {
        const ta = h("textarea.textarea.bd-ed-f", { rows: 2, placeholder: f.hint, "aria-label": f.name }, c[f.id] || "");
        ta.addEventListener("blur", () => { const v = ta.value.trim(); if (v !== (c[f.id] || "")) save(`改分镜卡的${f.name}`, (x) => { x[f.id] = v; }); });
        return h("label.bd-ed-row", {}, h("span.bd-ed-k", {}, f.name), ta);
      };
      // 谁出场：设定库里的人物（别的分类也能点），点一下加上 / 去掉
      const castBox = h("div.bd-ed-cast");
      const people = env.people.filter((p) => p.kind === "person" || (c.cast || []).includes(p.id));
      for (const p of people) {
        const on = (c.cast || []).includes(p.id);
        const b = h("button.bd-pick" + (on ? ".on" : ""), { type: "button", style: "--c:" + p.color, "aria-pressed": String(on) }, p.thumb ? h("img", { src: p.thumb, alt: "" }) : h("i"), p.name);
        b.addEventListener("click", () => save(on ? `「${p.name}」不出场了` : `「${p.name}」出场`, (x) => { x.cast = on ? x.cast.filter((y) => y !== p.id) : [...(x.cast || []), p.id]; }));
        castBox.append(b);
      }
      const newP = h("input.bd-pick-new", { placeholder: "+ 新人物（回车建卡）", "aria-label": "新人物的名字", maxlength: 20 });
      newP.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter" || composing(e)) return;
        e.preventDefault();
        const name = newP.value.trim();
        if (!name) return;
        newP.value = "";
        const card = await commands.run("cards.new", { bookId, cat: "person", name, silent: true });
        if (!card) return;
        await load();
        save(`「${name}」出场`, (x) => { x.cast = [...(x.cast || []), card.id]; });
      });
      castBox.append(newP);
      // 挂哪几章：一章只能挂一张卡，挂到这里会从别的卡上拿下来
      const chBox = h("div.bd-ed-chs");
      for (const ch of env.chapters) {
        const owner = Object.values(env.board.cards).find((x) => (x.chapters || []).includes(ch.id));
        const on = owner && owner.id === cardId;
        const cb = h("input", { type: "checkbox", checked: !!on });
        cb.addEventListener("change", () => save(on ? `「${chapterName(ch)}」不挂了` : `把「${chapterName(ch)}」挂到这张卡`, (x, b) => {
          if (on) { x.chapters = x.chapters.filter((y) => y !== ch.id); return; }
          for (const y of Object.values(b.cards)) y.chapters = (y.chapters || []).filter((z) => z !== ch.id);
          x.chapters = [...(x.chapters || []), ch.id];
        }));
        chBox.append(h("label.check.bd-ed-ch", {}, cb, h("span", {}, chapterName(ch) + (ch.title ? " " + ch.title : "")),
          owner && !on ? h("span.bd-ed-own", {}, "在「" + (owner.title || "第 " + indexOf(env.board, owner.id) + " 张") + "」") : null,
          h("span.bd-ed-w", {}, (ch.words || 0) + " 字")));
      }
      const del = h("button.btn.ghost.bd-ed-del", { type: "button" }, icon("trash"), "删掉这张卡");
      del.addEventListener("click", async () => {
        m.close();
        const { entry } = await edit(bookId, `删掉分镜卡「${c.title || "没有标题"}」`, (b) => { delete b.cards[cardId]; b.acts.forEach((a) => { a.cards = a.cards.filter((x) => x !== cardId); }); });
        undoToast("删掉了这张分镜卡，挂着的章节解开了", entry);
      });
      const noteTa = h("textarea.textarea.bd-ed-f", { rows: 2, placeholder: "别的想法", "aria-label": "备注" }, c.note || "");
      noteTa.addEventListener("blur", () => { const v = noteTa.value.trim(); if (v !== (c.note || "")) save("改分镜卡备注", (x) => { x.note = v; }); });
      // 重画时别丢了正在打的字：记下焦点所在的框、里面的字和光标，画完放回去
      const foc = document.activeElement;
      const keep = foc && body.contains(foc) && foc.matches("input:not([type=checkbox]), textarea")
        ? { label: foc.getAttribute("aria-label"), value: foc.value, s: foc.selectionStart, e: foc.selectionEnd } : null;
      body.replaceChildren(
        h("div.bd-ed-top", {}, h("span.bd-ed-n", {}, `第 ${indexOf(env.board, cardId)} 张 · ${act ? act.title || "" : ""}`), titleIn),
        ...FIELDS.map(field),
        h("div.bd-ed-row", {}, h("span.bd-ed-k", {}, "谁出场"), castBox),
        h("label.bd-ed-row", {}, h("span.bd-ed-k", {}, "备注"), noteTa),
        h("div.bd-ed-row", {}, h("span.bd-ed-k", {}, "挂的章节"), env.chapters.length ? chBox : h("p.muted", {}, "这本书还没有章节。")),
        h("p.bd-ed-tip", {}, "挂上的章节，这张卡的目标、冲突、转折、透露会变成那一章的要点；卡改了，要点跟着改。"),
        h("div.bd-ed-foot", {}, note, del));
      if (keep && keep.label) {
        const f = body.querySelector(`[aria-label="${keep.label}"]`);
        if (f) { f.value = keep.value; f.focus(); try { f.setSelectionRange(keep.s, keep.e); } catch (_) { /* 有的框不支持 */ } }
      }
    };
    render();
    const onRefresh = () => { if (!body.contains(document.activeElement) || document.activeElement.type === "checkbox") render(); };
    env.watch.add(onRefresh);
    off = () => env.watch.delete(onRefresh);
  }

  /** 重新读看板和章节，重画看板和开着的卡 */
  async function refresh() {
    env.board = await getBoard(bookId);
    env.chapters = await listChapters(bookId);
    if (env.destroyed) return;
    paint();
    env.watch.forEach((fn) => fn());
  }

  offs.push(bus.on("board:changed", (d) => { if (d.bookId === bookId) refresh(); }));
  offs.push(bus.on("lore:changed", (d) => { if (d.bookId === bookId) load(); }));
  const ready = load();
  return {
    ready,
    openCard: (id) => ready.then(() => openCard(id)),
    destroy() { env.destroyed = true; offs.forEach((f) => f()); },
  };
}
