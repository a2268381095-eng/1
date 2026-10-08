// sailor 这套的码字进度：作业本上四颗星，一颗管四分之一。黄铅笔把星星从下往上涂满（按面积涂），涂满的星变成闪亮的金星贴纸。
// 平时铅笔在正涂的那行慢慢来回蹭，金星上隔一会儿滑过一道反光；刚涨字铅笔涂得飞快、蹦出铅笔屑，那颗星跳一下；
// 写满了铅笔收走，四颗星挨个跳，底下的横线换成老师的红色双线。
const STAR = [
  "....#....",
  "...###...",
  "...###...",
  "#########",
  ".#######.",
  "..#####..",
  "..#####..",
  ".###.###.",
  ".##...##.",
];
const N = 4, SX = [2, 12, 22, 32], SY = 2;
const at = (x, y) => STAR[y] && STAR[y][x] === "#";
const edge = (x, y) => !at(x + 1, y) || !at(x - 1, y) || !at(x, y + 1) || !at(x, y - 1);
// 星里的格子从下往上一行行排好，按面积涂
const CELLS = [];
for (let y = STAR.length - 1; y >= 0; y--) for (let x = 0; x < 9; x++) if (at(x, y)) CELLS.push([x, y]);

const GOLD = "#ffd23f", GOLD_D = "#f2b51c", GOLD_O = "#d18a12", GOLD_H = "#fff0a0", WHITE = "#ffffff";
const LEAD = "#d18a12", WOOD = "#f3d3a0", BODY = "#ffcf3a", BODY_D = "#e0a419", FERRULE = "#c5cfdf", ERASER = "#f39ab9";
const RED = "#c8333f";

function px(g, x, y, col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }

/** 一颗星：f 涂了多少（0–1），full 已经是贴纸 */
function star(g, x0, y0, f, full, c, glint) {
  const n = full ? CELLS.length : Math.round(f * CELLS.length);
  // 涂到的最高一行，那一行亮一点（铅笔刚涂过）
  const top = n ? CELLS[n - 1][1] : 99;
  CELLS.forEach(([x, y], k) => {
    const lit = k < n, e = edge(x, y);
    let col;
    if (full) col = e ? GOLD_O : x + y < 7 ? GOLD_H : x + y > 10 ? GOLD_D : GOLD;
    else if (lit) col = e ? GOLD_O : y === top ? GOLD_H : GOLD;
    else if (e) col = c.faint;
    else return;
    if (full && glint >= 0 && x + y === glint) col = WHITE;
    px(g, x0 + x, y0 + y, col);
  });
}

/** 黄铅笔，笔尖在 (x, y)，朝左下斜着 */
function pencil(g, x, y) {
  px(g, x, y, LEAD);
  px(g, x + 1, y - 1, WOOD); px(g, x + 1, y, WOOD); px(g, x, y - 1, WOOD);
  for (let i = 2; i <= 4; i++) { px(g, x + i, y - i, BODY); px(g, x + i - 1, y - i, BODY_D); px(g, x + i, y - i + 1, BODY_D); }
  px(g, x + 5, y - 5, FERRULE); px(g, x + 4, y - 5, FERRULE); px(g, x + 5, y - 4, FERRULE);
  px(g, x + 6, y - 6, ERASER); px(g, x + 5, y - 6, ERASER); px(g, x + 6, y - 5, ERASER);
}

export default {
  w: 44, h: 14, animated: true,
  draw(g, s) {
    const { c, t } = s;
    const fresh = s.bump < 0.6;
    const p = Math.max(0, Math.min(1, s.shown));
    const cur = s.done ? N : Math.min(N - 1, Math.floor(p * N));
    // 底下一道横线：平时是作业本的蓝线，写满了换成老师的红色双线
    g.fillStyle = s.done ? RED : "rgba(91, 127, 214, .45)";
    g.fillRect(0, 13, 44, 1);
    if (s.done) g.fillRect(0, 11, 44, 1);
    // 反光：每 4 秒从左往右滑过所有金星（写满了 2 秒一次）
    const sweep = s.done ? (t % 2) * 28 - 6 : (t % 4) * 14 - 6;
    for (let i = 0; i < N; i++) {
      const full = s.done || i < cur || (i === cur && p * N - i >= 1);
      const f = full ? 1 : i === cur ? p * N - i : 0;
      // 写满了挨个跳；刚涨字时正涂的那颗跳一下
      let dy = 0;
      if (s.done && s.motion !== "off") dy = ((t * 1.6 - i * 0.18) % 1.6 + 1.6) % 1.6 < 0.16 ? -1 : 0;
      else if (fresh && i === cur && s.bump < 0.15) dy = -1;
      const glint = full ? Math.round(sweep - SX[i]) : -1;
      star(g, SX[i], SY + dy, f, full, c, glint >= 0 && glint < 17 ? glint : -1);
    }
    if (s.done) {
      // 写满：星星缝里轮流冒小十字闪光
      const k = Math.floor(t * 4);
      for (const [sx, sy] of [[1, 2], [11, 1], [21, 2], [31, 1], [42, 2]].filter((_, i) => (k + i) % 3 === 0)) {
        px(g, sx, sy, WHITE); px(g, sx - 1, sy, GOLD); px(g, sx + 1, sy, GOLD); px(g, sx, sy - 1, GOLD); px(g, sx, sy + 1, GOLD);
      }
      return;
    }
    // 铅笔：在正涂的那颗星的涂色线上来回蹭；刚涨字蹭得快
    const f = p * N - cur;
    const n = Math.round(f * CELLS.length);
    const line = n ? CELLS[Math.min(n, CELLS.length - 1)][1] : STAR.length - 1;
    const sway = fresh ? [0, 3, 1, 2][Math.floor(t * 18) % 4] : Math.round(1.5 + 1.5 * Math.sin(t * 2.4));
    const tipX = SX[cur] + 1 + sway, tipY = Math.max(6, SY + line);
    pencil(g, tipX, tipY);
    // 铅笔屑
    if (fresh) {
      const k = s.bump / 0.6;
      px(g, tipX - 1 - Math.round(k * 3), tipY + Math.round(k * 2), LEAD);
      px(g, tipX + 1 + Math.round(k * 2), tipY + 1 + Math.round(k * 2), GOLD_D);
    }
  },
  label(s) {
    const n = `${s.words.toLocaleString()}/${s.goal.toLocaleString()}`;
    return s.done ? `满分 ${n}` : `作业 ${n}`;
  },
};
