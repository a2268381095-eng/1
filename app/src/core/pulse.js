// 码字的「脉搏」：连击、大段删除、写太久、今日每满一千字、本章写到一定长度。
// 只负责算，发事件；小恶魔（demon.js）听这些事件做反应、更新头顶的字数牌子。
//   pulse:combo       { n }          连续码字的字数（停 4 秒以上就断）
//   pulse:combo-level { n, level }   连击跨过 200 / 500 / 1000 / 2000
//   pulse:combo-end   { n }
//   pulse:bigdelete   { n }          一次删了一大段
//   pulse:rest        { minutes }    连续写了很久
//   pulse:milestone   { words }      今天又满了一千字
//   pulse:chapterlen  { words, mark }  本章写到 2000 / 3000 / 5000 / 8000 / 10000 字
import { bus } from "./bus.js";
import { todayWords } from "./store.js";

const COMBO_GAP = 4000;
const LEVELS = [200, 500, 1000, 2000];
const CHAPTER_MARKS = [2000, 3000, 5000, 8000, 10000];
const REST_AFTER = 50 * 60000;
const SESSION_BREAK = 10 * 60000;

let combo = 0, lastInput = 0, comboTimer = 0, levelHit = 0;
let sessionStart = 0, lastRest = 0;
let delWindow = [];
const chapterWords = new Map();   // 章 id → 上次保存时的字数
const today = new Map();          // 作品 id → 今天的字数（上次看到的）

export function mountPulse() {
  bus.on("typing:input", ({ ins, del }) => {
    const now = Date.now();
    // 连击
    if (now - lastInput > COMBO_GAP) { combo = 0; levelHit = 0; }
    combo = Math.max(0, combo + ins);
    lastInput = now;
    if (ins > 0) {
      bus.emit("pulse:combo", { n: combo });
      const lv = LEVELS.filter((x) => combo >= x).pop() || 0;
      if (lv > levelHit) { levelHit = lv; bus.emit("pulse:combo-level", { n: combo, level: lv }); }
    }
    clearTimeout(comboTimer);
    comboTimer = setTimeout(() => { if (combo) bus.emit("pulse:combo-end", { n: combo }); combo = 0; levelHit = 0; }, COMBO_GAP);
    // 大段删除：一次删 120 字以上，或 8 秒内一共删了 300 字以上
    if (del >= 120) bus.emit("pulse:bigdelete", { n: del });
    else if (del > 0) {
      delWindow.push([now, del]);
      delWindow = delWindow.filter(([t]) => now - t < 8000);
      const sum = delWindow.reduce((s, [, d]) => s + d, 0);
      if (sum >= 300) { delWindow = []; bus.emit("pulse:bigdelete", { n: sum }); }
    }
    // 写太久
    if (!sessionStart || now - (lastInput - 1) > SESSION_BREAK) sessionStart = sessionStart && now - sessionStart < SESSION_BREAK * 100 ? sessionStart : now;
    if (now - sessionStart >= REST_AFTER && now - lastRest >= REST_AFTER) { lastRest = now; bus.emit("pulse:rest", { minutes: Math.round((now - sessionStart) / 60000) }); }
  });
  // 停笔超过 10 分钟，重新开始算「连续写了多久」
  bus.on("typing:start", () => { if (Date.now() - lastInput > SESSION_BREAK) sessionStart = Date.now(); });

  bus.on("content:saved", async ({ chapter }) => {
    // 本章长度
    const before = chapterWords.get(chapter.id);
    chapterWords.set(chapter.id, chapter.words);
    if (before != null) {
      const mark = CHAPTER_MARKS.filter((m) => before < m && chapter.words >= m).pop();
      if (mark) bus.emit("pulse:chapterlen", { words: chapter.words, mark });
    }
    // 今日每满一千字
    const n = await todayWords(chapter.bookId);
    const prev = today.get(chapter.bookId);
    today.set(chapter.bookId, n);
    if (prev != null && Math.floor(n / 1000) > Math.floor(prev / 1000) && n >= 1000) bus.emit("pulse:milestone", { words: Math.floor(n / 1000) * 1000 });
    bus.emit("pulse:today", { bookId: chapter.bookId, words: n });
  });
  bus.on("chapter:opened", ({ chapter }) => { if (!chapterWords.has(chapter.id)) chapterWords.set(chapter.id, chapter.words || 0); });
}
