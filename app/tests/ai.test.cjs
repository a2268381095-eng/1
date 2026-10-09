// AI 接入：用测试用假接口走一遍接入流程、确认卡、流式结果、替换、撤销、暂存盒、出错提示
const { launch, newBook, getText, check } = require('./helpers.cjs');
(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await page.evaluate(() => localStorage.setItem('xemoMock', '1'));
  await page.reload(); await page.waitForSelector('.topbar');
  await newBook(page, 'AI 测试', [{ title: '开头', text: '　　雨下到第三天。门铃响了。' }]);
  // 没接入时调用：选中文字 → Ctrl+J 打开 AI 工具栏（rewrite 模块）→「临时写一个」→ 就地弹出接入流程
  // 工具栏有提示词时才列「临时写一个」，先放一条
  await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('xiaoemo-wenshu');
    r.onsuccess = () => { const t = r.result.transaction('prompts', 'readwrite');
      t.objectStore('prompts').put({ id: 'pr-test', name: '测试用', group: '', text: '改一改：', feature: '', order: 1, uses: 0, pinned: false });
      t.oncomplete = () => res(); };
  }));
  await page.click('.cm-content');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+j');
  await page.click('.rw-bar .rw-temp');
  await page.waitForSelector('.ai-setup-modal');
  check(true, '没接入时就地弹出接入流程', fails);
  await page.click('.ai-setup-modal .ai-prov[data-id="mock"]');
  await page.fill('.ai-steps input[type="password"]', 'bad');
  await page.press('.ai-steps input[type="password"]', 'Enter');
  await page.waitForSelector('.ai-status.err');
  check((await page.textContent('.ai-status')).includes('不认'), 'Key 错了在当前页说明', fails);
  await page.fill('.ai-steps input[type="password"]', 'good');
  await page.click('.ai-steps .btn:has-text("拉取模型列表")');
  await page.waitForSelector('.ai-status.ok');
  await page.click('.ai-steps .btn.primary:has-text("测试")');
  await page.waitForSelector('.ai-status.ok:has-text("接好了")');
  check(true, '测试通过', fails);
  // 接好后继续：确认卡
  await page.waitForSelector('.ai-card', { timeout: 5000 });
  check(true, '接好后接着弹确认卡', fails);
  await page.fill('.ai-card textarea', '把这段改得更紧凑：');
  await page.waitForTimeout(200);
  const est = await page.textContent('.ai-est');
  check(/发送约 \d+ token/.test(est), '确认卡显示预估 token：' + est, fails);
  await page.click('.modal-foot .btn.primary:has-text("发送")');
  // 结果流式进对比面板，「完成」替换选中的文字
  await page.waitForSelector('.rw-panel');
  await page.waitForFunction(() => { const b = document.querySelector('.rw-panel .rw-ok'); return b && !b.disabled && !document.querySelector('.rw-live'); }, null, { timeout: 8000 });
  const out = await page.textContent('.rw-panel .rw-body');
  check(out.includes('真的'), 'AI 结果流式显示：' + out.slice(0, 30), fails);
  await page.click('.rw-panel .rw-ok');
  await page.waitForTimeout(600);
  check((await getText(page)).includes('真的'), '替换进正文', fails);
  await page.click('.toast:has-text("已采用") .toast-act');
  await page.waitForTimeout(800);
  check(!(await getText(page)).includes('真的'), '撤销后恢复原文', fails);
  // 暂存盒里有记录、用量记了账
  const counts = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('xiaoemo-wenshu');
    r.onsuccess = () => { const db = r.result; const t = db.transaction(['stash', 'usage']);
      const a = t.objectStore('stash').count(), b = t.objectStore('usage').count();
      t.oncomplete = () => res([a.result, b.result]); };
  }));
  check(counts[0] === 1 && counts[1] === 1, `暂存盒 ${counts[0]} 条、记账 ${counts[1]} 条`, fails);
  // 第二次调用：最近用过的组合排在前面；出错时有中文说明和「重试」
  await page.click('.cm-content'); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+j');
  await page.click('.rw-bar .rw-temp');
  await page.waitForSelector('.ai-card');
  check(await page.$('.ai-recent-chip') !== null, '最近用过的组合显示在前面', fails);
  await page.selectOption('.ai-card select[aria-label="提示词"]', '__temp');
  await page.fill('.ai-card textarea', '【报错】');
  await page.click('.modal-foot .btn.primary:has-text("发送")');
  await page.waitForSelector('.notice');
  const n = await page.textContent('.notice');
  check(n.includes('故意出错') && (await page.$('.modal-foot .btn:has-text("重试")')) !== null, '出错时中文说明 + 重试按钮', fails);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
