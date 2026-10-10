// 地图编辑：一层一张图，滚轮缩放、拖空白处平移。左边工具：移动、画笔、地形色块、河流道路边界、文字、图钉、子地图入口、橡皮；
// 底图可以上传自己画的。点入口进下一层（层数不限），顶上面包屑回上一层。图钉能连到设定库的地点卡，点一下看详情。
import { h, icon, toast, prompt, confirm } from "../../core/ui.js";
import { commands } from "../../core/commands.js";
import { bus } from "../../core/bus.js";
import { undo as appUndo } from "../../core/undo.js";
import { readMeta, listCards, catOf, valueOf } from "../../core/lore.js";
import { getMaps, edit, newMap, newItem, pathTo, subtree, putMapImage, getMapImage, TERRAINS, LINES, PEN_COLORS, LEVEL_NAMES } from "../../core/maps.js";

const NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
const r1 = (n) => Math.round(n * 10) / 10;
const composing = (e) => e.isComposing || e.keyCode === 229;

// 折线简化（拉默-道格拉斯-普克）：手画的线点太密，留下拐弯的地方
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const d2 = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = dx * dx + dy * dy; let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0; t = Math.max(0, Math.min(1, t)); const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1]; return x * x + y * y; };
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let best = 0, idx = -1;
    for (let i = a + 1; i < b; i++) { const d = d2(pts[i], pts[a], pts[b]); if (d > best) { best = d; idx = i; } }
    if (best > eps * eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// 平滑曲线（卡特穆尔-罗姆 → 三次贝塞尔）
function smooth(pts, closed = false) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]} ${pts[0][1]}` : "";
  if (pts.length === 2 && !closed) return `M${pts[0][0]} ${pts[0][1]}L${pts[1][0]} ${pts[1][1]}`;
  const p = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  let d = `M${r1(p[1][0])} ${r1(p[1][1])}`;
  for (let i = 1; i < p.length - 2; i++) {
    const [a, b, c, e] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    d += `C${r1(b[0] + (c[0] - a[0]) / 6)} ${r1(b[1] + (c[1] - a[1]) / 6)} ${r1(c[0] - (e[0] - b[0]) / 6)} ${r1(c[1] - (e[1] - b[1]) / 6)} ${r1(c[0])} ${r1(c[1])}`;
  }
  return d + (closed ? "Z" : "");
}

/** 上传的底图：最长边缩到 2400 */
async function decodeImage(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch (_) { /* 换个办法 */ } }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("这张图打不开")); img.src = url; });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function readMapImage(file) {
  const bmp = await decodeImage(file);
  const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), hgt = Math.round(bmp.height * k);
  const c = document.createElement("canvas"); c.width = w; c.height = hgt;
  c.getContext("2d").drawImage(bmp, 0, 0, w, hgt);
  if (bmp.close) bmp.close();
  return { data: c.toDataURL(file.type === "image/png" && w * hgt < 1.5e6 ? "image/png" : "image/jpeg", 0.9), w, h: hgt };
}

const TOOLS = [
  ["move", "移动", "drag", "V", "拖空白处平移；点入口进下一层，点图钉看地点；拖东西挪位置"],
  ["pen", "画笔", "pen", "B", "随手画"],
  ["area", "色块", "grid", "T", "圈一块地形：森林、水域、山地……"],
  ["line", "线条", "link", "L", "河流、道路、边界"],
  ["text", "文字", "format", "X", "点一下放文字"],
  ["pin", "图钉", "pin", "P", "点一下钉一个地点，可以连到设定库的地点卡"],
  ["portal", "入口", "focus", "E", "框出一块，设成下一层地图的入口"],
  ["erase", "橡皮", "trash", "D", "点一下擦掉一样东西"],
];

export function mountMap(root, { bookId, mapId: startId = null, onNav = () => {} }) {
  const st = { data: null, mapId: startId, view: { tx: 0, ty: 0, k: 1 }, tool: "move", sel: null, places: [], meta: null, bgUrl: null, bgId: null,
    pen: PEN_COLORS[0], penW: 3, terrain: "forest", line: "river", textSize: 22, destroyed: false };
  const offs = [];

  const svg = s("svg", { class: "mp-svg", role: "img", "aria-label": "地图" });
  const viewG = s("g", { class: "mp-view" });
  const paper = s("rect", { class: "mp-paper", x: 0, y: 0 });
  const bgImg = s("image", { class: "mp-bg", x: 0, y: 0, preserveAspectRatio: "xMidYMid meet" });
  const itemsG = s("g", { class: "mp-items" });
  const draftG = s("g", { class: "mp-draft" });
  const frame = s("rect", { class: "mp-frame", x: 0, y: 0 });
  // 画出纸外的部分裁掉
  const clipRect = s("rect", { x: 0, y: 0 });
  const defs = s("defs", {}, s("clipPath", { id: "mp-clip" }, clipRect));
  itemsG.setAttribute("clip-path", "url(#mp-clip)");
  viewG.append(paper, bgImg, itemsG, frame, draftG);
  svg.append(defs, viewG);
  const canvas = h("div.mp-canvas", { tabindex: "0", "aria-label": "地图画布：滚轮缩放，方向键挪选中的东西，Delete 删掉" }, svg);
  const crumbs = h("nav.mp-crumbs", { "aria-label": "地图层级" });
  const jump = h("select.select.mp-jump", { "aria-label": "跳到哪一层" });
  jump.addEventListener("change", () => { if (jump.value) go(jump.value); });
  const opts = h("div.mp-opts");
  const hint = h("p.mp-hint");
  const zoomTxt = h("span.mp-zoom-v");
  const zb = (t, title, fn) => { const b = h("button.icon-btn", { type: "button", title, "aria-label": title }, t); b.addEventListener("click", fn); return b; };
  const zoom = h("div.mp-zoom", {}, zb("−", "缩小", () => zoomBy(1 / 1.25)), zoomTxt, zb("+", "放大", () => zoomBy(1.25)), zb(icon("focus"), "整张放进窗口", () => fit()));
  const file = h("input", { type: "file", accept: "image/*", hidden: true });
  file.addEventListener("change", () => { if (file.files[0]) setBg(file.files[0]); file.value = ""; });
  const bgB = h("button.btn.small", { type: "button", title: "用自己画好的图当底图，在上面标注" }, icon("image"), "上传底图");
  bgB.addEventListener("click", () => file.click());
  const bgX = h("button.btn.small.ghost", { type: "button" }, "去掉底图");
  bgX.addEventListener("click", async () => { const { entry } = await edit(bookId, "去掉底图", (d) => { d.maps[st.mapId].bg = null; }); undoToast("去掉了底图", entry); });
  const toolBtns = TOOLS.map(([id, name, ic, key, tipText]) => {
    const b = h("button.mp-tool", { type: "button", "data-tool": id, title: `${name}（${key}）：${tipText}`, "aria-pressed": String(id === st.tool) }, icon(ic), h("span", {}, name));
    b.addEventListener("click", () => setTool(id));
    return b;
  });
  const side = h("aside.mp-side", { "aria-label": "工具" }, ...toolBtns, h("span.mp-side-sep"), bgB, bgX, file);
  root.replaceChildren(h("div.mp-root", {}, h("div.mp-bar", {}, crumbs, jump), h("div.mp-body", {}, side, h("div.mp-stage", {}, opts, canvas, zoom, hint))));

  const undoToast = (msg, entry) => toast(msg, entry ? { action: { label: "撤销", run: () => appUndo.undoEntry(entry) } } : {});
  const cur = () => st.data && st.data.maps[st.mapId];

  // ---------------- 视图：缩放、平移 ----------------
  function applyView() {
    const { tx, ty, k } = st.view;
    viewG.setAttribute("transform", `translate(${r1(tx)} ${r1(ty)}) scale(${k})`);
    zoomTxt.textContent = Math.round(k * 100) + "%";
    canvas.style.setProperty("--k", k);
  }
  function fit() {
    const m = cur(); if (!m) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const k = Math.min((r.width - 40) / m.w, (r.height - 40) / m.h);
    st.view = { k, tx: (r.width - m.w * k) / 2, ty: (r.height - m.h * k) / 2 };
    applyView();
  }
  function zoomAt(f, cx, cy) {
    const v = st.view, k = Math.max(0.15, Math.min(10, v.k * f));
    const mx = (cx - v.tx) / v.k, my = (cy - v.ty) / v.k;
    st.view = { k, tx: cx - mx * k, ty: cy - my * k };
    applyView();
  }
  function zoomBy(f) { const r = canvas.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); }
  const toMap = (e) => { const r = canvas.getBoundingClientRect(); return [r1((e.clientX - r.left - st.view.tx) / st.view.k), r1((e.clientY - r.top - st.view.ty) / st.view.k)]; };
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(Math.pow(1.0015, -e.deltaY * (e.ctrlKey ? 3 : 1)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });

  // ---------------- 画 ----------------
  function setTool(id) {
    st.tool = id;
    toolBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === id)));
    canvas.dataset.tool = id;
    select(null);
    paintOpts();
  }
  function paintOpts() {
    const chips = (list, curVal, set, swatch) => h("div.mp-chips", { role: "group" }, ...list.map((x) => {
      const b = h("button.mp-chip", { type: "button", "aria-pressed": String(x.id === curVal), style: swatch ? "--c:" + x.color : null }, swatch ? h("i") : null, x.name);
      b.addEventListener("click", () => { set(x.id); paintOpts(); });
      return b;
    }));
    const t = TOOLS.find((x) => x[0] === st.tool);
    hint.textContent = "滚轮缩放 · 空格加拖动平移 · 选中后 Delete 删掉、方向键挪 · 0 整张放进窗口 · 字母键换工具（V B T L X P E D）";
    if (st.tool === "pen") {
      opts.replaceChildren(h("span.mp-opt-k", {}, "颜色"), h("div.mp-chips", {}, ...PEN_COLORS.map((c) => { const b = h("button.mp-color", { type: "button", "aria-pressed": String(c === st.pen), "aria-label": "颜色 " + c, style: "--c:" + c }); b.addEventListener("click", () => { st.pen = c; paintOpts(); }); return b; })),
        h("span.mp-opt-k", {}, "粗细"), chips([{ id: 2, name: "细" }, { id: 4, name: "中" }, { id: 8, name: "粗" }], st.penW, (v) => { st.penW = v; }));
    } else if (st.tool === "area") opts.replaceChildren(h("span.mp-opt-k", {}, "地形"), chips(TERRAINS, st.terrain, (v) => { st.terrain = v; }, true));
    else if (st.tool === "line") opts.replaceChildren(h("span.mp-opt-k", {}, "画什么"), chips(LINES, st.line, (v) => { st.line = v; }));
    else if (st.tool === "text") opts.replaceChildren(h("span.mp-opt-k", {}, "字号"), chips([{ id: 16, name: "小" }, { id: 22, name: "中" }, { id: 34, name: "大" }, { id: 54, name: "地名" }], st.textSize, (v) => { st.textSize = v; }));
    else opts.replaceChildren(h("span.mp-opt-k.muted", {}, t ? t[1] + "：" + t[4] : ""));
  }

  function itemEl(it) {
    const g = s("g", { class: "mp-it mp-" + it.type + (it.id === st.sel ? " sel" : ""), "data-id": it.id });
    if (it.type === "pen") g.append(s("path", { class: "mp-hit", d: smooth(it.points) }), s("path", { d: smooth(it.points), stroke: it.color, "stroke-width": it.width, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }));
    else if (it.type === "area") {
      const t = TERRAINS.find((x) => x.id === it.terrain) || TERRAINS[0];
      g.classList.add("t-" + t.id);
      g.append(s("path", { class: "mp-area-fill", d: smooth(it.points, true), style: "--t:" + t.color }));
    } else if (it.type === "line") g.append(s("path", { class: "mp-hit", d: smooth(it.points) }), ...(it.kind === "river" ? [s("path", { class: "mp-river-o", d: smooth(it.points) }), s("path", { class: "mp-river-i", d: smooth(it.points) })] : [s("path", { class: "mp-" + it.kind, d: smooth(it.points) })]));
    else if (it.type === "text") g.append(s("text", { x: it.x, y: it.y, class: "mp-label" + (it.size >= 50 ? " big" : ""), "font-size": it.size }, it.text));
    else if (it.type === "pin") {
      const place = it.cardId && st.places.find((p) => p.id === it.cardId);
      const name = place ? place.name : it.label || "";
      g.setAttribute("transform", `translate(${it.x} ${it.y})`);
      g.append(s("g", { class: "mp-pin-mark" },
        s("path", { class: "pin-drop", d: "M0 0C-7-10-12-15-12-22a12 12 0 0 1 24 0c0 7-5 12-12 22z" }), s("circle", { class: "pin-drop-dot", cx: 0, cy: -22, r: 4.5 }),
        s("path", { class: "pin-star", d: "M0-38l4 9 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z" }), s("path", { class: "pin-star-stick", d: "M0-20V0" }),
        s("circle", { class: "pin-tack", cx: 0, cy: -20, r: 8 }), s("path", { class: "pin-tack-needle", d: "M0-12V0" }),
        s("rect", { class: "pin-seal", x: -10, y: -32, width: 20, height: 20, rx: 2 }), s("text", { class: "pin-seal-t", x: 0, y: -17 }, "印"),
        s("path", { class: "pin-gem", d: "M0-34l9 11-9 13-9-13z" }), s("path", { class: "pin-gem-stick", d: "M0-10V0" }),
        s("circle", { class: "pin-ring", cx: 0, cy: -16, r: 11 }), s("circle", { class: "pin-ring-dot", cx: 0, cy: -16, r: 3.5 }),
        s("path", { class: "pin-flag", d: "M0 0V-36M0-36h16l-4 6 4 6H0" })),
        name ? s("text", { class: "mp-pin-name", x: 14, y: -8 }, name) : null);
    } else if (it.type === "portal") {
      const child = st.data.maps[it.mapId];
      g.append(s("rect", { class: "mp-portal-box", x: it.x, y: it.y, width: it.w, height: it.h, rx: 8 }),
        s("text", { class: "mp-portal-name", x: it.x + 10, y: it.y + 24 }, "› " + (child ? child.name : "（这一层没了）")));
    }
    return g;
  }
  async function paint() {
    const m = cur();
    if (!m) return;
    paper.setAttribute("width", m.w); paper.setAttribute("height", m.h);
    frame.setAttribute("width", m.w); frame.setAttribute("height", m.h);
    clipRect.setAttribute("width", m.w); clipRect.setAttribute("height", m.h);
    bgImg.setAttribute("width", m.w); bgImg.setAttribute("height", m.h);
    if (m.bg) {
      if (st.bgId !== m.bg.id) { st.bgId = m.bg.id; st.bgUrl = await getMapImage(m.bg.id); }
      bgImg.setAttribute("href", st.bgUrl || "");
      bgImg.style.display = "";
    } else { st.bgId = null; bgImg.style.display = "none"; }
    bgX.hidden = !m.bg;
    const order = { area: 0, line: 1, pen: 2, portal: 3, text: 4, pin: 5 };
    itemsG.replaceChildren(...[...m.items].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9)).map(itemEl));
    // 面包屑
    const path = pathTo(st.data, st.mapId);
    crumbs.replaceChildren(...path.flatMap((x, i) => {
      const last = i === path.length - 1;
      const el = last ? h("button.mp-crumb.cur", { type: "button", title: "点一下改名字" }, x.name) : h("button.mp-crumb", { type: "button" }, x.name);
      el.addEventListener("click", () => (last ? rename() : go(x.id)));
      return i ? [h("span.mp-crumb-sep", { "aria-hidden": "true" }, "›"), el] : [el];
    }));
    // 跳到哪一层：整棵树
    const tree = [];
    const walk = (id, depth) => { const mm = st.data.maps[id]; if (!mm) return; tree.push([mm, depth]); Object.values(st.data.maps).filter((x) => x.parentId === id).forEach((x) => walk(x.id, depth + 1)); };
    walk(st.data.root, 0);
    jump.replaceChildren(h("option", { value: "" }, `跳到…（共 ${tree.length} 层）`), ...tree.map(([mm, d]) => h("option", { value: mm.id, disabled: mm.id === st.mapId }, "　".repeat(d) + mm.name)));
    jump.value = "";
  }

  // ---------------- 选中、挪动、删除 ----------------
  function select(id) {
    st.sel = id;
    itemsG.querySelectorAll(".mp-it").forEach((g) => g.classList.toggle("sel", g.dataset.id === id));
  }
  const itemOf = (id) => cur().items.find((x) => x.id === id);
  async function removeItem(id) {
    const it = itemOf(id); if (!it) return;
    const what = { pen: "一笔", area: "一块地形", line: "一条线", text: "文字", pin: "图钉", portal: "入口" }[it.type] || "一样东西";
    if (it.type === "portal" && st.data.maps[it.mapId] && (st.data.maps[it.mapId].items.length || Object.values(st.data.maps).some((x) => x.parentId === it.mapId))) {
      if (!(await confirm("删掉这个入口？", `「${st.data.maps[it.mapId].name}」这一层和它下面的地图一起删。删了可以撤销。`, "删掉", true))) return;
    }
    const { entry } = await edit(bookId, "擦掉" + what, (d) => {
      const m = d.maps[st.mapId];
      m.items = m.items.filter((x) => x.id !== id);
      if (it.type === "portal" && it.mapId) subtree(d, it.mapId).forEach((mid) => { delete d.maps[mid]; });
    });
    st.sel = null;
    undoToast("擦掉了" + what, entry);
  }
  const moveBy = (it, dx, dy) => {
    if (it.points) it.points = it.points.map(([x, y]) => [r1(x + dx), r1(y + dy)]);
    else { it.x = r1(it.x + dx); it.y = r1(it.y + dy); }
  };
  canvas.addEventListener("keydown", (e) => {
    if (e.target !== canvas) return;
    const k = e.key.toLowerCase();
    if ((e.key === "Delete" || e.key === "Backspace") && st.sel) { e.preventDefault(); removeItem(st.sel); return; }
    if (e.key === "Escape" && st.sel) { e.stopPropagation(); select(null); return; }
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (d && st.sel) { e.preventDefault(); const n = e.shiftKey ? 10 : 1; edit(bookId, "挪动", (dd) => { const it = dd.maps[st.mapId].items.find((x) => x.id === st.sel); if (it) moveBy(it, d[0] * n, d[1] * n); }); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = TOOLS.find((x) => x[3].toLowerCase() === k);
    if (t) { e.preventDefault(); setTool(t[0]); }
    if (e.key === "0") fit();
  });

  // ---------------- 按下、拖动、松开 ----------------
  let space = false;
  const onKey = (e) => { if (e.code === "Space" && document.activeElement === canvas) { space = e.type === "keydown"; canvas.classList.toggle("panning", space); if (space) e.preventDefault(); } };
  document.addEventListener("keydown", onKey); document.addEventListener("keyup", onKey);
  offs.push(() => { document.removeEventListener("keydown", onKey); document.removeEventListener("keyup", onKey); });

  canvas.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".mp-text-in, .mp-pop")) return;
    canvas.focus({ preventScroll: true });
    const p0 = toMap(e), c0 = [e.clientX, e.clientY];
    const hitG = e.target.closest && e.target.closest(".mp-it");
    const hit = hitG ? itemOf(hitG.dataset.id) : null;
    canvas.setPointerCapture(e.pointerId);
    const end = (fnUp, fnMove) => {
      const mv = (ev) => fnMove && fnMove(ev);
      const up = (ev) => { canvas.removeEventListener("pointermove", mv); canvas.removeEventListener("pointerup", up); canvas.removeEventListener("pointercancel", up); fnUp && fnUp(ev); };
      canvas.addEventListener("pointermove", mv); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
    };
    // 平移：中键、空格 + 拖，或者移动工具拖空白处
    if (e.button === 1 || space || (st.tool === "move" && !hit)) {
      const v0 = { ...st.view };
      canvas.classList.add("panning");
      end(() => { canvas.classList.remove("panning"); if (!hit && st.tool === "move" && Math.hypot(e.clientX - c0[0], e.clientY - c0[1]) < 4) { select(null); closePop(); } }, (ev) => { st.view = { ...v0, tx: v0.tx + ev.clientX - c0[0], ty: v0.ty + ev.clientY - c0[1] }; applyView(); });
      return;
    }
    if (e.button !== 0) return;
    if (st.tool === "move" && hit) {
      select(hit.id);
      let moved = false;
      end(async (ev) => {
        if (moved) {
          const [x, y] = toMap(ev);
          await edit(bookId, "挪动", (d) => { const it = d.maps[st.mapId].items.find((q) => q.id === hit.id); if (it) moveBy(it, x - p0[0], y - p0[1]); });
          select(hit.id);
        } else if (hit.type === "portal") go(hit.mapId);
        else if (hit.type === "pin") pinPop(hit);
        else if (hit.type === "text") textInput(hit.x, hit.y, hit);
      }, (ev) => {
        if (!moved && Math.hypot(ev.clientX - c0[0], ev.clientY - c0[1]) < 4) return;
        moved = true;
        const [x, y] = toMap(ev);
        hitG.setAttribute("transform", (hit.type === "pin" ? `translate(${hit.x + x - p0[0]} ${hit.y + y - p0[1]})` : `translate(${x - p0[0]} ${y - p0[1]})`));
      });
      return;
    }
    if (st.tool === "erase") { if (hit) removeItem(hit.id); return; }
    // 文字框、图钉卡片在松手后才出来：按下时浏览器会把焦点放回画布，先出来的输入框会马上失焦
    if (st.tool === "text") { e.preventDefault(); end(() => textInput(p0[0], p0[1], null)); return; }
    if (st.tool === "pin") {
      e.preventDefault();
      end(async () => {
        const it = newItem("pin", { x: p0[0], y: p0[1], cardId: null, label: "" });
        await edit(bookId, "钉一个图钉", (d) => { d.maps[st.mapId].items.push(it); });
        pinPop(it, true);
      });
      return;
    }
    if (st.tool === "portal") {
      const box = s("rect", { class: "mp-draft-box", x: p0[0], y: p0[1], width: 0, height: 0 });
      draftG.replaceChildren(box);
      let b = null;
      end(async () => {
        draftG.replaceChildren();
        if (!b || b.w < 20 || b.h < 20) { toast("框大一点：按住拖出一块"); return; }
        const depth = pathTo(st.data, st.mapId).length;
        const name = await prompt("下一层地图叫什么？", LEVEL_NAMES[depth] || "新地图", "比如：北境、落霞镇");
        if (name == null) return;
        const child = newMap(name.trim() || "新地图", st.mapId, 1600, Math.round(1600 * Math.max(0.4, Math.min(1.6, b.h / b.w))));
        const { entry } = await edit(bookId, `框出入口「${child.name}」`, (d) => { d.maps[child.id] = child; d.maps[st.mapId].items.push(newItem("portal", { x: b.x, y: b.y, w: b.w, h: b.h, mapId: child.id })); });
        toast(`「${child.name}」的入口框好了，点它进去画下一层`, { actions: [{ label: "进去", run: () => go(child.id) }, { label: "撤销", run: () => appUndo.undoEntry(entry) }] });
      }, (ev) => {
        const [x, y] = toMap(ev);
        b = { x: Math.min(x, p0[0]), y: Math.min(y, p0[1]), w: Math.abs(x - p0[0]), h: Math.abs(y - p0[1]) };
        box.setAttribute("x", b.x); box.setAttribute("y", b.y); box.setAttribute("width", b.w); box.setAttribute("height", b.h);
      });
      return;
    }
    // 画笔、色块、线条：按住画，松手存
    const pts = [p0];
    const path = s("path", { class: "mp-draft-path t-" + st.tool, stroke: st.tool === "pen" ? st.pen : null, "stroke-width": st.tool === "pen" ? st.penW : null, style: st.tool === "area" ? "--t:" + (TERRAINS.find((x) => x.id === st.terrain) || TERRAINS[0]).color : null });
    draftG.replaceChildren(path);
    end(async () => {
      draftG.replaceChildren();
      const simple = simplify(pts, 1.2 / st.view.k);
      if (simple.length < 2 || (st.tool === "area" && simple.length < 3)) return;
      const label = { pen: "画了一笔", area: "画了一块" + ((TERRAINS.find((x) => x.id === st.terrain) || {}).name || "地形"), line: "画了一条" + ((LINES.find((x) => x.id === st.line) || {}).name || "线") }[st.tool];
      const data = st.tool === "pen" ? { color: st.pen, width: st.penW, points: simple } : st.tool === "area" ? { terrain: st.terrain, points: simple } : { kind: st.line, points: simple };
      await edit(bookId, label, (d) => { d.maps[st.mapId].items.push(newItem(st.tool, data)); });
    }, (ev) => {
      const p = toMap(ev), last = pts[pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2 / st.view.k) return;
      pts.push(p);
      path.setAttribute("d", smooth(pts, st.tool === "area"));
    });
  });

  // ---------------- 文字 ----------------
  function textInput(x, y, it) {
    closePop();
    const r = canvas.getBoundingClientRect();
    const inp = h("input.input.mp-text-in", { value: it ? it.text : "", placeholder: "写字，回车放下", "aria-label": "地图上的文字", style: `left:${st.view.tx + x * st.view.k}px;top:${st.view.ty + y * st.view.k - 18}px` });
    canvas.append(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = async (keep) => {
      if (done) return; done = true;
      const v = inp.value.trim();
      inp.remove();
      canvas.focus({ preventScroll: true });
      if (!keep) return;
      if (it) {
        if (v === it.text) return;
        if (!v) { removeItem(it.id); return; }
        await edit(bookId, "改文字", (d) => { const q = d.maps[st.mapId].items.find((z) => z.id === it.id); if (q) q.text = v; });
      } else if (v) await edit(bookId, "放了文字「" + v + "」", (d) => { d.maps[st.mapId].items.push(newItem("text", { x, y, text: v, size: st.textSize })); });
    };
    inp.addEventListener("keydown", (e) => { if (composing(e)) return; if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } });
    inp.addEventListener("blur", () => finish(true));
    void r;
  }

  // ---------------- 图钉：连地点卡 ----------------
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function pinPop(it, fresh = false) {
    closePop();
    const place = it.cardId && st.places.find((p) => p.id === it.cardId);
    const el = h("div.mp-pop", { role: "dialog", "aria-label": "图钉" });
    const pos = () => { el.style.left = Math.min(st.view.tx + it.x * st.view.k + 16, canvas.clientWidth - el.offsetWidth - 8) + "px"; el.style.top = Math.max(8, Math.min(st.view.ty + it.y * st.view.k - 20, canvas.clientHeight - el.offsetHeight - 8)) + "px"; };
    const setCard = async (cardId, label) => {
      await edit(bookId, cardId ? "图钉连到地点卡" : "改图钉", (d) => { const q = d.maps[st.mapId].items.find((z) => z.id === it.id); if (q) { q.cardId = cardId; q.label = label || ""; } });
      await load();
      const again = itemOf(it.id); if (again) pinPop(again);
    };
    const del = h("button.btn.small.ghost.mp-pop-del", { type: "button" }, icon("trash"), "拔掉");
    del.addEventListener("click", () => { closePop(); removeItem(it.id); });
    if (place) {
      const openB = h("button.btn.small.primary", { type: "button" }, icon("lore"), "打开卡片");
      openB.addEventListener("click", () => commands.run("cards.open", { bookId, id: place.id }));
      const swap = h("button.btn.small.ghost", { type: "button" }, "换一张");
      swap.addEventListener("click", () => setCard(null, ""));
      el.append(h("div.mp-pop-head", { style: "--c:" + place.color }, place.thumb ? h("img", { src: place.thumb, alt: "" }) : h("span.mp-pop-g", {}, "地"), h("div", {}, h("b", {}, place.name), h("span.mp-pop-cat", {}, place.cat))),
        ...place.lines.map(([k, v]) => h("p.mp-pop-l", {}, h("b", {}, k), " ", v)),
        place.lines.length ? null : h("p.mp-pop-l.muted", {}, "这张卡还没填内容。"),
        h("div.mp-pop-foot", {}, del, swap, openB));
    } else {
      const q = h("input.input", { placeholder: "搜地点卡，或者写个新地名", value: it.label || "", "aria-label": "地点" });
      const list = h("div.mp-pop-list");
      const fill = () => {
        const v = q.value.trim();
        const hits = st.places.filter((p) => !v || p.name.includes(v)).slice(0, 8);
        list.replaceChildren(...hits.map((p) => { const b = h("button.mp-pop-i", { type: "button", style: "--c:" + p.color }, h("i"), p.name); b.addEventListener("click", () => setCard(p.id, "")); return b; }),
          v && !st.places.some((p) => p.name === v) ? (() => { const b = h("button.mp-pop-i.new", { type: "button" }, "＋ 新建地点卡「" + v + "」"); b.addEventListener("click", async () => { const c = await commands.run("cards.new", { bookId, cat: "place", name: v, silent: true }); if (c) { await loadPlaces(); setCard(c.id, ""); } }); return b; })() : null,
          v ? (() => { const b = h("button.mp-pop-i.plain", { type: "button" }, "只写个名字「" + v + "」，不建卡"); b.addEventListener("click", () => setCard(null, v)); return b; })() : null);
      };
      q.addEventListener("input", fill);
      q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); const b = list.querySelector("button"); if (b) b.click(); } if (e.key === "Escape") { e.stopPropagation(); closePop(); } });
      fill();
      el.append(h("p.mp-pop-t", {}, fresh ? "钉在这里的是哪个地方？" : "这个图钉连到哪张地点卡？"), q, list, h("div.mp-pop-foot", {}, del));
      setTimeout(() => q.focus(), 0);
    }
    canvas.append(el);
    pop = el;
    pos();
  }

  async function loadPlaces() {
    const [meta, cards] = await Promise.all([readMeta(bookId), listCards(bookId)]);
    st.meta = meta;
    st.places = cards.filter((c) => c.name && ["place", "faction", "festival"].includes(catOf(meta, c).kind)).map((c) => {
      const cat = catOf(meta, c);
      const lines = (cat.fields || []).map((f) => [f.name, valueOf(c, f)]).filter(([, v]) => String(v || "").trim()).slice(0, 3);
      return { id: c.id, name: c.name, color: cat.color, cat: cat.name, thumb: c.img ? c.img.thumb : null, lines };
    });
  }

  // ---------------- 底图、层级 ----------------
  async function setBg(f) {
    let img;
    try { img = await readMapImage(f); } catch (e) { toast("这张图读不出来"); return; }
    const id = await putMapImage(img.data);
    const { entry } = await edit(bookId, "换底图", (d) => {
      const m = d.maps[st.mapId];
      // 还没画东西：地图按底图的比例来；已经画了：大小不变，图按比例放进去
      if (!m.items.length) { const k = 1600 / Math.max(img.w, img.h); m.w = Math.round(img.w * k); m.h = Math.round(img.h * k); }
      m.bg = { id, w: img.w, h: img.h };
    });
    fit();
    undoToast("底图换好了，在上面画吧", entry);
  }
  async function rename() {
    const m = cur();
    const name = await prompt("这一层地图叫什么？", m.name, "比如：北境");
    if (name == null || !name.trim() || name.trim() === m.name) return;
    const { entry } = await edit(bookId, `地图改名叫「${name.trim()}」`, (d) => { d.maps[st.mapId].name = name.trim(); });
    undoToast("改好名字了", entry);
  }
  function go(id) {
    if (!st.data.maps[id]) return;
    const deeper = pathTo(st.data, id).length > pathTo(st.data, st.mapId).length;
    st.mapId = id; st.sel = null;
    closePop();
    onNav(id);
    paint().then(() => { fit(); canvas.classList.remove("enter-in", "enter-out"); void canvas.offsetWidth; canvas.classList.add(deeper ? "enter-in" : "enter-out"); });
  }

  async function load() {
    const d = await getMaps(bookId);
    if (st.destroyed) return;
    st.data = d;
    if (!st.mapId || !d.maps[st.mapId]) st.mapId = d.root;
    await paint();
  }
  offs.push(bus.on("maps:changed", (d) => { if (d.bookId === bookId) load(); }));
  offs.push(bus.on("lore:changed", async (d) => { if (d.bookId === bookId) { await loadPlaces(); paint(); } }));
  const ro = new ResizeObserver(() => { if (!st.fitted && canvas.clientWidth) { st.fitted = true; fit(); } });
  ro.observe(canvas);
  offs.push(() => ro.disconnect());
  setTool("move");
  const ready = (async () => { await loadPlaces(); await load(); requestAnimationFrame(fit); })();
  return { ready, go: (id) => ready.then(() => go(id)), destroy() { st.destroyed = true; offs.forEach((f) => f()); }, state: () => ({ mapId: st.mapId, view: st.view }) };
}
