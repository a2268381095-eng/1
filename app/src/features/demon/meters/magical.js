// magical 这套的码字进度：一颗带翅膀的水晶心，魔力（粉色的光）从心尖往上灌。
// 按面积灌（灌到一半，心里一半的格子亮）。平时液面慢慢流、冒小泡，翅膀隔一会儿扇两下；
// 刚涨字：魔力亮一下、溅起一滴、两边蹦出星星、翅膀扇快；写满了：金边金翅膀，一道光扫过，两颗星绕着心转。
const HEART = [
  "..ooo.....ooo..",
  ".oiiio...oiiio.",
  "oiiiiio.oiiiiio",
  "oiiiiiioiiiiiio",
  "oiiiiiiiiiiiiio",
  "oiiiiiiiiiiiiio",
  ".oiiiiiiiiiiio.",
  "..oiiiiiiiiio..",
  "...oiiiiiiio...",
  "....oiiiiio....",
  ".....oiiio.....",
  "......oio......",
  ".......o.......",
];
// 左翅膀两帧：平展、抬起。右边那只翻过来画
const WING_FLAT = [
  "..............",
  "..............",
  "kkkkkk........",
  "kwwwwfkkkk....",
  ".kkkkkffffkk..",
  "kwwwwwfffffkk.",
  ".kkkkkkffffffk",
  "..kwwwwffffffk",
  "...kkkkkkfffk.",
  "......kwwffk..",
  ".......kkkk...",
];
const WING_UP = [
  "..............",
  "kkk...........",
  "kwfkk.........",
  "kwfffkk.......",
  ".kwffffkkk....",
  "kkkkfffffffkk.",
  "kwwffkffffffk.",
  ".kkkkffffffffk",
  "..kwffkfffffk.",
  "...kkkkfffkk..",
  "......kkkk....",
];
const HX = 14; // 心的左边
const PINK = "#ff6fae", DEEP = "#e2468e", FOAM = "#ffb8d8", WHITE = "#fffafd";

// 心里每一行的格子（从下往上），按面积算液面
const ROWS = [];
for (let y = HEART.length - 1; y >= 0; y--) {
  const xs = [...HEART[y]].map((ch, x) => (ch === "i" ? x : -1)).filter((x) => x >= 0);
  if (xs.length) ROWS.push({ y, xs });
}
const AREA = ROWS.reduce((n, r) => n + r.xs.length, 0);

function px(g, x, y, col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }
function plus(g, x, y, mid, arm) { px(g, x, y, mid); px(g, x - 1, y, arm); px(g, x + 1, y, arm); px(g, x, y - 1, arm); px(g, x, y + 1, arm); }
function isDark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) < 110;
}

export default {
  w: 43, h: 14, animated: true,
  draw(g, s) {
    const { c, t, done } = s;
    const dark = isDark(c.surface);
    const fresh = s.bump < 0.6;
    const gold = dark ? "#f2b51c" : "#dd9a12";
    const line = done ? gold : c.accent;

    // 翅膀：平时隔三秒扇两下；刚涨字一直扇；写满了慢慢扇
    const beat = fresh ? Math.floor(t * 10) % 2 : done ? Math.floor(t * 2.5) % 2 : (t % 3.2 < 0.8 ? Math.floor(t * 5) % 2 : 0);
    const W = beat ? WING_UP : WING_FLAT;
    const fill = done ? (dark ? "#ffe9a8" : "#ffe08a") : dark ? WHITE : "#ffd2e6";
    W.forEach((r, y) => [...r].forEach((ch, i) => {
      if (ch === ".") return;
      const col = ch === "k" ? line : ch === "w" ? WHITE : fill;
      px(g, i, y, col);
      px(g, 42 - i, y, col);
    }));

    // 心：玻璃底色
    HEART.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === "i") px(g, HX + x, y, c.accentSoft); }));

    // 魔力：从心尖往上，最上面那行是起伏的液面
    const glow = fresh && s.bump < 0.18;
    let left = Math.max(0, Math.min(1, s.shown)) * AREA, level = 0, surf = null;
    for (const row of ROWS) {
      if (left <= 0) break;
      const n = row.xs.length, part = Math.min(1, left / n);
      left -= n;
      level++;
      const top = left <= 0;
      if (top) surf = row;
      row.xs.forEach((x, k) => {
        if (top) {
          const lit = Math.max(1, Math.round(part * n));
          const on = ((k + Math.floor(t * 3)) % n) < lit;
          if (!on) return;
          px(g, HX + x, row.y, part < 1 || (k + Math.floor(t * 2)) % 3 ? FOAM : WHITE);
          return;
        }
        px(g, HX + x, row.y, glow ? FOAM : row.y >= 10 ? DEEP : PINK);
      });
    }

    // 小气泡往上冒
    if (level > 3 && !done) {
      for (let k = 0; k < 2; k++) {
        const ph = (t * 0.6 + k * 0.5) % 1;
        const by = 11 - Math.floor(ph * (level - 1));
        const row = ROWS.find((r) => r.y === by);
        if (!row || row === surf) continue;
        const bx = row.xs[(k * 5 + Math.floor(t * 0.6 + k * 0.5) * 3) % row.xs.length];
        px(g, HX + bx, by, FOAM);
      }
    }

    // 写满了：一道光斜着扫过去
    if (done) {
      const sweep = (t * 9) % 30 - 6;
      HEART.forEach((r, y) => [...r].forEach((ch, x) => {
        if (ch !== "i") return;
        const d = x + y * 0.5 - sweep;
        if (d >= 0 && d < 2) px(g, HX + x, y, d < 1 ? WHITE : FOAM);
      }));
    }

    // 轮廓
    HEART.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === "o") px(g, HX + x, y, line); }));
    // 玻璃反光：左上那瓣
    px(g, HX + 2, 2, WHITE); px(g, HX + 3, 2, WHITE); px(g, HX + 2, 3, WHITE);
    // 右瓣偶尔闪一下
    if (!done && t % 4 < 0.35) px(g, HX + 11, 3, WHITE);

    // 刚涨字：溅起一滴，两边蹦出星星
    if (fresh) {
      const p = s.bump / 0.6;
      if (surf) {
        const dy = Math.round(Math.sin(p * Math.PI) * 3);
        if (surf.y - 1 - dy >= 1) px(g, HX + 7, surf.y - 1 - dy, FOAM);
      }
      const ox = Math.round(p * 4), oy = Math.round(p * 2);
      for (const sx of [-1, 1]) {
        const x = HX + 7 + sx * (8 + ox), y = 2 - oy + 1;
        if (p < 0.6) plus(g, x, y, WHITE, dark ? PINK : DEEP);
        else px(g, x, y, dark ? FOAM : PINK);
      }
    }

    // 写满了：两颗金星绕着心转，转到心后面就被挡住
    if (done) {
      for (let k = 0; k < 2; k++) {
        const a = t * 1.8 + k * Math.PI;
        const x = Math.round(HX + 7 + Math.cos(a) * 17), y = Math.round(6.5 + Math.sin(a) * 4.5);
        if (Math.sin(a) < 0 && x >= HX && x <= HX + 14) continue;
        plus(g, x, y, WHITE, gold);
      }
    }
  },
  label(s) {
    const n = (v) => Math.round(v).toLocaleString();
    return `${s.done ? "魔力全满" : "魔力"} ${n(s.words)}/${n(s.goal)}`;
  },
};
