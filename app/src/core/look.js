// 配色和明暗：手选一套，或者自动变（跟随小恶魔 / 随时间 / 随季节；明暗可以随时间）。
// 顶栏的「配色」按钮弹出小面板，随手切换，不用进设置页。
import { getSettings, setSettings } from "./settings.js";
import { PALETTES } from "./pattern.js";
import { h, icon, pushLayer } from "./ui.js";

/** 一天里的时段 → 配色 */
export function paletteByTime(d = new Date()) {
  const hr = d.getHours();
  if (hr >= 6 && hr < 11) return "sailor";       // 早上：教室
  if (hr >= 11 && hr < 17) return "adventurer";  // 下午：冒险者公会
  if (hr >= 17 && hr < 20) return "detective";   // 傍晚：旧书房
  return "gothic";                               // 夜里：暗夜魔典
}

/** 季节 → 配色（按北半球月份） */
export function paletteBySeason(d = new Date()) {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 5) return "magical";        // 春：粉白
  if (m >= 6 && m <= 8) return "sailor";         // 夏：教室
  if (m >= 9 && m <= 11) return "detective";     // 秋：旧书房
  return "hanfu";                                // 冬：宣纸墨色
}

/** 现在该用哪套配色。demonStyle：小恶魔现在穿的风格 */
export function resolvePalette(s, demonStyle) {
  if (s.palette === "follow") return demonStyle || "magical";
  if (s.palette === "time") return paletteByTime();
  if (s.palette === "season") return paletteBySeason();
  return s.palette || "magical";
}

/** 现在是不是深色 */
export function resolveDark(s) {
  if (s.theme === "dark") return true;
  if (s.theme === "light") return false;
  if (s.theme === "time") { const hr = new Date().getHours(); return hr >= 20 || hr < 6; }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

export const AUTO_PALETTES = [
  { id: "follow", name: "跟随小恶魔", sub: "按作品换" },
  { id: "time", name: "随时间", sub: "早·午·傍晚·夜" },
  { id: "season", name: "随季节", sub: "春夏秋冬" },
];
export const DARK_MODES = [["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"], ["time", "随时间"]];

function paletteName(id) {
  const p = PALETTES.find((x) => x.id === id) || AUTO_PALETTES.find((x) => x.id === id);
  return p ? p.name : id;
}

/** 顶栏用的「配色」按钮 */
export function lookButton() {
  const b = h("button.tool-btn.look-btn", { type: "button", title: "换配色、明暗", "aria-label": "换配色" }, swatchIcon(), h("span.tb-t", {}, "配色"));
  b.addEventListener("click", () => openLookPop(b));
  return b;
}

function swatchIcon() {
  return h("span.look-ico", { "aria-hidden": "true" }, h("i"), h("i"), h("i"));
}

let pop = null;
export function openLookPop(anchor) {
  if (pop) { pop.layer.close(); return; }
  const s = () => getSettings();
  const box = h("div.look-pop", { role: "dialog", "aria-label": "配色和明暗" });
  const render = () => {
    const cur = s().palette;
    box.replaceChildren(
      h("div.look-head", {}, h("b", {}, "配色"), h("button.icon-btn", { type: "button", "aria-label": "关闭", onclick: () => layerObj.close() }, icon("close"))),
      h("div.look-grid", {},
        ...AUTO_PALETTES.map((p) => item(p.id, p.name, p.sub, null, cur === p.id)),
        ...PALETTES.map((p) => item(p.id, p.name, p.style, p.swatch, cur === p.id))),
      h("div.look-head", {}, h("b", {}, "明暗")),
      h("div.look-seg", { role: "group", "aria-label": "明暗" }, ...DARK_MODES.map(([v, t]) => {
        const btn = h("button", { type: "button", "aria-pressed": String(s().theme === v) }, t);
        btn.addEventListener("click", async () => { await setSettings({ theme: v }); render(); });
        return btn;
      })),
      h("p.look-note", {}, nowText()));
  };
  const item = (id, name, sub, swatch, on) => {
    const sw = swatch ? h("span.look-sw", {}, ...swatch.map((c) => h("i", { style: { background: c } }))) : h("span.look-sw.auto", {}, "↻");
    const btn = h("button.look-item", { type: "button", "aria-pressed": String(on) }, sw, h("span.look-n", {}, name), h("span.look-s", {}, sub));
    btn.addEventListener("click", async () => { await setSettings({ palette: id }); render(); });
    return btn;
  };
  const nowText = () => {
    const st = s();
    const auto = AUTO_PALETTES.find((p) => p.id === st.palette);
    const dark = DARK_MODES.find(([v]) => v === st.theme);
    return (auto ? `现在是「${paletteName(resolvePalette(st, document.documentElement.dataset.palette || "magical"))}」` : "") + (dark ? ` · ${dark[1]}` : "");
  };
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.top = r.bottom + 6 + "px";
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - 336)) + "px";
  const off = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) layerObj.close(); };
  const layerObj = pushLayer({ onClose: () => { box.remove(); pop = null; document.removeEventListener("mousedown", off, true); } });
  pop = { layer: layerObj };
  setTimeout(() => document.addEventListener("mousedown", off, true), 0);
  render();
  box.querySelector(".look-item[aria-pressed=\"true\"]")?.focus();
}
