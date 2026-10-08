// 浏览器自动测试的公用工具（Playwright）。用法见 tests/smoke.test.cjs。
//   node build.mjs --out /tmp/xxx && node tests/smoke.test.cjs /tmp/xxx
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

async function launch(distDir, { width = 1360, height = 860 } = {}) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('file://' + require('path').resolve(distDir) + '/index.html');
  await page.waitForSelector('.topbar');
  return { browser, ctx, page, errors };
}

/** 新建一本书并写入几章。chapters: [{ title, text }]，返回书的 id */
async function newBook(page, title, chapters = [{ title: '', text: '' }]) {
  await page.click('.shelf .btn.primary');
  await page.fill('.modal input.input', title);
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('.cm-content');
  for (let i = 0; i < chapters.length; i++) {
    if (i > 0) { await page.click('.cm-content'); await page.keyboard.press('Control+Enter'); await page.waitForTimeout(500); }
    const c = chapters[i];
    if (c.title) { await page.fill('.ch-title', c.title); await page.waitForTimeout(450); }
    if (c.text) await setText(page, c.text);
  }
  await page.waitForTimeout(1300);
  return page.evaluate(() => location.hash.split('/')[2]);
}

/** 把当前章正文整体换成 text（走编辑器，会触发自动保存） */
async function setText(page, text) {
  await page.click('.cm-content');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

const getText = (page) => page.evaluate(() => {
  const v = document.querySelector('.cm-content').cmView;
  return [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
});

const chapterList = (page) => page.$$eval('.ch-item', (els) => els.map((e) => e.querySelector('.ch-item-no').textContent + '|' + e.querySelector('.ch-item-t').textContent));

function check(cond, msg, fails) { if (!cond) { fails.push(msg); console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); }

module.exports = { launch, newBook, setText, getText, chapterList, check };
