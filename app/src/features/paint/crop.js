// 裁剪框：图按原比例摆在台子上，上面一个固定比例的框（封面 3:4），框外压暗。
// 拖框移动，拖四个角缩放，滚轮缩放，方向键微调（Shift 走大步），+ / - 缩放，0 复原；下面的滑块也能放大。
// result(w, h) 把框里的原图像素画到 w×h 的画布上，返回 dataURL。
import { h } from "../../core/ui.js";

/** cropper({ src, ratio: [3, 4], onChange }) → { el, ready, result(outW, outH, type?, quality?), area(), reset(), destroy() } */
export function cropper({ src, ratio = [3, 4], onChange }) {
  const [rw, rh] = ratio;
  const img = h("img.paint-crop-img", { alt: "要裁的图", draggable: "false" });
  const hd = (k) => h("span.paint-crop-hd.hd-" + k, { "data-h": k, "aria-hidden": "true" });
  const frame = h("div.paint-crop-frame", { tabindex: "0", role: "group",
    "aria-label": "裁剪框：拖动移动，拖角或滚轮缩放，方向键微调，加减号缩放，0 复原" },
  h("span.paint-crop-third.t-v1"), h("span.paint-crop-third.t-v2"), h("span.paint-crop-third.t-h1"), h("span.paint-crop-third.t-h2"),
  hd("tl"), hd("tr"), hd("bl"), hd("br"));
  const stage = h("div.paint-crop-stage", {}, img, frame);
  const zoom = h("input.paint-crop-zoom", { type: "range", min: "100", max: "500", step: "1", value: "100", "aria-label": "放大" });
  const zoomV = h("span.paint-crop-zv", {}, "100%");
  const resetBtn = h("button.btn.small.ghost.paint-crop-reset", { type: "button" }, "复原");
  const el = h("div.paint-crop", {}, stage,
    h("div.paint-crop-tools", {}, h("label.paint-crop-zl", {}, h("span", {}, "放大"), zoom, zoomV), resetBtn,
      h("span.paint-crop-hint", {}, "拖框移动 · 拖角或滚轮缩放 · 方向键微调")));

  const N = { w: 0, h: 0 };          // 原图大小
  const F = { x: 0, y: 0, w: 0 };    // 框（原图像素），高 = 宽 × rh / rw
  let D = { s: 1, ox: 0, oy: 0 };    // 原图在台子上的缩放和偏移
  const fh = (w) => (w * rh) / rw;
  const maxW = () => Math.min(N.w, (N.h * rw) / rh);
  const minW = () => Math.min(maxW(), Math.max(48, maxW() * 0.12));

  function clamp() {
    F.w = Math.max(minW(), Math.min(maxW(), F.w));
    F.x = Math.max(0, Math.min(N.w - F.w, F.x));
    F.y = Math.max(0, Math.min(N.h - fh(F.w), F.y));
  }
  function layout() {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height || !N.w) return;
    // 四周留一圈，拖角的把手不会被台子边缘切掉
    const pad = Math.min(22, r.width * 0.06, r.height * 0.06);
    const s = Math.min((r.width - pad * 2) / N.w, (r.height - pad * 2) / N.h);
    D = { s, ox: (r.width - N.w * s) / 2, oy: (r.height - N.h * s) / 2 };
    Object.assign(img.style, { width: N.w * s + "px", height: N.h * s + "px", left: D.ox + "px", top: D.oy + "px" });
    paint();
  }
  function paint() {
    Object.assign(frame.style, { left: D.ox + F.x * D.s + "px", top: D.oy + F.y * D.s + "px", width: F.w * D.s + "px", height: fh(F.w) * D.s + "px" });
    const z = Math.round((maxW() / (F.w || 1)) * 100);
    zoom.value = String(z);
    zoomV.textContent = z + "%";
    zoom.style.setProperty("--p", (((z - 100) / 400) * 100).toFixed(1) + "%");
    onChange && onChange();
  }
  function reset() {
    F.w = maxW();
    F.x = (N.w - F.w) / 2;
    F.y = (N.h - fh(F.w)) / 2;
    paint();
  }
  /** k > 1 放大（框变小），以 (cx, cy) 为中心（原图像素，默认框中心） */
  function zoomBy(k, cx, cy) {
    const ox = cx == null ? F.x + F.w / 2 : cx, oy = cy == null ? F.y + fh(F.w) / 2 : cy;
    const fx = (ox - F.x) / F.w, fy = (oy - F.y) / fh(F.w);
    F.w = Math.max(minW(), Math.min(maxW(), F.w / k));
    F.x = ox - fx * F.w;
    F.y = oy - fy * fh(F.w);
    clamp();
    paint();
  }
  const toNat = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left - D.ox) / D.s, y: (e.clientY - r.top - D.oy) / D.s };
  };

  // 拖：框本身移动，四个角缩放（对角不动）
  frame.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    frame.focus({ preventScroll: true });
    const k = e.target.dataset && e.target.dataset.h;
    const p0 = toNat(e), f0 = { ...F };
    const ax = k && k.includes("l") ? F.x + F.w : F.x, ay = k && k.includes("t") ? F.y + fh(F.w) : F.y;
    frame.setPointerCapture(e.pointerId);
    frame.classList.add(k ? "sizing" : "moving");
    const move = (ev) => {
      const p = toNat(ev);
      if (!k) {
        F.x = f0.x + (p.x - p0.x);
        F.y = f0.y + (p.y - p0.y);
        clamp();
      } else {
        const roomX = k.includes("l") ? ax : N.w - ax, roomY = ((k.includes("t") ? ay : N.h - ay) * rw) / rh;
        const w = Math.max(minW(), Math.min(Math.max(Math.abs(p.x - ax), (Math.abs(p.y - ay) * rw) / rh), roomX, roomY));
        F.w = w;
        F.x = k.includes("l") ? ax - w : ax;
        F.y = k.includes("t") ? ay - fh(w) : ay;
      }
      paint();
    };
    const up = () => {
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerup", up);
      frame.removeEventListener("pointercancel", up);
      frame.classList.remove("sizing", "moving");
    };
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", up);
    frame.addEventListener("pointercancel", up);
  });
  stage.addEventListener("wheel", (e) => {
    if (!N.w) return;
    e.preventDefault();
    const p = toNat(e);
    zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08, Math.max(0, Math.min(N.w, p.x)), Math.max(0, Math.min(N.h, p.y)));
  }, { passive: false });
  frame.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? N.w * 0.05 : Math.max(1, N.w * 0.008);
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) { F.x += mv[0]; F.y += mv[1]; clamp(); paint(); }
    else if (e.key === "+" || e.key === "=") zoomBy(1.08);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.08);
    else if (e.key === "0" || e.key === "Home") reset();
    else return;
    e.preventDefault();
  });
  zoom.addEventListener("input", () => {
    const want = maxW() / (Number(zoom.value) / 100);
    zoomBy(F.w / want);
  });
  resetBtn.addEventListener("click", reset);

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => layout()) : null;
  const ready = new Promise((resolve) => {
    img.onload = () => {
      N.w = img.naturalWidth; N.h = img.naturalHeight;
      reset();
      if (ro) ro.observe(stage);
      requestAnimationFrame(() => { layout(); resolve(true); });
    };
    img.onerror = () => resolve(false);
  });
  img.src = src;

  return {
    el, ready,
    /** 框里的原图区域（原图像素） */
    area: () => ({ x: F.x, y: F.y, w: F.w, h: fh(F.w), nw: N.w, nh: N.h }),
    /** 把框里的部分画到 outW×outH，返回 dataURL */
    result(outW, outH, type = "image/jpeg", quality = 0.9) {
      const c = document.createElement("canvas");
      c.width = outW; c.height = outH;
      const g = c.getContext("2d");
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.fillStyle = "#fff";
      g.fillRect(0, 0, outW, outH);
      g.drawImage(img, F.x, F.y, F.w, fh(F.w), 0, 0, outW, outH);
      return c.toDataURL(type, quality);
    },
    /** 画一张小预览 */
    drawTo(canvas) {
      if (!N.w) return;
      const g = canvas.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(img, F.x, F.y, F.w, fh(F.w), 0, 0, canvas.width, canvas.height);
    },
    reset,
    focus: () => frame.focus({ preventScroll: true }),
    destroy() { if (ro) ro.disconnect(); },
  };
}
