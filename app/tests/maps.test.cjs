// 分层地图：画笔、地形色块、河流、文字、图钉连地点卡、框入口进下一层、面包屑回去、橡皮和撤销、上传底图、缩放、拖动挪位置、手机宽度
const { launch, newBook, check } = require('./helpers.cjs');

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await newBook(page, '雨夜来信', [{ title: '门铃', text: '　　雨下到第三天。' }]);
  await page.waitForTimeout(400);
  await page.click('.tool-btn[data-cmd="map.open"]');
  await page.waitForSelector('.mp-canvas');
  await page.waitForTimeout(400);
  check((await page.textContent('.mp-crumb.cur')) === '大陆', '最上层叫「大陆」', fails);
  const box = await page.$eval('.mp-paper', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
  const drag = async (pts) => { await page.mouse.move(...pts[0]); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(300); };
  const count = (sel) => page.$$eval(sel, (els) => els.length);

  console.log('画笔、色块、河流');
  await page.click('.mp-tool[data-tool="pen"]');
  await drag([at(.1, .1), at(.2, .15), at(.3, .12), at(.35, .2)]);
  check(await count('.mp-items .mp-pen') === 1, '画了一笔', fails);
  await page.click('.mp-tool[data-tool="area"]');
  await page.click('.mp-chip:has-text("森林")');
  await drag([at(.4, .4), at(.55, .38), at(.6, .55), at(.45, .6), at(.4, .45)]);
  check(await count('.mp-items .mp-area.t-forest') === 1, '圈了一块森林', fails);
  await page.click('.mp-tool[data-tool="line"]');
  await page.click('.mp-chip:has-text("河流")');
  await drag([at(.1, .8), at(.3, .7), at(.5, .85), at(.8, .75)]);
  check(await count('.mp-items .mp-river-o') === 1, '画了一条河', fails);

  console.log('文字');
  await page.click('.mp-tool[data-tool="text"]');
  await page.mouse.click(...at(.7, .3));
  await page.waitForSelector('.mp-text-in');
  await page.keyboard.type('北境');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check((await page.$$eval('.mp-label', (els) => els.map((e) => e.textContent))).includes('北境'), '文字放上去了', fails);

  console.log('图钉：新建地点卡并连上');
  await page.click('.mp-tool[data-tool="pin"]');
  await page.mouse.click(...at(.25, .45));
  await page.waitForSelector('.mp-pop input');
  await page.keyboard.type('落霞镇');
  await page.waitForTimeout(200);
  await page.click('.mp-pop-i.new');
  await page.waitForSelector('.mp-pop .mp-pop-head');
  check((await page.textContent('.mp-pop-head b')) === '落霞镇', '图钉连到新建的地点卡「落霞镇」', fails);
  check((await page.$$eval('.mp-pin-name', (els) => els.map((e) => e.textContent))).includes('落霞镇'), '地图上图钉旁边写着名字', fails);
  check(await page.isVisible('.mp-pop .btn.primary:has-text("打开卡片")'), '能打开地点卡', fails);
  await page.click('.mp-tool[data-tool="move"]');
  await page.mouse.click(...at(.9, .9));

  console.log('框入口 → 进下一层 → 面包屑回去');
  await page.click('.mp-tool[data-tool="portal"]');
  await drag([at(.62, .5), at(.75, .58), at(.85, .7)]);
  await page.waitForSelector('.modal input');
  await page.fill('.modal input', '北境');
  await page.click('.modal .btn.primary');
  await page.waitForTimeout(400);
  check(await count('.mp-items .mp-portal') === 1, '入口框好了', fails);
  await page.click('.mp-tool[data-tool="move"]');
  await page.click('.mp-portal-box');
  await page.waitForTimeout(500);
  const crumbs = await page.$$eval('.mp-crumb', (els) => els.map((e) => e.textContent));
  check(crumbs.join('›') === '大陆›北境', '点入口进了下一层：' + crumbs.join(' › '), fails);
  check(await count('.mp-items .mp-it') === 0, '下一层是空的', fails);
  check(/#\/map\/[^/]+\/mp/.test(await page.evaluate(() => location.hash)), '地址记着在哪一层', fails);
  await page.click('.mp-crumb:has-text("大陆")');
  await page.waitForTimeout(400);
  check((await page.textContent('.mp-crumb.cur')) === '大陆' && await count('.mp-items .mp-it') >= 6, '面包屑回到大陆，东西都在', fails);

  console.log('橡皮、撤销');
  await page.click('.mp-tool[data-tool="erase"]');
  const pen = await page.$eval('.mp-items .mp-pen path:last-child', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  const before = await count('.mp-items .mp-it');
  await page.click('.mp-items .mp-pen .mp-hit', { force: true });
  await page.waitForTimeout(300);
  check(await count('.mp-items .mp-it') === before - 1, '擦掉了一样', fails);
  await page.click('.mp-page .topbar .icon-btn[aria-label="撤销"]');
  await page.waitForTimeout(400);
  check(await count('.mp-items .mp-it') === before, '撤销回来了', fails);
  void pen;

  console.log('拖动挪位置');
  await page.click('.mp-tool[data-tool="move"]');
  const lb = await page.$eval('.mp-label', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await drag([lb, [lb[0] + 40, lb[1] + 30], [lb[0] + 80, lb[1] + 60]]);
  const lb2 = await page.$eval('.mp-label', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  check(Math.abs(lb2[0] - lb[0] - 80) < 6 && Math.abs(lb2[1] - lb[1] - 60) < 6, '文字挪过去了', fails);

  console.log('缩放、底图');
  const z0 = await page.textContent('.mp-zoom-v');
  await page.click('.mp-zoom .icon-btn[aria-label="放大"]');
  check((await page.textContent('.mp-zoom-v')) !== z0, '放大了：' + z0 + ' → ' + await page.textContent('.mp-zoom-v'), fails);
  await page.click('.mp-zoom .icon-btn[aria-label="整张放进窗口"]');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP4z8DwnwEIGP4zMDAwAAAx+gP9X0B1UQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('.mp-side input[type=file]', { name: 'm.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => { const i = document.querySelector('.mp-bg'); return i && i.getAttribute('href') && i.style.display !== 'none'; }, null, { timeout: 5000 });
  check(true, '上传的底图铺上了', fails);

  console.log('六套风格图钉形状不同');
  const shapes = {};
  for (const pal of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
    await page.evaluate((p) => document.documentElement.setAttribute('data-paper', p), pal);
    shapes[pal] = await page.$eval('.mp-pin-mark', (g) => [...g.children].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.getAttribute('class')).join(','));
  }
  check(new Set(Object.values(shapes)).size === 6, '图钉形状各不相同 ' + JSON.stringify(shapes), fails);

  console.log('手机宽度');
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  check(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, '390 宽不横向溢出', fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
