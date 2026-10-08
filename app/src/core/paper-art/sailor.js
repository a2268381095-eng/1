// sailor 这套纸上的像素装饰。每项：{ rows: 字符画, colors: { 字符: 颜色或 "accent"/"ink"/"paper"/"muted"/"faint"/"line"/"surface"/"accent-soft" }, scale: 放大倍数 }
// 在 CSS 里用 var(--pa-<名字>)、var(--pa-<名字>-w)、var(--pa-<名字>-h)。
// 活页本的一页：左边一列打孔（punch 是挖孔的遮罩，rim 是孔边一圈淡影），右上角贴一颗金星贴纸，右下角是小恶魔随手画的尾巴。

// 孔：一格 12×10（CSS 里按 3 倍是 36×30），孔 5×5 在中间偏左
const HOLE = [".###.", "#####", "#####", "#####", ".###."];
const tile = (fn) => Array.from({ length: 10 }, (_, y) => Array.from({ length: 12 }, (_, x) => fn(x - 3, y - 2)).join(""));
const inHole = (x, y) => HOLE[y] && HOLE[y][x] === "#";

// 剪影 → 描边、亮面、暗面，外面一圈白边
function sticker(sil) {
  const H = sil.length + 2, W = sil[0].length + 2;
  const at = (x, y) => sil[y] && sil[y][x] === "#";
  const rim = (x, y) => !at(x, y) && [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => at(x + dx, y + dy)));
  const rows = [];
  for (let y = 0; y < H; y++) {
    let r = "";
    for (let x = 0; x < W; x++) {
      const sx = x - 1, sy = y - 1, n = sil.length;
      if (at(sx, sy)) r += !at(sx + 1, sy) || !at(sx - 1, sy) || !at(sx, sy + 1) || !at(sx, sy - 1) ? "o" : sx + sy < n - 2 ? "h" : sx + sy > n + 1 ? "d" : "y";
      else if (rim(sx, sy)) r += "w";
      else r += ".";
    }
    rows.push(r);
  }
  return rows;
}

const STAR = [
  ".....#.....",
  "....###....",
  "....###....",
  "...#####...",
  "###########",
  ".#########.",
  "..#######..",
  "..#######..",
  ".####.####.",
  ".###...###.",
  ".#.......#.",
];

export default {
  // 挖孔遮罩：# 是纸，. 是孔
  punch: { rows: tile((x, y) => (inHole(x, y) ? "." : "#")), colors: { "#": "#000000" }, scale: 3 },
  // 孔的上沿、左沿一道淡影，孔看起来有厚度
  rim: {
    rows: tile((x, y) => (inHole(x, y) ? "." : (inHole(x, y + 1) || inHole(x + 1, y)) ? "r" : ".")),
    colors: { r: "line" }, scale: 3,
  },
  star: {
    rows: sticker(STAR),
    colors: { o: "#d18a12", y: "#ffd23f", h: "#fff0a0", d: "#f2b51c", w: "#ffffff" }, scale: 3,
  },
  // 小恶魔的尾巴：圆珠笔一笔画过去，尾巴尖是倒过来的心
  tail: {
    rows: [
      "..........#...",
      ".........###..",
      "........#####.",
      ".......#######",
      ".......#######",
      "........##.##.",
      "..........#...",
      ".........#....",
      "..##....#.....",
      ".#..#..#......",
      "#....##.......",
    ],
    colors: { "#": "#5b7fd6" }, scale: 3,
  },
};
