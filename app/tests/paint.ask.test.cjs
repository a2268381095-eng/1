// 绘画追问：草稿上点「接着改」，写一句怎么改，带着这张图重画；结果放进高清，卡上写着改了什么；还能接着改
const { launch, newBook, check } = require('./helpers.cjs');

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await page.evaluate(() => localStorage.setItem('xemoMock', '1'));
  await page.reload(); await page.waitForSelector('.topbar');
  await newBook(page, '星落之城', [{ title: '开头', text: '　　雨下到第三天。' }]);
  await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('xiaoemo-wenshu'); r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite');
    t.objectStore('kv').put({ key: 'ai:config', value: { providers: { mock: { key: 'good', models: [{ id: 'mock-small', name: 'mock-small' }], testModel: 'mock-small', ok: true, modelsAt: Date.now(), image: { api: 'openai', models: ['mock-image'] } } }, prices: {}, cheap: null } });
    t.oncomplete = () => res(); }; }));
  await page.reload(); await page.waitForSelector('.cm-content');
  await page.click('.tool-btn[data-cmd="paint.cover"]');
  await page.waitForSelector('.paint-go-btn');
  await page.fill('.paint textarea', '雨夜，旧书店门口，撑伞的少女');
  await page.click('.paint-go-btn');
  await page.waitForSelector('.ai-img-card');
  await page.click('.ai-img-modal .modal-foot .btn.primary');
  await page.waitForFunction(() => document.querySelectorAll('.paint-card.is-draft.st-done').length >= 1, null, { timeout: 10000 });

  console.log('接着改');
  await page.click('.paint-card.is-draft.st-done .paint-ask-btn');
  await page.waitForSelector('.paint-ask:not([hidden]) .paint-ask-in');
  check((await page.textContent('.paint-ask-t')).includes('草稿'), '写着照哪张改', fails);
  await page.click('.paint-ask-tip:has-text("背景换成夜晚")');
  check((await page.inputValue('.paint-ask-in')) === '背景换成夜晚', '点建议能填进去', fails);
  await page.click('.paint-ask .btn.primary');
  await page.waitForSelector('.ai-img-card[data-step="final"]');
  const prompt = await page.textContent('.ai-img-card .ai-img-prompt');
  check(prompt.includes('在参考图的基础上修改：背景换成夜晚') && prompt.includes('书名：《星落之城》'), '发出去的提示词：先说怎么改，原来的要求和书名都在', fails);
  check(await page.$eval('.ai-img-ref input', (i) => i.checked), '默认带上这张图', fails);
  await page.click('.ai-img-modal .modal-foot .btn.primary');
  await page.waitForSelector('.paint-card.is-final.st-done .paint-card-ask', { timeout: 10000 });
  check((await page.textContent('.paint-card.is-final.st-done .paint-card-ask')).includes('背景换成夜晚'), '改出来的图放在高清里，写着改了什么', fails);
  check(await page.$('.paint-card.is-final.st-done .paint-ask-btn') !== null, '改出来的还能接着改', fails);
  check(await page.isHidden('.paint-ask'), '画完收起追问框', fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
