// 主线分镜看板：模板开头、主线、加卡、改卡、挂章节（卡的内容变成本章要点，卡改了要点跟着改）、拖动和 Alt+方向键挪卡、
// 删除和撤销、写作界面右侧栏显示这一章的分镜卡、就地挂卡、六套风格编号不同、手机宽度、深色
const { launch, newBook, check } = require('./helpers.cjs');

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await newBook(page, '雨夜来信', [{ title: '门铃', text: '　　林栀说：“门铃响了。”' }, { title: '旧书店', text: '　　沈砚之笑道。' }]);
  await page.waitForTimeout(500);

  console.log('从写作界面进看板，按模板开头');
  await page.click('.tool-btn[data-cmd="board.open"]');
  await page.waitForSelector('.bd-tpl');
  check((await page.$$('.bd-tpl')).length >= 3, '有几种分法可选', fails);
  await page.click('.bd-tpl:has-text("三幕")');
  await page.waitForSelector('.bd-act');
  check((await page.$$('.bd-act')).length === 3, '排好三段', fails);

  console.log('主线');
  await page.fill('.bd-line-in', '一封没有落款的信，把林栀拉回十年前的旧事。');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.reload(); await page.waitForSelector('.bd-act');
  check((await page.inputValue('.bd-line-in')).includes('没有落款'), '主线存住了（刷新还在）', fails);

  console.log('加卡、改卡');
  for (const [i, t] of [[0, '门铃'], [0, '旧书店的灯'], [1, '青云宗来人']]) { await page.locator('.bd-add').nth(i).click(); await page.keyboard.type(t); await page.keyboard.press('Enter'); await page.waitForTimeout(300); }
  const titles = await page.$$eval('.bd-act', (cols) => cols.map((c) => [...c.querySelectorAll('.bd-c-t')].map((x) => x.textContent)));
  check(JSON.stringify(titles) === JSON.stringify([['门铃', '旧书店的灯'], ['青云宗来人'], []]), '卡加在对应的段里 ' + JSON.stringify(titles), fails);
  check((await page.textContent('.bd-card:has-text("门铃") .bd-c-st')) === '空着', '新卡显示「空着」', fails);
  await page.click('.bd-card:has-text("门铃")');
  await page.waitForSelector('.bd-ed');
  await page.fill('.bd-ed textarea[aria-label="目标"]', '林栀收到一封没有落款的信');
  await page.click('.bd-ed-title');
  await page.fill('.bd-ed textarea[aria-label="冲突"]', '她不想开门');
  await page.click('.bd-ed-title');
  await page.waitForTimeout(400);
  check(/存好了/.test(await page.textContent('.bd-ed-note')), '改完显示「存好了 · 撤销」', fails);
  await page.click('.bd-ed-ch:has-text("第一章") input');
  await page.waitForTimeout(500);
  await page.fill('.bd-ed-new, .bd-pick-new', '林栀');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  check(await page.isVisible('.bd-pick.on:has-text("林栀")'), '出场人物：新建人物卡并勾上', fails);
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('.bd-ed', { state: 'detached' });
  const card = await page.$eval('.bd-card:has-text("门铃")', (e) => ({ st: e.querySelector('.bd-c-st').textContent, ch: [...e.querySelectorAll('.bd-c-ch')].map((x) => x.textContent), cast: [...e.querySelectorAll('.bd-c-p')].map((x) => x.textContent) }));
  check(/写了/.test(card.st) && card.ch.includes('第一章') && card.cast.includes('林栀'), '卡上看得到：写了多少、挂的章节、出场人物 ' + JSON.stringify(card), fails);

  console.log('挂上的章节：卡的内容变成本章要点');
  await page.click('.tool-btn:has-text("写正文")');
  await page.waitForSelector('.ch-item');
  await page.click('.ch-item:has-text("门铃")');
  await page.waitForTimeout(600);
  check(await page.isVisible('.bd-side .bd-side-t:has-text("门铃")'), '右侧栏最上面是这一章的分镜卡', fails);
  const pts = await page.$$eval('.pt-list .pt-text', (els) => els.map((e) => e.textContent));
  check(pts.includes('目标：林栀收到一封没有落款的信') && pts.includes('冲突：她不想开门'), '卡上的目标、冲突成了本章要点 ' + JSON.stringify(pts), fails);
  await page.click('.bd-side-open');
  await page.waitForSelector('.bd-ed');
  await page.fill('.bd-ed textarea[aria-label="冲突"]', '她不敢开门');
  await page.click('.bd-ed-title');
  await page.waitForTimeout(500);
  await page.click('.modal-foot .btn.primary');
  await page.click('.tool-btn:has-text("写正文")');
  await page.waitForSelector('.ch-item');
  await page.click('.ch-item:has-text("门铃")');
  await page.waitForTimeout(600);
  const pts2 = await page.$$eval('.pt-list .pt-text', (els) => els.map((e) => e.textContent));
  check(pts2.includes('冲突：她不敢开门') && !pts2.includes('冲突：她不想开门'), '卡改了，要点跟着改 ' + JSON.stringify(pts2), fails);

  console.log('右侧栏就地挂卡');
  await page.click('.ch-item:has-text("旧书店")');
  await page.waitForSelector('.bd-side-sel');
  const opt = await page.$eval('.bd-side-sel', (s) => [...s.options].find((o) => o.textContent.includes('旧书店的灯')).value);
  await page.selectOption('.bd-side-sel', opt);
  await page.waitForTimeout(600);
  check(await page.isVisible('.bd-side .bd-side-t:has-text("旧书店的灯")'), '挂上以后侧栏显示这张卡', fails);
  await page.click('.toast:has-text("挂上了") .toast-act:has-text("撤销")');
  await page.waitForTimeout(600);
  check(await page.isVisible('.bd-side-sel'), '撤销后又是没挂的样子', fails);

  console.log('拖动、键盘挪卡、撤销');
  await page.evaluate(() => { location.hash = location.hash.replace('#/book/', '#/board/').split('/').slice(0, 3).join('/'); });
  await page.waitForSelector('.bd-card');
  const src = await page.$('.bd-card:has-text("旧书店的灯")');
  const dst = await page.$('.bd-act:nth-child(2) .bd-cards');
  const a = await src.boundingBox(), b = await dst.boundingBox();
  await page.mouse.move(a.x + 30, a.y + 20);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, a.y + 40, { steps: 4 });
  await page.mouse.move(b.x + 40, b.y + b.height - 6, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const t2 = await page.$$eval('.bd-act', (cols) => cols.map((c) => [...c.querySelectorAll('.bd-c-t')].map((x) => x.textContent)));
  check(t2[1].includes('旧书店的灯') && !t2[0].includes('旧书店的灯'), '拖到第二段 ' + JSON.stringify(t2), fails);
  await page.focus('.bd-card:has-text("旧书店的灯")');
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForTimeout(400);
  const t3 = await page.$$eval('.bd-act:nth-child(2) .bd-c-t', (els) => els.map((x) => x.textContent));
  check(t3[0] === '旧书店的灯', 'Alt+↑ 在段里往上挪 ' + JSON.stringify(t3), fails);
  await page.click('.bd-page .topbar .icon-btn[aria-label="撤销"]');
  await page.waitForTimeout(400);
  await page.click('.bd-page .topbar .icon-btn[aria-label="撤销"]');
  await page.waitForTimeout(500);
  const t4 = await page.$$eval('.bd-act', (cols) => cols.map((c) => [...c.querySelectorAll('.bd-c-t')].map((x) => x.textContent)));
  check(t4[0].includes('旧书店的灯'), '撤销两步回到第一段 ' + JSON.stringify(t4), fails);

  console.log('删卡、删段');
  await page.click('.bd-card:has-text("青云宗来人")');
  await page.waitForSelector('.bd-ed');
  await page.click('.bd-ed-del');
  await page.waitForTimeout(500);
  check(!(await page.isVisible('.bd-card:has-text("青云宗来人")')), '删掉了', fails);
  await page.click('.toast:has-text("删掉了这张分镜卡") .toast-act:has-text("撤销")');
  await page.waitForTimeout(500);
  check(await page.isVisible('.bd-card:has-text("青云宗来人")'), '撤销回来了', fails);
  await page.click('.bd-act:nth-child(3) .bd-act-more');
  await page.click('.bd-menu-i:has-text("删掉这一段")');
  await page.waitForTimeout(400);
  check((await page.$$('.bd-act')).length === 2, '空的一段直接删', fails);

  console.log('六套风格编号不同');
  const nos = {};
  for (const pal of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
    await page.evaluate((p) => document.documentElement.setAttribute('data-paper', p), pal);
    nos[pal] = await page.$eval('.bd-card .bd-c-no', (e) => getComputedStyle(e, '::before').content) + '|' + await page.$eval('.bd-act-no', (e) => getComputedStyle(e, '::before').content);
  }
  check(new Set(Object.values(nos)).size === 6, '编号写法各不相同 ' + JSON.stringify(nos), fails);

  console.log('手机宽度');
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 0, '390 宽不横向溢出（看板自己横着滚） ' + over, fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
