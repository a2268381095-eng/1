// 打包：把 src/ 里的代码和样式塞进一个 dist/index.html，双击就能在浏览器里打开用；
// 小恶魔的像素动画放在 dist/sprites/ 里。
//
//   npm run build
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "src");
// --out <目录>：输出到别的目录（几个人同时测试时互不覆盖）
const outArg = process.argv.indexOf("--out");
const DIST = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, "dist");
const SPRITE_SRC = path.join(ROOT, "..", "assistant_sprite", "styles");
// --bg <目录>：背景插画从别的目录取（测试时用）
const bgArg = process.argv.indexOf("--bg");
const BG_SRC = bgArg > 0 ? path.resolve(process.argv[bgArg + 1]) : path.join(ROOT, "assets", "bg");

// 和 assistant_sprite/tools/make_wardrobe_page.py 里的一致
const STYLES = [
  ["magical", "原稿·小恶魔魔法少女", ["通用", "奇幻", "轻小说"]],
  ["sailor", "水手服·元气同桌", ["校园", "青春", "都市", "日常", "恋爱"]],
  ["hanfu", "古风·执笔仙子", ["仙侠", "玄幻", "古言", "武侠", "历史"]],
  ["gothic", "哥特·暗夜魔典", ["西幻", "魔幻", "暗黑"]],
  ["detective", "侦探·推理少女", ["悬疑", "推理", "刑侦", "惊悚"]],
  ["adventurer", "异世界·见习冒险者", ["异世界", "穿越", "冒险", "游戏", "种田"]],
];
const ACTIONS = ["idle", "wave", "point", "think", "cheer", "shock", "doze"];

function buildSprites() {
  const out = [];
  fs.mkdirSync(path.join(DIST, "sprites"), { recursive: true });
  for (const [id, name, genres] of STYLES) {
    const dir = path.join(SPRITE_SRC, id);
    const actions = {};
    for (const a of ACTIONS) {
      const meta = path.join(dir, "actions", a, "anim.json");
      if (!fs.existsSync(meta)) continue;
      const m = JSON.parse(fs.readFileSync(meta, "utf8"));
      fs.mkdirSync(path.join(DIST, "sprites", id), { recursive: true });
      fs.copyFileSync(path.join(dir, "actions", a, "frames.png"), path.join(DIST, "sprites", id, a + ".png"));
      actions[a] = { frames: m.frames, ms: m.ms, loop: m.loop, w: m.frame_w || 128, h: m.frame_h || 224 };
    }
    const pf = path.join(dir, "persona.json");
    const persona = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, "utf8")) : null;
    out.push({ id, name, genres, actions, persona });
  }
  fs.mkdirSync(path.join(SRC, "generated"), { recursive: true });
  const gen = path.join(SRC, "generated", "sprites.json");
  const json = JSON.stringify(out);
  if (!fs.existsSync(gen) || fs.readFileSync(gen, "utf8") !== json) fs.writeFileSync(gen, json);
  return out.length;
}

// 背景插画：assets/bg/<风格>_out.png（外景）、<风格>_in.png（内景），各带一张 _dither 网点版。
// 拷到 dist/bg/，再把有哪些图、推进的位置、动效（assets/bg/scenes.json）写进 src/generated/scenes.json。
function buildScenes() {
  const metaFile = path.join(ROOT, "assets", "bg", "scenes.json");
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
  const out = {};
  fs.mkdirSync(path.join(DIST, "bg"), { recursive: true });
  let n = 0;
  if (fs.existsSync(BG_SRC)) {
    for (const f of fs.readdirSync(BG_SRC).sort()) {
      const m = /^([a-z]+)_(out|in)\.png$/.exec(f);
      if (!m) continue;
      const [, id, kind] = m;
      const dither = `${id}_${kind}_dither.png`;
      fs.copyFileSync(path.join(BG_SRC, f), path.join(DIST, "bg", f));
      const hasDither = fs.existsSync(path.join(BG_SRC, dither));
      if (hasDither) fs.copyFileSync(path.join(BG_SRC, dither), path.join(DIST, "bg", dither));
      const st = meta[id] || {};
      out[id] = out[id] || { transition: st.transition || "mosaic" };
      out[id][kind] = { focus: [192, 128], anchor: [0.5, 0.5], fx: [], ...(st[kind] || {}), dither: hasDither };
      n++;
    }
  }
  const gen = path.join(SRC, "generated", "scenes.json");
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  const json = JSON.stringify(out);
  if (!fs.existsSync(gen) || fs.readFileSync(gen, "utf8") !== json) fs.writeFileSync(gen, json);
  return n;
}

function collectCss(dir) {
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".css")) files.push(p);
    }
  };
  walk(dir);
  // 基础样式放最前面
  files.sort((a, b) => (a.includes(path.join("styles", "base")) ? -1 : b.includes(path.join("styles", "base")) ? 1 : a.localeCompare(b)));
  return files.map((f) => `/* ${path.relative(SRC, f)} */\n` + fs.readFileSync(f, "utf8")).join("\n");
}

async function build() {
  fs.mkdirSync(DIST, { recursive: true });
  const n = buildSprites();
  const nb = buildScenes();
  const js = await esbuild.build({
    entryPoints: [path.join(SRC, "main.js")],
    bundle: true,
    format: "iife",
    target: ["chrome100", "safari15", "firefox100"],
    minify: true,
    write: false,
    charset: "utf8",
    legalComments: "none",
  });
  const code = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const css = collectCss(SRC);
  const tpl = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
  const html = tpl.replace("/*__CSS__*/", () => css).replace("/*__JS__*/", () => code);
  fs.writeFileSync(path.join(DIST, "index.html"), html);
  const kb = (s) => Math.round(Buffer.byteLength(s) / 1024);
  console.log(`${path.relative(process.cwd(), path.join(DIST, "index.html"))}  js ${kb(code)}KB  css ${kb(css)}KB  sprites ${n} 套  背景 ${nb} 张`);
}

build().catch((e) => { console.error(e); process.exit(1); });
