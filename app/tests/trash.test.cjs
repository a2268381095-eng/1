// 回收站：纯函数的单元测试（node 直接跑）+ 浏览器里的流程测试（Playwright）
//   node build.mjs --out /tmp/xemo-trash && node tests/trash.test.cjs /tmp/xemo-trash
//   只跑单元测试：node tests/trash.test.cjs --unit
const path = require('path');
const { pathToFileURL } = require('url');
const { launch, newBook, getText, chapterList, check } = require('./helpers.cjs');

const DAY = 86400000;
const load = (f) => import(pathToFileURL(path.join(__dirname, '../src/features/trash', f)).href);

// ---------------- 单元测试 ----------------
async function unit(fails) {
  const T = await load('logic.js');
  const now = new Date(2026, 9, 8, 15, 0).getTime();
  console.log('剩几天');
  check(T.daysLeft(now, now) === 30, '刚删的还剩 30 天', fails);
  check(T.leftText(now - 28 * DAY, now) === '还剩 2 天', '删了 28 天：还剩 2 天', fails);
  check(T.leftText(now - 29.5 * DAY, now) === '还剩不到 1 天', '删了 29.5 天：还剩不到 1 天', fails);
  check(T.leftText(now - 31 * DAY, now).includes('下次打开'), '过期的：下次打开时清理', fails);
  check(T.isSoon(now - 28 * DAY, now) && !T.isSoon(now - 5 * DAY, now), '3 天内到期的标出来', fails);

  console.log('第几章');
  const sib = [{ id: 'a', order: 1 }, { id: 'b', order: 2 }, { id: 'd', order: 4 }];
  check(T.positionOf({ id: 'c', order: 3 }, sib) === 3, '删掉的第三章（剩下 1、2、4）还是第三章', fails);
  check(T.positionOf({ id: 'd2', order: 4 }, [{ id: 'a', order: 1 }, { id: 'b', order: 2 }]) === 3, '前面的章也删过：按排在前面的章数算', fails);
  check(T.positionOf({ id: 'x', order: 5 }, []) === 5, '作品不在了：按原来的顺序号', fails);
  check(T.positionOf({ id: 'b', order: 2 }, sib) === 2, '不把自己算进去', fails);

  console.log('条目怎么显示');
  const book = { id: 'b1', title: '测试书', numbering: 'zh' };
  const ch = { id: 'c3', bookId: 'b1', order: 3, title: '旧信', content: '　　信封是空的。\n　　她把信放回去。', words: 13 };
  const ctx = { b1: { book, live: true, chapters: [{ id: 'c1', order: 1 }, { id: 'c2', order: 2 }, { id: 'c4', order: 4 }] } };
  const e1 = { id: 't1', kind: 'chapter', bookId: 'b1', title: '旧信', data: { chapter: ch }, deletedAt: now };
  const d1 = T.describe(e1, ctx);
  check(d1.title === '第三章 旧信' && d1.kindText === '章节' && d1.bookTitle === '测试书' && d1.bookState === 'live' && d1.words === 13,
    '章节：第三章 旧信、所属作品、字数', fails);
  check(d1.excerpt === '信封是空的。 她把信放回去。', '摘要把空白压成一个空格', fails);
  const d2 = T.describe({ ...e1, title: '', data: { chapter: { ...ch, title: '' } } }, { b1: { ...ctx.b1, book: { ...book, numbering: 'num' } } });
  check(d2.title === '第3章' && d2.sub === '没有章名', '没章名时只显示章号，按作品的编号方式', fails);
  check(T.describe(e1, { b1: { book, live: false, chapters: [] } }).bookState === 'trashed', '作品也在回收站：trashed', fails);
  check(T.describe(e1, {}).bookState === 'gone', '作品已经彻底删除：gone', fails);
  const eb = { id: 't2', kind: 'book', bookId: 'b1', title: '测试书', data: { book: { ...book, intro: '' }, chapters: [{ words: 10, content: '甲' }, { words: 5 }] }, deletedAt: now };
  const db = T.describe(eb, {});
  check(db.title === '《测试书》' && db.chapters === 2 && db.words === 15 && db.kindText === '作品', '作品：书名、章数、总字数', fails);
  check(T.describe({ id: 't3', kind: 'image', bookId: 'b1', title: '封面草图', deletedAt: now }, ctx).kindText === '图片'
    && T.describe({ id: 't4', kind: 'xxx', title: '', deletedAt: now }, {}).kindText === '其他', '以后的类型：图片、其他', fails);
  check(T.excerpt('一二三四五六', 3) === '一二三…' && T.excerpt('', 3) === '', '摘要截断加省略号', fails);

  console.log('筛选和恢复前检查');
  const list = [e1, eb, { ...e1, id: 't5' }];
  check(JSON.stringify(T.kindsIn(list)) === '["book","chapter"]', '列出出现过的类型，作品在前', fails);
  check(T.filterKind(list, 'chapter').length === 2 && T.filterKind(list, 'all').length === 3, '按类型筛', fails);
  check(T.restoreBlock(e1, ctx) === 'ok' && T.restoreBlock(eb, {}) === 'ok', '作品在书架上：能直接恢复', fails);
  check(T.restoreBlock(e1, { b1: { book, live: false } }) === 'book-trashed', '作品也在回收站：先恢复作品', fails);
  check(T.restoreBlock(e1, {}) === 'book-gone', '作品不在了：book-gone', fails);
}

// ---------------- 浏览器 ----------------
/** 在页面里直接读写 IndexedDB（造测试数据、核对结果） */
function idb(page, op, store, value) {
  return page.evaluate(([op, store, value]) => new Promise((resolve, reject) => {
    const req = indexedDB.open('xiaoemo-wenshu');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(store, op === 'all' || op === 'get' ? 'readonly' : 'readwrite');
      const os = t.objectStore(store);
      const r = op === 'all' ? os.getAll() : op === 'get' ? os.get(value) : op === 'put' ? os.put(value) : os.delete(value);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => { const out = r.result; t.oncomplete = () => { db.close(); resolve(out); }; };
    };
  }), [op, store, value]);
}

const lastToast = (page, text) => page.locator('.toast:not(.out)', { hasText: text }).last();
const items = (page) => page.$$eval('.trash-item', (els) => els.map((e) => ({
  id: e.dataset.id, kind: e.dataset.kind, name: e.querySelector('.trash-name').textContent, meta: e.querySelector('.trash-meta').textContent,
  soon: !!e.querySelector('.trash-left.soon'),
})));
const hash = (page) => page.evaluate(() => location.hash);
const pause = (page, ms = 250) => page.waitForTimeout(ms);

async function deleteChapterAt(page, i) {
  await page.click(`.ch-item >> nth=${i}`, { button: 'right' });
  await page.click('.menu-item:has-text("删除这一章")');
  await page.click('.modal-foot .btn.danger');
  await page.waitForSelector('.toast:has-text("已删除")');
  await pause(page, 300);
}

async function flows(dist, fails) {
  const { browser, page, errors } = await launch(dist);
  const bookId = await newBook(page, '测试书', [
    { title: '门铃', text: '　　雨下到第三天。' },
    { title: '旧信', text: '　　信封是空的。\n　　她把信放回去。' },
    { title: '尾声', text: '　　结束。' },
  ]);
  check((await chapterList(page)).length === 3, '准备：三章', fails);

  console.log('删一章，从章节列表「…」进回收站');
  await deleteChapterAt(page, 1);
  check((await chapterList(page)).length === 2, '删掉第二章', fails);
  await page.click('[aria-label="章节更多操作"]');
  await page.click('.menu-item:has-text("回收站")');
  await page.waitForSelector('.trash-item');
  check((await hash(page)) === '#/trash/' + bookId, '地址是 #/trash/<作品>', fails);
  let rows = await items(page);
  check(rows.length === 1 && rows[0].name === '第二章 旧信', '列出「第二章 旧信」', fails);
  check(rows[0].meta.includes('《测试书》') && rows[0].meta.includes('13 字') && rows[0].meta.includes('删除于 今天') && rows[0].meta.includes('还剩 30 天'),
    '显示所属作品、字数、删除时间、还剩几天：' + rows[0].meta, fails);
  check((await page.textContent('.topbar .title')) === '回收站 · 《测试书》', '标题带作品名', fails);
  await pause(page, 300);
  const kv = await idb(page, 'get', 'kv', 'settings');
  check(kv && kv.value.tipsSeen && kv.value.tipsSeen['trash-first'], '第一次打开时小恶魔说明了一句', fails);
  const firstEntry = (await idb(page, 'all', 'trash'))[0];

  console.log('返回、找功能');
  await page.click('.topbar [aria-label="返回"]');
  await page.waitForSelector('.cm-content');
  check((await hash(page)).startsWith('#/book/' + bookId), '左上角返回回到写作界面', fails);
  await page.keyboard.press('F1');
  await page.fill('.help-search', '回收站');
  await pause(page, 100);
  check((await page.textContent('.help-item >> nth=0')).includes('回收站'), '问小恶魔「回收站」能搜到', fails);
  await page.click('.help-item >> nth=0');
  await page.waitForSelector('.trash-item');
  check((await hash(page)) === '#/trash/' + bookId, '在作品里打开，只看这本书', fails);
  await page.click('.trash-scope button[data-v="all"]');
  await page.waitForSelector('.trash-scope button[data-v="all"][aria-pressed="true"]');
  check((await hash(page)) === '#/trash', '切到「全部」', fails);
  await page.click('.trash-scope button[data-v="book"]');
  await page.waitForSelector('.trash-scope button[data-v="book"][aria-pressed="true"]');
  check((await hash(page)) === '#/trash/' + bookId, '切回本书', fails);

  console.log('恢复和撤销');
  await page.click('.trash-restore');
  await lastToast(page, '已恢复第二章 旧信').waitFor();
  check(await lastToast(page, '已恢复').locator('.toast-act', { hasText: '打开' }).count() === 1, '提示条有「打开」', fails);
  check(!!(await page.$('.trash-none')), '恢复后列表空了，有说明文字', fails);
  let chs = (await idb(page, 'all', 'chapters')).filter((c) => c.bookId === bookId).sort((a, b) => a.order - b.order);
  check(chs.length === 3 && chs[1].title === '旧信' && (await idb(page, 'all', 'trash')).length === 0, '章节回到原来的位置', fails);
  await lastToast(page, '已恢复').locator('.toast-act', { hasText: '撤销' }).click();
  await page.waitForSelector('.trash-item');
  let trash = await idb(page, 'all', 'trash');
  check(trash.length === 1 && trash[0].id === firstEntry.id && trash[0].deletedAt === firstEntry.deletedAt, '提示条撤销：放回回收站，删除时间不变', fails);
  check((await idb(page, 'all', 'chapters')).filter((c) => c.bookId === bookId).length === 2, '撤销后章节又不在了', fails);
  await page.click('.topbar [aria-label="重做"]');
  await page.waitForSelector('.trash-none');
  check((await idb(page, 'all', 'trash')).length === 0, '重做按钮：又恢复了', fails);
  await page.keyboard.press('Control+z');
  await page.waitForSelector('.trash-item');
  check((await idb(page, 'all', 'trash')).length === 1, 'Ctrl+Z 撤销', fails);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForSelector('.trash-none');
  check((await idb(page, 'all', 'trash')).length === 0, 'Ctrl+Shift+Z 重做', fails);
  await page.click('.topbar [aria-label="撤销"]');
  await page.waitForSelector('.trash-item');

  console.log('恢复后点「打开」');
  await page.click('.trash-restore');
  await lastToast(page, '已恢复').locator('.toast-act', { hasText: '打开' }).click();
  await page.waitForSelector('.cm-content');
  await pause(page, 400);
  const chList = await chapterList(page);
  check((await hash(page)).includes(firstEntry.data.chapter.id) && chList[1] === '第二章|旧信' && (await getText(page)).includes('信封是空的'),
    '跳到那一章：' + chList.join(' / '), fails);

  console.log('作品也删了：先恢复作品');
  await deleteChapterAt(page, 1);
  await page.keyboard.press('F1');
  await page.fill('.help-search', '回到书架');
  await page.click('.help-item >> nth=0');
  await page.waitForSelector('.shelf');
  await page.locator('.book-card', { hasText: '测试书' }).locator('.book-more').click();
  await page.click('.menu-item:has-text("删除作品")');
  await page.click('.modal-foot .btn.danger');
  await page.waitForSelector('.toast:has-text("已删除《测试书》")');
  await page.click('.shelf .tool-btn:has-text("回收站")');
  await page.waitForSelector('.trash-item');
  check((await hash(page)) === '#/trash', '书架上的入口：看全部', fails);
  rows = await items(page);
  check(rows.length === 2 && rows[0].kind === 'book' && rows[0].name === '《测试书》' && rows[0].meta.includes('2 章'), '作品条目：书名、章数', fails);
  check(rows[1].meta.includes('作品也在回收站里'), '章节条目说明作品也删了', fails);
  check(!(await page.$('.trash-scope')), '从书架进来没有「本书」切换', fails);
  await page.click('.trash-kinds button[data-v="chapter"]');
  check((await items(page)).length === 1 && (await items(page))[0].kind === 'chapter', '按类型筛：只看章节', fails);
  await page.click('.trash-kinds button[data-v="all"]');
  check((await items(page)).length === 2, '筛选切回全部', fails);

  await page.click('.trash-item[data-kind="book"] .trash-peek');
  await page.waitForSelector('.trash-read-list li');
  check((await page.$$eval('.trash-read-list li', (l) => l.map((x) => x.textContent))).join('|').includes('第二章 尾声'), '看内容：作品里的章节', fails);
  await page.click('.modal .modal-x');
  await page.waitForSelector('.modal', { state: 'detached' });

  await page.click('.trash-item[data-kind="chapter"] .trash-restore');
  await page.waitForSelector('.modal:has-text("也在回收站里")');
  await page.click('.modal-foot .btn:has-text("先恢复作品")');
  await lastToast(page, '已恢复《测试书》和第二章 旧信').waitFor();
  check((await idb(page, 'all', 'books')).length === 1 && (await idb(page, 'all', 'chapters')).length === 3 && (await idb(page, 'all', 'trash')).length === 0,
    '作品和这一章一起恢复，三章都在', fails);
  await page.keyboard.press('Control+z');
  await page.waitForSelector('.trash-item');
  await pause(page);
  check((await idb(page, 'all', 'books')).length === 0 && (await idb(page, 'all', 'trash')).length === 2 && (await items(page)).length === 2,
    '一次撤销：作品和章节都回到回收站', fails);

  console.log('彻底删除、清空');
  await page.click('.trash-item[data-kind="chapter"] .trash-purge');
  await page.waitForSelector('.modal:has-text("彻底删除")');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
  check((await items(page)).length === 2, 'Esc 关掉确认框，什么都没删', fails);
  await page.click('.trash-item[data-kind="chapter"] .trash-purge');
  await page.click('.modal-foot .btn.danger');
  await page.waitForFunction(() => document.querySelectorAll('.trash-item').length === 1);
  await lastToast(page, '已删除第二章 旧信').waitFor();
  check((await items(page)).length === 1 && (await idb(page, 'all', 'trash')).length === 1, '彻底删除一项', fails);
  await lastToast(page, '已删除').locator('.toast-act', { hasText: '撤销' }).click();
  await page.waitForSelector('.trash-item[data-kind="chapter"]');
  check((await idb(page, 'all', 'trash')).length === 2, '「已删除 · 撤销」找回来', fails);

  await page.click('.trash-empty-btn');
  await page.waitForSelector('.modal:has-text("2 项")');
  check((await page.textContent('.modal')).includes('作品 1、章节 1'), '清空前说清楚有几项', fails);
  await page.click('.modal-foot .btn.danger');
  await page.waitForSelector('.trash-none');
  check((await idb(page, 'all', 'trash')).length === 0, '清空', fails);
  await page.keyboard.press('Control+z');
  await page.waitForSelector('.trash-item');
  check((await idb(page, 'all', 'trash')).length === 2, '清空算一步，一次撤销全回来', fails);

  console.log('作品已经彻底删除：放进别的作品');
  await page.click('.topbar [aria-label="返回"]');
  await page.waitForSelector('.shelf');
  const book2 = await newBook(page, '第二本', [{ title: '开头', text: '　　第一段。' }]);
  const t0 = Date.now();
  await idb(page, 'put', 'trash', {
    id: 't-orphan', kind: 'chapter', bookId: 'b-gone', title: '孤章', deletedAt: t0 - 28 * DAY,
    data: { chapter: { id: 'c-orphan', bookId: 'b-gone', order: 2, volumeId: null, title: '孤章', content: '　　没有家的一章。', points: [], words: 8, createdAt: t0, updatedAt: t0 } },
  });
  await page.click('[aria-label="章节更多操作"]');
  await page.click('.menu-item:has-text("回收站")');
  await page.waitForSelector('.trash-none');
  check((await page.textContent('.trash-none')).includes('这本书没有删掉的东西'), '这本书没删过东西：有说明', fails);
  await page.click('.trash-scope button[data-v="all"]');
  await page.waitForSelector('.trash-item[data-id="t-orphan"]');
  const orphan = (await items(page)).find((r) => r.id === 't-orphan');
  check(orphan.meta.includes('原作品已经彻底删除') && orphan.meta.includes('还剩 2 天') && orphan.soon, '快到期的标出来：还剩 2 天', fails);
  await page.click('.trash-item[data-id="t-orphan"] .trash-restore');
  await page.waitForSelector('.modal:has-text("已经彻底删除了")');
  check(await page.locator('.modal-foot .btn', { hasText: '另存成 txt' }).count() === 1, '报错卡给出「另存成 txt」', fails);
  await page.click('.modal-foot .btn:has-text("放进别的作品")');
  await page.click('.trash-pick-item:has-text("第二本")');
  await lastToast(page, '放进《第二本》').waitFor();
  let moved = await idb(page, 'get', 'chapters', 'c-orphan');
  check(moved && moved.bookId === book2 && moved.order === 2 && !(await idb(page, 'get', 'trash', 't-orphan')), '放进《第二本》的最后', fails);
  await lastToast(page, '放进《第二本》').locator('.toast-act', { hasText: '打开' }).click();
  await page.waitForSelector('.cm-content');
  await pause(page, 400);
  check((await chapterList(page)).length === 2 && (await getText(page)).includes('没有家的一章'), '打开：在第二本里看到这一章', fails);
  await page.click('.topbar [aria-label="撤销"]');
  await page.waitForFunction(() => document.querySelectorAll('.ch-item').length === 1);
  await pause(page, 400);
  const back = await idb(page, 'get', 'trash', 't-orphan');
  check(!(await idb(page, 'get', 'chapters', 'c-orphan')) && back && back.bookId === 'b-gone' && back.deletedAt === t0 - 28 * DAY,
    '在写作界面撤销：这一章回到回收站，原样不变，列表跟着变', fails);

  console.log('主题彩蛋、手机宽度、深色');
  const s = await idb(page, 'get', 'kv', 'settings');
  await idb(page, 'put', 'kv', { key: 'settings', value: { ...(s ? s.value : {}), themeNames: true } });
  await page.evaluate(() => { location.hash = '#/trash'; });
  await page.reload();
  await page.waitForSelector('.trash-item');
  check((await page.textContent('.topbar .title')) === '地狱', '标题用 label()：地狱', fails);
  check((await page.textContent('.trash-item[data-kind="chapter"]:not([data-id="t-orphan"]) .trash-meta')).includes('作品也在地狱里'), '说明文字里也跟着改', fails);
  await page.click('.topbar [aria-label="返回"]');
  await page.waitForSelector('.shelf');
  check((await hash(page)) === '#/', '直接打开的回收站，返回到书架', fails);
  await page.click('.shelf .tool-btn:has-text("地狱")');
  await page.waitForSelector('.trash-item');

  await page.setViewportSize({ width: 390, height: 844 });
  await pause(page, 300);
  const fit = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll('.trash-item, .trash-item button, .topbar > *, .trash-bar > *')].filter((e) => e.getBoundingClientRect().right > W + 0.5);
    return { W, sw: document.documentElement.scrollWidth, main: document.querySelector('.trash-main').scrollWidth - document.querySelector('.trash-main').clientWidth, over: over.map((e) => e.className) };
  });
  check(fit.sw <= fit.W && fit.main <= 0 && !fit.over.length, '390px 宽不横向溢出 ' + JSON.stringify(fit), fails);
  await page.emulateMedia({ colorScheme: 'dark' });
  await pause(page, 200);
  const dark = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    const it = getComputedStyle(document.querySelector('.trash-item'));
    const nm = getComputedStyle(document.querySelector('.trash-name'));
    return { bg: lum(it.backgroundColor), ink: lum(nm.color) };
  });
  check(dark.bg < 0.2 && dark.ink > 0.7, '深色模式：底色深、字浅 ' + JSON.stringify(dark), fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
}

(async () => {
  const fails = [];
  await unit(fails);
  if (!process.argv.includes('--unit')) {
    const dist = process.argv[2] || path.join(__dirname, '../dist');
    try { await flows(dist, fails); }
    catch (e) { fails.push('浏览器测试中断：' + e.message); console.log('  ✗ ' + (e.stack || e.message)); }
  }
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
