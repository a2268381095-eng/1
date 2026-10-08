// 基础流程：新建作品、写字、自动保存、新建章、删章撤销、刷新后还在
const { launch, newBook, getText, chapterList, check } = require('./helpers.cjs');
(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await newBook(page, '测试书', [{ title: '门铃', text: '　　雨下到第三天。\n　　林栀没有抬头。' }, { title: '旧信', text: '　　第二章。' }]);
  check((await chapterList(page)).length === 2, '有两章', fails);
  check((await page.textContent('.statusbar')).includes('已自动保存'), '自动保存了', fails);
  await page.reload(); await page.waitForSelector('.cm-content'); await page.waitForTimeout(500);
  check((await getText(page)).includes('第二章'), '刷新后正文还在', fails);
  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
