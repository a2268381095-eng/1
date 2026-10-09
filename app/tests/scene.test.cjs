// 背景插画（只在首页，原图 / 像素可选）、小恶魔跟着主题换衣服、写字页是素净的书桌（Playwright）
//   node build.mjs --out /tmp/xemo-scene && node tests/scene.test.cjs /tmp/xemo-scene
// helpers 里开着「减少动态效果」，所以转场是直接换，不用等动画。
const { launch, newBook, check } = require('./helpers.cjs');

const NAMES = { magical: '粉白魔法', sailor: '教室', hanfu: '宣纸墨色', gothic: '暗夜魔典', detective: '旧书房', adventurer: '冒险者公会' };

async function main() {
  const dist = process.argv[2];
  const fails = [];
  const { browser, page, errors } = await launch(dist);
  const scene = () => page.evaluate(() => { const c = document.querySelector('.scene-layer'); return c && !c.hidden ? c.dataset.scene : null; });
  const demon = () => page.evaluate(() => document.querySelector('.demon')?.dataset.style);
  const look = async (name, extra) => {
    await page.click('.look-btn');
    if (name) await page.click(`.look-item:has-text("${name}")`);
    if (extra) await extra();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  };

  console.log('书架上是外景');
  await page.waitForTimeout(600);
  check(await scene() === 'magical_out', '默认：魔法少女外景', fails);
  check(await page.evaluate(() => document.body.classList.contains('has-scene')), 'body 有 has-scene', fails);
  const size = await page.evaluate(() => { const c = document.querySelector('.scene-layer'); const r = c.getBoundingClientRect(); return [c.width, c.height, r.width >= innerWidth - 1, r.height >= innerHeight - 1]; });
  check(size[0] === 1536 && size[1] === 1024 && size[2] && size[3], '默认原图：画布内部 1536×1024，盖满窗口 ' + size, fails);
  check(await page.evaluate(() => document.querySelector('.scene-layer').classList.contains('smooth')), '原图平滑放大', fails);

  console.log('画法：像素是可选的');
  await look(null, async () => { await page.click('.look-seg button:has-text("像素")'); });
  await page.waitForTimeout(400);
  const px = await page.evaluate(() => { const c = document.querySelector('.scene-layer'); return [c.width, c.height, c.classList.contains('smooth'), c.style.imageRendering || getComputedStyle(c).imageRendering]; });
  check(px[0] === 384 && px[1] === 256 && !px[2] && px[3] === 'pixelated', '像素：画布 384×256、按像素放大 ' + px, fails);
  await look(null, async () => { await page.click('.look-seg button:has-text("原图")'); });
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.querySelector('.scene-layer').width) === 1536, '换回原图', fails);

  console.log('换主题：背景和小恶魔都换成那一套');
  for (const id of ['gothic', 'detective', 'adventurer']) {
    await look(NAMES[id]);
    await page.waitForTimeout(400);
    const sc = await scene();
    check(sc && sc.startsWith(id + '_'), `配色「${NAMES[id]}」→ 背景 ${sc}`, fails);
    check(await demon() === id, `配色「${NAMES[id]}」→ 小恶魔穿 ${id}`, fails);
  }

  console.log('背景只在首页：写字页是素净的书桌，回书架画又出来');
  await newBook(page, '雨夜来信', [{ title: '', text: '雨下到第三天。' }]);
  await page.waitForTimeout(500);
  const desk = await page.evaluate(() => ({ scene: !document.querySelector('.scene-layer').hidden, has: document.body.classList.contains('has-scene'), desk: document.body.classList.contains('desk') }));
  check(!desk.scene && !desk.has && desk.desk, '写字页：不铺背景，body 是 desk ' + JSON.stringify(desk), fails);
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('.shelf');
  await page.waitForTimeout(500);
  check(await scene() === 'adventurer_out', '回书架：公会门口', fails);
  check(!(await page.evaluate(() => document.body.classList.contains('desk'))), '书架上不是 desk', fails);

  console.log('换景按钮');
  await look(null, async () => { await page.click('.look-scene'); });
  await page.waitForTimeout(400);
  check(await scene() === 'adventurer_in', '「走进去」换到内景', fails);
  await look(null, async () => { await page.click('.look-scene'); });
  await page.waitForTimeout(400);
  check(await scene() === 'adventurer_out', '再点「走出去」回外景', fails);

  console.log('关掉背景插画');
  await look(null, async () => { await page.click('.look-seg button:has-text("不铺")'); });
  check(await scene() === null && !(await page.evaluate(() => document.body.classList.contains('has-scene'))), '不铺：画布藏起来，has-scene 去掉', fails);
  await look(null, async () => { await page.click('.look-seg button:has-text("铺上")'); });
  await page.waitForTimeout(400);
  check(await scene() === 'adventurer_out', '铺上：回来', fails);

  console.log('配色跟随小恶魔');
  await look('跟随小恶魔');
  check(await demon() === 'magical' && (await scene()).startsWith('magical_'), '跟随：书架上按默认那套', fails);

  console.log('写字页的纸：实心的，带这套风格的点缀');
  await page.click('.book-card');
  await page.waitForSelector('.cm-content');
  await page.waitForTimeout(500);
  const paper = await page.evaluate(() => {
    const st = getComputedStyle(document.querySelector('.ws-body > .center'), '::before');
    return { content: st.content, bg: st.backgroundColor, w: parseFloat(st.width) };
  });
  check(paper.content !== 'none' && paper.w > 300, '写字页中间有一张纸', fails);
  check(!/\/ 0?\.\d+\)$/.test(paper.bg) && !/rgba\(.*,\s*0?\.\d+\)$/.test(paper.bg), '纸是实心的：' + paper.bg, fails);
  check(await page.evaluate(() => document.documentElement.dataset.paper) === 'magical', '<html data-paper> 是这套风格', fails);
  check(await page.evaluate(() => document.querySelector('.scene-layer').hidden), '写字页背后没有画', fails);
  // 码字进度画在小画布上
  const meter = await page.evaluate(() => { const c = document.querySelector('.demon-badge .db-meter'); return c && [c.width, c.height, parseFloat(c.style.width)]; });
  check(meter && meter[0] > 0 && meter[2] === meter[0] * 3, '码字进度：画布按 3 倍显示', fails);

  check(!errors.length, '没有报错' + (errors.length ? '：' + errors.join(' | ') : ''), fails);
  await browser.close();
  console.log(fails.length ? `\n${fails.length} 项没通过` : '\n全部通过');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
