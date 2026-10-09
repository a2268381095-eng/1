// 暂存盒里的一条：时间、模型、内容（长的折叠）、标签，和采用、复制、置顶、加标签、继续追问、删除。
// 抽屉和总暂存盒共用。条目可以拖进正文（dataTransfer 的 text/plain 就是正文，CodeMirror 自己处理放下）。
import { h, icon, prompt, toast, notice } from "../../core/ui.js";
import { commands } from "../../core/commands.js";
import { fmtTime } from "../../core/text.js";
import { providerOf } from "../../core/ai.js";
import { featureName, isLong, charCount, parseTags } from "./logic.js";
import { setPinned, setTags, copyText } from "./ops.js";

const motionFull = () => document.documentElement.dataset.motion === "full";

/** 删除前让卡片按主题的样子退场（只在完整动效下等它播完） */
export async function animateOut(cards) {
  cards = cards.filter(Boolean);
  if (!cards.length || !motionFull()) return;
  cards.forEach((c, i) => { c.style.setProperty("--o", String(Math.min(i, 6))); c.classList.add("stash-out"); });
  await new Promise((r) => setTimeout(r, 320 + Math.min(cards.length - 1, 6) * 30));
}

/** 继续追问：交给对话模块，在当前界面里接着问 */
export function followUp(row) {
  const args = {
    bookId: row.bookId || null, ref: row.ref || null, title: row.title || "继续追问",
    history: [{ role: "user", content: row.prompt || row.input || row.title || "" }, { role: "assistant", content: row.text || "" }],
  };
  if (!commands.get("chat.open")) { toast("对话还在做，下一版就有。"); return; }
  commands.run("chat.open", args);
}

const imgSrc = (row) => row.src || row.url || row.dataUrl || row.image || "";

/**
 * ctx: {
 *   showFeature, showBook, bookName(row)   要不要显示功能名、作品名
 *   selecting, selected: Set, onSelect(id, on)   多选
 *   expanded: Set                           展开了全文的
 *   use: { label, run(row) } | null          采用
 *   draggable                               能拖进正文
 *   onTag(tag)                              点标签：按标签筛选
 *   remove(rows, cards)                     删除（带退场动画）
 *   fresh, index                            新出现的：播出场动画，index 决定先后
 * }
 */
export function cardEl(row, ctx) {
  const sel = ctx.selecting && ctx.selected.has(row.id);
  const card = h("article.stash-card" + (row.pinned ? ".pinned" : "") + (sel ? ".sel" : "") + (ctx.fresh ? ".stash-in" : ""),
    { role: "listitem", "data-id": row.id, "data-kind": row.kind || "text", "data-feature": row.feature || "other" });
  if (ctx.fresh) card.style.setProperty("--i", String(Math.min(ctx.index || 0, 8)));

  // ---- 头：时间、模型、功能、作品 ----
  const meta = h("div.stash-meta");
  if (ctx.selecting) {
    const cb = h("input", { type: "checkbox", "aria-label": "选择这一条", checked: sel });
    cb.addEventListener("change", () => ctx.onSelect(row.id, cb.checked));
    meta.append(h("label.stash-pick", {}, cb));
  }
  if (row.pinned) meta.append(h("span.stash-pin-mark", { title: "置顶" }, "置顶"));
  if (ctx.showFeature) meta.append(h("span.stash-feat", {}, featureName(row.feature)));
  meta.append(h("span.stash-when", { title: new Date(row.at).toLocaleString() }, fmtTime(row.at)));
  if (row.model) {
    const p = providerOf(row.providerId);
    meta.append(h("span.stash-model", { title: (p ? p.name + " · " : "") + row.model }, row.model));
  }
  if (ctx.showBook) meta.append(h("span.stash-book", {}, ctx.bookName(row)));
  if (ctx.draggable) meta.append(h("span.stash-grip", { title: "按住拖进正文", "aria-hidden": "true" }, icon("drag")));
  card.append(meta);
  if (row.title) card.append(h("h4.stash-title", {}, row.title));

  // ---- 内容 ----
  const src = row.kind === "image" ? imgSrc(row) : "";
  if (src) card.append(h("img.stash-img", { src, alt: row.title || "AI 生成的图片", loading: "lazy", draggable: "false" }));
  const text = row.text || "";
  if (text || !src) {
    const long = isLong(text);
    const open = ctx.expanded.has(row.id);
    const body = h("div.stash-text" + (long && !open ? ".folded" : ""), {}, text || h("span.muted", {}, "（没有文字）"));
    card.append(body);
    if (long) {
      const fold = h("button.stash-fold", { type: "button", "aria-expanded": String(open) }, open ? "收起" : `展开全文（${charCount(text).toLocaleString()} 字）`);
      fold.addEventListener("click", () => {
        const now = !ctx.expanded.has(row.id);
        if (now) ctx.expanded.add(row.id); else ctx.expanded.delete(row.id);
        body.classList.toggle("folded", !now);
        fold.setAttribute("aria-expanded", String(now));
        fold.textContent = now ? "收起" : `展开全文（${charCount(text).toLocaleString()} 字）`;
      });
      card.append(fold);
    }
  }

  // ---- 标签 ----
  const tags = row.tags || [];
  if (tags.length) {
    card.append(h("div.stash-tags", {}, ...tags.map((t) => {
      const name = h("button.stash-tag", { type: "button", title: "只看「" + t + "」", "data-tag": t }, t);
      name.addEventListener("click", () => ctx.onTag && ctx.onTag(t));
      const x = h("button.stash-tag-x", { type: "button", "aria-label": "去掉标签「" + t + "」", title: "去掉这个标签" }, icon("close"));
      x.addEventListener("click", () => setTags(row, tags.filter((v) => v !== t), "去掉标签「" + t + "」"));
      return h("span.stash-tag-w", {}, name, x);
    })));
  }

  // ---- 操作 ----
  const act = (text, cls, fn, extra = {}) => {
    const b = h("button.btn.small" + cls, { type: "button", "data-act": cls.split(".").pop(), ...extra }, text);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
    return b;
  };
  const acts = h("div.stash-acts");
  if (ctx.use) {
    acts.append(act(ctx.use.label, ".primary.stash-use", async (b) => {
      try { await ctx.use.run(row); }
      catch (e) { notice({ what: "没能" + ctx.use.label + "。", why: "这一条的内容和现在的界面对不上，或者正文没能保存。可以先复制，再手动粘贴。", detail: String(e && (e.stack || e.message || e)) }); return; }
      if (!card.isConnected) return;
      card.classList.remove("used");
      void card.offsetWidth;
      card.classList.add("used");
      b.textContent = "已" + ctx.use.label.replace(/^已/, "");
      setTimeout(() => { if (b.isConnected) b.textContent = ctx.use.label; }, 1600);
    }));
  }
  acts.append(
    act("复制", ".ghost.stash-copy", async () => {
      if (await copyText(text)) toast("已复制");
      else notice({ what: "没能复制。", why: "浏览器不让网页写剪贴板。可以展开全文，选中后按 Ctrl+C。" });
    }),
    act(row.pinned ? "取消置顶" : "置顶", ".ghost.stash-pin", () => setPinned(row, !row.pinned), { "aria-pressed": String(!!row.pinned) }),
    act("加标签", ".ghost.stash-tag-add", async () => {
      const v = await prompt("给这一条加标签", "", "用空格隔开，比如：备选 要改");
      const add = parseTags(v);
      if (!add.length) return;
      const next = [...tags, ...add.filter((t) => !tags.includes(t))];
      if (next.length !== tags.length) setTags(row, next, "加标签「" + add.join("、") + "」");
    }),
    act("继续追问", ".ghost.stash-ask", () => followUp(row)),
    act(icon("trash"), ".ghost.stash-del", () => ctx.remove([row], [card]), { "aria-label": "删除", title: "删除这一条（能撤销）" }));
  card.append(acts);

  // 多选时点卡片空白处也能选
  if (ctx.selecting) {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button, input, a, label, summary")) return;
      ctx.onSelect(row.id, !ctx.selected.has(row.id));
    });
  }

  // 拖进正文
  if (ctx.draggable && (text || src)) {
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData("text/plain", text || "");
      if (src && !/^data:/.test(src)) e.dataTransfer.setData("text/uri-list", src);
      e.dataTransfer.effectAllowed = "copy";
      card.classList.add("dragging");
      document.body.classList.add("stash-dragging");
    });
    card.addEventListener("dragend", () => { card.classList.remove("dragging"); document.body.classList.remove("stash-dragging"); });
  }
  return card;
}

/** 列表重画后把焦点还给原来那一条的同一个按钮 */
export function focusKey(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a)) return null;
  const card = a.closest(".stash-card");
  return card ? { id: card.dataset.id, act: a.dataset.act || null } : { sel: a.className };
}
export function restoreFocus(root, key) {
  if (!key) return;
  if (key.id) {
    const card = [...root.querySelectorAll(".stash-card")].find((c) => c.dataset.id === key.id);
    const el = card && (key.act ? card.querySelector(`[data-act="${key.act}"]`) : null);
    if (el) el.focus({ preventScroll: true });
  }
}
