// 全局设置（和具体作品无关的）。存在 kv "settings"。
import { db } from "./db.js";
import { bus } from "./bus.js";

export const DEFAULT_SETTINGS = {
  theme: "auto",              // 明暗：auto 跟随系统 / light / dark / time 随时间（晚 8 点到早 6 点深色）
  palette: "follow",          // 配色：follow 跟随小恶魔 / time 随时间 / season 随季节 / magical / sailor / hanfu / gothic / detective / adventurer
  pixelBg: true,              // 空白处铺像素底纹
  sceneBg: true,              // 背景插画（每套风格一张外景、一张内景）
  sceneArt: "",               // 背景画法：orig 原图（默认）/ pixel 像素 / dot 像素网点；空着时看旧的 sceneDither
  sceneDither: false,         // 旧设置：背景插画用网点版
  sceneVeil: 60,              // 背景透出：0 界面最实 — 100 画最清楚
  sceneCycle: 10,             // 外景、内景轮换：每几分钟，0 不轮换
  sceneNav: true,             // 打开作品时走进内景，回书架走回外景
  paperRest: 30,              // 停笔多少秒后纸和侧栏淡下去、屏幕交给动态背景，0 不淡
  motion: "auto",             // 界面动效：auto（系统要求减少动态时关掉）/ full 完整 / simple 简洁 / off 关闭
  clickFx: "style",           // 点击特效：style 跟随小恶魔的道具 / hearts 像素爱心 / ripple 魔法波纹 / ink 墨点 / off
  demonPulse: true,           // 码字互动：字数牌子、连击
  uiFont: "system",           // 界面字体
  textFont: "kai",            // 正文字体：默认霞鹜文楷（打包在软件里，书卷气）
  textSize: 18,               // 正文字号 px
  lineHeight: 1.9,            // 正文行高
  textWidth: 720,             // 正文栏最大宽度 px
  customFonts: [],            // 自己上传的字体 [{ id, name }]（文件存在 kv "font:<id>"）
  hoverDelay: 500,            // 书架悬停多久显示详情（毫秒）
  demonOn: true,              // 小恶魔显示
  demonScale: 1,              // 大小：0.5–3
  demonPos: null,             // 位置 { right, bottom }（px，离窗口右下角），null 是默认的右下角
  demonStyle: "magical",      // 书架等没有作品时用哪套
  demonChatty: "normal",      // quiet 少说话 / normal / chatty 多说话
  demonGuide: "on",          // 鼠标停在功能上时小恶魔讲一句（on / off）
  idleMinutes: 5,             // 停笔多少分钟算「停笔很久」
  tipsSeen: {},               // 第一次使用的说明看过哪些
  keys: {},                   // 自定义快捷键 { commandId: "Mod-Shift-f" }
  themeNames: false,          // 主题彩蛋：设置=签订契约，回收站=地狱，暂存盒=恶魔口袋
};

let settings = { ...DEFAULT_SETTINGS };

export async function loadSettings() {
  const saved = await db.getKV("settings", {});
  settings = { ...DEFAULT_SETTINGS, ...saved };
  return settings;
}

export const getSettings = () => settings;

export async function setSettings(patch) {
  settings = { ...settings, ...patch };
  await db.setKV("settings", settings);
  bus.emit("settings:changed", { settings, patch });
  return settings;
}

/** 名称彩蛋 */
export function label(name) {
  if (!settings.themeNames) return name;
  return { 设置: "签订契约", 回收站: "地狱", 暂存盒: "恶魔口袋" }[name] || name;
}
