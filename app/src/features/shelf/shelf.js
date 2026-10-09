// 书架：书封 + 书名 + 简介摘要；悬停一会儿显示大封面和完整详情；新建作品填完书名就能开写。
// 作品信息表单里有作者名和「制作封面」（绘画模块的 paint.cover，书名、作者名在那边改了这边跟着变）。
import { listBooks, getBook, createBook, updateBook, trashBook, restoreFromTrash, listChapters } from "../../core/store.js";
import { nav } from "../../core/nav.js";
import { h, icon, modal, toast, confirm } from "../../core/ui.js";
import { getSettings, label } from "../../core/settings.js";
import { commands } from "../../core/commands.js";
import { bus } from "../../core/bus.js";
import { fmtTime } from "../../core/text.js";
import { setDemonBook, tip } from "../demon/demon.js";
import { lookButton } from "../../core/look.js";
import { styledCover } from "./covers.js";

const GENRES = ["奇幻", "玄幻", "仙侠", "武侠", "都市", "校园", "恋爱", "悬疑", "推理", "科幻", "历史", "西幻", "异世界", "穿越", "游戏", "种田", "轻小说", "古言", "日常"];

/** 没有封面时的默认书封：按现在的主题画成那一套的书（covers.js） */
export function defaultCover(title) {
  return styledCover(title, document.documentElement.dataset.paper || "magical");
}

/** 读取图片文件，裁成 3:4 后缩放到 600×800，返回 JPEG dataURL */
export function coverFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const r = 3 / 4;
      let sw = im.width, sh = im.height;
      if (sw / sh > r) sw = sh * r; else sh = sw / r;
      const c = document.createElement("canvas");
      c.width = 600; c.height = 800;
      c.getContext("2d").drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, 0, 0, 600, 800);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.88));
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片读不出来，可能文件损坏或格式不支持")); };
    im.src = url;
  });
}

// ---------------- 新建 / 编辑作品 ----------------
export function bookForm(book = null) {
  return new Promise((resolve) => {
    const data = { title: book ? book.title : "", author: book ? book.author || "" : "", intro: book ? book.intro : "", tags: book ? [...book.tags] : [], cover: book ? book.cover : "" };
    const titleIn = h("input.input", { value: data.title, placeholder: "书名", maxlength: "60", autofocus: true });
    const authorIn = h("input.input.book-author-in", { value: data.author, placeholder: "作者名（可空）", maxlength: "40", "aria-label": "作者" });
    const introIn = h("textarea.textarea", { placeholder: "简介（可以以后再写）", rows: "4" });
    introIn.value = data.intro;
    const tagBox = h("div.row.tag-pick");
    const renderTags = () => {
      tagBox.textContent = "";
      const all = [...new Set([...GENRES, ...data.tags])];
      all.forEach((g) => {
        const on = data.tags.includes(g);
        const b = h("button.tag" + (on ? ".on" : ""), { type: "button", "aria-pressed": String(on) }, g);
        b.addEventListener("click", () => { data.tags = on ? data.tags.filter((x) => x !== g) : [...data.tags, g]; renderTags(); });
        tagBox.append(b);
      });
      const add = h("input.input.tag-add", { placeholder: "自己加一个，回车" });
      add.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !(e.isComposing || e.keyCode === 229) && add.value.trim()) { e.preventDefault(); data.tags.push(add.value.trim()); renderTags(); }
      });
      tagBox.append(add);
    };
    renderTags();
    const coverImg = h("img.cover-prev", { alt: "书封预览" });
    const showCover = () => { coverImg.src = data.cover || defaultCover(titleIn.value); };
    showCover();
    titleIn.addEventListener("input", () => { if (!data.cover) showCover(); });
    const file = h("input", { type: "file", accept: "image/*", hidden: true });
    file.addEventListener("change", async () => {
      if (!file.files[0]) return;
      try { data.cover = await coverFromFile(file.files[0]); showCover(); }
      catch (e) { toast(e.message); }
    });
    // 制作封面：就地打开绘画界面，书名、作者名带过去；那边改了书名、作者名、换了封面，这边跟着变
    const paintBtn = h("button.btn.small.book-paint-btn", { type: "button", title: "用 AI 画封面：先出草稿，挑中的出高清，裁成 600×800" }, icon("brush"), "制作封面");
    paintBtn.addEventListener("click", () => {
      if (!commands.get("paint.cover")) { toast("封面制作还在做，下一版就有。"); return; }
      commands.run("paint.cover", {
        bookId: book ? book.id : null, title: titleIn.value, author: authorIn.value, intro: introIn.value, cover: data.cover,
        onMeta: ({ title, author }) => { titleIn.value = title; authorIn.value = author; if (!data.cover) showCover(); },
        onCover: (url) => { data.cover = url || ""; showCover(); },
      });
    });
    const coverCol = h("div.cover-col", {}, coverImg, paintBtn,
      h("button.btn.small", { type: "button", onclick: () => file.click() }, icon("upload"), "上传书封"),
      h("button.btn.small.ghost", { type: "button", onclick: () => { data.cover = ""; showCover(); } }, "用默认封面"),
      h("p.muted.small-note", {}, "会裁成 600×800"), file);
    const body = h("div.book-form", {}, coverCol,
      h("div.book-fields", {},
        h("div.book-names", {}, h("label.field", {}, h("span", {}, "书名"), titleIn), h("label.field", {}, h("span", {}, "作者"), authorIn)),
        h("label.field", {}, h("span", {}, "简介"), introIn),
        h("div.field", {}, h("span", {}, "类型标签（小恶魔会按类型换装）"), tagBox)));
    let result = null;
    const dirty = () => !book && (titleIn.value.trim() || introIn.value.trim());
    const m = modal({
      title: book ? "作品信息" : "新建作品",
      body, wide: true,
      isDirty: () => result == null && dirty(),
      onClose: () => resolve(result),
      actions: [
        { label: book ? "保存" : "开始写", primary: true, onClick: () => {
          result = { title: titleIn.value.trim() || "未命名作品", author: authorIn.value.trim(), intro: introIn.value.trim(), tags: data.tags, cover: data.cover };
          m.close(true);
        } },
        { label: "取消", onClick: () => m.close() },
      ],
    });
  });
}

// ---------------- 书架界面 ----------------
export async function renderShelf(root, restore) {
  setDemonBook(null);
  const books = await listBooks();
  const grid = h("div.shelf-grid");
  const view = h("div.view.shelf",
    {},
    h("header.topbar", {},
      h("span.brand", {}, "小恶魔文书"),
      h("span.spacer"),
      h("button.tool-btn", { type: "button", onclick: () => commands.run("io.import") }, icon("upload"), "导入"),
      h("button.tool-btn", { type: "button", "data-cmd": "prompts.open", onclick: () => commands.run("prompts.open") }, icon("prompt"), "提示词"),
      h("button.tool-btn", { type: "button", "data-cmd": "stash.open", onclick: () => commands.run("stash.open") }, icon("box"), label("暂存盒")),
      h("button.tool-btn", { type: "button", onclick: () => nav.go("/trash") }, icon("trash"), label("回收站")),
      lookButton(),
      h("button.tool-btn", { type: "button", onclick: () => nav.go("/settings") }, icon("gear"), label("设置")),
      h("button.btn.primary", { type: "button", onclick: newBook }, icon("plus"), "新建作品")),
    h("main.shelf-main", {}, grid));
  root.replaceChildren(view);

  if (!books.length) {
    grid.replaceWith(h("div.shelf-empty", {},
      h("p.shelf-empty-t", {}, "书架还是空的"),
      h("p.muted", {}, "新建一本，或者把写好的 txt 导进来。"),
      h("div.row", {}, h("button.btn.primary", { type: "button", onclick: newBook }, icon("plus"), "新建作品"),
        h("button.btn", { type: "button", onclick: () => commands.run("io.import") }, icon("upload"), "导入 txt"))));
  }
  for (const b of books) grid.append(bookCard(b));
  if (restore && restore.shelfScroll) view.querySelector(".shelf-main").scrollTop = restore.shelfScroll;
  nav.onLeave(() => ({ shelfScroll: view.querySelector(".shelf-main") ? view.querySelector(".shelf-main").scrollTop : 0 }));
  if (books.length) tip("shelf-hover", "鼠标在书上停一会儿，能看到大封面和完整简介；右上角「…」可以改信息。");
}

function bookCard(b) {
  const card = h("article.book-card", { tabindex: "0", "aria-label": b.title, "data-id": b.id },
    h("img.book-cover", { src: b.cover || defaultCover(b.title), alt: "", "data-default-title": b.cover ? null : b.title || "" }),
    h("div.book-meta", {},
      h("h3.book-title", {}, b.title),
      h("p.book-intro", {}, b.intro || "还没有简介"),
      h("p.book-time", {}, "上次打开 " + fmtTime(b.openedAt || b.updatedAt))));
  const more = h("button.icon-btn.book-more", { type: "button", "aria-label": "更多操作", title: "更多操作" }, icon("more"));
  card.append(more);
  const open = () => nav.go("/book/" + b.id);
  card.addEventListener("click", (e) => { if (!e.target.closest(".book-more")) open(); });
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === card) open(); });
  more.addEventListener("click", (e) => { e.stopPropagation(); bookMenu(b, more); });
  hoverCard(card, b);
  return card;
}

async function newBook() {
  const data = await bookForm();
  if (!data) return;
  const book = await createBook(data);
  nav.go("/book/" + book.id);
}

function bookMenu(b, anchor) {
  const menu = h("div.menu", { role: "menu" });
  const item = (text, fn, danger) => {
    const it = h("button.menu-item" + (danger ? ".danger" : ""), { type: "button", role: "menuitem" }, text);
    it.addEventListener("click", () => { close(); fn(); });
    menu.append(it);
  };
  item("打开", () => nav.go("/book/" + b.id));
  item("修改作品信息", async () => {
    const data = await bookForm(b);
    if (data) { await updateBook(b.id, data); nav.go("/", { replace: true }); }
  });
  item("导出 txt", () => commands.run("io.export", b.id));
  item("删除作品", async () => {
    const n = (await listChapters(b.id)).length;
    if (!(await confirm("删除《" + b.title + "》？", `连同 ${n} 章一起放进${label("回收站")}，30 天内都能找回来。`, "删除", true))) return;
    const tid = await trashBook(b.id);
    nav.go("/", { replace: true });
    toast("已删除《" + b.title + "》", { action: { label: "撤销", run: async () => { await restoreFromTrash(tid); nav.go("/", { replace: true }); } } });
  }, true);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + 4 + "px";
  menu.style.left = Math.max(8, r.right - 180) + "px";
  const off = (e) => { if (!menu.contains(e.target)) close(); };
  const close = () => { menu.remove(); document.removeEventListener("mousedown", off, true); document.removeEventListener("keydown", esc, true); };
  const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); anchor.focus(); } };
  setTimeout(() => { document.addEventListener("mousedown", off, true); document.addEventListener("keydown", esc, true); }, 0);
  menu.querySelector("button").focus();
}

/** 悬停显示大封面 + 完整详情，延迟可在设置里改 */
function hoverCard(card, b) {
  let timer = 0, pop = null;
  const show = async () => {
    b = (await getBook(b.id)) || b;
    const chapters = await listChapters(b.id);
    const words = chapters.reduce((s, c) => s + (c.words || 0), 0);
    pop = h("div.book-pop", { role: "tooltip" },
      h("img.book-pop-cover", { src: b.cover || defaultCover(b.title), alt: "" }),
      h("div.book-pop-meta", {},
        h("h3", {}, b.title),
        b.author ? h("p.book-pop-author", {}, "作者：" + b.author) : null,
        h("div.row", {}, ...(b.tags || []).map((t) => h("span.chip", {}, t))),
        h("p.muted", {}, `${chapters.length} 章 · ${words.toLocaleString()} 字`),
        h("p.book-pop-intro", {}, b.intro || "还没有简介")));
    document.body.append(pop);
    const r = card.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.right + 10;
    if (left + pw > innerWidth - 8) left = Math.max(8, r.left - pw - 10);
    pop.style.left = left + "px";
    pop.style.top = Math.max(8, Math.min(r.top, innerHeight - ph - 8)) + "px";
  };
  const hide = () => { clearTimeout(timer); if (pop) { pop.remove(); pop = null; } };
  card.addEventListener("mouseenter", () => { timer = setTimeout(show, getSettings().hoverDelay || 500); });
  card.addEventListener("mouseleave", hide);
  card.addEventListener("click", hide);
}

export function registerShelf() {
  nav.route("shelf", "/", (params, restore) => renderShelf(document.getElementById("app"), restore));
  commands.register({ id: "book.new", title: "新建作品", keywords: "新书 开新坑 创建", hint: "填书名就能开写", run: newBook });
  commands.register({ id: "nav.shelf", title: "回到书架", keywords: "书架 首页 作品列表", run: () => nav.go("/") });
  bus.on("book:deleted", () => {});
  // 换主题：没有自己封面的书换成那一套的书封
  const recover = () => setTimeout(() => {
    for (const im of document.querySelectorAll("img.book-cover[data-default-title]")) {
      const src = defaultCover(im.dataset.defaultTitle);
      if (im.src !== src) im.src = src;
    }
  }, 0);
  bus.on("settings:changed", recover);
  bus.on("demon:style", recover);
  // 作品信息变了（换了封面、改了书名，或者撤销）：书架上那张卡跟着换
  bus.on("book:updated", ({ book }) => {
    if (!book) return;
    const card = [...document.querySelectorAll(".book-card[data-id]")].find((c) => c.dataset.id === book.id);
    if (!card) return;
    card.setAttribute("aria-label", book.title);
    const im = card.querySelector("img.book-cover");
    if (im) {
      const src = book.cover || defaultCover(book.title);
      if (im.getAttribute("src") !== src) im.src = src;
      if (book.cover) im.removeAttribute("data-default-title"); else im.dataset.defaultTitle = book.title || "";
    }
    const t = card.querySelector(".book-title");
    if (t) t.textContent = book.title;
    const intro = card.querySelector(".book-intro");
    if (intro) intro.textContent = book.intro || "还没有简介";
  });
}
