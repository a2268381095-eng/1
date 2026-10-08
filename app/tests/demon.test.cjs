// 小恶魔：拖动换位置、拖角和按钮变大变小、刷新后还记得、点一下还是戳她
const { launch, newBook, check } = require('./helpers.cjs');
(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  const box = () => page.$eval('.demon-body', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.waitForTimeout(800);
  const b0 = await box();
  // 拖动
  await page.mouse.move(b0.x + b0.w / 2, b0.y + b0.h / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x - 300, b0.y - 200, { steps: 8 });
  check(await page.$eval('.demon', (e) => e.classList.contains('dragging')), '拖动时进入拖动状态', fails);
  await page.mouse.up();
  const b1 = await box();
  check(Math.abs(b1.x - (b0.x - 300 - b0.w / 2)) < 3 && Math.abs(b1.y - (b0.y - 200 - b0.h / 2)) < 3, `拖动后位置变了 (${Math.round(b0.x)},${Math.round(b0.y)}) → (${Math.round(b1.x)},${Math.round(b1.y)})`, fails);
  // 点一下是戳
  await page.waitForTimeout(400);
  await page.mouse.click(b1.x + b1.w / 2, b1.y + b1.h / 2);
  await page.waitForTimeout(1200);
  check((await page.textContent('.demon-bubble')).length > 0 && await page.$eval('.demon-bubble', (e) => e.classList.contains('on')), '点一下她会说话', fails);
  // 按钮变大
  await page.hover('.demon-body');
  await page.click('.demon-btn.bigger');
  await page.waitForTimeout(300);
  const b2 = await box();
  check(b2.h > b1.h + 20, `点「+」变大 ${Math.round(b1.h)} → ${Math.round(b2.h)}`, fails);
  // 拖角变小
  await page.hover('.demon-body');
  const g = await page.$eval('.demon-grip', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + 6, y: r.y + 6 }; });
  await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x + 20, g.y + 120, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const b3 = await box();
  check(b3.h < b2.h - 60, `拖角变小 ${Math.round(b2.h)} → ${Math.round(b3.h)}`, fails);
  // 拖出窗口外会被拦住
  await page.mouse.move(b3.x + b3.w / 2, b3.y + b3.h / 2); await page.mouse.down();
  await page.mouse.move(-500, -500, { steps: 6 }); await page.mouse.up();
  const b4 = await box();
  check(b4.x >= -1 && b4.y >= -1, `不会拖出窗口 (${Math.round(b4.x)},${Math.round(b4.y)})`, fails);
  // 靠近上沿时气泡放到下面
  await page.mouse.click(b4.x + b4.w / 2, b4.y + b4.h / 2);
  await page.waitForTimeout(800);
  const bub = await page.$eval('.demon-bubble', (e) => e.getBoundingClientRect().top);
  check(bub >= b4.y + b4.h - 2, '在屏幕顶上时气泡在她下面', fails);
  await page.waitForTimeout(500);
  await page.reload(); await page.waitForTimeout(1200);
  const b5 = await box();
  check(Math.abs(b5.x - b4.x) < 2 && Math.abs(b5.h - b4.h) < 2, '刷新后位置和大小还在', fails);
  // 复位命令
  await page.keyboard.press('F1'); await page.waitForTimeout(300);
  await page.fill('.help-search', '复位'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  const b6 = await box();
  check(Math.abs(b6.x - b0.x) < 2 && Math.abs(b6.h - b0.h) < 2, '「小恶魔回到右下角」能复位', fails);
  // 打开右侧面板时她让到面板左边，关掉后回来
  await newBook(page, '让路测试', [{ title: '', text: '　　测试。' }]);
  const d0 = await box();
  await page.click('.cm-content'); await page.keyboard.press('Control+f'); await page.waitForTimeout(600);
  const panel = await page.$eval('.side-right', (e) => e.getBoundingClientRect().left);
  const d1 = await box();
  check(d1.x + d1.w <= panel + 1, `面板打开时她在面板左边（她右边 ${Math.round(d1.x + d1.w)}，面板左边 ${Math.round(panel)}）`, fails);
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  const d2 = await box();
  check(Math.abs(d2.x - d0.x) < 2, '面板关掉后回到原来的位置', fails);
  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
