// 名词标色：设定库的名字在正文里上色、点名字弹卡片能改、选中收入设定库、本地找新名字、虚线点一下收进 / 忽略、名字面板、撤销
const { launch, newBook, check } = require('./helpers.cjs');

const TEXT = [
  '　　林栀说：“门铃响了。”',
  '　　沈砚之笑道：“青云宗的人来了。”',
  '　　林栀看着窗外。青云宗在北边，过了落霞镇就是。',
  '　　沈砚之点头：“落霞镇的灯笼节快到了。”灯笼节那天，阿栀没有回答。',
].join('\n');

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await newBook(page, '雨夜来信', [{ title: '门铃', text: TEXT }]);
  await page.waitForTimeout(500);

  console.log('选中名字 → 收入设定库');
  const f1 = async (title) => {
    await page.keyboard.press('F1');
    await page.waitForSelector('.help-search', { timeout: 3000 });
    await page.keyboard.type(title);
    await page.waitForTimeout(250);
    await page.keyboard.press('Enter');
  };
  await page.click('.cm-content');
  await page.keyboard.press('Control+Home');   // 行首有全角空格，Home 会跳到空格后面，这里不按
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await f1('收入设定库');
  await page.waitForSelector('.nm-pop.nm-arch', { timeout: 3000 });
  check(await page.inputValue('.nm-name-in') === '林栀', '选中的字填进了名字框 ' + await page.inputValue('.nm-name-in'), fails);
  const guess = await page.textContent('.nm-cat.guess');
  check(/人物/.test(guess || ''), '猜的分类是人物：' + guess, fails);
  await page.click('.nm-cat.guess');
  await page.waitForTimeout(600);
  const marks = await page.$$eval('.ed-host .nm-t', (els) => els.map((e) => e.textContent));
  check(marks.filter((t) => t === '林栀').length === 2, '正文里两处「林栀」都上色了 ' + JSON.stringify(marks), fails);
  const color = await page.$eval('.ed-host .nm-t', (e) => getComputedStyle(e).getPropertyValue('--nm').trim());
  check(/#|rgb/.test(color), '用的是分类颜色 ' + color, fails);
  check(await page.isVisible('.toast:has-text("已收进设定库")'), '提示「已收进设定库」，带撤销', fails);

  console.log('鼠标停在名字上弹出卡片；点一下留住；直接改');
  await page.hover('.ed-host .nm-t');
  await page.waitForSelector('.nm-pop.nm-term', { timeout: 3000 });
  check(!(await page.$eval('.nm-pop', (e) => e.classList.contains('pinned'))), '停一会儿就弹出来（没点之前是「看一眼」）', fails);
  await page.mouse.move(5, 400);
  await page.waitForSelector('.nm-pop', { state: 'detached', timeout: 3000 });
  check(true, '鼠标移开就收起', fails);
  await page.click('.ed-host .nm-t');
  await page.waitForSelector('.nm-pop.nm-term.pinned', { timeout: 3000 });
  check((await page.textContent('.nm-name-b')) === '林栀', '卡片上是这个名字', fails);
  check(/这一章出现 2 次/.test(await page.textContent('.nm-pop .nm-count')), '显示这一章出现几次', fails);
  check(await page.isVisible('.nm-pic.none') && await page.isVisible('.nm-mini:has-text("上传")') && await page.isVisible('.nm-mini:has-text("AI 画")'), '没有形象：占位图 + 上传 + AI 画', fails);
  await page.mouse.move(5, 400);
  await page.waitForTimeout(700);
  check(await page.isVisible('.nm-pop.nm-term'), '点过以后鼠标移开也不收', fails);
  await page.click('.nm-pop .nm-row .nm-val');
  await page.fill('.nm-pop .nm-edit', '旧书店店主');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  check((await page.textContent('.nm-pop .nm-row .nm-val')) === '旧书店店主', '字段改好了', fails);
  check(/改好了/.test(await page.textContent('.nm-pop .nm-note-line')), '卡片底下说「改好了」带撤销', fails);
  // 上传形象
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP4z8DwnwEIGP4zMDAwAAAx+gP9X0B1UQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('.nm-pop input[type=file]', { name: 'a.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.nm-pop .nm-pic img', { timeout: 5000 });
  check(true, '上传的图直接显示在卡片上', fails);
  // 加别名：别名也上色
  await page.fill('.nm-pop .nm-chip-in[data-focus="alias"]', '阿栀');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  check((await page.$$eval('.nm-pop .nm-tag', (els) => els.map((e) => e.textContent))).some((t) => t.startsWith('阿栀')), '别名加上了', fails);
  check(await page.$$eval('.ed-host .nm-t', (els) => els.some((e) => e.textContent === '阿栀')), '别名「阿栀」在正文里也上色了', fails);
  // 改名字
  await page.click('.nm-name-b');
  await page.fill('.nm-name-edit', '林小栀');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  check((await page.textContent('.nm-name-b')) === '林小栀', '名字改好了', fails);
  check(!(await page.$$eval('.ed-host .nm-t', (els) => els.some((e) => e.textContent === '林栀'))), '改名后正文里旧名字不再按这张卡标', fails);
  await page.click('.nm-pop .nm-undo');
  await page.waitForTimeout(700);
  check((await page.textContent('.nm-name-b')) === '林栀', '卡片里「撤销」改回原名', fails);
  // 换分类
  await page.selectOption('.nm-catsel', { label: '地点' });
  await page.waitForTimeout(600);
  check((await page.$eval('.nm-catsel', (s) => s.options[s.selectedIndex].text)) === '地点', '分类换成地点', fails);
  await page.selectOption('.nm-catsel', { label: '人物' });
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.nm-pop', { state: 'detached' });
  await page.click('.ed-host .nm-t');
  await page.waitForSelector('.nm-pop.nm-term');
  check((await page.textContent('.nm-pop .nm-row .nm-val')) === '旧书店店主', '再打开还在（存进设定库了）', fails);

  console.log('从卡片里删掉 → 撤销');
  await page.click('.nm-pop .nm-del');
  await page.waitForSelector('.nm-pop', { state: 'detached' });
  await page.waitForTimeout(600);
  check((await page.$$('.ed-host .nm-t')).length === 0, '删掉以后正文不再标', fails);
  await page.click('.toast:has-text("已删除") .toast-act:has-text("撤销")');
  await page.waitForTimeout(700);
  check((await page.$$('.ed-host .nm-t')).length >= 2, '撤销以后又标回来', fails);

  console.log('打开卡片');
  await page.click('.ed-host .nm-t');
  await page.waitForSelector('.nm-pop.nm-term');
  await page.click('.nm-pop .btn.primary');
  await page.waitForTimeout(800);
  check(await page.evaluate(() => !!document.querySelector('.lr-panel-body, .lr-root')), '「打开卡片」打开设定库里这张卡', fails);
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const d = await page.$('.modal .btn:has-text("丢弃")'); if (d) await d.click();

  console.log('本地找新名字 → 虚线 → 收进 / 忽略');
  await f1('本地找新名字');
  await page.waitForTimeout(700);
  const cands = await page.$$eval('.ed-host .nm-c', (els) => [...new Set(els.map((e) => e.textContent))]);
  check(cands.includes('沈砚之') && cands.includes('青云宗') && cands.includes('落霞镇') && cands.includes('灯笼节') && !cands.includes('林栀'),
    '找到沈砚之、青云宗、落霞镇、灯笼节（林栀已经在库里不算） ' + JSON.stringify(cands), fails);
  await page.click('.ed-host .nm-c:has-text("青云宗")');
  await page.waitForSelector('.nm-pop.nm-cand');
  check(/势力/.test(await page.textContent('.nm-cat.guess')), '青云宗猜成势力', fails);
  check(await page.inputValue('.nm-pop .nm-name-in') === '青云宗', '收之前名字可以改', fails);
  await page.click('.nm-cat.guess');
  await page.waitForTimeout(600);
  check((await page.$$eval('.ed-host .nm-t', (els) => els.filter((e) => e.textContent === '青云宗').length)) === 2, '收进以后变成实线上色', fails);
  await page.click('.ed-host .nm-c:has-text("灯笼节")');
  await page.waitForSelector('.nm-pop.nm-cand');
  await page.click('.nm-pop .btn.ghost:has-text("忽略")');
  await page.waitForTimeout(500);
  check(!(await page.$$eval('.ed-host .nm-c', (els) => els.some((e) => e.textContent === '灯笼节'))), '忽略以后不再标', fails);

  console.log('名字面板');
  await page.click('.nm-status');
  await page.waitForSelector('.nm-panel .nm-li');
  const here = await page.$$eval('.nm-panel .nm-item-n', (els) => els.map((e) => e.textContent));
  check(here.includes('林栀') && here.includes('青云宗'), '这一章出现的：' + here.join('、'), fails);
  const candRows = await page.$$eval('.nm-panel .nm-cli .nm-cand-in', (els) => els.map((e) => e.value));
  check(candRows.includes('沈砚之') && candRows.includes('落霞镇'), '疑似新名字：' + candRows.join('、'), fails);
  check(await page.isVisible('.nm-ign summary'), '忽略过的可以展开取消', fails);
  await page.click('.nm-panel .nm-all .btn');
  await page.waitForTimeout(700);
  const after = await page.$$eval('.ed-host .nm-t', (els) => [...new Set(els.map((e) => e.textContent))]);
  check(after.includes('沈砚之') && after.includes('落霞镇'), '全部收进（一步）：' + after.join('、'), fails);
  await page.click('.toast:has-text("已收进设定库 2 个名字") .toast-act:has-text("撤销")');
  await page.waitForTimeout(700);
  const undone = await page.$$eval('.ed-host .nm-t', (els) => [...new Set(els.map((e) => e.textContent))]);
  check(!undone.includes('沈砚之') && !undone.includes('落霞镇') && undone.includes('林栀'), '撤销一步就全拿掉：' + undone.join('、'), fails);
  check(/名字 \d/.test(await page.textContent('.nm-status')), '状态栏显示名字数 ' + await page.textContent('.nm-status'), fails);

  console.log('关掉正文标色');
  await page.click('.nm-switches .check:has-text("正文标色")');
  await page.waitForTimeout(400);
  check((await page.$$('.ed-host .nm-t')).length === 0, '关掉以后正文不上色', fails);
  await page.click('.nm-switches .check:has-text("正文标色")');
  await page.waitForTimeout(400);
  check((await page.$$('.ed-host .nm-t')).length > 0, '打开又有了', fails);

  console.log('六套风格标法不同');
  const looks = {};
  for (const pal of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
    await page.evaluate((p) => document.documentElement.setAttribute('data-paper', p), pal);
    looks[pal] = await page.$eval('.ed-host .nm-t', (e) => { const s = getComputedStyle(e); return [s.textDecorationStyle, s.textDecorationLine, s.backgroundImage.slice(0, 15), s.textEmphasisStyle || s.webkitTextEmphasisStyle || '', s.boxShadow.slice(0, 10)].join('|'); });
  }
  check(new Set(Object.values(looks)).size === 6, '六套标法各不相同 ' + JSON.stringify(looks), fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
