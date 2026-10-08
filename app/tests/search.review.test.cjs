// 查找替换 · 复查用的刁钻测试：边界、长章节、输入法、特殊字符、连续撤销重做、刷新、Esc、深色、手机宽度。
//   node build.mjs --out /tmp/xemo-search-review && node tests/search.review.test.cjs /tmp/xemo-search-review
const path = require('path');
const { pathToFileURL } = require('url');
const { launch, newBook, getText, check } = require('./helpers.cjs');

// ---------------- 纯函数 ----------------
async function unit(fails) {
  console.log('单元测试（engine.js 边界）');
  const E = await import(pathToFileURL(path.join(__dirname, '../src/features/search/engine.js')).href);
  const find = (text, q, o = {}) => { const m = E.buildMatcher(q, o); return m.error ? m : E.findAll(text, m.re, o).map((x) => [x.from, x.to]); };

  // 普通模式下所有正则元字符都按字面找
  const meta = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o/p-q';
  for (const ch of '.*+?^${}()|[]\\/-') {
    const r = find(meta, ch);
    check(Array.isArray(r) && r.length === [...meta].filter((x) => x === ch).length, `普通模式按字面找「${ch}」`, fails);
  }
  check(find('价格是 $5，$1 不是分组', '$1').length === 1, '普通模式找 $1', fails);
  check(find('', '林栀').length === 0 && find('林栀', '').length === 0, '空正文、空查找都不出错', fails);
  check(JSON.stringify(find('😀林栀😀', '😀')) === '[[0,2],[4,6]]', '表情字符按两个码元定位', fails);
  check(find('ΣΑΣ σας', 'σας').length === 2 && find('ДОМ дом', 'дом').length === 2 && find('ΣΑΣ σας', 'σας', { caseSensitive: true }).length === 1, '希腊文、俄文不区分大小写', fails);
  check(find('a\nb', '\\n', { regex: true }).length === 1, '正则能找换行', fails);
  check(find('林栀，林夏', '(?<=林)栀', { regex: true }).length === 1, '正则后行断言', fails);

  // 正则乱写：不抛异常，要么能用，要么给中文说明
  const pool = ['(', ')', '[', ']', '{', '}', '*', '+', '?', '\\', '^', '$', '|', '.', 'a', '1', ',', '<', '>', '-', ':', '=', '!', 'k', 'p', 'u'];
  let seed = 7, thrown = 0, noZh = 0;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 3000; i++) {
    let q = '';
    for (let j = 0, n = 1 + rnd(8); j < n; j++) q += pool[rnd(pool.length)];
    try {
      const m = E.buildMatcher(q, { regex: true });
      if (m.error && !/[一-龥]/.test(m.error)) noZh++;
      if (m.re) E.findAll('aa1,<b>-c{2}', m.re, {});
    } catch (e) { thrown++; }
  }
  check(thrown === 0 && noZh === 0, `3000 个乱写的正则：抛异常 ${thrown} 个，没有中文说明 ${noZh} 个`, fails);

  // 替换模板
  const hit = E.findAll('第一章', E.buildMatcher('第(.)章', { regex: true }).re)[0];
  const ex = (t) => E.expandReplacement(t, hit, { regex: true });
  check(ex('$0') === '$0' && ex('$2') === '$2' && ex('$10') === '一0' && ex('$<x>') === '$<x>' && ex('$') === '$' && ex('$$$1') === '$一', '替换模板里的 $0 $2 $10 $<x> $ $$', fails);

  // 上下文：表情不被截成半个，超长单行也快
  const emo = '😀'.repeat(30) + '林栀' + '😀'.repeat(30);
  const c1 = E.contextOf(emo, 60, 62, 15);
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  check(!lone.test(c1.before) && !lone.test(c1.after), '上下文不把表情截成半个', fails);
  check(E.contextOf('林栀', 0, 2).before === '' && E.contextOf('林栀', 0, 2).after === '', '上下文：命中就是全文', fails);
  const line = '　　林栀走过长街，雨水落在伞面上，她想起旧信里的那句话。'.repeat(4000);
  const lhits = E.findAll(line, E.buildMatcher('林栀', {}).re).slice(0, 1000);
  let t = Date.now();
  for (const x of lhits) E.contextOf(line, x.from, x.to, 16);
  const ctxMs = Date.now() - t;
  check(ctxMs < 15, `11 万字的单段里取 1000 条上下文：${ctxMs}ms`, fails);

  // 恰好找到上限那么多处时，不算「只找了前几处」
  const exact = E.searchChapters([{ id: 'a', text: 'x'.repeat(10) }], E.buildMatcher('x', {}).re, { limit: 10 });
  check(exact.total === 10 && !exact.truncated, '恰好 10 处、上限 10：不算截断', fails);
  const over = E.searchChapters([{ id: 'a', text: 'x'.repeat(5) }, { id: 'b', text: 'x'.repeat(6) }], E.buildMatcher('x', {}).re, { limit: 10 });
  check(over.total === 10 && over.truncated, '11 处、上限 10：截断', fails);

  // 未分卷：卷 id 已经不存在的章也算未分卷（和章节列表一致）
  const vlist = [{ id: 'a', volumeId: 'v1' }, { id: 'b', volumeId: 'gone' }, { id: 'c' }];
  check(E.chaptersInScope(vlist, 'vol:', { volumeIds: ['v1'] }).map((c) => c.id).join('') === 'bc', '未分卷包括卷已经不在的章', fails);

  // 筛选：字数等于上限不算「少于」，数字是字符串也行
  check(!E.chapterPasses({}, { wordsOn: true, maxWords: 100 }, 100) && E.chapterPasses({}, { wordsOn: true, maxWords: '100' }, 99), '筛选：少于是严格小于，字符串数字也认', fails);

  // 改动很大时位置换算也不卡
  const para = '　　林栀走过长街，雨水落在伞面上，她想起旧信里的那句话。';
  const big = Array.from({ length: 4000 }, () => para).join('\n');
  const bigHits = E.findAll(big, E.buildMatcher('林栀', {}).re);
  const after = E.replaceHits(big, bigHits, '林小夏');
  t = Date.now();
  E.makeMapper(big, after)(50000);
  const mapMs = Date.now() - t;
  check(mapMs < 400, `11 万字里换了 4000 处后换算位置：${mapMs}ms`, fails);

  // 已知改了哪几段时，位置换算是准的
  if (E.editMapper) {
    const edits = bigHits.slice(0, 3).map((x) => ({ from: x.from, to: x.to, len: 3 }));
    const mp = E.editMapper(edits);
    const p = bigHits[3].from;
    const moved = E.replaceHits(big, bigHits.slice(0, 3), '林小夏');
    check(moved.slice(mp(p), mp(p) + 2) === '林栀' && mp(0) === 0, '按改动换算位置', fails);
  } else check(false, '有 editMapper（按改动换算位置）', fails);

  // 查找线程要用的函数不能引用外面的变量
  if (E.scan) {
    let ok = false;
    try {
      const fn = new Function('return (' + E.scan.toString() + ')')();
      const r = fn([{ id: 'a', text: 'Tom tom atom' }], /tom/gi, true, 100);
      ok = r.total === 2 && r.groups[0].hits[1].from === 4;
    } catch (e) { ok = false; }
    check(ok, 'scan 单独拿出来也能跑（放进查找线程用）', fails);
  } else check(false, '有 scan（放进查找线程用）', fails);
}

// ---------------- 浏览器里的工具 ----------------
const dbChapters = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const bookId = location.hash.split('/')[2];
  const r = indexedDB.open('xiaoemo-wenshu');
  r.onerror = () => reject(r.error);
  r.onsuccess = () => {
    const q = r.result.transaction('chapters').objectStore('chapters').getAll();
    q.onsuccess = () => { resolve(q.result.filter((c) => c.bookId === bookId).sort((a, b) => a.order - b.order).map((c) => ({ title: c.title, content: c.content }))); r.result.close(); };
  };
}));
const contents = async (page) => (await dbChapters(page)).map((c) => c.content);
const wait = (page, ms = 450) => page.waitForTimeout(ms);
const press = (page, k) => page.keyboard.press(k);
const sum = (page) => page.textContent('.sr-sum');
const panelOpen = (page) => page.isVisible('.side-right .sr-panel');
const checks = (page) => page.$$eval('.sr-hit .sr-cb input', (els) => els.map((e) => e.checked));
const editorFocused = (page) => page.evaluate(() => !!(document.activeElement && document.activeElement.closest('.cm-editor')));
const responsive = (page, ms) => Promise.race([page.evaluate(() => 1).then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
async function openPanel(page, k = 'Control+f') { await press(page, k); await page.waitForSelector('.sr-panel .sr-q'); await wait(page, 250); }
async function fillQ(page, q, ms = 450) { await page.fill('.sr-q', q); await wait(page, ms); }
async function scopeBook(page) { if (!(await page.isVisible('.sr-seg[aria-pressed="true"]:has-text("全书")'))) await page.click('.sr-seg:has-text("全书")'); await wait(page, 300); }
async function showReplace(page) { if (!(await page.isVisible('.sr-r'))) await page.click('.sr-fold[data-k="showReplace"]'); await wait(page, 100); }
async function selectInEditor(page, word) {
  await page.evaluate((w) => {
    const v = document.querySelector('.cm-content').cmView.view;
    const i = v.state.doc.toString().indexOf(w);
    v.dispatch({ selection: { anchor: i, head: i + w.length } });
    v.focus();
  }, word);
}
/** 把第 n 章的正文整体换成 text（走编辑器，等自动保存） */
async function putText(page, n, text) {
  await page.click(`.ch-item >> nth=${n}`);
  await wait(page, 300);
  await page.evaluate((t) => { const v = document.querySelector('.cm-content').cmView.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, userEvent: 'input' }); }, text);
  await wait(page, 1500);
}
async function longTasks(page) {
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] });
  });
}
const takeLong = (page) => page.evaluate(() => { const a = window.__lt.slice(); window.__lt.length = 0; return a.length ? Math.max(...a) : 0; });

const T = {
  empty: '',
  sym: '　　a.b*c (x) [y] {z} $1 \\ ^ | 价格是 $5。\n　　a.b*c 再来一次。',
  emoji: '　　😀林栀😀笑了。Tom 说 tom。\n　　林栀😀。',
  pair: '　　林栀和林栀。',
  back: '　　' + 'a'.repeat(40) + '!',
};

// ---------------- 桌面：边界、撤销、刷新、Esc ----------------
async function desktop(dist, fails) {
  console.log('浏览器 · 桌面');
  const { browser, page, errors } = await launch(dist);
  let hung = false;
  try {
    await newBook(page, '边界测试', ['空章', '符号', '表情', '一对', '回溯'].map((title) => ({ title, text: '' })));
    const all = [T.empty, T.sym, T.emoji, T.pair, T.back];
    for (let i = 0; i < all.length; i++) await putText(page, i, all[i]);
    check(JSON.stringify(await contents(page)) === JSON.stringify([T.empty, T.sym, T.emoji, T.pair, T.back]), '准备：五章写进去了', fails);

    // ---- 空章节、空查找 ----
    await page.click('.ch-item >> nth=0');
    await wait(page, 300);
    await openPanel(page);
    const bubble = await page.evaluate(() => { const b = document.querySelector('.demon-bubble'); return b ? { n: b.children.length, cls: b.firstElementChild && b.firstElementChild.className, text: b.textContent } : null; });
    check(bubble && bubble.n === 1 && bubble.cls === 'demon-text' && !/^\s*小恶魔/.test(bubble.text), '小恶魔的气泡上面没有名字，只有台词 ' + JSON.stringify(bubble), fails);
    await fillQ(page, '林栀');
    check((await sum(page)).includes('没找到'), '空章节里找：没找到', fails);
    await press(page, 'Enter');
    await press(page, 'F3');
    await press(page, 'Shift+F3');
    await openPanel(page, 'Control+h');
    check(await page.isDisabled('.sr-rep button:has-text("替换这一处")') && await page.isDisabled('.sr-all'), '没找到时两个替换按钮都不能点', fails);
    await fillQ(page, '');
    check((await page.textContent('.sr-count')) === '' && (await page.textContent('.sr-list')).includes('输入要找的字'), '查找框清空：回到提示', fails);
    await page.focus('.sr-q');
    await press(page, 'Enter');
    check(errors.length === 0, '空查找按回车、F3 不报错', fails);

    // ---- 特殊字符：普通模式按字面找 ----
    await scopeBook(page);
    for (const [q, n] of [['(x)', 1], ['a.b*c', 2], ['\\', 1], ['$1', 1], ['^', 1], ['|', 1], ['[y]', 1], ['{z}', 1], ['$5', 1]]) {
      await fillQ(page, q, 350);
      check((await sum(page)).includes(`共 ${n} 处`), `普通模式找「${q}」：${n} 处`, fails);
    }
    await showReplace(page);
    await fillQ(page, 'a.b*c');
    await page.fill('.sr-r', '$1&$&');
    await wait(page, 200);
    await page.click('.sr-all');
    await wait(page, 700);
    let c = await contents(page);
    check(c[1].includes('$1&$& (x)') && c[1].includes('$1&$& 再来一次'), '普通模式替换里的 $1 $& 原样写进去', fails);
    await page.click('.toast:has-text("已替换") .toast-act');
    await wait(page, 700);
    check((await contents(page))[1] === T.sym, '提示条撤销：符号章还原', fails);

    // ---- 表情、大小写 ----
    await fillQ(page, '😀');
    check((await sum(page)).includes('共 3 处'), '找表情：3 处', fails);
    const listText = await page.textContent('.sr-list');
    check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(listText), '结果里没有半个表情', fails);
    await page.fill('.sr-r', '🙂');
    await wait(page, 200);
    await page.click('.sr-all');
    await wait(page, 700);
    c = await contents(page);
    check(!c[2].includes('😀') && [...c[2]].filter((x) => x === '🙂').length === 3, '表情全部替换', fails);
    await page.click('.ws .topbar button[aria-label="撤销"]');
    await wait(page, 700);
    check((await contents(page))[2] === T.emoji, '顶栏撤销：表情章还原', fails);

    // ---- 中文输入法：拼音没打完不找 ----
    await page.fill('.sr-q', '');
    await wait(page, 350);
    await page.focus('.sr-q');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'lin', selectionStart: 3, selectionEnd: 3 });
    await wait(page, 450);
    check(!(await sum(page)).includes('没找到') && (await page.textContent('.sr-count')) === '', '输入法拼音没打完时不找', fails);
    await cdp.send('Input.insertText', { text: '林栀' });
    await wait(page, 450);
    check((await page.inputValue('.sr-q')) === '林栀' && (await sum(page)).includes('共 4 处'), '输入法打完字马上找', fails);

    // ---- 连续操作后撤销、重做 ----
    await page.fill('.sr-r', '林夏');
    await wait(page, 200);
    await page.click('.sr-rep button:has-text("替换这一处")');
    await wait(page, 300);
    await page.click('.sr-rep button:has-text("替换这一处")');
    await wait(page, 700);
    await page.click('.sr-all');
    await wait(page, 800);
    c = await contents(page);
    check(!c[2].includes('林栀') && !c[3].includes('林栀') && c[2].includes('林夏') && c[3] === '　　林夏和林夏。', '逐个替换 1 处 + 全部替换 3 处', fails);
    for (let i = 0; i < 2; i++) { await page.click('.ws .topbar button[aria-label="撤销"]'); await wait(page, 700); }
    c = await contents(page);
    check(c[2] === T.emoji && c[3] === T.pair, '顶栏撤销两次：两次替换都还原', fails);
    for (let i = 0; i < 2; i++) { await page.click('.ws .topbar button[aria-label="重做"]'); await wait(page, 700); }
    c = await contents(page);
    check(!c[2].includes('林栀') && c[3] === '　　林夏和林夏。', '重做两次', fails);
    for (let i = 0; i < 2; i++) { await page.click('.ws .topbar button[aria-label="撤销"]'); await wait(page, 700); }
    c = await contents(page);
    check(c[2] === T.emoji && c[3] === T.pair && (await sum(page)).includes('共 4 处'), '再撤销两次：还原，结果刷新', fails);

    // ---- 提示条上的撤销：后面又做了一次替换，也一起撤掉 ----
    await page.click('.sr-all');
    await wait(page, 800);
    await fillQ(page, '林夏');
    await page.fill('.sr-r', '林秋');
    await wait(page, 200);
    await page.click('.sr-all');
    await wait(page, 800);
    c = await contents(page);
    check(c[3] === '　　林秋和林秋。', '两次全部替换：林栀 → 林夏 → 林秋', fails);
    await page.click('.toast:has-text("已替换 4 处") >> nth=0 >> .toast-act');
    await wait(page, 1000);
    c = await contents(page);
    check(c[2] === T.emoji && c[3] === T.pair, '点第一次替换的「撤销」：两次都还原', fails);

    // ---- 不在替换范围里的章打开着：顶栏撤销、编辑器 Ctrl+Z 也能撤掉全书替换 ----
    await page.click('.ch-item >> nth=0');
    await wait(page, 300);
    await fillQ(page, '林栀');
    await page.fill('.sr-r', '林夏');
    await wait(page, 200);
    await page.click('.sr-all');
    await wait(page, 800);
    check((await page.isVisible('.sr-done')), '替换后面板里有「已替换 · 撤销」', fails);
    await page.click('.ws .topbar button[aria-label="撤销"]');
    await wait(page, 800);
    c = await contents(page);
    check(c[2] === T.emoji && c[3] === T.pair, '当前章不在替换范围里：顶栏撤销也能整体还原', fails);
    check(!(await page.isVisible('.sr-done')), '撤销以后面板里的「已替换 · 撤销」收起来', fails);
    await page.click('.ws .topbar button[aria-label="重做"]');
    await wait(page, 800);
    await page.click('.cm-content');
    await press(page, 'Control+z');
    await wait(page, 800);
    c = await contents(page);
    check(c[2] === T.emoji && c[3] === T.pair, '重做后在正文里按 Ctrl+Z 也能整体还原', fails);

    // ---- 刷新以后：撤销过的正文还是撤销后的样子 ----
    await page.reload();
    await page.waitForSelector('.cm-content');
    await wait(page, 500);
    c = await contents(page);
    check(c[2] === T.emoji && c[3] === T.pair, '刷新后正文是撤销后的样子', fails);

    // ---- 刷新后：先在第一章，替换别的章，再撤销 ----
    await page.click('.ch-item >> nth=0');
    await wait(page, 300);
    await openPanel(page, 'Control+Shift+F');
    await showReplace(page);
    await fillQ(page, '林栀');
    await page.fill('.sr-r', '林夏');
    await wait(page, 200);
    await page.click('.sr-all');
    await wait(page, 800);
    await page.click('.cm-content');
    await press(page, 'Control+z');
    await wait(page, 800);
    c = await contents(page);
    check(c[2] === T.emoji && c[3] === T.pair, '刷新后替换没打开过的章：正文里 Ctrl+Z 能整体还原', fails);

    // ---- 保留草稿：刷新后取消勾选的那一处还是不勾 ----
    await page.click('.sr-sum button:has-text("全选")').catch(() => {});
    await page.fill('.sr-r', '林夏');
    await wait(page, 300);
    await page.click('.sr-hit >> nth=1 >> .sr-cb input');
    check(JSON.stringify(await checks(page)) === '[true,false,true,true]', '取消勾选第二处', fails);
    await page.focus('.sr-q');
    await press(page, 'Escape');
    await page.click('.modal-foot .btn:has-text("保留草稿")');
    await wait(page, 300);
    await page.reload();
    await page.waitForSelector('.cm-content');
    await wait(page, 500);
    await page.click('.ch-item >> nth=2');
    await wait(page, 300);
    await page.click('.cm-content');
    await press(page, 'Control+Home');
    await page.keyboard.insertText('开头');
    await wait(page, 1600);
    await openPanel(page, 'Control+h');
    await wait(page, 300);
    check((await page.inputValue('.sr-r')) === '林夏', '刷新后草稿还在', fails);
    check(JSON.stringify(await checks(page)) === '[true,false,true,true]', '刷新、改过正文后，取消勾选的那一处还是不勾 ' + JSON.stringify(await checks(page)), fails);
    await page.click('.sr-all');
    await wait(page, 800);
    c = await contents(page);
    check(c[2] === '开头　　😀林夏😀笑了。Tom 说 tom。\n　　林栀😀。' && c[3] === '　　林夏和林夏。', '全部替换跳过了不勾的那一处', fails);
    await page.click('.toast:has-text("已替换") .toast-act');
    await wait(page, 800);

    // ---- 面板开着时删章、多选章 ----
    await page.click('.ch-item >> nth=0');
    await wait(page, 300);
    await fillQ(page, '林栀');
    check((await sum(page)).includes('共 4 处 · 2 章'), '删章前：4 处 2 章', fails);
    await page.click('.ch-item >> nth=3', { button: 'right' });
    await page.click('.menu-item:has-text("删除这一章")');
    await page.click('.modal-foot .btn.danger');
    await page.mouse.move(700, 400);
    await wait(page, 800);
    const titles = await page.$$eval('.sr-gt', (els) => els.map((e) => e.textContent));
    check((await sum(page)).includes('共 2 处 · 1 章') && !titles.some((t) => t.includes('一对')), '删掉一章：结果里马上没有它 ' + titles.join(','), fails);
    await page.click('.toast:has-text("已删除") .toast-act');
    await page.mouse.move(700, 400);
    await wait(page, 900);
    check((await sum(page)).includes('共 4 处 · 2 章'), '撤销删章：结果回来', fails);
    await page.click('.ch-item >> nth=2', { modifiers: ['Control'] });
    await page.mouse.move(700, 400);
    await wait(page, 500);
    check(await page.isVisible('.sr-seg:has-text("选中的 2 章")'), 'Ctrl 点选章节：不用把鼠标移进面板，范围里马上有「选中的 2 章」', fails);
    await page.click('.sel-bar button:has-text("取消选择")');
    await page.mouse.move(700, 400);
    await wait(page, 500);
    check(!(await page.isVisible('.sr-seg:has-text("选中")')), '取消选择：范围马上收回', fails);

    // ---- 面板开着时，正文里选一段字再按 Ctrl+F ----
    await page.click('.ch-item >> nth=1');
    await wait(page, 300);
    await selectInEditor(page, '价格');
    await openPanel(page);
    check((await page.inputValue('.sr-q')) === '价格', '面板开着时选字按 Ctrl+F：拿选中的字来找', fails);

    // ---- Esc、关闭按钮、焦点回到正文 ----
    if (await page.isVisible('.sr-r')) await page.fill('.sr-r', '');
    await page.focus('.sr-q');
    await press(page, 'Escape');
    await wait(page, 200);
    check(!(await panelOpen(page)) && await editorFocused(page), '在查找框按 Esc：关掉面板，光标回到正文', fails);
    await openPanel(page);
    await page.click('.side-right .panel-head button[aria-label="关闭"]');
    await wait(page, 200);
    check(!(await panelOpen(page)) && await editorFocused(page), '点 ×：关掉面板，光标回到正文', fails);
    await openPanel(page);
    await page.click('.sr-fold[data-k="showFilter"]');
    await page.click('.sr-save');
    await page.waitForSelector('.modal input.input');
    await press(page, 'Escape');
    await wait(page, 200);
    check(!(await page.isVisible('.modal')) && await panelOpen(page), '存常用筛选的弹窗里按 Esc：只关弹窗', fails);
    await page.click('.sr-fold[data-k="showFilter"]');
    await page.click('.cm-content');
    await press(page, 'Escape');
    await wait(page, 200);
    check(!(await panelOpen(page)), '光标在正文里按 Esc：也能关掉面板', fails);

    // ---- 没找到也算改了一半：关之前问 ----
    await openPanel(page, 'Control+h');
    await fillQ(page, 'zzzz');
    await page.fill('.sr-r', '半截');
    await page.focus('.sr-q');
    await press(page, 'Escape');
    await wait(page, 300);
    check(await page.isVisible('.modal:has-text("里面还有没保存的内容")'), '替换框填了字（没找到也算）：关之前问保留草稿还是丢弃', fails);
    await page.click('.modal-foot .btn:has-text("丢弃")').catch(() => {});
    await wait(page, 300);

    // ---- 正则：写错、命名分组、回溯太多 ----
    await openPanel(page, 'Control+Shift+F');
    await page.fill('.sr-r', '');
    if (!(await page.isVisible('.sr-opt[data-k="regex"]'))) await page.click('.sr-fold[data-k="advanced"]');
    if ((await page.getAttribute('.sr-opt[data-k="regex"]', 'aria-pressed')) !== 'true') await page.click('.sr-opt[data-k="regex"]');
    for (const bad of ['(', '[', 'a{2,1}', '*', '\\', '(?<a>x)(?<a>y)', '(?', '[z-a]']) {
      await fillQ(page, bad, 350);
      const t = (await page.isVisible('.sr-err')) ? await page.textContent('.sr-err') : '';
      check(/[一-龥]/.test(t) && !/SyntaxError|Invalid/.test(t), `正则「${bad}」写错：中文提示 ${t}`, fails);
    }
    await fillQ(page, '\\d+');
    check(!(await page.isVisible('.sr-err')), '改对以后提示消失', fails);
    await fillQ(page, '(?<x>林)(?<y>栀)');
    await page.fill('.sr-r', '$<y>$<x>');
    await wait(page, 300);
    check((await page.textContent('.sr-hit .sr-ins')) === '栀林', '命名分组替换预览', fails);
    await page.fill('.sr-r', '');
    check(errors.length === 0, '正则乱写不报错 ' + errors.join(' | '), fails);

    await page.fill('.sr-q', '(a+)+$');
    await wait(page, 600);
    const alive = await responsive(page, 3000);
    check(alive, '回溯很多的正则：页面不卡死', fails);
    if (!alive) { hung = true; throw new Error('页面卡死了'); }
    await page.waitForSelector('.sr-err:visible', { timeout: 8000 }).catch(() => {});
    check((await page.textContent('.sr-err')).includes('太复杂'), '回溯很多的正则：提示太复杂 ' + (await page.textContent('.sr-err')), fails);
    await fillQ(page, 'a+!', 600);
    check((await sum(page)).includes('共 1 处'), '换个正则又能找', fails);

    check(errors.length === 0, '没有页面报错 ' + errors.join(' | '), fails);
  } catch (e) {
    fails.push('异常：' + e.message);
    console.log('  ✗ 异常：' + e.stack);
    if (!hung) try { await page.screenshot({ path: path.join(require('os').tmpdir(), 'search-review-fail.png') }); } catch (_) { /* 截图失败不管 */ }
  }
  if (hung) { try { browser.process && browser.process() && browser.process().kill('SIGKILL'); } catch (_) { /* */ } }
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]);
}

// ---------------- 超长章节 ----------------
async function longChapters(dist, fails) {
  console.log('浏览器 · 超长章节');
  const { browser, page, errors } = await launch(dist);
  try {
    const para = '　　林栀走过长街，雨水落在伞面上，她想起旧信里的那句话。';
    const big = Array.from({ length: 4000 }, () => para).join('\n');
    const line = '雨水落在伞面上林栀，'.repeat(900);
    await newBook(page, '长章', [{ title: '长一', text: '　　开头。' }, { title: '长二', text: '　　开头。' }]);
    await putText(page, 0, big);
    await putText(page, 1, line);
    const c0 = await contents(page);
    check(c0[0].length > 100000 && c0[1].length === line.length, `两章写进去了（${c0[0].length} 字、${c0[1].length} 字）`, fails);
    await page.click('.ch-item >> nth=0');
    await wait(page, 400);
    await longTasks(page);

    let t = Date.now();
    await openPanel(page, 'Control+Shift+F');
    await page.fill('.sr-q', '林栀');
    await page.waitForFunction(() => (document.querySelector('.sr-sum') || {}).textContent && document.querySelector('.sr-sum').textContent.includes('共'), null, { timeout: 5000 });
    const findMs = Date.now() - t;
    check((await sum(page)).includes('共 4900 处 · 2 章'), '11 万字 + 9 千字里找到 4900 处', fails);
    check(findMs < 1500, `出结果用了 ${findMs}ms`, fails);
    check((await page.$$('.sr-hit')).length === 1000 && (await page.textContent('.sr-list')).includes('还有 3900 处没列出来'), '列表只画 1000 条，后面有说明', fails);
    check(!(await page.textContent('.sr-list')).includes('命中太多'), '没到上限时不说「命中太多」', fails);
    let lt = await takeLong(page);
    check(lt < 600, `找的时候最长卡了 ${lt}ms`, fails);

    await fillQ(page, '，', 800);
    check((await page.textContent('.sr-list')).includes('只找了前 5000 处'), '超过 5000 处：说明只找了前 5000 处', fails);
    await takeLong(page);

    // 面板开着时在长章里打字
    await fillQ(page, '林栀', 800);
    await page.click('.sr-hit >> nth=3');
    await wait(page, 300);
    await page.click('.cm-content');
    await page.keyboard.type('又写了几个字', { delay: 40 });
    await wait(page, 1800);
    lt = await takeLong(page);
    check(lt < 300, `面板开着时在长章里打字，最长卡了 ${lt}ms`, fails);
    check((await sum(page)).includes('共 4900 处'), '打字后结果刷新', fails);
    await press(page, 'Control+z');
    await wait(page, 1500);

    // 全部替换（一处不勾），再点剩下那一处，再撤销
    await openPanel(page, 'Control+h');
    await page.fill('.sr-r', '林小夏');
    await wait(page, 400);
    await page.click('.sr-hit >> nth=0 >> .sr-cb input');
    await takeLong(page);
    t = Date.now();
    await page.click('.sr-all');
    await page.waitForSelector('.sr-done:visible', { timeout: 8000 });
    const repMs = Date.now() - t;
    await wait(page, 600);
    let c = await contents(page);
    const cnt = (s, w) => s.split(w).length - 1;
    check(cnt(c[0], '林栀') === 1 && cnt(c[0], '林小夏') === 3999 && cnt(c[1], '林小夏') === 900, '全部替换 4899 处，跳过 1 处', fails);
    check(repMs < 3000, `全部替换用了 ${repMs}ms`, fails);
    lt = await takeLong(page);
    check(lt < 1500, `全部替换最长卡了 ${lt}ms`, fails);
    await page.click('.sr-hit >> nth=0 >> .sr-go');
    await wait(page, 300);
    await takeLong(page);
    t = Date.now();
    await page.click('.ws .topbar button[aria-label="撤销"]');
    await page.waitForFunction(() => document.querySelector('.sr-sum').textContent.includes('共 4900 处'), null, { timeout: 8000 });
    const undoMs = Date.now() - t;
    await wait(page, 500);
    lt = await takeLong(page);
    c = await contents(page);
    check(cnt(c[0], '林栀') === 4000 && cnt(c[1], '林栀') === 900, '撤销：两章 4900 处都还原', fails);
    check(undoMs < 3000 && lt < 700, `撤销用了 ${undoMs}ms，最长卡了 ${lt}ms`, fails);

    // 正则在长章里也能找
    await page.click('.sr-fold[data-k="advanced"]');
    await page.click('.sr-opt[data-k="regex"]');
    await fillQ(page, '林.走过', 1000);
    check((await sum(page)).includes('共 4000 处'), '正则在长章里找', fails);

    // 筛选出的章：点开以后从头看
    await page.click('.sr-opt[data-k="regex"]');
    await page.fill('.sr-q', '');
    await page.click('.sr-fold[data-k="showFilter"]');
    await page.fill('.sr-num', '100000');
    await wait(page, 500);
    await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 99999; });
    await page.click('.sr-ch:has-text("长二")');
    await wait(page, 500);
    await page.click('.sr-ch:has-text("长一")');
    await wait(page, 600);
    const top = await page.evaluate(() => document.querySelector('.cm-scroller').scrollTop);
    check(top < 50, `从筛选结果打开章：从头显示（scrollTop ${top}）`, fails);

    check(errors.length === 0, '没有页面报错 ' + errors.join(' | '), fails);
  } catch (e) {
    fails.push('异常：' + e.message);
    console.log('  ✗ 异常：' + e.stack);
  }
  await browser.close();
}

// ---------------- 手机宽度、深色模式 ----------------
async function mobileDark(dist, fails) {
  console.log('浏览器 · 手机宽度和深色模式');
  const { browser, page, errors } = await launch(dist);
  try {
    const longTitle = '这一章的名字特别特别长长到放不下一整行还要继续写下去看看会不会撑破';
    await newBook(page, '窄屏', [
      { title: longTitle, text: '　　' + 'x'.repeat(300) + '林栀' + 'y'.repeat(300) + '\n　　林栀在门外。' },
      { title: '二', text: '　　林栀。' },
    ]);
    await openPanel(page, 'Control+Shift+F');
    await page.click('.sr-fold[data-k="showFilter"]');
    await page.fill('.sr-q', '林栀');
    await page.click('.sr-save');
    await page.waitForSelector('.modal input.input');
    await page.fill('.modal input.input', '一个很长很长很长很长很长很长很长很长很长很长的常用筛选名字');
    await page.click('.modal-foot .btn.primary');
    await wait(page, 300);
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(page, 300);
    await page.click('.sr-fold[data-k="showReplace"]');
    await page.click('.sr-fold[data-k="advanced"]');
    await page.click('.sr-opt[data-k="regex"]');
    await fillQ(page, '林栀(');
    const over = async (label) => {
      const r = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth,
        wide: [...document.querySelectorAll('.side-right *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > 391; }).map((e) => e.className || e.tagName).slice(0, 5),
      }));
      check(r.sw <= 390 && r.bw <= 390 && !r.wide.length, `手机：${label}没有横向溢出 ` + JSON.stringify(r), fails);
    };
    await over('正则报错时');
    await page.click('.sr-opt[data-k="regex"]');
    await fillQ(page, '林栀');
    await page.fill('.sr-r', '一个很长的替换内容一个很长的替换内容一个很长的替换内容');
    await wait(page, 300);
    await over('替换预览、长章名、长常用筛选名');
    const geo = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { x: r('.side-right .panel-head button[aria-label="关闭"]'), panel: r('.side-right'), center: r('.center'), vh: innerHeight };
    });
    check(geo.x.right <= 390 && geo.x.top >= 0 && geo.x.bottom <= geo.vh, '手机：关闭按钮在屏幕里', fails);
    check(geo.panel.bottom <= geo.vh + 1 && geo.center.bottom <= geo.panel.top + 1 && geo.center.height > 120, '手机：正文在上，面板在下，不重叠', fails);
    await page.click('.sr-all');
    await wait(page, 800);
    await over('替换完');
    check((await contents(page)).every((t) => !t.includes('林栀')), '手机：全部替换', fails);
    await page.click('.sr-done button:has-text("撤销")');
    await wait(page, 800);
    check((await contents(page)).filter((t) => t.includes('林栀')).length === 2, '手机：面板里的撤销', fails);

    // 深色模式：面板里的颜色都跟着变量走
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1200, height: 860 });
    await page.click('.sr-opt[data-k="regex"]');
    await fillQ(page, '林栀(');
    const darkErr = await page.evaluate(() => {
      const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const rgb = (hex) => { const m = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16)); return `rgb(${m.join(', ')})`; };
      const cs = (s) => getComputedStyle(document.querySelector(s));
      return { err: [cs('.sr-err').backgroundColor, rgb(v('--danger-soft'))], errInk: [cs('.sr-err').color, rgb(v('--danger'))] };
    });
    check(darkErr.err[0] === darkErr.err[1] && darkErr.errInk[0] === darkErr.errInk[1], '深色：正则报错框用深色的变量 ' + JSON.stringify(darkErr), fails);
    await page.click('.sr-opt[data-k="regex"]');
    await fillQ(page, '林栀');
    await page.click('.sr-all');
    await wait(page, 800);
    await fillQ(page, '林');
    const dark = await page.evaluate(() => {
      const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const rgb = (hex) => { const m = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16)); return `rgb(${m.join(', ')})`; };
      const cs = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
      const out = {};
      const pairs = [['.sr-done', 'backgroundColor', '--ok-soft'], ['.sr-ins', 'backgroundColor', '--ok-soft'], ['del.sr-m', 'backgroundColor', '--danger-soft'],
        ['.sr-chip', 'backgroundColor', '--accent-soft'], ['.sr-seg[aria-pressed="true"]', 'backgroundColor', '--accent-soft'], ['.sr-gh', 'backgroundColor', '--side'],
        ['.sr-q', 'color', '--ink']];
      for (const [s, p, n] of pairs) { const c = cs(s); out[s] = c ? [c[p], rgb(v(n))] : ['没有', rgb(v(n))]; }
      return out;
    });
    const bad = Object.entries(dark).filter(([, [a, b]]) => a !== b);
    check(!bad.length, '深色：面板各处颜色跟着变量 ' + JSON.stringify(bad), fails);
    await page.click('.sr-done button:has-text("撤销")').catch(() => {});
    await wait(page, 600);
    await page.emulateMedia({ colorScheme: 'light' });

    check(errors.length === 0, '没有页面报错 ' + errors.join(' | '), fails);
  } catch (e) {
    fails.push('异常：' + e.message);
    console.log('  ✗ 异常：' + e.stack);
  }
  await browser.close();
}

(async () => {
  const dist = process.argv[2] || path.join(__dirname, '../dist');
  const only = process.argv[3];
  const fails = [];
  if (!only || only === 'unit') await unit(fails);
  if (!only || only === 'desktop') await desktop(dist, fails);
  if (!only || only === 'long') await longChapters(dist, fails);
  if (!only || only === 'mobile') await mobileDark(dist, fails);
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
