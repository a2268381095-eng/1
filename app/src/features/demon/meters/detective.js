// detective 这套的码字进度：软木委托板上钉着五张线索卡，最右边一张是嫌疑人的照片。
// 写多少，红线就从第一颗图钉往后拉多长；红线拉到哪张卡，那张卡就按上红图钉。
// 平时放大镜在下一张卡上来回照，线头松松地晃；刚涨字线头往前一窜，刚钉上的图钉闪一下；
// 写满了线全连上、照片底下亮一圈，板子中间斜着盖一枚红色「结案」章，图钉挨个反光。
const W = 44, H = 14;
// 卡片左上角和图钉位置（图钉在卡片上沿中间）
const CARDS = [[2, 5], [10, 2], [18, 6], [26, 2], [34, 4]];
const PIN = CARDS.map(([x, y], i) => (i === 4 ? [x + 3, y] : [x + 2, y]));
const CORK = "#b98a55", CORK_D = "#9c6f3e", CORK_L = "#cfa36c", FRAME = "#5a3a1e", FRAME_L = "#7a5230";
const CARD = "#f6efd9", CARD_D = "#d8c9a4", TYPE = "#8a7a62", PHOTO = "#3a332c", PHOTO_L = "#6d6458";
const RED = "#c0262e", RED_D = "#7e161c", RED_L = "#ff8a8a", THREAD = "#d4313a", GOLD = "#ffd76a";
const BRASS = "#c9a24a", GLASS = "rgba(220, 240, 255, .55)";

// 「结案」两个字，8×7 和 7×7
const JIE = [
  ".#...#..",
  "#..#####",
  ".#...#..",
  "##..###.",
  ".#.#####",
  "#..#...#",
  "##.#####",
];
const AN = [
  "...#...",
  "#######",
  "#.#...#",
  "#######",
  "...#...",
  "#######",
  ".#.#.#.",
];

function px(g, x, y, col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }
function rect(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }
/** 一段线（Bresenham）里的点 */
function linePts(x0, y0, x1, y1) {
  const out = [], dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
  return out;
}
// 红线整条路径上的点，按顺序；记下每颗图钉在路径上的下标
const PATH = [], AT = [0];
for (let i = 0; i < 4; i++) {
  const seg = linePts(...PIN[i], ...PIN[i + 1]);
  PATH.push(...(i ? seg.slice(1) : seg));
  AT.push(PATH.length - 1);
}

function board(g) {
  rect(g, 0, 0, W, H, FRAME);
  rect(g, 1, 1, W - 2, H - 2, CORK);
  rect(g, 0, 0, W, 1, FRAME_L);
  // 软木颗粒：固定的散点
  for (let i = 0; i < 70; i++) {
    const x = 1 + ((i * 37) % (W - 2)), y = 1 + ((i * 11 + (i >> 2)) % (H - 2));
    px(g, x, y, i % 3 ? CORK_D : CORK_L);
  }
}
/** 线索卡：上沿两行打字痕迹；最后一张是照片（剪影） */
function card(g, i, lit, jig) {
  const [x, y0] = CARDS[i], y = y0 + jig;
  if (i === 4) {
    rect(g, x, y, 7, 8, lit ? "#fbf6e6" : CARD_D);
    rect(g, x + 1, y + 1, 5, 6, PHOTO);
    // 剪影：头、肩
    rect(g, x + 2, y + 2, 3, 2, PHOTO_L); rect(g, x + 1, y + 5, 5, 2, PHOTO_L);
    px(g, x + 3, y + 4, PHOTO_L);
    if (!lit) { px(g, x + 3, y + 2, "#ffffff"); px(g, x + 3, y + 3, PHOTO_L); }   // 还没查到：一个问号似的白点
    return;
  }
  rect(g, x, y, 5, 5, lit ? CARD : CARD_D);
  rect(g, x + 1, y + 2, 3, 1, TYPE);
  rect(g, x + 1, y + 3, 2, 1, TYPE);
  rect(g, x + 4, y + 1, 1, 4, "rgba(0,0,0,.12)");
}
function pin(g, [x, y], glow) {
  px(g, x, y, glow ? GOLD : RED); px(g, x + 1, y, RED_D); px(g, x, y + 1, RED_D);
  px(g, x - 1, y - 1, glow ? "#ffffff" : RED_L);
}
function stampMark(g, t, motion) {
  // 斜着盖：每往右 7 格往上错一格
  const x0 = 13, y0 = 4;
  const fade = motion === "off" ? 1 : 0.86 + 0.14 * Math.sin(t * 3);
  g.globalAlpha = fade;
  const put = (x, y) => px(g, x0 + x, y0 + y - Math.floor(x / 7), RED);
  for (let x = -1; x <= 17; x++) { put(x, -1); put(x, 7); }
  for (let y = -1; y <= 7; y++) { put(-1, y); put(17, y); }
  JIE.forEach((r, y) => [...r].forEach((ch, x) => ch === "#" && put(x + 0, y)));
  AN.forEach((r, y) => [...r].forEach((ch, x) => ch === "#" && put(x + 9, y)));
  g.globalAlpha = 1;
}

export default {
  w: W, h: H, animated: true,
  draw(g, s) {
    const { t } = s;
    const fresh = s.bump < 0.6, still = s.motion === "off";
    const p = Math.max(0, Math.min(1, s.shown));
    const n = s.done ? PATH.length : Math.round(p * (PATH.length - 1)) + (p > 0 ? 1 : 0);
    const end = n ? PATH[n - 1] : null;
    // 钉上了几颗：红线到了的那颗
    const reached = s.done ? 5 : p > 0 ? AT.filter((a) => a < n).length : 0;
    board(g);
    // 刚钉上的那张卡抖一下
    const newest = reached - 1;
    for (let i = 0; i < 5; i++) card(g, i, i < reached, fresh && i === newest && s.bump < 0.2 ? 1 : 0);
    if (s.done) {
      // 照片底下亮一圈
      const [x, y] = CARDS[4];
      g.fillStyle = "rgba(255, 215, 106, .55)";
      g.fillRect(x - 1, y - 1, 9, 1); g.fillRect(x - 1, y + 8, 9, 1); g.fillRect(x - 1, y, 1, 8); g.fillRect(x + 7, y, 1, 8);
    }
    // 红线
    for (let k = 0; k < n; k++) px(g, PATH[k][0], PATH[k][1], THREAD);
    // 松着的线头：从线端往下垂一两格，平时慢慢晃，刚涨字往前窜
    if (end && !s.done) {
      const sway = still ? 0 : fresh ? [1, 2, 1, 0][Math.floor(t * 16) % 4] : Math.round(Math.sin(t * 2.2));
      px(g, end[0] + 1, end[1] + 1, THREAD);
      px(g, end[0] + 1 + sway, end[1] + 2, THREAD);
      if (fresh) px(g, end[0] + 2, end[1] - 1, GOLD);
    }
    // 图钉：写满了一颗颗反光；刚钉上的那颗闪金色
    const k = Math.floor(t * 5) % 7;
    for (let i = 0; i < reached; i++) pin(g, PIN[i], s.done ? k === i : fresh && i === newest && s.bump < 0.35);
    if (s.done) { stampMark(g, t, s.motion); return; }
    // 放大镜：在下一张还没钉的卡上来回照
    const next = Math.min(4, reached);
    const [cx, cy] = PIN[next];
    const dx = still ? 0 : Math.round(Math.sin(t * 1.3) * 2), dy = still ? 0 : Math.round(Math.cos(t * 1.7));
    const lx = Math.max(3, Math.min(W - 6, cx + dx)), ly = Math.max(3, Math.min(H - 5, cy + 3 + dy));
    g.fillStyle = GLASS; g.fillRect(lx - 1, ly - 1, 3, 3);
    for (const [ox, oy] of [[-1, -2], [0, -2], [1, -2], [-2, -1], [-2, 0], [-2, 1], [2, -1], [2, 0], [2, 1], [-1, 2], [0, 2], [1, 2]]) px(g, lx + ox, ly + oy, BRASS);
    px(g, lx - 1, ly - 1, "#ffffff");
    px(g, lx + 2, ly + 2, FRAME); px(g, lx + 3, ly + 3, FRAME); px(g, lx + 3, ly + 2, FRAME_L);
  },
  label(s) {
    const n = `${s.words.toLocaleString()}/${s.goal.toLocaleString()}`;
    return s.done ? `结案 ${n}` : `线索 ${n}`;
  },
};
