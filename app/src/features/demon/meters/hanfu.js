// hanfu 这套的码字进度：一枝梅（九九消寒图），九朵花，一朵五瓣，按字数一瓣一瓣点红。
// 没轮到的是花苞；正在点的那朵，没点的花瓣留着淡淡的墨线，下一瓣一明一暗等着落笔；点满的花有金色花蕊，隔一阵飘下一片花瓣。
// 刚涨字那一瓣先白后红，周围溅起一圈墨点；写满了，花蕊从左往右亮一遍，花瓣飘得勤些，右下角盖一方朱印。

// 枝：主枝从左下往右上折着长（梅枝讲究转折），几根小枝；粗的那段两像素
const MAIN = [[0, 11], [5, 9], [9, 9], [14, 6], [19, 7], [25, 5], [30, 5], [35, 3], [43, 1]];
const THICK = [[[0, 12], [4, 10]], [[0, 10], [3, 9]]];
const TWIG = [[[9, 9], [12, 12]], [[19, 7], [21, 3]], [[30, 5], [33, 8]]];
// 九朵花的中心（5×5），从左到右开
const SPOT = [[3, 6], [8, 11], [13, 3], [18, 10], [21, 2], [27, 8], [30, 2], [35, 7], [39, 2]];

// 一朵花：T 上 R 右 Y 右下 X 左下 L 左，c 花蕊，d 花心暗红
const FLOWER = [
  "..T..",
  ".LTR.",
  "LLcRR",
  ".XdY.",
  ".X.Y.",
];
const ORDER = "TRYXL";
const TIP = new Set(["2,0", "0,2", "4,2", "1,4", "3,4"]);
const N = SPOT.length, P = 5;

function line(out, [x0, y0], [x1, y1]) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= n; i++) out.push([Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n)]);
}
const BRANCH = [], TWIGS = [];
for (let i = 1; i < MAIN.length; i++) line(BRANCH, MAIN[i - 1], MAIN[i]);
for (const [a, b] of THICK) line(BRANCH, a, b);
for (const [a, b] of TWIG) line(TWIGS, a, b);
// 花苞长在枝上：找花下面（或上面）离得最近的枝，苞贴着它
const BUD = SPOT.map(([cx, cy]) => {
  const ys = [...BRANCH, ...TWIGS].filter(([x]) => x === cx).map(([, y]) => y);
  const by = ys.reduce((a, y) => (Math.abs(y - cy) < Math.abs(a - cy) ? y : a), ys[0] ?? cy);
  return by > cy ? [cx, by - 1, -1] : [cx, by + 1, 1];
});

// 颜色混合（配色都是 #rrggbb）
const rgb = (h) => { const n = parseInt(String(h).replace("#", "").slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a, b, k) => { const A = rgb(a), B = rgb(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(",")})`; };
const GOLD = "#f0be46", WHITE = "#ffffff";
const SEAL = ["RRRRR", "RwwwR", "RwRwR", "RwwwR", "RRRRR"];

function px(g, x, y, col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }
// 固定的伪随机（同一个数每次一样）
const hash = (n) => { let x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

export default {
  w: 44, h: 14, animated: true,
  label(s) { return `${s.done ? "梅开" : "点梅"} ${s.words.toLocaleString()}/${s.goal.toLocaleString()}`; },
  draw(g, s) {
    const { c, t } = s;
    const red = c.accent, redD = mix(c.accent, c.ink, 0.35), redL = mix(c.accent, WHITE, 0.3);
    const bud = mix(c.accent, c.surface, 0.25), ghost = mix(c.faint, c.surface, 0.35), branch = mix(c.ink, c.muted, 0.3);
    const p = Math.max(0, Math.min(1, s.shown));
    const steps = s.done ? N * P : Math.min(N * P - 1, Math.floor(p * N * P + 1e-6));
    const cur = Math.floor(steps / P), got = steps % P;
    const fresh = s.bump < 0.6 && !s.done;

    // 枝
    for (const [x, y] of TWIGS) px(g, x, y, c.muted);
    for (const [x, y] of BRANCH) px(g, x, y, branch);

    for (let i = 0; i < N; i++) {
      const [cx, cy] = SPOT[i];
      const full = i < cur;
      if (i > cur || (i === cur && got === 0 && !fresh)) {
        // 花苞：贴着枝，一点花萼一点红；轮到的那颗大一点，一胀一缩
        const [bx, by, dir] = BUD[i];
        px(g, bx, by, redD); px(g, bx, by + dir, bud);
        if (i === cur && (s.motion === "off" || t % 1.2 < 0.6)) { px(g, bx, by + 2 * dir, bud); px(g, bx + 1, by + dir, redL); }
        continue;
      }
      // 刚点上那一瓣时整朵跳一下
      const dy = i === cur && fresh && s.bump < 0.12 ? -1 : 0;
      FLOWER.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === ".") return;
        const X = cx - 2 + x, Y = cy - 2 + y + dy;
        if (ch === "c" || ch === "d") {
          if (full || got >= 3) px(g, X, Y, ch === "c" ? GOLD : redD);
          else px(g, X, Y, ch === "c" ? bud : redD);
          return;
        }
        const k = ORDER.indexOf(ch);
        let col;
        if (full || k < got) col = TIP.has(x + "," + y) ? redL : red;
        else if (k === got && !s.done) col = s.motion !== "off" && t % 1.2 < 0.6 ? bud : ghost;
        else col = ghost;
        // 刚点上的那一瓣：先白后红
        if (i === cur && fresh && k === got - 1) col = s.bump < 0.15 ? WHITE : s.bump < 0.3 ? redL : col;
        px(g, X, Y, col);
      }));
      // 刚点上：一圈墨点溅开
      if (i === cur && fresh) {
        const r = 3 + Math.floor(s.bump / 0.2);
        g.globalAlpha = Math.max(0, 1 - s.bump / 0.6);
        for (const [dx, dy2] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1.3], [1.3, 0], [-1.3, 0]]) px(g, Math.round(cx + dx * r), Math.round(cy + dy2 * r), c.ink);
        g.globalAlpha = 1;
      }
    }

    // 飘下的花瓣：开过的花里挑一朵，隔一阵落一片（写满了落得勤）
    const opened = s.done ? N : cur;
    if (opened > 0 && s.motion !== "off") {
      const period = s.done ? 1.6 : 5, fall = 2.2;
      for (let k = 0; k < (s.done ? 2 : 1); k++) {
        const tt = t + k * 0.8;
        const n = Math.floor(tt / period), u = (tt % period) / fall;
        if (u >= 1) continue;
        const [sx, sy] = SPOT[Math.floor(hash(n + k * 17) * opened)];
        const x = Math.round(sx - u * 6 + Math.sin(u * 9) * 1.2), y = Math.round(sy + 2 + u * 13);
        if (y < 14) { g.globalAlpha = 1 - u * 0.5; px(g, x, y, u * 10 % 2 < 1 ? redL : red); g.globalAlpha = 1; }
      }
    }

    if (s.done) {
      // 花蕊从左往右亮一遍
      const wave = (t * 12) % 60 - 4;
      for (const [cx, cy] of SPOT) if (Math.abs(cx - wave) < 2) { px(g, cx, cy, WHITE); px(g, cx, cy - 1, GOLD); }
      // 右下角一方朱印
      SEAL.forEach((row, y) => [...row].forEach((ch, x) => px(g, 39 + x, 9 + y, ch === "R" ? red : c.surface)));
    }
  },
};
