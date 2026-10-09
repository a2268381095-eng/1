// chapterai：AI 起章名（章名下面就地出候选、选一个、撤销、都不要、暂存盒里挑以前的）、AI 写摘要（单章、覆盖前先问、撤销、
// 几章一起写确认一次逐章发、整批撤销、中途出错）、AI 生成简介（就地勾章、出几版并排、挑一版、撤销、暂存盒）；
// 没写正文、没有提示词的说明；Esc / 关闭；六套风格形态不同；深色；手机宽度不溢出
const { launch, newBook, check } = require('./helpers.cjs');
const pause = (page, ms) => page.waitForTimeout(ms);

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await page.evaluate(() => localStorage.setItem('xemoMock', '1'));
  await page.reload(); await page.waitForSelector('.topbar');

  const idb = (fn, arg) => page.evaluate(([src, arg]) => new Promise((res, rej) => {
    const r = indexedDB.open('xiaoemo-wenshu');
    r.onsuccess = () => { const db = r.result; Promise.resolve((0, eval)(src)(db, arg)).then((v) => { db.close(); res(v); }, rej); };
    r.onerror = () => rej(r.error);
  }), [fn.toString(), arg]);
  const put = (store, row) => idb((db, [store, row]) => new Promise((res, rej) => { const t = db.transaction([store], 'readwrite'); t.objectStore(store).put(row); t.oncomplete = res; t.onerror = () => rej(t.error); }), [store, row]);
  const all = (store) => idb((db, store) => new Promise((res) => { const q = db.transaction([store]).objectStore(store).getAll(); q.onsuccess = () => res(q.result); }), store);
  const chapters = async (bookId) => (await all('chapters')).filter((c) => c.bookId === bookId).sort((a, b) => a.order - b.order);
  const bookOf = async (id) => (await all('books')).find((b) => b.id === id);
  const palette = async (title) => {
    await page.keyboard.press('F1');
    await page.waitForSelector('.help-search');
    await page.fill('.help-search', title);
    await page.click(`.help-item:has(.help-t:text-is("${title}"))`);
    await pause(page, 300);
  };
  const openCh = async (i) => { await page.click(`.ch-item:nth-child(${i})`); await pause(page, 350); };
  const send = async () => { await page.click('.modal-foot .btn.primary:has-text("发送")'); };
  const toastUndo = async (text) => { await page.click(`.toast:has-text("${text}") .toast-act:has-text("撤销")`); await pause(page, 500); };

  const bookId = await newBook(page, '章名测试', [
    { title: '雨夜', text: '　　雨夜来客。\n　　门铃响了。\n　　旧信。' },
    { title: '门铃', text: '　　第二章的事。' },
    { title: '空章', text: '' },
    { title: '出错', text: '　　这一章会出错【报错】。' },
  ]);
  let chs = await chapters(bookId);
  check(chs.length === 4, '四章：' + chs.map((c) => c.title).join(','), fails);
  // 接好测试用假接口（接入流程在 ai.test 里测过）
  await put('kv', { key: 'ai:config', value: { providers: { mock: { key: 'good', models: [{ id: 'mock-small', name: '假模型（小）' }, { id: 'mock-large', name: '假模型（大）' }], ok: true, testModel: 'mock-large', testedAt: Date.now() } },
    prices: {}, cheap: { providerId: 'mock', model: 'mock-small' } } });

  // ---------------- 起章名 ----------------
  console.log('起章名');
  await openCh(1);
  await page.click('.ch-name-ai');
  await page.waitForSelector('.modal:has-text("还没有提示词")');
  check(true, '没有提示词时先说明', fails);
  await page.click('.modal-foot .btn:has-text("临时写一句")');
  await page.waitForSelector('.ai-card');
  const modelVal = await page.$eval('.ai-card select[aria-label="模型"]', (s) => s.value);
  check(modelVal.endsWith('mock-small'), '简单的活默认用绑定的便宜模型：' + modelVal.replace('\u0001', '/'), fails);
  check((await page.textContent('.ai-card .ai-input summary')).includes('本章正文'), '确认卡写明发送的是本章正文', fails);
  await page.fill('.ai-card textarea', '根据这一章起几个章名，一行一个：');
  await send();
  await page.waitForSelector('.cai-names[data-state="ready"] .cai-name');
  const names = await page.$$eval('.cai-name', (els) => els.map((e) => e.textContent));
  check(names.join('|') === '雨夜来客，真的|门铃响了，真的|旧信，真的', '候选在章名下方展开，按行拆好：' + names.join('|'), fails);
  const inCenter = await page.evaluate(() => { const b = document.querySelector('.cai-names'); return !!b.closest('.center') && b.previousElementSibling.classList.contains('ch-head') && !document.querySelector('.modal-back'); });
  check(inCenter, '候选列表在正文区章名下面，没有弹窗', fails);
  check(await page.$('.cai-names .icon-btn[aria-label="关闭"]') !== null && await page.$('.cai-names .cai-none') !== null && await page.$('.cai-names .cai-stash') !== null, '有关闭、都不要、暂存盒', fails);
  check(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('cai-name')), '出来后焦点在第一个候选上', fails);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await pause(page, 500);
  check((await page.inputValue('.ch-title')) === '门铃响了，真的', '方向键 + 回车选第二个，写进章名', fails);
  check((await chapters(bookId))[0].title === '门铃响了，真的', '章名存进去了', fails);
  check(await page.$('.cai-names') === null, '选完收起', fails);
  check((await page.textContent('.ch-item:nth-child(1) .ch-item-t')) === '门铃响了，真的', '章节列表跟着变', fails);
  await toastUndo('章名换成');
  check((await page.inputValue('.ch-title')) === '雨夜' && (await chapters(bookId))[0].title === '雨夜', '撤销后章名回到「雨夜」', fails);

  // 再来一次（这次不再问提示词，直接确认卡）→ 都不要
  await page.click('.ch-name-ai');
  await page.waitForSelector('.ai-card');
  check(await page.$('.modal:has-text("还没有提示词")') === null, '这次打开软件期间选过临时写，不再问', fails);
  check(await page.$('.ai-recent-chip') !== null, '最近用过的组合排在前面', fails);
  await page.fill('.ai-card textarea', '再起几个：');
  await send();
  await page.waitForSelector('.cai-names[data-state="ready"]');
  await page.click('.cai-names .cai-none');
  await pause(page, 400);
  check(await page.$('.cai-names') === null && (await page.inputValue('.ch-title')) === '雨夜', '「都不要」收起，章名不变', fails);

  // 暂存盒：只看这一章的章名候选，「列出来挑」放回候选列表
  await page.click('.ch-name-ai');
  await page.waitForSelector('.ai-card');
  await page.fill('.ai-card textarea', '第三批：');
  await send();
  await page.waitForSelector('.cai-names[data-state="ready"]');
  await page.click('.cai-names .cai-stash');
  await page.waitForSelector('.side-right .stash-drawer .stash-card');
  const sCards = await page.$$eval('.side-right .stash-card', (els) => els.length);
  check(sCards === 3, '暂存盒抽屉就地打开，列出这一章的 3 批章名：' + sCards, fails);
  check(await page.$('.cai-names') !== null, '抽屉打开时候选列表还在', fails);
  await page.click('.side-right .stash-card:last-child .stash-use');
  await pause(page, 400);
  check(await page.$('.side-right .stash-drawer') === null, '挑了一批后抽屉关上', fails);
  check((await page.textContent('.cai-names-note')).includes('以前生成'), '以前的一批放回候选列表', fails);
  await page.keyboard.press('Escape');
  await pause(page, 300);
  check(await page.$('.cai-names') === null, 'Esc 关掉候选列表', fails);

  // 还没写正文
  await openCh(3);
  await page.click('.ch-name-ai');
  await pause(page, 300);
  check(await page.$('.toast:has-text("还没写正文")') !== null && await page.$('.ai-card') === null, '空章：说明还没写正文，不调用', fails);

  // 出错
  await openCh(4);
  await page.click('.ch-name-ai');
  await page.waitForSelector('.ai-card');
  await page.fill('.ai-card textarea', '起名：');
  await send();
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('故意出错'), '出错时中文说明', fails);
  await page.click('.modal-foot .btn:has-text("知道了")');
  await pause(page, 400);
  check(await page.$('.cai-names') === null && !(await page.$eval('.ch-name-ai', (b) => b.classList.contains('cai-busy'))), '出错后不留空列表，按钮恢复', fails);

  // ---------------- 摘要（单章） ----------------
  console.log('摘要');
  await put('prompts', { id: 'pr-sum', name: '摘要用', group: '', text: '写一段摘要：', feature: 'summary', order: 1, uses: 0, pinned: false, createdAt: 1, updatedAt: 1 });
  await openCh(1);
  await page.click('.pt-sum-head .btn');
  await page.waitForSelector('.ai-card');
  check((await page.$eval('.ai-card select[aria-label="提示词"]', (s) => s.value)) === 'pr-sum', '有给摘要写的提示词时预先选上', fails);
  await send();
  await page.waitForSelector('.toast:has-text("已写进本章摘要")');
  let sum = await page.inputValue('.pt-summary');
  check(sum.includes('雨夜来客，真的') && (await chapters(bookId))[0].summary === sum, '摘要写进本章摘要框并保存：' + sum.slice(0, 20), fails);
  await toastUndo('已写进本章摘要');
  check((await page.inputValue('.pt-summary')) === '' && (await chapters(bookId))[0].summary === '', '撤销后摘要清空', fails);
  // 已有摘要：先问
  await page.fill('.pt-summary', '手写的摘要');
  await pause(page, 800);
  await page.click('.pt-sum-head .btn');
  await page.waitForSelector('.modal:has-text("覆盖已有的摘要")');
  await page.click('.modal-foot .btn:has-text("取消")');
  await pause(page, 300);
  check(await page.$('.ai-card') === null && (await page.inputValue('.pt-summary')) === '手写的摘要', '覆盖前先问，取消就不动', fails);
  await page.click('.pt-sum-head .btn');
  await page.click('.modal-foot .btn:has-text("写新的替换")');
  await page.waitForSelector('.ai-card');
  await send();
  await page.waitForSelector('.toast:has-text("已写进本章摘要")');
  check((await page.inputValue('.pt-summary')).includes('真的'), '确认后替换', fails);
  // 暂存盒里挑以前那份（就地，右侧栏）
  await page.click('.toast:has-text("已写进本章摘要") .toast-act:has-text("暂存盒")');
  await page.waitForSelector('.side-right .stash-drawer .stash-card');
  check((await page.$$('.side-right .stash-card')).length === 2, '暂存盒只列这一章的 2 份摘要', fails);
  await page.click('.side-right .panel-head .icon-btn[aria-label="关闭"]');
  await pause(page, 300);
  check(await page.$('.side-right .pt-summary') !== null, '关掉抽屉回到要点和摘要', fails);
  // 提示条已经随「暂存盒」按钮收起：焦点不在正文里时按 Ctrl+Z 撤销
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  await pause(page, 500);
  check((await page.inputValue('.pt-summary')) === '手写的摘要' && (await chapters(bookId))[0].summary === '手写的摘要', '撤销后回到手写的摘要', fails);

  // ---------------- 几章一起写摘要 ----------------
  console.log('批量摘要');
  await page.click('.ch-item:nth-child(2)', { modifiers: ['Control'] });
  await pause(page, 300);
  check(await page.$('.sel-bar .cai-sel:has-text("AI 写摘要")') !== null && await page.$('.sel-bar .cai-sel:has-text("AI 简介")') !== null, '多选条上有「AI 写摘要」「AI 简介」', fails);
  await page.click('.sel-bar .cai-sel:has-text("AI 写摘要")');
  await page.waitForSelector('.cai-batch-modal');
  const picked = await page.$$eval('.cai-batch-modal .cai-pick-row', (rows) => rows.map((r) => (r.querySelector('input').checked ? '1' : '0') + (r.querySelector('input').disabled ? 'x' : '')).join(','));
  check(picked === '1,1,0x,0', '选中的两章先勾上，空章不能勾：' + picked, fails);
  check((await page.textContent('.cai-batch-modal .cai-info')).includes('跳过 1 章'), '已有摘要的默认跳过：' + await page.textContent('.cai-batch-modal .cai-info'), fails);
  await page.check('.cai-batch-modal .cai-ow input');
  check((await page.textContent('.cai-batch-modal .cai-info')).includes('要写 2 章'), '勾「也重写」后要写 2 章', fails);
  await page.click('.cai-batch-modal .modal-foot .btn.primary:has-text("开始写")');
  await page.waitForSelector('.ai-card');
  check((await page.textContent('.ai-card .ai-input summary')).includes('一共 2 章'), '确认卡写明一共几章、确认一次', fails);
  await send();
  await page.waitForSelector('.cai-batch-modal .cai-result:has-text("都写好了")', { timeout: 8000 });
  check((await page.$$('.ai-card')).length === 0, '只确认了一次', fails);
  chs = await chapters(bookId);
  check(chs[0].summary.includes('雨夜来客，真的') && chs[1].summary.includes('第二章的事，真的'), '两章摘要都写好了', fails);
  const sts = await page.$$eval('.cai-prog-row', (rows) => rows.map((r) => r.dataset.st).join(','));
  check(sts === 'ok,ok', '进度一章章显示：' + sts, fails);
  await toastUndo('写好 2 章摘要');
  chs = await chapters(bookId);
  check(chs[0].summary === '手写的摘要' && chs[1].summary === '', '整批一步撤销', fails);
  await page.click('.cai-batch-modal .modal-foot .btn:has-text("关闭")');
  await pause(page, 300);
  check(await page.$('.cai-batch-modal') === null, '关闭按钮关掉弹窗', fails);
  await page.click('.sel-bar .btn.ghost:has-text("取消选择")');

  // 没选章：就地勾；中途出错
  await palette('AI 给几章一起写摘要');
  await page.waitForSelector('.cai-batch-modal');
  check((await page.$$eval('.cai-batch-modal .cai-pick-row input:checked', (e) => e.length)) === 0, '没选章时什么都不勾', fails);
  check(await page.$eval('.cai-batch-modal .modal-foot .btn.primary', (b) => b.disabled), '没勾章时「开始写」不能点', fails);
  await page.check('.cai-batch-modal .cai-pick-row:nth-child(2) input');
  await page.check('.cai-batch-modal .cai-pick-row:nth-child(4) input');
  await page.click('.cai-batch-modal .modal-foot .btn.primary');
  await page.waitForSelector('.ai-card');
  await send();
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('故意出错'), '有一章出错时中文说明', fails);
  await page.click('.modal-foot .btn:has-text("知道了")');
  await page.waitForSelector('.cai-batch-modal .cai-result:has-text("写好 1 章")');
  const sts2 = await page.$$eval('.cai-prog-row', (rows) => rows.map((r) => r.dataset.st).join(','));
  check(sts2 === 'ok,fail', '写好的留着，出错的标出来：' + sts2, fails);
  check((await chapters(bookId))[1].summary.includes('真的'), '出错前写好的那章存进去了', fails);
  check(await page.$('.toast:has-text("写好 1 章摘要")') !== null, '提示写好几章，可以撤销', fails);
  await page.keyboard.press('Escape');
  await pause(page, 300);
  check(await page.$('.cai-batch-modal') === null, 'Esc 关掉批量弹窗', fails);

  // ---------------- 简介 ----------------
  console.log('简介');
  await openCh(1);
  await page.click('.ch-item:nth-child(2)', { modifiers: ['Control'] });
  await pause(page, 300);
  await page.click('.sel-bar .cai-sel:has-text("AI 简介")');
  await page.waitForSelector('.cai-intro-modal');
  const badges = await page.$$eval('.cai-intro-modal .cai-pick-row', (rows) => rows.map((r) => (r.querySelector('input').checked ? '✓' : '') + r.querySelector('.cai-badge').textContent).join(','));
  check(badges === '✓用摘要,✓用摘要,空的,用正文开头', '选中的两章勾上，标出用摘要还是正文开头：' + badges, fails);
  await page.uncheck('.cai-intro-modal .cai-pick-row:nth-child(2) input');
  await page.check('.cai-intro-modal .cai-pick-row:nth-child(4) input');
  const info = await page.textContent('.cai-intro-modal .cai-info');
  check(info.includes('1 章用摘要') && info.includes('1 章用正文开头 1500 字'), '说明发什么：' + info, fails);
  await page.click('.cai-intro-modal .cai-seg button[data-n="3"]');
  check((await page.textContent('.cai-intro-modal .cai-info')).includes('出 3 版'), '选 3 版，说明花费 ×3', fails);
  // 第四章含【报错】，先换回第二章
  await page.uncheck('.cai-intro-modal .cai-pick-row:nth-child(4) input');
  await page.check('.cai-intro-modal .cai-pick-row:nth-child(2) input');
  await page.click('.cai-intro-modal .modal-foot .btn.primary:has-text("生成")');
  await page.waitForSelector('.ai-card');
  check((await page.textContent('.ai-card .ai-input summary')).includes('2 章用摘要'), '确认卡写清楚用了哪些内容：' + await page.textContent('.ai-card .ai-input summary'), fails);
  check((await page.textContent('.ai-est')).includes('出 3 版'), '确认卡预估花费按 3 版算', fails);
  await send();
  await page.waitForSelector('.cai-intro-modal .cai-result:has-text("出了 3 版")', { timeout: 10000 });
  const vers = await page.$$eval('.cai-ver', (els) => els.map((e) => e.dataset.state + ':' + e.querySelector('.cai-ver-text').textContent.length));
  check(vers.length === 3 && vers.every((v) => v.startsWith('ready:') && !v.endsWith(':0')), '三版并排：' + vers.join(','), fails);
  const grid = await page.$$eval('.cai-ver', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  check(grid[0] === grid[1], '宽屏时几版并排在一行', fails);
  const v2 = await page.textContent('.cai-ver:nth-child(2) .cai-ver-text');
  await page.click('.cai-ver:nth-child(2) .cai-use');
  await pause(page, 400);
  check((await bookOf(bookId)).intro === v2, '挑的那版写进作品简介', fails);
  check((await page.getAttribute('.cai-ver:nth-child(2)', 'data-state')) === 'chosen', '挑中的那版标出来', fails);
  await toastUndo('已写进作品简介');
  check((await bookOf(bookId)).intro === '' && (await page.getAttribute('.cai-ver:nth-child(2)', 'data-state')) === 'ready', '撤销后简介清空，标记去掉', fails);
  const stashIntro = (await all('stash')).filter((r) => r.feature === 'intro').length;
  check(stashIntro === 3, '三版都在暂存盒里：' + stashIntro, fails);
  // 暂存盒就地打开（弹窗），用作简介
  await page.click('.cai-intro-modal .modal-foot .btn:has-text("暂存盒")');
  await page.waitForSelector('.stash-modal .stash-card');
  await page.click('.stash-modal .stash-card:first-child .stash-use');
  await pause(page, 400);
  check((await bookOf(bookId)).intro.includes('真的'), '暂存盒里挑一版用作简介', fails);
  await page.keyboard.press('Escape');
  await pause(page, 300);
  check(await page.$('.stash-modal') === null && await page.$('.cai-intro-modal') !== null, 'Esc 先关最上层的暂存盒', fails);
  // 都清空：生成按钮不能点
  await page.click('.cai-intro-modal .cai-pick-tools .btn:has-text("清空")');
  check(await page.$eval('.cai-intro-modal .modal-foot .btn.primary', (b) => b.disabled), '没勾章时不能生成', fails);
  await page.keyboard.press('Escape');
  await pause(page, 300);
  check(await page.$('.cai-intro-modal') === null, 'Esc 关掉简介弹窗', fails);
  await page.click('.sel-bar .btn.ghost:has-text("取消选择")').catch(() => {});

  // ---------------- 命令表 ----------------
  await page.keyboard.press('F1');
  await page.waitForSelector('.help-search');
  for (const [q, t] of [['章名', 'AI 起章名'], ['摘要', 'AI 写本章摘要'], ['简介', 'AI 生成简介']]) {
    await page.fill('.help-search', q);
    await pause(page, 150);
    const ts = await page.$$eval('.help-item .help-t', (els) => els.map((e) => e.textContent));
    check(ts.includes(t), `命令表里搜「${q}」有「${t}」`, fails);
  }
  await page.keyboard.press('Escape');
  await pause(page, 200);

  // ---------------- 起章名：停下、生成中换章 ----------------
  console.log('停下、换章');
  await openCh(4);
  await page.click('.cm-content'); await page.keyboard.press('Control+Enter'); await pause(page, 500);
  await page.fill('.ch-title', '长章'); await pause(page, 450);
  await page.click('.cm-content');
  await page.keyboard.insertText(Array.from({ length: 160 }, (_, i) => `　　第${i + 1}行。`).join('\n'));
  await pause(page, 1300);
  const stashBefore = (await all('stash')).length;
  await page.click('.ch-name-ai');
  await page.waitForSelector('.ai-card');
  await page.fill('.ai-card textarea', '起名：');
  await send();
  await page.waitForFunction(() => document.querySelectorAll('.cai-names[data-state="busy"] .cai-name').length >= 3);
  check(await page.isVisible('.cai-names .cai-stop'), '生成时候选一个个冒出来，有「停下」', fails);
  await page.click('.cai-names .cai-stop');
  await page.waitForSelector('.cai-names[data-state="ready"]');
  check((await page.textContent('.cai-names-note')).includes('停下了') && !(await page.isVisible('.cai-names .cai-stop')), '停下后留着已经出来的几个', fails);
  check((await all('stash')).length === stashBefore, '停下的不进暂存盒', fails);
  await page.click('.cai-names .cai-again');
  await page.waitForSelector('.ai-card');
  await page.fill('.ai-card textarea', '起名：');
  await send();
  await page.waitForFunction(() => document.querySelectorAll('.cai-names[data-state="busy"] .cai-name').length >= 2);
  await openCh(1);
  check(await page.$('.cai-names') === null, '换章时候选列表收起', fails);
  await page.waitForSelector('.toast:has-text("章名候选放进暂存盒")', { timeout: 8000 });
  check((await all('stash')).length === stashBefore + 1, '换章不打断生成，结果进暂存盒', fails);

  // ---------------- 六套风格形态 ----------------
  console.log('风格');
  await openCh(1);
  await page.click('.ch-name-ai');
  await page.waitForSelector('.ai-card');
  await page.fill('.ai-card textarea', '起名：');
  await send();
  await page.waitForSelector('.cai-names[data-state="ready"]');
  const forms = await page.evaluate(() => {
    const root = document.documentElement;
    const keep = { paper: root.dataset.paper, motion: root.dataset.motion };
    const out = {};
    for (const p of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
      root.dataset.paper = p; root.dataset.motion = 'full';
      const box = document.querySelector('.cai-names'), name = document.querySelector('.cai-name'), hd = document.querySelector('.cai-h');
      const cs = getComputedStyle(box), ns = getComputedStyle(name), mk = getComputedStyle(hd, '::before');
      out[p] = { border: cs.borderRadius + '/' + cs.borderLeftWidth + '/' + cs.clipPath.slice(0, 12), name: ns.borderRadius + '/' + ns.borderLeftWidth + ns.borderStyle,
        mark: mk.content + '/' + mk.clipPath.slice(0, 10) + '/' + mk.width + '/' + mk.rotate, anim: cs.animationName };
    }
    root.dataset.paper = keep.paper; if (keep.motion) root.dataset.motion = keep.motion; else delete root.dataset.motion;
    return out;
  });
  const uniq = (k) => new Set(Object.values(forms).map((f) => f[k])).size;
  check(uniq('border') === 6, '六套的边框和角都不同 ' + uniq('border'), fails);
  check(uniq('name') === 6, '六套的候选按钮形状都不同 ' + uniq('name'), fails);
  check(uniq('mark') === 6, '六套的标题小标记都不同 ' + uniq('mark'), fails);
  check(uniq('anim') === 6, '六套的出场动画都不同 ' + uniq('anim') + ' ' + Object.values(forms).map((f) => f.anim).join(','), fails);
  const noAnim = await page.$eval('.cai-names', (b) => getComputedStyle(b).animationName);
  check(noAnim === 'none', '减少动态效果时不播动画：' + noAnim, fails);
  // 背景插画开着时：半透明 + 模糊
  const glass = await page.evaluate(() => {
    document.body.classList.add('has-scene');
    const cs = getComputedStyle(document.querySelector('.cai-names'));
    const r = { bg: cs.backgroundColor, blur: cs.backdropFilter };
    document.body.classList.remove('has-scene');
    return r;
  });
  check(/rgba?\(.*,\s*0?\.\d+\)|color\(.*\/\s*0?\.\d+\)/.test(glass.bg) && glass.blur.includes('blur'), '背景插画开着时是玻璃底：' + JSON.stringify(glass), fails);
  await page.click('.cai-names .cai-x');
  await pause(page, 300);
  check(await page.$('.cai-names') === null, '右上角关闭', fails);

  // ---------------- 深色 + 手机宽度 ----------------
  console.log('深色、手机');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await pause(page, 300);
  await page.click('.ch-name-ai');
  await page.waitForSelector('.ai-card');
  await page.fill('.ai-card textarea', '起名：');
  await send();
  await page.waitForSelector('.cai-names[data-state="ready"]');
  const mob = await page.evaluate(() => {
    const b = document.querySelector('.cai-names').getBoundingClientRect();
    const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000; };
    return { doc: document.documentElement.scrollWidth, left: b.left, right: b.right, bg: lum(getComputedStyle(document.querySelector('.cai-names')).backgroundColor),
      ink: lum(getComputedStyle(document.querySelector('.cai-name')).color) };
  });
  check(mob.doc <= 390 && mob.left >= 0 && mob.right <= 390, '390px：候选列表不横向溢出 ' + JSON.stringify(mob), fails);
  check(mob.bg < 80 && mob.ink > 160, '深色模式：深底浅字 ' + JSON.stringify(mob), fails);
  await page.keyboard.press('Escape');
  await palette('AI 生成简介');
  await page.waitForSelector('.cai-intro-modal');
  await page.check('.cai-intro-modal .cai-pick-row:nth-child(1) input');
  await page.click('.cai-intro-modal .cai-seg button[data-n="2"]');
  await page.click('.cai-intro-modal .modal-foot .btn.primary');
  await page.waitForSelector('.ai-card');
  await send();
  await page.waitForSelector('.cai-intro-modal .cai-result:has-text("出了 2 版")', { timeout: 10000 });
  const mob2 = await page.evaluate(() => {
    const m = document.querySelector('.cai-intro-modal'), b = m.querySelector('.modal-body');
    const v = [...document.querySelectorAll('.cai-ver')].map((e) => e.getBoundingClientRect());
    return { doc: document.documentElement.scrollWidth, right: m.getBoundingClientRect().right, over: b.scrollWidth - b.clientWidth, stacked: v.length === 2 && v[1].top > v[0].top };
  });
  check(mob2.doc <= 390 && mob2.right <= 390 && mob2.over <= 0, '390px：简介弹窗不横向溢出 ' + JSON.stringify(mob2), fails);
  check(mob2.stacked, '390px：几版上下排', fails);
  await page.keyboard.press('Escape');
  await pause(page, 300);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
