// 全局设置（和具体作品无关的）。存在 kv "settings"。
import { db } from "./db.js";
import { bus } from "./bus.js";

export const DEFAULT_SETTINGS = {
  theme: "auto",              // auto 跟随系统 / light / dark
  uiFont: "system",           // 界面字体
  textFont: "serif",          // 正文字体
  textSize: 18,               // 正文字号 px
  lineHeight: 1.9,            // 正文行高
  textWidth: 720,             // 正文栏最大宽度 px
  customFonts: [],            // 自己上传的字体 [{ id, name }]（文件存在 kv "font:<id>"）
  hoverDelay: 500,            // 书架悬停多久显示详情（毫秒）
  demonOn: true,              // 小恶魔显示
  demonScale: 1,              // 1 或 2
  demonStyle: "magical",      // 书架等没有作品时用哪套
  demonChatty: "normal",      // quiet 少说话 / normal / chatty 多说话
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
