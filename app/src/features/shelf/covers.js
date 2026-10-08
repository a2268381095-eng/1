// 没有封面时的默认书封：按主题画成不同的书——魔法书、作业本、线装书、皮面魔典、案卷夹、皮革手账。
// 先在 60×80 的格子上画像素，放大 5 倍成 300×400，再写书名。同一套里按书名换颜色，书架上不会一模一样。
const W = 60, H = 80, K = 5;

function hashOf(s) { let x = 0; for (const ch of s) x = (x * 31 + ch.codePointAt(0)) >>> 0; return x; }

function px(g) {
  return {
    rect: (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); },
    dot: (x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); },
    rows: (x, y, rows, map) => rows.forEach((r, j) => [...r].forEach((ch, i) => { if (map[ch]) { g.fillStyle = map[ch]; g.fillRect(x + i, y + j, 1, 1); } })),
  };
}

// 每套：draw(p, v) 画像素（v 是按书名挑的配色），title 说书名怎么写
const BOOKS = {
  // 魔法书：粉白封皮，金色包角，中间一颗心形魔法石，书名竖写在白签上
  magical: {
    variants: [["#f6c9dc", "#e58fb4", "#b23f77"], ["#e7d8f6", "#b79be0", "#6f4fb0"], ["#fbe3c8", "#efb07c", "#b8642c"]],
    draw(p, [light, mid, deep]) {
      p.rect(0, 0, W, H, mid); p.rect(2, 2, W - 4, H - 4, light);
      p.rect(0, 0, 4, H, deep); p.rect(4, 0, 1, H, "#ffffff55");
      const gold = "#e8b84a", goldD = "#b8862a";
      for (const [x, y] of [[5, 1], [W - 8, 1], [5, H - 8], [W - 8, H - 8]]) { p.rect(x, y, 7, 7, gold); p.rect(x + 1, y + 1, 5, 5, goldD); p.rect(x + 2, y + 2, 3, 3, gold); }
      p.rect(22, 9, 22, 46, "#fffdfa"); p.rect(22, 9, 22, 1, mid); p.rect(22, 54, 22, 1, mid);
      p.rows(27, 59, [".##.##.", "#######", "#######", ".#####.", "..###..", "...#..."], { "#": deep });
      p.dot(29, 60, "#ffffff");
    },
    title: { mode: "v", x: 33, y: 13, size: 30, color: (v) => v[2] },
  },
  // 作业本：深色封面，书脊一道布条，中间一张横线标签，书名横写在标签上
  sailor: {
    variants: [["#1f2a3d", "#c8333f", "#fdfdfb"], ["#2f5d4a", "#e0b12a", "#fdfdfb"], ["#7a2430", "#1f2a3d", "#fdfdfb"]],
    draw(p, [cover, tape, label]) {
      p.rect(0, 0, W, H, cover);
      p.rect(0, 0, 7, H, tape); p.rect(7, 0, 1, H, "#00000040");
      for (let y = 4; y < H; y += 6) p.dot(3, y, "#ffffff66");
      p.rect(14, 16, 40, 24, label); p.rect(14, 16, 40, 2, tape);
      for (let y = 24; y < 40; y += 5) p.rect(16, y, 36, 1, "#5b7fd655");
      p.rect(14, 62, 40, 1, "#ffffff40"); p.rect(14, 66, 26, 1, "#ffffff40");
    },
    title: { mode: "h", x: 34, y: 28, size: 26, color: () => "#1f2a3d", maxW: 190 },
  },
  // 线装书：素色封皮，右边四眼订线，左上一条白题签，书名竖写
  hanfu: {
    variants: [["#2f4a6b", "#22364f"], ["#8a6d4a", "#6a5236"], ["#5f7a6a", "#465c50"]],
    draw(p, [cover, dark]) {
      p.rect(0, 0, W, H, cover);
      for (let i = 0; i < 90; i++) { const h = (i * 2654435761) >>> 0; p.dot(h % W, (h >>> 8) % H, dark); }
      p.rect(W - 9, 0, 9, H, dark);
      for (const y of [8, 28, 52, 72]) { p.rect(W - 6, y, 2, 2, "#f3ead6"); p.rect(W - 9, y, 3, 1, "#f3ead6"); }
      p.rect(W - 5, 0, 1, H, "#f3ead6aa");
      p.rect(8, 6, 13, 50, "#f6efde"); p.rect(9, 7, 11, 48, "#fbf6ea"); p.rect(8, 6, 13, 1, "#b8432f"); p.rect(8, 55, 13, 1, "#b8432f");
      p.rect(10, 60, 9, 9, "#b8432f"); p.rect(12, 62, 5, 5, "#e8b4a8"); p.rect(13, 63, 3, 3, "#b8432f");
    },
    title: { mode: "v", x: 14.5, y: 9, size: 26, color: () => "#2b2622" },
  },
  // 皮面魔典：黑皮，酒红边框，金属包角和锁扣，中间一弯月亮，书名竖写在中间
  gothic: {
    variants: [["#1d141f", "#8e2a4f"], ["#16161f", "#4a5aa8"], ["#22140f", "#a8402a"]],
    draw(p, [leather, trim]) {
      p.rect(0, 0, W, H, leather);
      p.rect(4, 4, W - 8, H - 8, trim); p.rect(5, 5, W - 10, H - 10, leather); p.rect(7, 7, W - 14, H - 14, trim); p.rect(8, 8, W - 16, H - 16, leather);
      const metal = "#c9c1d6", metalD = "#7c7290";
      for (const [x, y] of [[0, 0], [W - 6, 0], [0, H - 6], [W - 6, H - 6]]) { p.rect(x, y, 6, 6, metal); p.rect(x + 1, y + 1, 4, 4, metalD); p.dot(x + 2, y + 2, metal); }
      p.rect(W - 4, 34, 4, 12, metal); p.rect(W - 3, 36, 3, 8, metalD); p.rect(W - 7, 38, 4, 4, metal);
      p.rows(26, 12, ["..###.", ".##...", "##....", "##....", "##....", ".##...", "..###."], { "#": "#f0d9a8" });
    },
    title: { mode: "v", x: 30, y: 25, size: 26, color: () => "#f0d9a8" },
  },
  // 案卷夹：牛皮纸夹子，顶上一个标签耳，回形针，红色「卷宗」章，书名横写在打字标签上
  detective: {
    variants: [["#d8b98a", "#b8945e"], ["#c9b28e", "#a48a62"], ["#b8c4a8", "#8e9c7c"]],
    draw(p, [kraft, dark]) {
      p.rect(0, 6, W, H - 6, kraft); p.rect(4, 0, 22, 8, kraft); p.rect(4, 0, 22, 1, dark); p.rect(4, 0, 1, 7, dark); p.rect(25, 0, 1, 7, dark);
      p.rect(0, 6, W, 1, dark); p.rect(0, H - 1, W, 1, dark); p.rect(W - 1, 6, 1, H - 6, dark);
      for (let i = 0; i < 70; i++) { const h = (i * 2246822519) >>> 0; p.dot(h % W, 8 + (h >>> 9) % (H - 9), dark + "55"); }
      p.rect(8, 22, 44, 14, "#fdfaf0"); p.rect(8, 22, 44, 1, "#8a7a62"); p.rect(8, 35, 44, 1, "#8a7a62");
      p.rows(44, 2, [".###.", "#...#", "#.#.#", "#.#.#", "#.#.#", "#.#.#", "#...#", ".#.#."], { "#": "#8c8c94" });
      p.rect(36, 52, 18, 12, "#c8333f"); p.rect(37, 53, 16, 10, kraft); p.rect(38, 54, 14, 8, "#c8333f33");
    },
    title: { mode: "h", x: 30, y: 29, size: 24, color: () => "#2e2620", maxW: 200, font: "'Courier New', 'Noto Serif SC', serif", stamp: { text: "卷宗", x: 45, y: 58 } },
  },
  // 皮革手账：棕色皮面，缝线边，横一道皮带扣，左上罗盘，书名横写在羊皮纸补丁上
  adventurer: {
    variants: [["#7a4a2a", "#5a341c"], ["#5a5a2a", "#3e3e1c"], ["#6a2f28", "#4a1f1a"]],
    draw(p, [leather, dark]) {
      p.rect(0, 0, W, H, leather);
      for (let x = 3; x < W - 3; x += 3) { p.dot(x, 3, "#e8d2a0"); p.dot(x, H - 4, "#e8d2a0"); }
      for (let y = 3; y < H - 3; y += 3) { p.dot(3, y, "#e8d2a0"); p.dot(W - 4, y, "#e8d2a0"); }
      p.rect(0, 48, W, 7, dark); p.rect(0, 49, W, 5, "#3a2412"); p.rect(W - 14, 46, 8, 11, "#d4a640"); p.rect(W - 12, 48, 4, 7, "#3a2412");
      p.rect(10, 14, 40, 22, "#efdcae"); p.rect(10, 14, 40, 1, "#c9a66e"); p.rect(10, 35, 40, 1, "#c9a66e"); p.dot(10, 14, leather); p.dot(49, 35, leather);
      p.rows(25, 60, ["...#...", "..#.#..", ".#...#.", "#..#..#", ".#...#.", "..#.#..", "...#..."], { "#": "#d4a640" });
      p.rect(28, 63, 1, 1, "#c8333f");
    },
    title: { mode: "h", x: 30, y: 25, size: 24, color: () => "#3a2a18", maxW: 190 },
  },
};

const cache = new Map();
/** 默认书封（dataURL）。style：现在的主题（magical / sailor / hanfu / gothic / detective / adventurer） */
export function styledCover(title, style) {
  const name = title || "无题";
  const book = BOOKS[style] || BOOKS.magical;
  const key = (BOOKS[style] ? style : "magical") + "\u0000" + name;
  if (cache.has(key)) return cache.get(key);
  const small = document.createElement("canvas");
  small.width = W; small.height = H;
  const sg = small.getContext("2d");
  const v = book.variants[hashOf(name) % book.variants.length];
  book.draw(px(sg), v);
  const c = document.createElement("canvas");
  c.width = W * K; c.height = H * K;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.drawImage(small, 0, 0, W * K, H * K);
  const t = book.title;
  g.fillStyle = t.color(v);
  g.textAlign = "center"; g.textBaseline = "middle";
  const chars = [...name];
  if (t.mode === "v") {
    const n = Math.min(chars.length, 8);
    const room = 46 * K - 10;
    const size = Math.min(t.size, Math.floor(room / n));
    g.font = `600 ${size}px 'Noto Serif SC', 'Songti SC', serif`;
    for (let i = 0; i < n; i++) g.fillText(chars[i], t.x * K, t.y * K + size / 2 + i * size);
  } else {
    let size = t.size;
    g.font = `600 ${size}px ${t.font || "'Noto Serif SC', 'Songti SC', serif"}`;
    let text = chars.length > 10 ? chars.slice(0, 9).join("") + "…" : name;
    while (g.measureText(text).width > t.maxW && size > 14) { size -= 2; g.font = `600 ${size}px ${t.font || "'Noto Serif SC', serif"}`; }
    g.fillText(text, t.x * K, t.y * K);
  }
  if (t.stamp) {
    g.save();
    g.translate(t.stamp.x * K, t.stamp.y * K); g.rotate(-0.12);
    g.fillStyle = "#c8333f"; g.font = "700 22px 'Noto Serif SC', serif";
    g.fillText(t.stamp.text, 0, 0);
    g.restore();
  }
  const url = c.toDataURL("image/png");
  cache.set(key, url);
  return url;
}
