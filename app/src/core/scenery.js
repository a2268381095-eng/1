// 正文区底部的像素风景：每套风格一幅，用程序画剪影，很淡，静静地铺在纸面最下面。
// 魔法少女：云和星星；水手服：海浪和灯塔；古风：水墨远山；哥特：古堡和弯月；侦探：屋顶和钟楼；冒险者：山丘、小树和旗子。
const W = 240, H = 48;   // 一段的像素尺寸，横向重复铺开

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function ridge(g, base, amp, rough, seed, alpha) {
  const r = rng(seed);
  let y = base;
  g.globalAlpha = alpha;
  for (let x = 0; x < W; x++) {
    y += (r() - 0.5) * rough;
    const wave = Math.sin((x / W) * Math.PI * 2) * amp;   // 首尾接得上
    const top = Math.round(Math.min(H - 1, Math.max(4, y + wave)));
    g.fillRect(x, top, 1, H - top);
    y += (base - y) * 0.06;
  }
}

const SCENES = {
  magical(g) {
    g.globalAlpha = 1;
    const cloud = (cx, cy, w) => { for (let i = 0; i < w; i++) { const hgt = Math.round(3 + Math.sin((i / w) * Math.PI) * 5); g.fillRect(cx + i, cy - hgt, 1, hgt); } };
    cloud(10, 40, 40); cloud(36, 44, 30); cloud(120, 38, 46); cloud(150, 44, 34); cloud(200, 42, 28);
    g.fillRect(0, 44, W, 4);
    const star = (x, y) => { g.fillRect(x, y - 1, 1, 3); g.fillRect(x - 1, y, 3, 1); };
    star(70, 10); star(100, 20); star(180, 8); star(222, 22); star(30, 16);
    g.fillRect(90, 4, 4, 1); g.fillRect(89, 5, 2, 4); g.fillRect(90, 9, 4, 1);    // 小月牙
  },
  sailor(g) {
    g.globalAlpha = 1;
    for (let x = 0; x < W; x++) { const y = Math.round(40 + Math.sin((x / W) * Math.PI * 8) * 2); g.fillRect(x, y, 1, H - y); }
    // 灯塔
    const lx = 176;
    for (let y = 14; y < 40; y++) { const half = Math.round(3 + (y - 14) / 8); g.fillRect(lx - half, y, half * 2, 1); }
    g.fillRect(lx - 4, 10, 8, 4); g.fillRect(lx - 2, 7, 4, 3); g.fillRect(lx - 1, 5, 2, 2);
    g.globalAlpha = 0.6; g.fillRect(lx + 6, 10, 26, 1); g.fillRect(lx + 6, 12, 20, 1);    // 灯光
    g.globalAlpha = 1;
    const gull = (x, y) => { g.fillRect(x, y, 2, 1); g.fillRect(x + 2, y + 1, 1, 1); g.fillRect(x + 3, y, 2, 1); };
    gull(40, 14); gull(60, 20); gull(110, 10);
  },
  hanfu(g) {
    ridge(g, 26, 4, 3.2, 7, 0.45);
    ridge(g, 34, 3, 2.4, 19, 0.75);
    ridge(g, 42, 1.5, 1.4, 31, 1);
    g.globalAlpha = 0.8;
    // 一叶小舟
    g.fillRect(60, 41, 10, 1); g.fillRect(61, 42, 8, 1); g.fillRect(64, 37, 1, 4);
    g.globalAlpha = 1;
  },
  gothic(g) {
    ridge(g, 40, 2, 1.6, 5, 1);
    const tower = (x, w, top) => {
      g.fillRect(x, top, w, H - top);
      for (let i = 0; i < w; i += 2) g.fillRect(x + i, top - 2, 1, 2);   // 城垛
      for (let k = 0; k < Math.ceil(w / 2) + 2; k++) g.fillRect(x + Math.floor(w / 2) - Math.min(k, Math.floor(w / 2)), top - 3 - k, 1 + Math.min(k, Math.floor(w / 2)) * 2 - (k > w / 2 ? 2 : 0), 1);
    };
    tower(140, 8, 20); tower(150, 14, 26); tower(166, 6, 16); tower(174, 10, 28);
    g.fillRect(146, 34, 40, 14);
    // 弯月
    for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
      const inA = x * x + y * y <= 36, inB = (x - 3) * (x - 3) + (y + 1) * (y + 1) <= 30;
      if (inA && !inB) g.fillRect(60 + x, 12 + y, 1, 1);
    }
    const bat = (x, y) => { g.fillRect(x, y, 1, 1); g.fillRect(x + 1, y + 1, 3, 1); g.fillRect(x + 4, y, 1, 1); g.fillRect(x + 2, y + 2, 1, 1); };
    bat(90, 16); bat(104, 10); bat(214, 18);
  },
  detective(g) {
    g.globalAlpha = 1;
    const r = rng(11);
    let x = 0;
    while (x < W) {
      const w = 10 + Math.floor(r() * 18), top = 22 + Math.floor(r() * 16);
      g.fillRect(x, top, w, H - top);
      if (r() > 0.4) g.fillRect(x + 2 + Math.floor(r() * (w - 6)), top - 4, 2, 4);   // 烟囱
      if (r() > 0.6) for (let k = 0; k < Math.floor(w / 2); k++) g.fillRect(x + k, top - k, w - k * 2, 1);   // 尖顶
      x += w + 1;
    }
    // 钟楼
    g.fillRect(100, 6, 10, 42); g.fillRect(101, 2, 8, 4); g.fillRect(104, 0, 2, 2);
    g.globalAlpha = 0; g.clearRect(102, 10, 6, 6);
    g.globalAlpha = 1;
  },
  adventurer(g) {
    g.globalAlpha = 0.6;
    for (let x = 0; x < W; x++) { const y = Math.round(30 + Math.sin((x / W) * Math.PI * 2) * 6); g.fillRect(x, y, 1, H - y); }
    g.globalAlpha = 1;
    for (let x = 0; x < W; x++) { const y = Math.round(40 + Math.sin((x / W) * Math.PI * 4 + 1) * 3); g.fillRect(x, y, 1, H - y); }
    const tree = (x, y) => { g.fillRect(x, y, 1, 4); for (let k = 0; k < 4; k++) g.fillRect(x - 3 + k, y - 2 - k * 2, 7 - k * 2, 2); };
    tree(30, 36); tree(38, 38); tree(150, 37); tree(200, 38);
    // 山顶的旗
    g.fillRect(64, 14, 1, 12); g.fillRect(65, 14, 6, 2); g.fillRect(65, 16, 4, 2);
  },
};

const cache = new Map();
export function sceneryURL(id, color, alpha) {
  const key = id + color + alpha;
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = color;
  (SCENES[id] || SCENES.magical)(g);
  // 整体再压淡一层
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const o = out.getContext("2d");
  o.globalAlpha = alpha;
  o.drawImage(c, 0, 0);
  const url = out.toDataURL("image/png");
  cache.set(key, url);
  return url;
}
