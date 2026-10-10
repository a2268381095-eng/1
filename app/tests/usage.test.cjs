// 用量与余额：按时间、作品、功能、模型统计；花费分币种；没填单价的提醒；按天的柱子图能悬停、能切表格；余额实时查（假接口）；导出表格；写作界面状态栏的小胶囊
const { launch, newBook, check } = require('./helpers.cjs');

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await page.evaluate(() => localStorage.setItem('xemoMock', '1'));
  await page.reload(); await page.waitForSelector('.topbar');
  await newBook(page, '雨夜来信', [{ title: '门铃', text: '　　雨下到第三天。' }]);
  const bookId = await page.evaluate(() => location.hash.split('/')[2]);
  const DAY = 864e5;
  await page.evaluate(({ bookId, DAY }) => new Promise((res) => {
    const r = indexedDB.open('xiaoemo-wenshu');
    r.onsuccess = () => {
      const t = r.result.transaction(['usage', 'kv'], 'readwrite');
      const now = Date.now(), u = t.objectStore('usage');
      const rows = [
        { at: now - 60e3, providerId: 'mock', model: 'mock-small', feature: 'rewrite', bookId, input: 1200, output: 300, cost: 0.012, currency: 'USD' },
        { at: now - 2 * 60e3, providerId: 'mock', model: 'mock-small', feature: 'rewrite', bookId, input: 800, output: 200, cost: 0.008, currency: 'USD' },
        { at: now - 3 * DAY, providerId: 'mock', model: 'mock-large', feature: 'summary', bookId, input: 5000, output: 900, cost: 0.5, currency: 'CNY' },
        { at: now - 10 * DAY, providerId: 'mock', model: 'mock-large', feature: 'chat', bookId: null, input: 3000, output: 1500, cost: null, currency: null },
        { at: now - 40 * DAY, providerId: 'mock', model: 'mock-small', feature: 'paint', bookId, input: 0, output: 0, images: 4, kind: 'image', cost: 0.16, currency: 'USD' },
      ];
      rows.forEach((x, i) => u.put({ id: 'u' + i, ...x }));
      t.objectStore('kv').put({ key: 'ai:config', value: { providers: { mock: { key: 'good', models: [{ id: 'mock-small', name: 'mock-small' }], testModel: 'mock-small', ok: true, modelsAt: Date.now() } }, prices: {}, cheap: null } });
      t.objectStore('kv').put({ key: 'ai:last', value: { providerId: 'mock', model: 'mock-small', creativity: 2, thinking: 4 } });
      t.oncomplete = () => res();
    };
  }), { bookId, DAY });

  console.log('写作界面状态栏的小胶囊');
  await page.reload(); await page.waitForSelector('.cm-content');
  await page.waitForSelector('.au-pill:not([hidden])', { timeout: 4000 });
  const pill = await page.textContent('.au-pill');
  check(pill.includes('mock-small') && pill.includes('思考深想') && pill.includes('今天') && pill.includes('$0.02'), '模型 · 思考档位 · 今天花了多少：' + pill, fails);
  await page.click('.au-pill');
  await page.waitForSelector('.au-root');

  console.log('余额：能查的实时查');
  await page.waitForFunction(() => /\$8\.88/.test((document.querySelector('.au-bal-row[data-provider="mock"] .au-bal-v') || {}).textContent || ''), null, { timeout: 4000 });
  check(true, '打开页面就查了一次余额：$8.88', fails);

  console.log('近 30 天合计');
  await page.waitForSelector('.au-tile');
  const hero = await page.textContent('.au-tile.hero');
  check(hero.includes('$0.02') && hero.includes('¥0.50') && hero.includes('1 次没填单价'), '花了：美元、人民币分开，提醒没单价的 ' + hero, fails);
  check((await page.textContent('.au-tiles')).includes('4 次'), '调用 4 次（40 天前那次不算）', fails);
  check(await page.isVisible('.au-warn'), '提醒去填单价', fails);
  check((await page.$$('.au-col')).length === 30, '每天一根柱子，30 根', fails);
  const bars = await page.$$eval('.au-bar', (els) => els.filter((e) => parseFloat(e.style.height) > 0).length);
  check(bars === 3, '有调用的三天有柱子 ' + bars, fails);
  await page.hover('.au-col:last-child');
  await page.waitForSelector('.au-tip:not([hidden])');
  const tipText = await page.textContent('.au-tip');
  check(tipText.includes('2 次') && tipText.includes('2.5K token'), '悬停看这一天的明细：' + tipText, fails);
  await page.click('.au-chart-head .btn:has-text("看表格")');
  check((await page.$$('.au-chart .au-table tbody tr')).length === 3, '切成表格：三行', fails);
  await page.click('.au-chart-head .btn:has-text("看图")');

  console.log('按作品、功能、模型');
  const secs = await page.$$eval('.au-sec', (els) => els.map((e) => e.querySelector('.au-h').textContent + ':' + [...e.querySelectorAll('tbody tr')].map((r) => r.querySelector('.au-name').textContent).join('|')));
  check(secs.some((s) => s.startsWith('按作品') && s.includes('《雨夜来信》') && s.includes('不在作品里')), '按作品 ' + secs[0], fails);
  check(secs.some((s) => s.startsWith('按功能') && s.includes('选中调用') && s.includes('章节摘要') && s.includes('对话')), '按功能 ' + secs[1], fails);
  check(secs.some((s) => s.startsWith('按模型') && s.includes('mock-small') && s.includes('mock-large')), '按模型 ' + secs[2], fails);

  console.log('换时间、换作品');
  await page.click('.au-seg button:has-text("今天")');
  check((await page.textContent('.au-tile.hero')).includes('$0.02') && !(await page.textContent('.au-tile.hero')).includes('¥'), '今天：只有今天的', fails);
  check((await page.$$('.au-col')).length === 24, '今天按小时，24 根', fails);
  await page.click('.au-seg button:has-text("全部")');
  check((await page.textContent('.au-tiles')).includes('5 次') && (await page.textContent('.au-tiles')).includes('4 张'), '全部：5 次，画图 4 张', fails);
  await page.selectOption('.au-book', { label: '《雨夜来信》' });
  check((await page.textContent('.au-tiles')).includes('4 次'), '只看这本书：4 次', fails);
  check(!(await page.$$eval('.au-sec .au-h', (els) => els.map((e) => e.textContent))).includes('按作品'), '只看一本书时不再按作品分', fails);

  console.log('导出表格');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.au-filters .tool-btn:has-text("导出表格")')]);
  const csv = require('fs').readFileSync(await dl.path(), 'utf8');
  check(csv.split('\n').length === 5 && csv.includes('选中调用') && csv.includes('mock-large'), '导出 4 条记录（加表头 5 行）', fails);

  console.log('F1 也能找到');
  await page.keyboard.press('F1');
  await page.waitForSelector('.help-search');
  await page.keyboard.type('余额');
  await page.waitForTimeout(300);
  check((await page.textContent('.help-pop, .help-list, body')).includes('用量与余额'), 'F1 搜「余额」能找到', fails);
  await page.keyboard.press('Escape');

  console.log('手机宽度');
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 0, '390 宽不横向溢出 ' + over, fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
