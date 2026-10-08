// gothic 这套的码字进度：铁烛台上五根蜡烛，一根管五分之一，一根根点亮；正在点的那根，火苗从一粒火星长成整朵。
// 右边一轮月亮跟着从新月长到满月。平时烛火晃、偶尔滴一滴蜡；刚涨字正在点的火苗蹿高、迸出火星，月亮边上闪一下；
// 写满了：月亮变成一轮血月，外面一圈红晕慢慢呼吸，五根烛火全换成紫色鬼火，一只蝙蝠从月亮前面飞过。
// 牌子永远是黑紫底（styles/paper/gothic.css），颜色按暗底来配。
const N = 5, CX = [3, 9, 15, 21, 27];        // 每根蜡烛的左边（蜡身 3 格宽）
const CH = [5, 7, 6, 7, 5];                  // 蜡烛高矮不一
const BASE = 12;                             // 烛台横梁所在的行
const MX = 37, MY = 6.5, MR = 5.2;           // 月亮

const WAX = "#efe3d2", WAX_S = "#c4b09c", WAX_H = "#fff8ec", WICK = "#3a2626";
const IRON = "#6b5672", IRON_H = "#9c86a6", IRON_D = "#3a2a40";
const F_CORE = "#fff6d0", F_MID = "#ffc24a", F_OUT = "#ff7a2e";
const G_CORE = "#f3e6ff", G_MID = "#c99bff", G_OUT = "#7d4dff";
const MOON = "#f1ead6", MOON_S = "#d6cbb2", MOON_DARK = "#2c2234", MOON_EDGE = "#5c4b68";
const BLOOD = "#e0577f", BLOOD_D = "#a41d45", BLOOD_H = "#ffb3c6", BLOOD_HALO = "#6d1030";

function px(g, x, y, col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }
function rect(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }

/** 一朵火苗：size 0（火星）–3（整朵，蹿高时 4），x 是蜡烛中间那格，top 是烛芯上面一行 */
function flame(g, x, top, size, t, k, ghost) {
  const core = ghost ? G_CORE : F_CORE, mid = ghost ? G_MID : F_MID, out = ghost ? G_OUT : F_OUT;
  const sway = size >= 2 && Math.floor(t * 3 + k * 1.7) % 4 === 0 ? (k % 2 ? 1 : -1) : 0;  // 偶尔往一边歪
  if (size <= 0) { px(g, x, top, (Math.floor(t * 6 + k) % 2) ? mid : out); return; }
  if (size === 1) { px(g, x, top, mid); px(g, x, top - 1, out); return; }
  const tall = size >= 4 ? 5 : size === 3 ? 4 : 3;
  // 外焰
  for (let i = 0; i < tall; i++) {
    const y = top - i, dx = i >= tall - 2 ? sway : 0;
    if (i < tall - 2) { px(g, x - 1, y, out); px(g, x + 1, y, out); }
    px(g, x + dx, y, i === tall - 1 ? out : mid);
  }
  // 焰心
  px(g, x, top, core);
  if (tall >= 4) px(g, x, top - 1, core);
}

export default {
  w: 44, h: 14, animated: true,
  draw(g, s) {
    const { t, done } = s;
    const fresh = s.bump < 0.6;
    const p = Math.max(0, Math.min(1, s.shown));
    const lit = done ? N : Math.floor(p * N + 1e-6);           // 点亮了几根
    const part = done ? 1 : p * N - lit;                        // 正在点的那根点到哪

    // ---------- 月亮 ----------
    if (done) {
      // 血月：外面一圈红晕呼吸
      const breath = 0.5 + 0.5 * Math.sin(t * 2);
      for (let y = 0; y < 14; y++) for (let x = 30; x < 44; x++) {
        const d = Math.hypot(x + .5 - MX - .5, y + .5 - MY - .5);
        if (d > MR + .3 && d < MR + 1.4 + breath * .9 && (x + y) % 2 === 0) px(g, x, y, BLOOD_HALO);
      }
    }
    for (let y = 0; y < 14; y++) for (let x = 30; x < 44; x++) {
      const dx = x + .5 - MX - .5, dy = y + .5 - MY - .5, d = Math.hypot(dx, dy);
      if (d > MR) continue;
      const edge = d > MR - 1;
      if (done) {
        let col = edge ? BLOOD_D : BLOOD;
        if (dx < -1 && dy < -1 && d < MR - 1.5) col = BLOOD_H;
        if ((Math.round(dx) === 1 && Math.round(dy) === 1) || (Math.round(dx) === -2 && Math.round(dy) === 2)) col = BLOOD_D;
        px(g, x, y, col);
        continue;
      }
      // 新月 → 满月：右边先亮，明暗交界按椭圆走
      const hw = Math.sqrt(Math.max(0, MR * MR - dy * dy));
      const on = p > 0 && dx > hw * (1 - 2 * p);
      if (on) px(g, x, y, (Math.round(dx) === 1 && Math.round(dy) === 1) || (Math.round(dx) === -1 && Math.round(dy) === -2) ? MOON_S : MOON);
      else px(g, x, y, edge ? MOON_EDGE : MOON_DARK);
    }
    // 刚涨字：月亮边上闪一颗小星
    if (fresh && !done) {
      const k = s.bump < 0.3 ? 1 : 0;
      px(g, 43, 1, "#ffffff"); if (k) { px(g, 42, 1, "#c9bcd8"); px(g, 43, 2, "#c9bcd8"); px(g, 43, 0, "#c9bcd8"); }
    }

    // ---------- 烛台：铁横梁，两头卷起，下面一个托 ----------
    rect(g, 1, BASE, 30, 1, IRON);
    rect(g, 2, BASE, 28, 1, IRON_H);
    px(g, 0, BASE - 1, IRON); px(g, 31, BASE - 1, IRON); px(g, 1, BASE - 1, IRON_D); px(g, 30, BASE - 1, IRON_D);
    rect(g, 14, BASE + 1, 5, 1, IRON_D);
    rect(g, 13, 13, 7, 1, IRON);

    // ---------- 蜡烛 ----------
    const ghost = done;
    for (let k = 0; k < N; k++) {
      const x0 = CX[k], top = BASE - CH[k];
      // 托盘
      rect(g, x0 - 1, BASE - 1, 5, 1, IRON_D);
      // 蜡身：左边亮、右边阴影
      rect(g, x0, top, 3, CH[k] - 1, WAX);
      rect(g, x0 + 2, top, 1, CH[k] - 1, WAX_S);
      px(g, x0, top, WAX_H);
      // 点过的蜡烛顶上化开一点，偶尔往下淌一滴
      const on = k < lit, cur = k === lit && !done;
      if (on) {
        px(g, x0 + 1, top, WAX_S);
        const dl = (t * 0.35 + k * 0.37) % 1;
        if (dl < 0.6) px(g, x0, top + 1 + Math.floor(dl * (CH[k] - 3)), WAX_H);
      }
      // 烛芯
      px(g, x0 + 1, top - 1, WICK);
      if (on) {
        const flare = fresh && k === lit - 1 && part < 0.05;
        flame(g, x0 + 1, top - 2, flare ? 4 : 3, t, k, ghost);
      } else if (cur && part > 0) {
        // 正在点：火星 → 小火苗 → 大一点
        const sz = part < 0.34 ? 0 : part < 0.67 ? 1 : 2;
        flame(g, x0 + 1, top - 2, fresh ? Math.min(4, sz + 2) : sz, t, k, false);
        // 刚涨字：迸出两粒火星
        if (fresh) {
          const q = s.bump / 0.6, dy = Math.round(q * 3);
          px(g, x0 - 1 - Math.round(q), top - 3 - dy, F_MID);
          px(g, x0 + 3 + Math.round(q), top - 2 - dy, F_OUT);
        }
      }
    }

    // ---------- 写满了：一只蝙蝠从月亮前面飞过去，翅膀一扇一扇 ----------
    if (done) {
      const ph = (t * 0.22) % 1;
      const bx = Math.round(46 - ph * 20), by = Math.round(4 + Math.sin(ph * Math.PI * 4) * 1.5);
      const up = Math.floor(t * 8) % 2;
      const B = "#120812";
      px(g, bx, by, B); px(g, bx + 1, by, B); px(g, bx, by + 1, B); px(g, bx + 1, by + 1, B);
      if (up) { px(g, bx - 1, by - 1, B); px(g, bx - 2, by - 2, B); px(g, bx + 2, by - 1, B); px(g, bx + 3, by - 2, B); px(g, bx - 1, by, B); px(g, bx + 2, by, B); }
      else { px(g, bx - 1, by + 1, B); px(g, bx - 2, by + 1, B); px(g, bx - 3, by, B); px(g, bx + 2, by + 1, B); px(g, bx + 3, by + 1, B); px(g, bx + 4, by, B); }
    }
  },
  label(s) {
    const n = (v) => Math.round(v).toLocaleString();
    return `${s.done ? "契约已成" : "契约"} ${n(s.words)}/${n(s.goal)}`;
  },
};
