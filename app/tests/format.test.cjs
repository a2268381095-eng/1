// 一键排版：规则引擎的单元测试（node 直接跑）+ 浏览器里的流程测试（Playwright）
//   node build.mjs --out /tmp/xemo-format && node tests/format.test.cjs /tmp/xemo-format
//   只跑单元测试：node tests/format.test.cjs --unit
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { launch, newBook, setText, getText, check } = require('./helpers.cjs');

const SRC = path.join(__dirname, '../src/features/format');
const load = (f) => import(pathToFileURL(path.join(SRC, f)).href);

// ---------------- 单元测试 ----------------
async function unit(fails) {
  const { formatText, RULES, DEFAULT_RULES, normalizeRules, sameRules } = await load('engine.js');
  const { diffParts, skeleton } = await load('diff.js');
  console.log('规则引擎');
  const none = Object.fromEntries(RULES.map((r) => [r.id, false]));
  const only = (extra) => ({ ...none, paraGap: 0, ...extra });
  const eq = (input, rules, want, msg) => {
    const got = formatText(input, rules);
    check(got === want, msg + (got === want ? '' : `  得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`), fails);
  };
  const P = only({ punct: true });
  const ALLP = only({ punct: true, quotes: true, ellipsis: true, dash: true });

  check(RULES.length >= 9 && RULES.every((r) => r.id && r.name && r.desc && typeof r.default === 'boolean' && typeof r.optional === 'boolean'), 'RULES 每条都有 id/name/desc/default/optional', fails);
  check(DEFAULT_RULES.paraGap === 0 && DEFAULT_RULES.indent && !DEFAULT_RULES.mergeLines && !DEFAULT_RULES.cjkSpace, 'DEFAULT_RULES：可选规则默认关', fails);
  check(sameRules(normalizeRules({ paraGap: '1', indent: 0 }), { ...DEFAULT_RULES, paraGap: 1, indent: false }), 'normalizeRules 补齐并整理值', fails);

  eq('第一段\n  第二段\n\t第三段\n　第四段\n\n', only({ indent: true }), '　　第一段\n　　第二段\n　　第三段\n　　第四段\n\n', '段首空两格（空行不加）');
  eq('　　甲\n\n\n　　乙\n \n', only({ gap: true }), '　　甲\n　　乙', '段间不空行');
  eq('　　甲\n　　乙\n\n\n　　丙', only({ gap: true, paraGap: 1 }), '　　甲\n\n　　乙\n\n　　丙', '段间空一行');
  eq('　　甲   \n　　乙　\t\r\n丙', only({ trimEnd: true }), '　　甲\n　　乙\n丙', '去掉行尾空格，\\r\\n 换成 \\n');

  eq('他说,你好!真的吗?好.', P, '他说，你好！真的吗？好。', '半角标点改全角');
  eq('分号;冒号:括号(笑)', P, '分号；冒号：括号（笑）', '分号、冒号、括号');
  eq('圆周率是3.14,对吧', P, '圆周率是3.14，对吧', '3.14 不动');
  eq('网址www.example.com/a?b=1,记一下', P, '网址www.example.com/a?b=1，记一下', '网址不动');
  eq('10:30出发,别迟到', P, '10:30出发，别迟到', '时间 10:30 不动');
  eq('函数f(x)的值', P, '函数f(x)的值', 'f(x) 不动');
  eq('他读了 Hello, world. 这句', P, '他读了 Hello, world. 这句', '中文里夹的英文句子不动');
  eq('He said: "Hello, world." Then -- left...', ALLP, 'He said: "Hello, world." Then -- left...', '整段英文不动');
  eq('你好 , 世界 。', P, '你好，世界。', '全角标点两边多出的空格去掉');

  eq('他说:"你好."', ALLP, '他说：“你好。”', '直双引号成对');
  eq('他说"走吧"，又说"别回头"', only({ quotes: true }), '他说“走吧”，又说“别回头”', '两对直引号');
  eq('「走吧」『嗯』', only({ quotes: true }), '“走吧”‘嗯’', '「」『』改成“”‘’');
  eq("'好'", only({ quotes: true }), '‘好’', '直单引号');
  eq("他说don't走", only({ quotes: true }), "他说don't走", "don't 的撇号不动");
  eq('"第一段，\n"第二段。"', only({ quotes: true }), '“第一段，\n“第二段。”', '多段引语');
  eq('他走了。"', only({ quotes: true }), '他走了。”', '段尾落单的直引号当后引号');

  for (const s of ['等等...', '等等。。。', '等等…', '等等......', '等等⋯⋯', '等等…………', '等等···', '等等。 。 。'])
    eq(s, only({ ellipsis: true, punct: true }), '等等……', `省略号 ${s}`);
  eq('他说 Wait...', only({ ellipsis: true }), '他说 Wait...', '英文单词后面的 ...（后面不是中文）不动');
  eq('3.14和1..2', only({ ellipsis: true, punct: true }), '3.14和1..2', '两个点、小数点不动');

  for (const s of ['他--走了', '他—走了', '他──走了', '他———走了', '他――走了', '他－－走了', '他-- 走了'])
    eq(s, only({ dash: true, punct: true }), '他——走了', `破折号 ${s}`);
  eq('变量a--b的值', only({ dash: true }), '变量a--b的值', 'a--b 不动');
  eq('　　***\n　　——————', ALLP, '　　***\n　　——————', '分隔线不动');

  eq('　　他走进房间，看见\n桌上放着一封信。\n　　信是旧的。', only({ mergeLines: true }), '　　他走进房间，看见桌上放着一封信。\n　　信是旧的。', '合并断行');
  eq('第一章 风起\n他走进房间', only({ mergeLines: true }), '第一章 风起\n他走进房间', '章节标题后不合并');
  eq('他回头看了一眼\n“走吧。”', only({ mergeLines: true }), '他回头看了一眼\n“走吧。”', '引号开头的不合并');
  eq('He walked into\nthe room', only({ mergeLines: true }), 'He walked into the room', '英文断行接上时补空格');
  eq('我用iPhone拍了3张照片', only({ cjkSpace: true }), '我用 iPhone 拍了 3 张照片', '中英文之间加空格');
  eq('我用  iPhone', only({ cjkSpace: true }), '我用 iPhone', '多个空格合成一个');

  const messy = '第一章\n  他说:"等等..."   \n\n\n她--没回头.\n';
  eq(messy, DEFAULT_RULES, '　　第一章\n　　他说：“等等……”\n　　她——没回头。', '默认规则一起用');
  eq(messy, { ...DEFAULT_RULES, paraGap: 1 }, '　　第一章\n\n　　他说：“等等……”\n\n　　她——没回头。', '默认规则 + 空一行');
  eq('', DEFAULT_RULES, '', '空文本');
  eq('  \n\n　　\n', DEFAULT_RULES, '', '只有空白');
  check(formatText('他说,好') === formatText('他说,好', {}), '不给规则按默认', fails);

  // 不变量：只动空白和标点、排两次和排一次一样
  const strip = (s) => Array.from(s).filter((c) => !/[\s\p{P}─━⋯]/u.test(c)).join('');
  const corpus = [
    messy, '　　雨下到第三天。\n　　林栀没有抬头。', '他说:"Hello, world." 然后--走了...\n\n\n「真的?」她问.',
    "It's 3.14, see www.a.com/x?y=1. 好的...我知道了--", '第1章 开始\n他走进\n房间，看见\n“谁？”\n***\n后来', '\r\n  \t混合　空白 \r\n',
  ];
  const ALL = Object.fromEntries(RULES.map((r) => [r.id, true]));
  const configs = [DEFAULT_RULES, { ...ALL, paraGap: 0 }, { ...ALL, paraGap: 1 }, ...RULES.map((r) => only({ [r.id]: true })), { ...ALL, indent: false, paraGap: 0 }];
  let idem = 0, skel = 0;
  for (const t of corpus) for (const r of configs) {
    const a = formatText(t, r);
    if (formatText(a, r) !== a) idem++;
    if (strip(a) !== strip(t)) skel++;
  }
  check(!idem, '样例：排两次和排一次一样' + (idem ? `（${idem} 处不一样）` : ''), fails);
  check(!skel, '样例：去掉空白和标点后文字不变' + (skel ? `（${skel} 处变了）` : ''), fails);

  // 随机文字 × 随机规则组合
  let seed = 20261008;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphaA = Array.from('你好世界他说了第一章abcXYZ019 　\t\n\n\r,.!?:;()"\'“”‘’「」『』…—─-－。，、！？：；（）·⋯*~ ');
  const alphaB = ['他', '说', '第', '1', '章', 'a', 'b', ' ', '\n', '\n　　', '  ', '.', '...', '--', '"', "'", '“', '”', ',', '!', '?', ':', '(', ')', '……', '——', '。', '，', '***', '\n\n', 'www.a.com', '3.14', "don't", 'Hello, world.'];
  let bad = 0, firstBad = '';
  for (let k = 0; k < 30000; k++) {
    const al = k % 2 ? alphaA : alphaB;
    let s = '';
    for (let m = rnd(60); m > 0; m--) s += al[rnd(al.length)];
    const rules = Object.fromEntries(RULES.map((r) => [r.id, rnd(10) < 6]));
    rules.paraGap = rnd(2);
    const a = formatText(s, rules);
    const src = s.replace(/\r\n?/g, '\n');
    const d = diffParts(src, a);
    const re = (keep) => d.parts.filter((p) => p.t === 0 || p.t === keep).map((p) => p.s).join('');
    if (formatText(a, rules) !== a || strip(a) !== strip(s) || re(-1) !== src || re(1) !== a) {
      bad++;
      if (!firstBad) firstBad = JSON.stringify({ s, rules });
    }
  }
  check(!bad, '随机 30000 段：幂等、只动空白标点、对比能还原两边' + (bad ? `（${bad} 段不对，例：${firstBad}）` : ''), fails);

  console.log('改动对比');
  const d1 = diffParts('他说,你好.', '他说，你好。');
  check(d1.count === 2 && JSON.stringify(d1.parts) === JSON.stringify([{ t: 0, s: '他说' }, { t: -1, s: ',' }, { t: 1, s: '，' }, { t: 0, s: '你好' }, { t: -1, s: '.' }, { t: 1, s: '。' }]), '按字对齐，改两处', fails);
  const d2 = diffParts('甲\n乙\n丙', '　　甲\n　　乙\n　　丙');
  check(d2.count === 3, '每段加缩进算一处', fails);
  check(diffParts('同样', '同样').count === 0, '没改动是 0 处', fails);
  check(skeleton('他说：“等等……”') === '他说等等', 'skeleton 去掉标点', fails);
  const d3 = diffParts('abc', 'abd');
  check(d3.count === 1, '文字不同时退回逐字对比', fails);
}

// ---------------- 浏览器流程 ----------------
const dbAll = (page, store) => page.evaluate((store) => new Promise((resolve, reject) => {
  const req = indexedDB.open('xiaoemo-wenshu');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const g = req.result.transaction(store).objectStore(store).getAll();
    g.onsuccess = () => { resolve(g.result); req.result.close(); };
    g.onerror = () => reject(g.error);
  };
}), store);
const chapters = async (page) => (await dbAll(page, 'chapters')).sort((a, b) => a.order - b.order).map((c) => c.content);
const kv = async (page, key) => { const r = (await dbAll(page, 'kv')).find((x) => x.key === key); return r ? r.value : undefined; };
const toastText = (page) => page.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' | '));
const clickToastUndo = async (page, text) => { await page.click(`.toast:has-text("${text}") .toast-act`); await page.waitForTimeout(500); };
const closeToasts = (page) => page.$$eval('.toast', (els) => els.forEach((e) => e.remove()));

async function flows(dist, fails) {
  const { formatText, DEFAULT_RULES } = await load('engine.js');
  const sprites = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/generated/sprites.json'), 'utf8'));
  const formatLines = new Set(sprites.flatMap((s) => (s.persona && s.persona.lines && s.persona.lines.format) || []));

  const { browser, page, errors } = await launch(dist);
  const t1 = '第一段 , 他说:"等等..."   \n\n\n她--没回头.\n  圆周率3.14,网址www.a.com';
  const t2 = '第二章的字 。\n「走吧」他说,\n\n不回头了...';
  const t3 = '　　第三章已经很整齐。';
  await newBook(page, '排版测试', [{ title: '门铃', text: t1 }, { title: '旧信', text: t2 }, { title: '整齐', text: t3 }]);
  const want = (t) => formatText(t, DEFAULT_RULES);
  // 现在打开的是第三章；先切到第二章。原文以存进去的为准（新建章节时编辑器可能多留一个空行）
  await page.click('.ch-item:nth-child(2)');
  await page.waitForTimeout(400);
  const [o1, o2, o3] = await chapters(page);
  check(o1.startsWith(t1) && o2.startsWith(t2) && o3 === t3, '三章都写进去了', fails);

  console.log('快捷键打开，Esc 取消');
  await page.click('.cm-content');
  await page.keyboard.press('Control+Shift+L');
  await page.waitForSelector('.center .fmt-overlay');
  const n1 = await page.textContent('.fmt-sum');
  check(/要改 \d+ 处/.test(n1), '预览显示改了多少处：' + n1.trim(), fails);
  check(await page.$('.fmt-preview .fmt-del') && await page.$('.fmt-preview .fmt-ins'), '删掉的标红、加上的标绿', fails);
  check(await page.getAttribute('.tool-btn[data-cmd="format.open"]', 'aria-pressed') === 'true', '顶栏「排版」按钮亮着', fails);
  check(await page.isVisible('.fmt-head .icon-btn[aria-label="返回正文"]') && await page.isVisible('.fmt-head .icon-btn[aria-label="关闭"]'), '左上角返回、右上角关闭', fails);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(!(await page.$('.fmt-overlay')), 'Esc 关掉预览', fails);
  check((await getText(page)) === o2, '取消后正文没变', fails);

  console.log('顶栏按钮打开，写回，提示条撤销');
  await page.click('.tool-btn[data-cmd="format.open"]');
  await page.waitForSelector('.fmt-overlay .fmt-ok:not([disabled])');
  await page.click('.fmt-ok');
  await page.waitForTimeout(600);
  check(!(await page.$('.fmt-overlay')), '写回后预览关掉', fails);
  check((await getText(page)) === want(o2), '正文排好了', fails);
  const tt = await toastText(page);
  check(/已排版，改了 \d+ 处/.test(tt) && tt.includes('撤销'), '提示条带「撤销」：' + tt, fails);
  await page.waitForTimeout(400);
  const said = await page.$eval('.demon .sr[role="status"]', (e) => e.textContent);
  check(formatLines.has(said), '小恶魔接话：' + said, fails);
  await page.waitForTimeout(2600);
  const bubble = await page.$eval('.demon-bubble', (e) => e.textContent);
  check(bubble === said, '对话框里只有台词，没有名字', fails);
  await clickToastUndo(page, '已排版');
  check((await getText(page)) === o2, '点「撤销」全部还原', fails);
  await page.waitForTimeout(1300);
  check((await chapters(page))[1] === o2, '还原也存进去了', fails);
  await closeToasts(page);

  console.log('写回后在正文里按 Ctrl+Z');
  await page.keyboard.press('Control+Shift+L');
  await page.waitForSelector('.fmt-overlay .fmt-ok:not([disabled])');
  await page.click('.fmt-ok');
  await page.waitForTimeout(600);
  check((await getText(page)) === want(o2), '又排好了', fails);
  await page.click('.cm-content');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  check((await getText(page)) === o2, '按一次 Ctrl+Z 全部还原', fails);
  await closeToasts(page);

  console.log('多选几章：排版这几章');
  await page.click('.ch-item:nth-child(1)', { modifiers: ['Control'] });
  await page.waitForSelector('.sel-bar:not([hidden])');
  await page.click('.sel-bar button:has-text("排版这几章")');
  await page.waitForSelector('.fmt-overlay .fmt-ch');
  check(await page.getAttribute('.fmt-seg [data-scope="selected"]', 'aria-pressed') === 'true', '范围默认是选中的几章', fails);
  check((await page.$$('.fmt-ch')).length === 2, '按章列出两章', fails);
  await page.click('.fmt-ch:first-child .fmt-ch-tog');
  check(await page.isVisible('.fmt-ch:first-child .fmt-ch-body .fmt-del'), '展开能看这一章的改动', fails);
  await page.click('.fmt-seg [data-scope="book"]');
  await page.waitForTimeout(300);
  check((await page.$$('.fmt-ch')).length === 2 && (await page.textContent('.fmt-same')).includes('1 章不用改'), '全书：整齐的那章不列出', fails);
  await page.click('.fmt-seg [data-scope="selected"]');
  await page.waitForTimeout(300);
  await page.click('.fmt-ok');
  await page.waitForTimeout(1500);
  let cs = await chapters(page);
  check(cs[0] === want(o1) && cs[1] === want(o2) && cs[2] === o3, '两章都写回了', fails);
  check((await toastText(page)).includes('已排版 2 章'), '提示条：已排版 2 章', fails);
  await clickToastUndo(page, '已排版 2 章');
  await page.waitForTimeout(800);
  cs = await chapters(page);
  check(cs[0] === o1 && cs[1] === o2, '一次撤销两章都还原', fails);
  await closeToasts(page);

  console.log('只写回勾上的章');
  await page.click('.ch-item:nth-child(2)');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+Shift+L');
  await page.waitForSelector('.fmt-overlay');
  await page.click('.fmt-seg [data-scope="book"]');
  await page.waitForSelector('.fmt-ch');
  await page.click('.fmt-ch:first-child .fmt-ch-t input');
  check((await page.textContent('.fmt-sum')).includes('跳过 1 章'), '取消勾选后显示跳过', fails);
  await page.click('.fmt-ok');
  await page.waitForTimeout(1500);
  cs = await chapters(page);
  check(cs[0] === o1 && cs[1] === want(o2), '没勾的那章不动', fails);
  await clickToastUndo(page, '已排版');
  await closeToasts(page);

  console.log('规则开关和排版方案');
  await page.keyboard.press('Control+Shift+L');
  await page.waitForSelector('.fmt-overlay .fmt-ok:not([disabled])');
  const before = await page.textContent('.fmt-sum');
  await page.click('.fmt-rule input[data-rule="indent"]');
  await page.waitForTimeout(300);
  check((await page.textContent('.fmt-sum')) !== before, '关掉一条规则，预览跟着变', fails);
  check((await page.$eval('.fmt-scheme', (e) => e.value)) === '', '方案显示「自定义」', fails);
  await page.click('.fmt-ctrl button:has-text("存为方案")');
  await page.fill('.modal input.input', '投稿用');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  check((await page.$eval('.fmt-scheme', (e) => e.value)) === '投稿用', '存成方案后选中它', fails);
  let saved = await kv(page, 'format:schemes');
  check(Array.isArray(saved) && saved.some((s) => s.name === '投稿用' && s.rules.indent === false), '方案存在 kv format:schemes', fails);
  await page.selectOption('.fmt-scheme', '网文平台');
  await page.waitForTimeout(300);
  check(await page.$eval('.fmt-rule input[data-rule="indent"]', (e) => e.checked) && await page.$eval('input[name="fmt-gap"][value="1"]', (e) => e.checked), '换成「网文平台」：缩进开、空一行', fails);
  await page.selectOption('.fmt-scheme', '投稿用');
  await page.waitForTimeout(300);
  await page.click('.fmt-del-scheme');
  await page.waitForTimeout(500);
  saved = await kv(page, 'format:schemes');
  check(!saved.some((s) => s.name === '投稿用') && (await toastText(page)).includes('已删除方案'), '删除方案出「已删除」提示条', fails);
  await clickToastUndo(page, '已删除方案');
  saved = await kv(page, 'format:schemes');
  check(saved.some((s) => s.name === '投稿用'), '撤销删除，方案回来了', fails);
  check(await page.$('.fmt-scheme option[value="投稿用"]'), '下拉框里也回来了', fails);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check((await getText(page)) === o2, '关掉预览正文没变', fails);
  await page.keyboard.press('Control+Shift+L');
  await page.waitForSelector('.fmt-overlay');
  check(!(await page.$eval('.fmt-rule input[data-rule="indent"]', (e) => e.checked)), '下次打开记得上次的规则', fails);
  await page.click('.fmt-head .icon-btn[aria-label="关闭"]');
  await closeToasts(page);

  console.log('问小恶魔能搜到');
  await page.keyboard.press('F1');   // 小恶魔旁边的「?」也是这个
  await page.waitForSelector('.help-search');
  await page.fill('.help-search', '排版');
  const items = await page.$$eval('.help-item .help-t', (els) => els.map((e) => e.textContent));
  check(items.includes('一键排版') && items.includes('全书排版'), '搜「排版」找到：' + items.join('、'), fails);
  await page.fill('.help-search', '省略号');
  check((await page.$$eval('.help-item .help-t', (els) => els.map((e) => e.textContent))).includes('一键排版'), '搜「省略号」也能找到', fails);
  await page.keyboard.press('Escape');

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();

  console.log('手机宽度、深色模式');
  const m = await launch(dist, { width: 390, height: 844 });
  await m.page.emulateMedia({ colorScheme: 'dark' });
  await newBook(m.page, '手机', [{ title: '', text: t1 }]);
  await m.page.click('.tool-btn[data-cmd="format.open"]');
  await m.page.waitForSelector('.fmt-overlay .fmt-ok:not([disabled])');
  const sz = await m.page.evaluate(() => {
    const o = document.querySelector('.fmt-overlay');
    const r = o.getBoundingClientRect();
    return { doc: document.documentElement.scrollWidth, left: r.left, right: r.right, ow: o.scrollWidth, cw: o.clientWidth,
      pw: document.querySelector('.fmt-preview').scrollWidth, pcw: document.querySelector('.fmt-preview').clientWidth,
      bg: getComputedStyle(o).backgroundColor, ins: getComputedStyle(document.querySelector('.fmt-ins')).color,
      ok: document.querySelector('.fmt-ok').getBoundingClientRect().right };
  });
  check(sz.doc <= 390 && sz.left >= 0 && sz.right <= 390 && sz.ow <= sz.cw && sz.pw <= sz.pcw && sz.ok <= 390, '390px 宽不横向溢出 ' + JSON.stringify({ doc: sz.doc, ow: sz.ow, cw: sz.cw, pw: sz.pw }), fails);
  check(sz.bg === 'rgb(27, 21, 29)' && sz.ins === 'rgb(127, 209, 168)', '深色模式用深色的纸色和绿色：' + sz.bg + ' / ' + sz.ins, fails);
  if (process.env.SHOT) {
    await m.page.screenshot({ path: path.join(process.env.SHOT, 'format-mobile-dark.png') });
    await m.page.click('.fmt-rules > summary');
    await m.page.screenshot({ path: path.join(process.env.SHOT, 'format-mobile-rules.png') });
  }
  await m.page.click('.fmt-ok');
  await m.page.waitForTimeout(600);
  check((await getText(m.page)) === want(t1), '手机上也能写回', fails);
  check(m.errors.length === 0, '没有报错 ' + m.errors.join(' | '), fails);
  await m.browser.close();
}

(async () => {
  const fails = [];
  await unit(fails);
  if (!process.argv.includes('--unit')) await flows(process.argv[2] || path.join(__dirname, '../dist'), fails);
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
