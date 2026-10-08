// 一键排版 · 挑刺测试：专门打边界（空内容、10 万字以上、中文输入法、特殊字符和正则元字符、
// 连续操作后撤销 / 重做、跨章批量撤销、刷新后数据还在、Esc 和关闭按钮、深色模式、手机 390px）。
//   node build.mjs --out /tmp/xemo-format-review && node tests/format.review.test.cjs /tmp/xemo-format-review
//   只跑单元测试：node tests/format.review.test.cjs --unit
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { launch, newBook, setText, check } = require('./helpers.cjs');

const SRC = path.join(__dirname, '../src/features/format');
const load = (f) => import(pathToFileURL(path.join(SRC, f)).href);
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0), ZWSP = String.fromCharCode(0x200b);
const strip = (s) => Array.from(s).filter((c) => !/[\s\p{P}─━⋯]/u.test(c)).join('');
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------- 单元测试 ----------------
async function unit(fails) {
  const { formatText, RULES, DEFAULT_RULES, normalizeRules, sameRules, BUILTIN_SCHEMES, isBuiltinScheme } = await load('engine.js');
  const { diffParts } = await load('diff.js');
  const none = Object.fromEntries(RULES.map((r) => [r.id, false]));
  const only = (extra) => ({ ...none, paraGap: 0, ...extra });
  const ALL = { ...Object.fromEntries(RULES.map((r) => [r.id, true])), paraGap: 0 };
  const STD = only({ punct: true, quotes: true, ellipsis: true, dash: true });
  const eq = (input, rules, want, msg) => {
    let got;
    try { got = formatText(input, rules); } catch (e) { got = 'THROW ' + e.message; }
    check(got === want, msg + (got === want ? '' : `  得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`), fails);
  };

  console.log('空内容、怪参数');
  eq('', DEFAULT_RULES, '', '空字符串');
  eq(null, DEFAULT_RULES, '', 'null 当空');
  eq(undefined, DEFAULT_RULES, '', 'undefined 当空');
  eq(12345, DEFAULT_RULES, '　　12345', '数字也能排');
  eq('\n\n\n', DEFAULT_RULES, '', '只有换行');
  eq('　　 \t\n' + NBSP + '\n　', DEFAULT_RULES, '', '只有各种空白');
  eq('，。！', DEFAULT_RULES, '　　，。！', '只有标点');
  for (const bad of [null, 'abc', [], 42, { indent: 'yes', paraGap: '2', zzz: 1 }]) {
    let ok = true;
    try { formatText('他说,好', bad); } catch (_) { ok = false; }
    check(ok, '规则参数是 ' + JSON.stringify(bad) + ' 也不出错', fails);
  }
  check(normalizeRules({ paraGap: '2' }).paraGap === 1 && normalizeRules({ paraGap: 'x' }).paraGap === 0, 'paraGap 只会是 0 或 1', fails);
  check(sameRules(null, DEFAULT_RULES) && !sameRules({ indent: false }, DEFAULT_RULES), 'sameRules 补齐后比较', fails);
  check(BUILTIN_SCHEMES.length >= 2 && isBuiltinScheme('默认') && isBuiltinScheme('网文平台') && !isBuiltinScheme('默认 '), '自带方案「默认」「网文平台」', fails);

  console.log('特殊字符、正则元字符、HTML');
  const meta = '他说$1和$&,还有\\d+(.*)?[a-z]{2}|^$.好';
  const mo = formatText(meta, STD);
  check(strip(mo) === strip(meta) && formatText(mo, STD) === mo, '正则元字符：文字不变、幂等 ' + JSON.stringify(mo), fails);
  check(mo.includes('$1') && mo.includes('$&') && mo.includes('\\d+') && mo.includes('[a-z]{2}'), '$1、$&、\\d+ 原样保留', fails);
  const html = '<img src=x onerror="alert(1)">他说,<b>好</b>.';
  const ho = formatText(html, DEFAULT_RULES);
  check(strip(ho) === strip(html) && ho.includes('<img src=x onerror=') && ho.includes('<b>好</b>'), 'HTML 标签里的字不动 ' + JSON.stringify(ho), fails);
  eq('😀,好', STD, '😀，好', '表情后面接中文：逗号改全角');
  eq('𠀀,好', STD, '𠀀，好', '扩展区汉字（两个码元）也算中文');
  eq('好,😀', STD, '好，😀', '中文后面接表情');
  const sur = formatText('😀...𠀀--👍"𠀁"\n🎉 ,好', ALL);
  check(!loneSurrogate.test(sur) && formatText(sur, ALL) === sur, '代理对不会被拆开 ' + JSON.stringify(sur), fails);
  eq('你' + NBSP + '好', STD, '你' + NBSP + '好', '中间的不换行空格不动');
  eq('你好' + NBSP + NBSP, only({ trimEnd: true }), '你好', '行尾不换行空格去掉');
  eq(BOM + '他说', only({ indent: true }), '　　他说', '开头的 BOM 换成缩进');
  eq('甲' + ZWSP + ',乙', STD, '甲' + ZWSP + ',乙', '零宽空格挡着的不算挨着中文（不乱改）');
  eq('甲' + LS + '乙' + PS + '丙\r丁\r\n戊', only({}), '甲\n乙\n丙\n丁\n戊', '各种换行都统一成 \\n');

  console.log('需求里的例子');
  eq('圆周率3.14,网址https://a.com/x?y=1&z=2,时间10:30', STD, '圆周率3.14，网址https://a.com/x?y=1&z=2，时间10:30', '3.14、网址、10:30 不动');
  eq('他读了 He said, "OK." 这句', STD, '他读了 He said, “OK.” 这句', '中文里夹的英文句子：逗号句点不动');
  eq('中文 , English', STD, '中文，English', '改成全角后两边不留半角空格');
  eq('他说: hello', STD, '他说：hello', '全角冒号后面接英文不留空格');
  eq('「他说『好』」', only({ quotes: true }), '“他说‘好’”', '「」『』嵌套');
  eq('"一"二"三"', only({ quotes: true }), '“一”二“三”', '直引号按顺序成对');
  for (const [s, w] of [['等等…………', '等等……'], ['等等.....', '等等……'], ['等等……', '等等……'], ['等等···', '等等……'], ['等等⋯', '等等……']])
    eq(s, STD, w, `省略号 ${s}`);
  for (const [s, w] of [['他——走', '他——走'], ['他—走', '他——走'], ['他──走', '他——走'], ['他 -- 走', '他——走'], ['2020--2021年', '2020--2021年']])
    eq(s, STD, w, `破折号 ${s}`);
  eq('He said: "Wait..." -- then left.', ALL, 'He said: "Wait..." -- then left.', '整段英文一个字都不动');

  console.log('随机文字（更多怪字符）');
  let seed = 4242;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alpha = ['他', '说', '走', '第', '一', '章', '番外', 'a', 'Z', '0', '9', ' ', NBSP, '　', '\t', '\n', '\r\n', LS, '\n　　', '.', '...', '。', '。。。', '．', '·',
    '…', '⋯', '—', '―', '─', '━', '-', '--', '－', '"', "'", '＂', '＇', '“', '”', '‘', '’', '「', '」', '『', '』', ',', '，', '!', '?', ';', ':', '(', ')', '（', '）',
    '【', '】', '~', '*', '***', '😀', '𠀀', BOM, ZWSP, 'www.a.com', '3.14', "don't", 'Hello, world.', '$1', '\\d+', '(.*)?', '[a-z]', '{2}', '|', '^', '<b>', '&amp;'];
  let bad = 0, first = '';
  for (let k = 0; k < 40000; k++) {
    let s = '';
    for (let m = rnd(50); m > 0; m--) s += alpha[rnd(alpha.length)];
    const rules = Object.fromEntries(RULES.map((r) => [r.id, rnd(10) < 6]));
    rules.paraGap = rnd(2);
    const a = formatText(s, rules);
    const src = s.replace(/\r\n?/g, '\n').split(LS).join('\n');
    const d = diffParts(src, a);
    const re = (keep) => d.parts.filter((p) => p.t === 0 || p.t === keep).map((p) => p.s).join('');
    if (formatText(a, rules) !== a || strip(a) !== strip(s) || re(-1) !== src || re(1) !== a || loneSurrogate.test(a)) {
      bad++;
      if (!first) first = JSON.stringify({ s, rules });
    }
  }
  check(!bad, '随机 40000 段：幂等、只动空白标点、对比能还原、不拆代理对' + (bad ? `（${bad} 段不对，例：${first}）` : ''), fails);

  console.log('改动对比的边界');
  const dd = (a, b) => { const d = diffParts(a, b); const re = (k) => d.parts.filter((p) => p.t === 0 || p.t === k).map((p) => p.s).join(''); return re(-1) === (a || '') && re(1) === (b || '') ? d.count : -1; };
  check(dd('', '') === 0 && dd(null, null) === 0, '两边都空：0 处', fails);
  check(dd('', '　　') === 1 && dd('，', '') === 1, '一边空：1 处', fails);
  check(dd('甲乙', '甲，乙') === 1 && dd('甲,乙,丙', '甲，乙，丙') === 2, '按字对齐计数', fails);

  console.log('性能（10 万字以上）');
  const para = '他说:"等等..."林栀没有抬头,她看着窗外的雨(很大),心想--这回真的要走了.Hello, world.\n\n';
  const big = para.repeat(2600);
  let t0 = Date.now();
  const bo = formatText(big, DEFAULT_RULES);
  const d = diffParts(big, bo);
  const ms = Date.now() - t0;
  check(big.length > 100000 && ms < 3000 && d.count > 10000, `${big.length} 字一章：排版加对比 ${ms}ms，${d.count} 处`, fails);
  const nasty = {
    '十万个直引号': '"'.repeat(100000) + '中',
    '十万对括号': '('.repeat(50000) + '中' + ')'.repeat(50000),
    '二十万个点': '中' + '.'.repeat(200000),
    '二十万个空格夹逗号': '中' + ' '.repeat(200000) + ',中',
    '十万行断行': '他走进房间\n'.repeat(100000),
    '二十万个减号': '中' + '-'.repeat(200000),
    '一行三十万字': '他说,好.'.repeat(60000),
  };
  for (const [name, s] of Object.entries(nasty)) {
    t0 = Date.now();
    const o = formatText(s, { ...ALL, indent: name !== '十万行断行' });
    const t = Date.now() - t0;
    check(t < 3000 && formatText(o, { ...ALL, indent: name !== '十万行断行' }) === o, `${name}：${t}ms，幂等`, fails);
  }
}

// ---------------- 浏览器里用的小工具 ----------------
const dbAll = (page, store) => page.evaluate((store) => new Promise((resolve, reject) => {
  const req = indexedDB.open('xiaoemo-wenshu');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const g = req.result.transaction(store).objectStore(store).getAll();
    g.onsuccess = () => { resolve(g.result); req.result.close(); };
    g.onerror = () => reject(g.error);
  };
}), store);
const chaptersOf = async (page, bookId) => (await dbAll(page, 'chapters')).filter((c) => !bookId || c.bookId === bookId).sort((a, b) => a.order - b.order).map((c) => c.content);
const kv = async (page, key) => { const r = (await dbAll(page, 'kv')).find((x) => x.key === key); return r ? r.value : undefined; };
/** 编辑器里的全文（.cm-line 只渲染看得见的几行，长文要从 EditorView 拿） */
const docText = (page) => page.evaluate(() => document.querySelector('.cm-content').cmView.view.state.doc.toString());
/** 像粘贴一样整体换掉正文（长文用，键盘输入十万字太慢） */
const setDoc = (page, text) => page.evaluate((text) => {
  const v = document.querySelector('.cm-content').cmView.view;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, userEvent: 'input.paste' });
}, text);
const toastText = (page) => page.$$eval('.toast', (els) => els.map((e) => e.textContent).join(' | '));
const closeToasts = (page) => page.$$eval('.toast', (els) => els.forEach((e) => e.remove()));
const openFmt = async (page) => { await page.keyboard.press('Control+Shift+L'); await page.waitForSelector('.fmt-overlay'); await page.waitForTimeout(150); };
const waitReady = (page) => page.waitForFunction(() => { const s = document.querySelector('.fmt-sum'); return s && !/正在看/.test(s.textContent); }, null, { timeout: 60000 });
const commit = async (page) => { await page.waitForSelector('.fmt-ok:not([disabled])', { timeout: 60000 }); await page.click('.fmt-ok'); await page.waitForSelector('.toast:has-text("已排版")', { timeout: 60000 }); await page.waitForTimeout(200); };
const ctrlZ = async (page) => { await page.click('.cm-content'); await page.keyboard.press('Control+z'); await page.waitForTimeout(500); };
const toolRedo = async (page) => { await page.click('.ch-item-no'); await page.click('.topbar .icon-btn[aria-label="重做"]'); await page.waitForTimeout(500); };
const openChapter = async (page, n) => { await page.click(`.ch-item:nth-child(${n})`); await page.waitForTimeout(400); };
const overlayGone = async (page) => page.evaluate(() => !document.querySelector('.fmt-overlay') && !document.querySelector('.center.fmt-on')
  && !document.querySelector('.ed-host').inert && document.querySelector('.tool-btn[data-cmd="format.open"]').getAttribute('aria-pressed') !== 'true');

/** 新建一本书，章节直接写进数据库（几十章、十万字时比键盘输入快得多）。返回书 id */
async function seedBook(page, title, chapters) {
  await newBook(page, title, [{ title: '', text: '' }]);
  const bookId = await page.evaluate(() => location.hash.split('/')[2]);
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('.shelf');
  await page.waitForTimeout(300);
  await page.evaluate(({ bookId, chapters }) => new Promise((resolve, reject) => {
    const req = indexedDB.open('xiaoemo-wenshu');
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction('chapters', 'readwrite');
      const os = t.objectStore('chapters');
      const g = os.index('bookId').getAll(bookId);
      g.onsuccess = () => {
        const old = g.result[0];
        chapters.forEach((c, i) => {
          const base = i === 0 ? old : { id: 'cseed' + i + '_' + Date.now().toString(36), bookId, volumeId: null, points: [], createdAt: Date.now() };
          os.put({ ...base, order: i + 1, title: c.title || '', content: c.text, words: c.text.length, updatedAt: Date.now() });
        });
      };
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  }), { bookId, chapters });
  await page.evaluate((id) => { location.hash = '#/book/' + id; }, bookId);
  await page.waitForSelector('.cm-content');
  await page.waitForTimeout(500);
  return bookId;
}

// ---------------- 浏览器流程 ----------------
async function flows(dist, fails) {
  const { formatText, DEFAULT_RULES } = await load('engine.js');
  const want = (t, extra = {}) => formatText(t, { ...DEFAULT_RULES, ...extra });
  const sprites = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/generated/sprites.json'), 'utf8'));
  const formatLines = new Set(sprites.flatMap((s) => (s.persona && s.persona.lines && s.persona.lines.format) || []));

  // ===== 1. 空章、Esc、关闭按钮 =====
  {
    const { browser, page, errors } = await launch(dist);
    console.log('空章节');
    await newBook(page, '空书', [{ title: '', text: '' }]);
    await openFmt(page);
    check((await page.textContent('.fmt-preview')).includes('不用改') && await page.$('.fmt-ok[disabled]'), '空章：显示不用改，「写回」按不了', fails);
    check(await page.evaluate(() => document.activeElement.classList.contains('fmt-x')), '空章：焦点在关闭按钮上', fails);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    check(await overlayGone(page), '空章：回车就是关闭', fails);
    check((await docText(page)) === '', '空章：正文还是空的', fails);

    console.log('Esc、返回、关闭、取消');
    const t = '甲,乙.\n丙--丁';
    await setText(page, t);
    await page.waitForTimeout(1300);
    for (const [how, act] of [
      ['Esc', () => page.keyboard.press('Escape')],
      ['左上角返回', () => page.click('.fmt-head .icon-btn[aria-label="返回正文"]')],
      ['右上角关闭', () => page.click('.fmt-head .icon-btn[aria-label="关闭"]')],
      ['取消', () => page.click('.fmt-btns .btn:has-text("取消")')],
    ]) {
      await openFmt(page);
      await page.click('.fmt-rule input[data-rule="cjkSpace"]');   // 动一下规则再关
      await page.waitForTimeout(150);
      await act();
      await page.waitForTimeout(250);
      check(await overlayGone(page) && (await docText(page)) === t, `${how}：预览关掉、正文没变、正文能再点`, fails);
      await page.click('.cm-content');
      check(await page.evaluate(() => !!document.activeElement.closest('.cm-editor')), `${how}：关掉后焦点回到正文`, fails);
    }
    check(!(await page.$('.modal')), '关预览不会问「保留草稿」（规则已经自动记住）', fails);

    console.log('连按两次快捷键、弹窗叠在上面时的 Esc 和焦点');
    await openFmt(page);
    await page.keyboard.press('Control+Shift+L');
    await page.waitForTimeout(300);
    check((await page.$$('.fmt-overlay')).length === 1, '再按一次快捷键不会叠出第二层', fails);
    await page.click('.fmt-ctrl button:has-text("存为方案")');
    await page.waitForSelector('.modal input.input');
    await page.keyboard.press('Control+Shift+L');
    await page.waitForTimeout(300);
    check(await page.evaluate(() => !!document.activeElement.closest('.modal')), '输入框开着时按快捷键，焦点不被抢到「写回」上', fails);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check(!(await page.$('.modal')) && !!(await page.$('.fmt-overlay')), 'Esc 先关输入框，预览还在', fails);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check(await overlayGone(page) && (await docText(page)) === t, '再按 Esc 关预览，正文没变', fails);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check((await docText(page)) === t && !(await page.$('.modal')), '多按一次 Esc 什么也不发生', fails);

    console.log('预览盖着时键盘进不了正文');
    await openFmt(page);
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) {
      await page.keyboard.press(i < 12 ? 'Shift+Tab' : 'Tab');
      reached = await page.evaluate(() => !!document.activeElement.closest('.cm-editor, .ch-head'));
    }
    check(!reached, 'Tab / Shift+Tab 走不到盖住的正文和章名', fails);
    await page.keyboard.insertText('X');
    await page.waitForTimeout(200);
    check((await docText(page)) === t, '预览开着时乱打字，正文不变', fails);
    await page.keyboard.press('Escape');
    check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
    await browser.close();
  }

  // ===== 2. 特殊字符、中文输入法、方案出错 =====
  {
    const { browser, page, errors } = await launch(dist);
    console.log('特殊字符和 HTML');
    const evil = '他说:<img src=x onerror="window.__xss=1">$1和$&,\\d+(.*)?[a-z]{2}|^$...好';
    await newBook(page, '<b>书</b>$&', [{ title: '<i>章</i>$1(.*)', text: evil }]);
    await page.waitForTimeout(500);
    const o = await docText(page);
    await openFmt(page);
    check(!(await page.$('.fmt-preview img, .fmt-preview b, .fmt-sum i')) && !(await page.evaluate(() => window.__xss)), '预览里的 HTML 当成文字显示，不会执行', fails);
    check((await page.textContent('.fmt-sum')).includes('<i>章</i>$1(.*)'), '章名里的特殊字符原样显示', fails);
    check((await page.textContent('.fmt-preview')).includes('$1和$&'), '$1、$& 原样显示（没被当成替换模板）', fails);
    await commit(page);
    check((await docText(page)) === want(o), '写回结果和引擎一致', fails);
    await closeToasts(page);

    console.log('中文输入法');
    await openFmt(page);
    await page.click('.fmt-rule input[data-rule="cjkSpace"]');
    await page.click('.fmt-ctrl button:has-text("存为方案")');
    await page.waitForSelector('.modal input.input');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'tou', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 229 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.waitForTimeout(200);
    check(!!(await page.$('.modal')) && !!(await page.$('.fmt-overlay')), '拼音没打完时按 Esc：输入框和预览都不关', fails);
    await cdp.send('Input.imeSetComposition', { text: '投稿', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 });
    await cdp.send('Input.insertText', { text: '投稿' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.waitForTimeout(200);
    check(!!(await page.$('.modal')), '选字时按回车不会提交', fails);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    check((await page.$eval('.fmt-scheme', (e) => e.value)) === '投稿' && !(await page.$('.modal')), '中文方案名存上了', fails);

    console.log('方案名带特殊字符、和自带方案同名');
    for (const name of ['<b>x</b>$&\\d+', '  默认  ']) {
      await page.click('.fmt-ctrl button:has-text("存为方案")');
      await page.fill('.modal input.input', name);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
    }
    const sc = await kv(page, 'format:schemes');
    check(sc.some((s) => s.name === '<b>x</b>$&\\d+') && !sc.some((s) => s.name.trim() === '默认'), '特殊字符方案名存上了；「默认」改不了', fails);
    check((await toastText(page)).includes('自带的方案'), '和自带方案同名时有提示', fails);
    check(!(await page.$('.fmt-scheme option b')), '下拉框里方案名当文字显示', fails);
    await closeToasts(page);

    console.log('删方案出错后「再试一次」');
    await page.selectOption('.fmt-scheme', '投稿');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.__put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (v) { if (this.name === 'kv' && v && v.key === 'format:schemes') throw new Error('QuotaExceededError（测试模拟）'); return window.__put.apply(this, arguments); };
    });
    await page.click('.fmt-del-scheme');
    await page.waitForSelector('.modal:has-text("方案没能删掉")');
    check((await page.$$eval('.modal-foot .btn', (b) => b.map((x) => x.textContent))).includes('再试一次'), '删不掉时出报错卡，带「再试一次」', fails);
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
    await page.click('.modal-foot .btn:has-text("再试一次")');
    await page.waitForTimeout(500);
    check(!(await page.$('.modal')) && !(await kv(page, 'format:schemes')).some((s) => s.name === '投稿'), '「再试一次」删的是方案（不会弹出存方案的输入框）', fails);
    check((await toastText(page)).includes('已删除方案「投稿」'), '删掉后出「已删除」提示条', fails);
    await page.click('.toast:has-text("已删除方案") .toast-act');
    await page.waitForTimeout(400);
    check((await kv(page, 'format:schemes')).some((s) => s.name === '投稿'), '撤销删除，方案回来了', fails);
    await page.keyboard.press('Escape');
    await closeToasts(page);

    console.log('写回出错');
    await setText(page, '甲,乙.');
    await page.waitForTimeout(1300);
    const o2 = await docText(page);
    await openFmt(page);
    await page.evaluate(() => {
      IDBObjectStore.prototype.put = function (v) { if (this.name === 'chapters') throw new Error('QuotaExceededError（测试模拟）'); return window.__put.apply(this, arguments); };
    });
    await page.click('.fmt-ok');
    await page.waitForSelector('.modal:has-text("排版没能全部写回")');
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
    const btns = await page.$$eval('.modal-foot .btn', (b) => b.map((x) => x.textContent));
    check(btns.includes('还原成排版前') && btns.includes('再试一次'), '写回出错：报错卡带「还原成排版前」「再试一次」', fails);
    await page.click('.modal-foot .btn:has-text("还原成排版前")');
    await page.waitForTimeout(1500);
    check((await docText(page)) === o2 && (await chaptersOf(page))[0] === o2, '「还原成排版前」：正文和存档都回到原样', fails);
    await page.$$eval('.modal-back', (els) => els.forEach((e) => e.remove()));
    await page.keyboard.press('Escape');
    const realErrors = errors.filter((e) => !/测试模拟/.test(e));
    check(realErrors.length === 0, '没有报错 ' + realErrors.join(' | '), fails);
    await browser.close();
  }

  // ===== 3. 连续操作后撤销 / 重做，跨章批量撤销 =====
  {
    const { browser, page, errors } = await launch(dist);
    console.log('连排两次再撤两次');
    await newBook(page, '撤销', [{ title: '', text: '甲,乙.\n丙--丁' }]);
    await page.waitForTimeout(300);
    const o = await docText(page);
    await openFmt(page);
    await commit(page);
    const f1 = await docText(page);
    await openFmt(page);
    await page.click('input[name="fmt-gap"][value="1"]');
    await commit(page);
    const f2 = await docText(page);
    check(f1 === want(o) && f2 === want(o, { paraGap: 1 }), '两次排版都写回了', fails);
    await ctrlZ(page);
    check((await docText(page)) === f1, '第一次 Ctrl+Z：回到第一次排版的样子', fails);
    await ctrlZ(page);
    check((await docText(page)) === o, '第二次 Ctrl+Z：回到原文', fails);
    await page.waitForTimeout(1200);
    check((await chaptersOf(page))[0] === o, '原文也存进去了', fails);
    await toolRedo(page);
    check((await docText(page)) === f1, '重做一次：第一次排版', fails);
    await toolRedo(page);
    check((await docText(page)) === f2, '再重做：第二次排版', fails);
    await ctrlZ(page);
    await ctrlZ(page);
    check((await docText(page)) === o, '重做后再撤两次还是原文', fails);
    await closeToasts(page);

    console.log('提示条撤销后再按 Ctrl+Z');
    await page.click('.cm-content');
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('戊');
    await page.waitForTimeout(900);
    const typed = await docText(page);
    await openFmt(page);
    await commit(page);
    await page.click('.toast:has-text("已排版") .toast-act');
    await page.waitForTimeout(500);
    check((await docText(page)) === typed, '提示条「撤销」还原', fails);
    await ctrlZ(page);
    check((await docText(page)) === o, '再按 Ctrl+Z 撤的是刚打的字，不会把排版改回来', fails);
    await closeToasts(page);

    console.log('排版后打字、输入法打字，再撤销');
    await openFmt(page);
    await commit(page);
    const f = await docText(page);
    await page.click('.cm-content');
    await page.keyboard.press('Control+End');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'de', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '的' });
    await page.waitForTimeout(900);
    check((await docText(page)) === f + '的', '输入法打进去一个字', fails);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
    check((await docText(page)) === f, '第一次 Ctrl+Z 撤掉刚打的字', fails);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(500);
    check((await docText(page)) === o, '第二次 Ctrl+Z 撤掉整次排版', fails);
    await closeToasts(page);
    check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
    await browser.close();
  }

  {
    const { browser, page, errors } = await launch(dist);
    console.log('跨章批量：一次撤销全部还原');
    const T = ['第一章的字 , 他说:"走."', '「第二章」--好...', '　　第三章已经很整齐。', '第四章\n\n\n没缩进.'];
    const bookId = await seedBook(page, '跨章', T.map((text, i) => ({ title: '章' + (i + 1), text })));
    await openFmt(page);
    await page.click('.fmt-seg [data-scope="book"]');
    await waitReady(page);
    check((await page.$$('.fmt-ch')).length === 3 && (await page.textContent('.fmt-same')).includes('1 章不用改'), '全书 4 章：列出 3 章要改', fails);
    await commit(page);
    const W = T.map((t) => want(t));
    let cs = await chaptersOf(page, bookId);
    check(cs.every((c, i) => c === W[i]), '4 章都写回（整齐的那章不动）', fails);
    check((await toastText(page)).includes('已排版 3 章'), '提示条：已排版 3 章', fails);
    await openChapter(page, 3);
    await ctrlZ(page);
    await page.waitForTimeout(500);
    cs = await chaptersOf(page, bookId);
    check(cs.every((c, i) => c === T[i]), '在别的章按一次 Ctrl+Z，所有章都还原', fails);
    await toolRedo(page);
    await page.waitForTimeout(500);
    cs = await chaptersOf(page, bookId);
    check(cs.every((c, i) => c === W[i]), '重做：所有章又排好', fails);
    await page.click('.topbar .icon-btn[aria-label="撤销"]');
    await page.waitForTimeout(800);
    cs = await chaptersOf(page, bookId);
    check(cs.every((c, i) => c === T[i]), '顶栏「撤销」按一次也全部还原', fails);
    await openChapter(page, 2);
    check((await docText(page)) === T[1], '切过去看，正文也是还原后的', fails);
    await closeToasts(page);

    console.log('预览开着时外面变了');
    await openChapter(page, 1);
    await page.click('.ch-item:nth-child(2)', { modifiers: ['Control'] });
    await page.waitForSelector('.sel-bar:not([hidden])');
    await page.click('.sel-bar button:has-text("排版这几章")');
    await waitReady(page);
    check((await page.$$('.fmt-ch')).length === 2, '多选两章：列出两章', fails);
    await page.click('.ch-item:nth-child(4)', { modifiers: ['Control'] });
    await page.waitForTimeout(400);
    await waitReady(page);
    check((await page.textContent('.fmt-seg [data-scope="selected"]')).includes('3') && (await page.$$('.fmt-ch')).length === 3, '再多选一章：范围变成 3 章，预览跟着变', fails);
    await page.click('.sel-bar button:has-text("取消选择")');
    await page.waitForTimeout(400);
    check(await page.getAttribute('.fmt-seg [data-scope="current"]', 'aria-pressed') === 'true' && !(await page.$('.fmt-seg [data-scope="selected"]')), '取消选择：范围回到本章', fails);
    await page.click('.fmt-seg [data-scope="book"]');
    await waitReady(page);
    await page.keyboard.press('Control+Enter');   // 预览开着时新建一章
    await page.waitForTimeout(800);
    check((await page.textContent('.fmt-seg [data-scope="book"]')).includes('5'), '新建一章后「全书」变成 5 章', fails);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
    await browser.close();
  }

  // ===== 4. 刷新后数据还在 =====
  {
    const { browser, page, errors } = await launch(dist);
    console.log('刷新页面');
    await newBook(page, '刷新', [{ title: '', text: '他说:"等等..."\n她--走了.' }]);
    await page.waitForTimeout(300);
    const o = await docText(page);
    await openFmt(page);
    await commit(page);
    await page.reload();
    await page.waitForSelector('.cm-content');
    await page.waitForTimeout(500);
    check((await docText(page)) === want(o) && (await chaptersOf(page))[0] === want(o), '写回后马上刷新，排好的正文还在', fails);
    await openFmt(page);
    await page.click('.fmt-rule input[data-rule="dash"]');
    await page.click('.fmt-ctrl button:has-text("存为方案")');
    await page.fill('.modal input.input', '不改破折号');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.waitForSelector('.cm-content');
    await openFmt(page);
    check(!!(await page.$('.fmt-scheme option[value="不改破折号"]')) && (await page.$eval('.fmt-scheme', (e) => e.value)) === '不改破折号', '刷新后方案还在，并且选着上次用的', fails);
    check(!(await page.$eval('.fmt-rule input[data-rule="dash"]', (e) => e.checked)), '刷新后记得上次的规则', fails);
    await page.selectOption('.fmt-scheme', '默认');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');

    console.log('「默认」方案的段间空行跟着作品设置');
    const bookId = await page.evaluate(() => location.hash.split('/')[2]);
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForSelector('.shelf');
    await page.evaluate((id) => new Promise((resolve) => {
      const req = indexedDB.open('xiaoemo-wenshu');
      req.onsuccess = () => {
        const t = req.result.transaction('books', 'readwrite');
        const os = t.objectStore('books');
        const g = os.get(id);
        g.onsuccess = () => { os.put({ ...g.result, paraGap: 1 }); };
        t.oncomplete = () => { req.result.close(); resolve(); };
      };
    }), bookId);
    await page.evaluate((id) => { location.hash = '#/book/' + id; }, bookId);
    await page.waitForSelector('.cm-content');
    await page.waitForTimeout(400);
    await openFmt(page);
    check(await page.$eval('input[name="fmt-gap"][value="1"]', (e) => e.checked) && (await page.$eval('.fmt-scheme', (e) => e.value)) === '默认',
      '作品改成空一行后，「默认」方案也空一行', fails);
    await page.keyboard.press('Escape');
    check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
    await browser.close();
  }

  // ===== 5. 十万字以上的长章、几十章的全书 =====
  {
    const { browser, page, errors } = await launch(dist);
    console.log('十万字一章');
    await newBook(page, '长章', [{ title: '', text: '' }]);
    const para = '他说:"等等..."林栀没有抬头,她看着窗外的雨(很大),心想--这回真的要走了.\n\n';
    const big = para.repeat(3000);
    await setDoc(page, big);
    await page.waitForTimeout(1500);
    let t0 = Date.now();
    await openFmt(page);
    await page.waitForSelector('.fmt-ok:not([disabled])', { timeout: 60000 });
    const tOpen = Date.now() - t0;
    check(tOpen < 4000, `${big.length} 字：打开预览 ${tOpen}ms`, fails);
    check(/要改 \d+ 处/.test(await page.textContent('.fmt-sum')) && (await page.textContent('.fmt-more')).includes('没列出来'), '改动太多时只列前面一部分，有说明', fails);
    check(await page.evaluate(() => document.querySelectorAll('.fmt-preview *').length) < 20000, '预览的元素数量有上限', fails);
    t0 = Date.now();
    await page.click('.fmt-rule input[data-rule="cjkSpace"]');
    await waitReady(page);
    await page.waitForSelector('.fmt-ok:not([disabled])');
    check(Date.now() - t0 < 4000, `改一条规则重新预览 ${Date.now() - t0}ms`, fails);
    await page.click('.fmt-rule input[data-rule="cjkSpace"]');
    await waitReady(page);
    t0 = Date.now();
    await commit(page);
    const tCommit = Date.now() - t0;
    check(tCommit < 8000 && (await docText(page)) === want(big), `写回 ${tCommit}ms，结果正确`, fails);
    check((await chaptersOf(page))[0] === want(big), '存进去的也是排好的', fails);
    t0 = Date.now();
    await ctrlZ(page);
    await page.waitForFunction((n) => document.querySelector('.cm-content').cmView.view.state.doc.length === n, big.length, { timeout: 30000 });
    const tUndo = Date.now() - t0;
    check(tUndo < 5000 && (await docText(page)) === big, `撤销 ${tUndo}ms，回到原文`, fails);
    await page.waitForTimeout(1300);
    check((await chaptersOf(page))[0] === big, '撤销后存进去的也是原文', fails);
    check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
    await browser.close();
  }
  {
    const { browser, page, errors } = await launch(dist);
    console.log('四十章的全书');
    const one = '他说:"等等..."林栀没有抬头,她看着窗外的雨,心想--这回真的要走了.\n'.repeat(160);
    const T = Array.from({ length: 40 }, (_, i) => `第${i + 1}章的开头.\n` + one);
    const bookId = await seedBook(page, '长书', T.map((text, i) => ({ title: '章' + (i + 1), text })));
    await openFmt(page);
    let t0 = Date.now();
    await page.click('.fmt-seg [data-scope="book"]');
    await waitReady(page);
    const tAll = Date.now() - t0;
    check((await page.$$('.fmt-ch')).length === 40 && tAll < 10000, `全书 40 章（${T.join('').length} 字）预览 ${tAll}ms`, fails);
    await page.click('.fmt-ch:nth-child(5) .fmt-ch-tog');
    check(await page.isVisible('.fmt-ch:nth-child(5) .fmt-ch-body .fmt-ins'), '第 5 章展开能看改动', fails);
    t0 = Date.now();
    await commit(page);
    check(Date.now() - t0 < 15000, `写回 40 章 ${Date.now() - t0}ms`, fails);
    let cs = await chaptersOf(page, bookId);
    check(cs.every((c, i) => c === want(T[i])), '40 章都排好了', fails);
    await page.click('.toast:has-text("已排版 40 章") .toast-act');
    await page.waitForTimeout(1500);
    cs = await chaptersOf(page, bookId);
    check(cs.every((c, i) => c === T[i]), '提示条撤销一次，40 章全部还原', fails);
    check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
    await browser.close();
  }

  // ===== 6. 小恶魔、找功能 =====
  {
    const { browser, page, errors } = await launch(dist);
    console.log('小恶魔接话、找功能');
    await newBook(page, '小恶魔', [{ title: '', text: '他说,好.' }]);
    await openFmt(page);
    await commit(page);
    await page.waitForTimeout(400);
    const said = await page.$eval('.demon .sr[role="status"]', (e) => e.textContent);
    check(formatLines.has(said), '写回后小恶魔接话：' + said, fails);
    await page.waitForTimeout(Math.min(4000, [...said].length * 60 + 400));
    const bubble = await page.$eval('.demon-bubble', (e) => ({ text: e.textContent, kids: e.children.length }));
    check(bubble.text === said && bubble.kids === 1, '对话框里只有台词，没有名字', fails);
    await page.keyboard.press('F1');
    await page.waitForSelector('.help-search');
    for (const q of ['排版', '标点', '省略号', '缩进', '全书']) {
      await page.fill('.help-search', q);
      const items = await page.$$eval('.help-item .help-t', (els) => els.map((e) => e.textContent));
      check(items.includes(q === '全书' ? '全书排版' : '一键排版'), `搜「${q}」能找到`, fails);
    }
    await page.fill('.help-search', '全书');
    await page.click('.help-item:has-text("全书排版")');
    await page.waitForSelector('.fmt-overlay');
    await waitReady(page);
    check(await page.getAttribute('.fmt-seg [data-scope="book"]', 'aria-pressed') === 'true', '从小恶魔那里点「全书排版」：范围是全书', fails);
    await page.keyboard.press('Escape');
    check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
    await browser.close();
  }

  // ===== 7. 深色模式、手机宽度 =====
  for (const [w, h] of [[1360, 860], [390, 844]]) {
    const { browser, page, errors } = await launch(dist, { width: w, height: h });
    console.log(`深色模式 ${w}px`);
    await page.emulateMedia({ colorScheme: 'dark' });
    const longTitle = '一个非常非常长的章节名字用来看看会不会把页面撑破'.repeat(2);
    const T = ['他说:"等等..."' + 'Supercalifragilisticexpialidocious_without_any_break_'.repeat(4) + '好.\n她--走了.', '「第二章」--好...'];
    await seedBook(page, '深色', T.map((text) => ({ title: longTitle, text })));
    await page.click('.tool-btn[data-cmd="format.open"]');
    await page.waitForSelector('.fmt-overlay');
    await page.click('.fmt-seg [data-scope="book"]');
    await waitReady(page);
    if (!(await page.$('.fmt-rules[open]'))) await page.click('.fmt-rules > summary');
    await page.click('.fmt-ch:first-child .fmt-ch-tog');
    await page.click('.fmt-ctrl button:has-text("存为方案")');
    await page.fill('.modal input.input', '一个特别长的方案名字'.repeat(6));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const vw = innerWidth, bad = [];
      for (const el of document.querySelectorAll('.fmt-overlay, .fmt-overlay *, .toast')) {
        const b = el.getBoundingClientRect();
        if (b.width && (b.right > vw + 1 || b.left < -1)) bad.push((el.className || el.tagName) + ':' + Math.round(b.right));
      }
      const css = (sel, p) => getComputedStyle(document.querySelector(sel))[p];
      return { bad: bad.slice(0, 6), doc: document.documentElement.scrollWidth, vw, bg: css('.fmt-overlay', 'backgroundColor'), ink: css('.fmt-overlay', 'color'),
        del: css('.fmt-del', 'color'), ins: css('.fmt-ins', 'color'), card: css('.fmt-ch', 'backgroundColor'), head: css('.fmt-head', 'backgroundColor') };
    });
    check(r.doc <= r.vw && !r.bad.length, `${w}px：长章名、长单词、长方案名都不撑破页面 ` + JSON.stringify(r.bad), fails);
    check(r.bg === 'rgb(27, 21, 29)' && r.ink === 'rgb(234, 221, 228)' && r.del === 'rgb(255, 143, 162)' && r.ins === 'rgb(127, 209, 168)'
      && r.card === 'rgb(30, 23, 32)' && r.head === 'rgb(34, 26, 37)', `${w}px 深色：底色、字色、红绿都是深色那套 ` + JSON.stringify(r), fails);
    await closeToasts(page);
    await page.click('.fmt-ok');
    await page.waitForSelector('.toast:has-text("已排版")');
    check((await chaptersOf(page)).filter((c) => c === want(T[0]) || c === want(T[1])).length === 2, `${w}px：写回两章`, fails);
    await page.click('.toast:has-text("已排版") .toast-act');
    await page.waitForTimeout(800);
    const back = await chaptersOf(page);
    check(back.includes(T[0]) && back.includes(T[1]), `${w}px：提示条撤销`, fails);
    check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
    await browser.close();
  }
}

(async () => {
  const fails = [];
  await unit(fails);
  if (!process.argv.includes('--unit')) await flows(process.argv[2] || path.join(__dirname, '../dist'), fails);
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
