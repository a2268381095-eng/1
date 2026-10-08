// 查找、替换、筛选：先跑纯函数单元测试，再在浏览器里走一遍主要流程和撤销。
//   node build.mjs --out /tmp/xemo-search && node tests/search.test.cjs /tmp/xemo-search
const path = require('path');
const { pathToFileURL } = require('url');
const { launch, newBook, getText, check } = require('./helpers.cjs');

async function unit(fails) {
  console.log('单元测试（engine.js）');
  const E = await import(pathToFileURL(path.join(__dirname, '../src/features/search/engine.js')).href);
  const find = (text, q, o = {}) => { const m = E.buildMatcher(q, o); return m.error ? m : E.findAll(text, m.re, o).map((x) => [x.from, x.to]); };

  check(JSON.stringify(find('林栀和林栀', '林栀')) === '[[0,2],[3,5]]', '普通查找找到两处', fails);
  check(find('a.b axb', 'a.b').length === 1, '普通模式里的 . 按字面找', fails);
  check(find('Tom Tomas tom', 'tom').length === 3, '默认不区分大小写', fails);
  check(find('Tom Tomas tom', 'tom', { caseSensitive: true }).length === 1, '区分大小写', fails);
  check(JSON.stringify(find('Tom Tomas atom', 'tom', { wholeWord: true })) === '[[0,3]]', '全字匹配只认整个词', fails);
  check(find('林栀没有抬头', '林栀', { wholeWord: true }).length === 1, '全字匹配不影响中文', fails);
  check(JSON.stringify(find('aab ab', 'ab', { wholeWord: true })) === '[[4,6]]', '全字匹配跳过一处后还能接着找', fails);
  check(find('第一章 第二章 第十章', '第.章', { regex: true }).length === 3, '正则查找', fails);
  check(find('ab', 'x*', { regex: true }).length === 0, '正则空匹配不会死循环', fails);
  check(find('😀a😀a', '(?:)', { regex: true }).length === 0, '空匹配遇到表情字符也不会卡住', fails);
  check(find('段一\n段二', '^段', { regex: true }).length === 2, '^ 匹配每段开头', fails);
  for (const [bad, word] of [['(abc', '括号'], ['abc)', ')'], ['[abc', '方括号'], ['*a', '前面要有'], ['a{2,1}', '数'], ['\\', '反斜杠']]) {
    let r;
    try { r = E.buildMatcher(bad, { regex: true }); } catch (e) { r = { thrown: e }; }
    check(r.error && /[一-龥]/.test(r.error) && r.error.includes(word), `正则写错给中文提示：${bad} → ${r.error || r.thrown}`, fails);
  }
  check(!E.buildMatcher('(abc', {}).error, '普通模式下括号不算错', fails);
  check(E.buildMatcher('\\p{Script=Han}+', { regex: true }).re.test('中文'), '正则支持 \\p{…}', fails);

  const m = E.buildMatcher('第(.)章', { regex: true });
  const hits = E.findAll('第一章和第二章', m.re);
  check(E.replaceHits('第一章和第二章', hits, '第$1回', { regex: true }) === '第一回和第二回', '正则替换支持 $1', fails);
  check(E.replaceHits('第一章和第二章', hits, '$&!', { regex: true }) === '第一章!和第二章!', '正则替换支持 $&', fails);
  check(E.replaceHits('第一章和第二章', hits, '$$1', { regex: true }) === '$1和$1', '$$ 是美元符号本身', fails);
  check(E.replaceHits('第一章和第二章', hits, '$1', {}) === '$1和$1', '普通模式不展开 $1', fails);
  const named = E.findAll('2024-10', E.buildMatcher('(?<y>\\d+)-(?<m>\\d+)', { regex: true }).re);
  check(E.replaceHits('2024-10', named, '$<m>/$<y>', { regex: true }) === '10/2024', '命名分组 $<名字>', fails);
  check(E.replaceHits('abcabc', [{ from: 3, to: 4, m: ['a'] }], 'X') === 'abcXbc', '只换勾选的那一处', fails);

  const ctx = E.contextOf('　　前面的文字很长很长很长很长很长林栀后面的字也很长很长很长很长\n下一段', 17, 19, 6);
  check(ctx.before === '…很长很长很长' && ctx.match === '林栀' && ctx.after === '后面的字也很…', '上下文：前后各几个字，截断加省略号', fails);
  check(E.contextOf('　　林栀来了', 2, 4).before === '', '上下文：段首缩进去掉', fails);
  check(!E.contextOf('上一段\n林栀', 4, 6).before.includes('上一段'), '上下文不跨段', fails);

  const chs = [{ id: 'a', points: [{ done: false }], words: 100 }, { id: 'b', points: [{ done: true }], words: 5000 }, { id: 'c', points: [], words: 10 }];
  const pass = (f) => chs.filter((c) => E.chapterPasses(c, f, c.words)).map((c) => c.id).join('');
  check(pass({ pointsOpen: true }) === 'a', '筛选：要点没打完', fails);
  check(pass({ wordsOn: true, maxWords: 200 }) === 'ac', '筛选：字数少于', fails);
  check(pass({ pointsOpen: true, wordsOn: true, maxWords: 50 }) === '', '筛选：条件同时满足', fails);
  check(pass({ wordsOn: false, maxWords: 50 }) === 'abc', '没勾的条件不算', fails);
  const list = [{ id: 'a', volumeId: 'v1' }, { id: 'b', volumeId: 'v2' }, { id: 'c' }];
  const sc = (s, o) => E.chaptersInScope(list, s, o).map((c) => c.id).join('');
  check(sc('cur', { currentId: 'b' }) === 'b' && sc('sel', { selectedIds: ['c', 'a'] }) === 'ac' && sc('vol:v2') === 'b' && sc('vol:') === 'c' && sc('book') === 'abc', '范围：本章 / 选中 / 某一卷 / 全书', fails);
  const map = E.makeMapper('林栀在门外，林栀', '他说林栀在门外，林栀');
  check(map(6) === 8, '正文改过以后位置跟着走', fails);
  check(E.describe({ query: '林栀', filter: { pointsOpen: true, wordsOn: true, maxWords: 2000 } }) === '「林栀」 + 要点没打完 + 少于 2000 字', '常用筛选的默认名字', fails);
}

// 浏览器里读数据库：这本书每章的正文（按顺序）
const contents = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const bookId = location.hash.split('/')[2];
  const r = indexedDB.open('xiaoemo-wenshu');
  r.onerror = () => reject(r.error);
  r.onsuccess = () => {
    const q = r.result.transaction('chapters').objectStore('chapters').getAll();
    q.onsuccess = () => { resolve(q.result.filter((c) => c.bookId === bookId).sort((a, b) => a.order - b.order).map((c) => c.content)); r.result.close(); };
  };
}));
const editorSel = (page) => page.evaluate(() => {
  const el = document.querySelector('.cm-editor .cm-content');
  const v = el && el.cmView && el.cmView.view;
  if (v) { const r = v.state.selection.main; return v.state.sliceDoc(r.from, r.to); }
  return '';
});
const curTitle = (page) => page.inputValue('.ch-title');
const sum = (page) => page.textContent('.sr-sum');
const wait = (page, ms = 450) => page.waitForTimeout(ms);
const press = (page, k) => page.keyboard.press(k);

async function e2e(dist, fails) {
  console.log('浏览器测试');
  const { browser, page, errors } = await launch(dist);
  try {
    await newBook(page, '查找测试', [
      { title: '门铃', text: '　　雨下到第三天，林栀没有抬头。\n　　林栀听见门铃。Tom 和 Tomas 在门外。' },
      { title: '旧信', text: '　　林栀拆开旧信，写着第一章的事。' },
      { title: '空白', text: '　　短。' },
    ]);

    // ---- 打开、查找、范围 ----
    await page.click('.cm-content');
    await press(page, 'Control+f');
    await page.waitForSelector('.sr-panel .sr-q');
    check(await page.isVisible('.side-right .sr-panel'), 'Ctrl+F 在右侧栏打开查找面板', fails);
    await wait(page, 300);
    check(await page.evaluate(() => document.activeElement.classList.contains('sr-q')), '查找框自动聚焦', fails);
    check((await page.textContent('.demon [role=status]')).includes('Ctrl+F'), '第一次用时小恶魔说明一句', fails);
    check(await page.isVisible('.side-right .panel-head button[aria-label="关闭"]'), '面板右上角有关闭按钮', fails);
    check((await page.getAttribute('.sr-seg[aria-pressed="true"]', 'aria-pressed')) === 'true' && (await page.textContent('.sr-seg[aria-pressed="true"]')) === '本章', '默认范围是本章', fails);
    await page.fill('.sr-q', '林栀');
    await wait(page);
    check((await sum(page)).includes('没找到') && (await page.textContent('.sr-list')).includes('试试「全书」'), '本章没有时提示换范围', fails);
    await page.click('.sr-seg:has-text("全书")');
    await wait(page);
    check((await sum(page)).includes('共 3 处 · 2 章'), '全书：按章分组，共 3 处 2 章', fails);
    check((await page.$$('.sr-group')).length === 2 && (await page.textContent('.sr-group .sr-gt')).includes('第一章 门铃'), '分组标题是章名', fails);
    check((await page.textContent('.sr-hit .sr-go')).includes('雨下到第三天，林栀没有抬头'), '每条显示前后的字', fails);

    // ---- 点击跳转、高亮 ----
    await page.click('.sr-hit >> nth=1');
    await wait(page, 300);
    check((await curTitle(page)) === '门铃', '点结果跳到那一章', fails);
    check((await editorSel(page)) === '林栀', '正文里选中那一处', fails);
    check((await page.$$('.cm-find-cur')).length === 1 && (await page.$$('.cm-content .cm-find')).length === 1, '当前这一处 cm-find-cur，其余 cm-find', fails);
    check((await page.textContent('.sr-count')) === '2/3', '计数显示第几处', fails);
    await page.focus('.sr-q');
    await press(page, 'Enter');
    await wait(page, 300);
    check((await curTitle(page)) === '旧信' && (await page.textContent('.sr-count')) === '3/3', '回车跳到下一处（跨章）', fails);
    await press(page, 'Shift+Enter');
    await wait(page, 300);
    check((await curTitle(page)) === '门铃' && (await page.textContent('.sr-count')) === '2/3', 'Shift+回车回到上一处', fails);
    await page.focus('.sr-hit >> nth=1 >> .sr-go');
    await press(page, 'ArrowDown');
    await wait(page, 300);
    check((await page.textContent('.sr-count')) === '3/3' && await page.evaluate(() => !!document.activeElement.closest('.sr-hit.cur')), '结果列表里按 ↓ 走到下一条，焦点跟着', fails);
    await press(page, 'ArrowUp');
    await wait(page, 300);
    check((await page.textContent('.sr-count')) === '2/3' && (await curTitle(page)) === '门铃', '按 ↑ 回到上一条', fails);

    // ---- 区分大小写、全字匹配、正则 ----
    await page.fill('.sr-q', 'tom');
    await wait(page);
    check((await sum(page)).includes('共 2 处'), '默认不区分大小写：tom 找到 Tom、Tomas', fails);
    await page.click('.sr-opt[data-k="wholeWord"]');
    await wait(page);
    check((await sum(page)).includes('共 1 处'), '全字匹配：只剩 Tom', fails);
    await page.click('.sr-opt[data-k="caseSensitive"]');
    await wait(page);
    check((await sum(page)).includes('没找到'), '区分大小写：tom 找不到 Tom', fails);
    await page.click('.sr-opt[data-k="caseSensitive"]');
    await page.click('.sr-opt[data-k="wholeWord"]');
    check(!(await page.isVisible('.sr-opt[data-k="regex"]')), '正则默认藏在「高级」里', fails);
    await page.click('.sr-fold[data-k="advanced"]');
    await page.click('.sr-opt[data-k="regex"]');
    await page.fill('.sr-q', '第(.)章');
    await wait(page);
    check((await sum(page)).includes('共 1 处'), '正则：第(.)章', fails);
    await page.fill('.sr-q', '林栀(没');
    await wait(page);
    check(await page.isVisible('.sr-err') && (await page.textContent('.sr-err')).includes('括号没配对'), '正则写错：面板里中文提示', fails);
    check(errors.length === 0, '正则写错不抛异常', fails);

    // ---- 正则替换：$1，整体撤销 ----
    await page.fill('.sr-q', '第(.)章');
    await press(page, 'Control+h');
    await page.waitForSelector('.sr-r', { state: 'visible' });
    await page.fill('.sr-r', '第$1回');
    await wait(page);
    check((await page.textContent('.sr-hit .sr-ins')) === '第一回', '替换预览：$1 展开', fails);
    await page.click('.sr-all');
    await wait(page, 600);
    check((await contents(page))[1].includes('写着第一回的事'), '正则全部替换写进正文', fails);
    await page.click('.toast-act:has-text("撤销")');
    await wait(page, 600);
    check((await contents(page))[1].includes('写着第一章的事'), '提示条上的撤销还原', fails);
    await page.click('.sr-fold[data-k="advanced"]');
    check((await page.getAttribute('.sr-opt[data-k="regex"]', 'aria-pressed')) === 'false', '收起「高级」时关掉正则', fails);

    // ---- 全书替换：逐条勾选、算一步撤销 ----
    await page.fill('.sr-q', '林栀');
    await page.fill('.sr-r', '林夏');
    await wait(page);
    check((await page.$$('.sr-hit .sr-cb input')).length === 3, '替换前列出每一处，带勾选', fails);
    await page.click('.sr-hit >> nth=0 >> .sr-cb input');
    check((await page.textContent('.sr-all')).includes('（2）'), '取消勾选一处，全部替换（2）', fails);
    check(await page.evaluate(() => document.querySelector('.sr-gh input').indeterminate), '这一章标题上的勾显示部分选中', fails);
    await page.click('.sr-all');
    await wait(page, 700);
    let c = await contents(page);
    check(c[0].includes('林栀没有抬头') && c[0].includes('林夏听见门铃') && c[1].includes('林夏拆开旧信'), '只替换勾选的 2 处，跨两章', fails);
    check((await page.textContent('.toasts')).includes('已替换 2 处'), '替换后出提示条', fails);
    check((await page.textContent('.sr-done')).includes('已替换 2 处'), '面板里也有「已替换 · 撤销」', fails);
    await page.click('.ws .topbar button[aria-label="撤销"]');
    await wait(page, 700);
    c = await contents(page);
    check(c[0].includes('林栀听见门铃') && c[1].includes('林栀拆开旧信'), '顶栏撤销一次，两章一起还原', fails);
    check((await sum(page)).includes('共 3 处'), '撤销后结果刷新', fails);
    await page.click('.ws .topbar button[aria-label="重做"]');
    await wait(page, 700);
    c = await contents(page);
    check(c[0].includes('林夏听见门铃') && c[1].includes('林夏拆开旧信'), '重做', fails);
    await page.click('.ws .topbar button[aria-label="撤销"]');
    await wait(page, 700);

    // ---- 一边改正文：勾选状态跟着位置走 ----
    await page.click('.sr-hit >> nth=1 >> .sr-cb input');
    await page.click('.cm-content');
    await press(page, 'Control+Home');
    await page.keyboard.insertText('新加的字');
    await wait(page, 1700);
    check(JSON.stringify(await page.$$eval('.sr-hit .sr-cb input', (els) => els.map((e) => e.checked))) === '[true,false,true]', '正文改了以后结果刷新，勾选跟着走', fails);
    check((await page.textContent('.sr-hit .sr-go')).includes('新加的字'), '结果里的上下文也更新了', fails);
    await press(page, 'Control+z');
    await wait(page, 1500);
    check(!(await getText(page)).includes('新加的字'), '编辑器里撤销打的字', fails);

    // ---- 编辑器里 Ctrl+Z 整体撤销全书替换 ----
    await page.click('.sr-sum button:has-text("全选")');
    await page.click('.sr-all');
    await wait(page, 700);
    c = await contents(page);
    check(!c[0].includes('林栀') && c[1].includes('林夏拆开旧信'), '全选后全部替换 3 处', fails);
    await page.click('.cm-content');
    await press(page, 'Control+z');
    await wait(page, 700);
    c = await contents(page);
    check(c[0].includes('林栀没有抬头') && c[0].includes('林栀听见门铃') && c[1].includes('林栀拆开旧信'), '正文里按 Ctrl+Z 一次，全书替换整体还原', fails);

    // ---- 逐个替换 ----
    await page.fill('.sr-q', 'Tomas');
    await page.fill('.sr-r', '托马斯');
    await wait(page);
    await page.click('.sr-rep button:has-text("替换这一处")');
    await wait(page, 300);
    check((await page.textContent('.sr-count')) === '1/1', '第一次按「替换这一处」先跳过去', fails);
    await page.click('.sr-rep button:has-text("替换这一处")');
    await wait(page, 700);
    check((await getText(page)).includes('Tom 和 托马斯'), '再按一次换掉这一处', fails);
    await page.click('.sr-done button:has-text("撤销")');
    await wait(page, 700);
    check((await getText(page)).includes('Tom 和 Tomas'), '面板里的撤销还原', fails);

    // ---- 改了一半关闭：保留草稿 / 丢弃 ----
    await page.fill('.sr-r', '半截');
    await page.focus('.sr-q');
    await press(page, 'Escape');
    await page.waitForSelector('.modal:has-text("里面还有没保存的内容")');
    check(true, '替换内容没用就关：先问保留草稿还是丢弃', fails);
    await page.click('.modal-foot .btn:has-text("保留草稿")');
    await wait(page, 300);
    check(!(await page.isVisible('.sr-panel')), '选完关掉面板', fails);
    check((await page.$$('.cm-find, .cm-find-cur')).length === 0, '关掉后正文高亮清掉', fails);
    await press(page, 'Control+h');
    await page.waitForSelector('.sr-r');
    check((await page.inputValue('.sr-r')) === '半截', '保留草稿：再打开还在', fails);
    await press(page, 'Escape');
    await page.click('.modal-foot .btn:has-text("丢弃")');
    await wait(page, 300);
    await press(page, 'Control+h');
    await page.waitForSelector('.sr-r');
    check((await page.inputValue('.sr-r')) === '', '丢弃：替换框清空', fails);
    await page.fill('.sr-r', '');
    await page.click('.side-right .panel-head button[aria-label="关闭"]');
    await wait(page, 200);
    check(!(await page.isVisible('.sr-panel')), '× 关闭面板', fails);

    // ---- 正文里选着字时 Ctrl+F 直接拿来找 ----
    await page.evaluate(() => { const v = document.querySelector('.cm-content').cmView.view; v.dispatch({ selection: { anchor: 2, head: 4 } }); v.focus(); });
    await press(page, 'Control+f');
    await page.waitForSelector('.sr-q');
    await wait(page, 300);
    check((await page.inputValue('.sr-q')) === '雨下' && (await sum(page)).includes('共 1 处'), '选着的字带进查找框', fails);
    await press(page, 'Escape');

    // ---- 选中的几章 ----
    await page.click('.ch-item >> nth=2', { modifiers: ['Control'] });
    await press(page, 'Control+f');
    await page.waitForSelector('.sr-q');
    await page.hover('.sr-top');
    check(await page.isVisible('.sr-seg:has-text("选中的 2 章")'), '范围里出现「选中的 2 章」', fails);
    await page.click('.sr-seg:has-text("选中的 2 章")');
    await page.fill('.sr-q', '林栀');
    await wait(page);
    check((await sum(page)).includes('共 2 处 · 1 章'), '只在选中的章里找', fails);
    await page.click('.sel-bar button:has-text("取消选择")');
    await page.hover('.sr-top');
    await wait(page);
    check(!(await page.isVisible('.sr-seg:has-text("选中")')), '取消选择后范围回到本章', fails);

    // ---- 筛选：要点没打完、字数少于；常用筛选 ----
    await press(page, 'Escape');
    await page.click('.ch-item >> nth=1');
    await wait(page, 300);
    await page.fill('.pt-add', '埋下旧信的伏笔');
    await press(page, 'Enter');
    await wait(page, 300);
    await press(page, 'Control+Shift+F');
    await page.waitForSelector('.sr-q');
    check((await page.textContent('.sr-seg[aria-pressed="true"]')) === '全书', 'Ctrl+Shift+F 范围是全书', fails);
    await page.fill('.sr-q', '');
    await page.click('.sr-fold[data-k="showFilter"]');
    await page.check('.sr-filter label:has-text("要点没打完") input');
    await wait(page);
    check((await page.$$('.sr-ch')).length === 1 && (await page.textContent('.sr-ch')).includes('旧信'), '筛出要点没打完的章', fails);
    await page.uncheck('.sr-filter label:has-text("要点没打完") input');
    await page.fill('.sr-num', '10');
    await wait(page);
    check((await page.getAttribute('.sr-fold[data-k="showFilter"]', 'class')).includes('on') && (await page.isChecked('.sr-filter label:has-text("字数少于") input')), '填了字数自动勾上', fails);
    check((await page.$$('.sr-ch')).length === 1 && (await page.textContent('.sr-ch')).includes('空白'), '筛出字数少于 10 的章', fails);
    await page.fill('.sr-q', '林栀');
    await wait(page);
    check((await sum(page)).includes('没找到'), '有筛选时只在符合的章里找', fails);
    await page.fill('.sr-q', '');
    await page.click('.sr-save');
    await page.waitForSelector('.modal input.input');
    await page.fill('.modal input.input', '短章');
    await page.click('.modal-foot .btn.primary');
    await wait(page, 300);
    check((await page.textContent('.sr-presets')).includes('短章'), '筛选条件存成常用', fails);
    await page.uncheck('.sr-filter label:has-text("字数少于") input');
    await wait(page);
    await page.click('.sr-chip-b:has-text("短章")');
    await wait(page);
    check((await page.isChecked('.sr-filter label:has-text("字数少于") input')) && (await page.$$('.sr-ch')).length === 1, '点一下常用筛选就套用', fails);
    await page.click('.sr-chip-x');
    await wait(page, 300);
    check(!(await page.textContent('.sr-presets')).includes('短章') && (await page.textContent('.toasts')).includes('已删除「短章」'), '删除常用筛选出「已删除 · 撤销」', fails);
    await page.click('.toast:has-text("已删除「短章」") .toast-act');
    await wait(page, 300);
    check((await page.textContent('.sr-presets')).includes('短章'), '撤销删除', fails);
    await page.click('.sr-ch');
    await wait(page, 300);
    check((await curTitle(page)) === '空白', '点筛出的章打开它', fails);

    // ---- 分卷：某一卷 ----
    await press(page, 'Escape');
    await page.click('button[aria-label="章节更多操作"]');
    await page.click('.menu-item:has-text("分卷")');
    await wait(page, 400);
    await press(page, 'Control+f');
    await page.waitForSelector('.sr-q');
    check(await page.isVisible('.sr-seg:has-text("某一卷")'), '作品分卷后出现「某一卷」', fails);
    await page.click('.sr-seg:has-text("某一卷")');
    await page.fill('.sr-q', '林栀');
    await page.uncheck('.sr-filter label:has-text("字数少于") input').catch(() => {});
    await wait(page);
    check(await page.isVisible('select.sr-vol') && (await sum(page)).includes('共 3 处'), '按卷找', fails);

    // ---- 找功能能搜到 ----
    await press(page, 'Escape');
    await press(page, 'F1');
    await page.fill('.help-search', '批量替换');
    await wait(page, 200);
    check((await page.textContent('.help-list')).includes('替换'), '问小恶魔能搜到「替换」', fails);
    await page.fill('.help-search', '要点没打完');
    await wait(page, 200);
    check((await page.textContent('.help-list')).includes('筛选章节'), '问小恶魔能搜到「筛选章节」', fails);
    await press(page, 'Escape');

    // ---- 刷新后常用筛选还在；离开作品时面板关掉不报错 ----
    await page.reload();
    await page.waitForSelector('.cm-content');
    await wait(page, 400);
    await page.click('.tool-btn[data-cmd="search.open"]');
    await page.waitForSelector('.sr-q');
    await page.click('.sr-fold[data-k="showFilter"]');
    check((await page.textContent('.sr-presets')).includes('短章'), '常用筛选按作品存住了', fails);
    await page.fill('.sr-q', '林栀');
    await page.click('.sr-seg:has-text("全书")');
    await wait(page);
    await page.click('.sr-hit >> nth=0');
    await page.click('.ws .topbar button[aria-label="返回"]');
    await page.waitForSelector('.shelf');
    await wait(page, 300);
    check(errors.length === 0, '开着面板返回书架不报错 ' + errors.join(' | '), fails);
    await page.goForward();
    await page.waitForSelector('.cm-content');
    await wait(page, 400);
    check(!(await page.isVisible('.sr-panel')) && (await page.$$('.cm-find, .cm-find-cur')).length === 0, '回来时面板关着，没有残留高亮', fails);

    // ---- 深色模式 ----
    await page.emulateMedia({ colorScheme: 'dark' });
    await press(page, 'Control+Shift+F');
    await page.waitForSelector('.sr-q');
    await page.fill('.sr-q', '林栀');
    await wait(page);
    const dark = await page.evaluate(() => {
      const lum = (s) => { const [r, g, b] = s.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      return { panel: lum(getComputedStyle(document.querySelector('.side-right')).backgroundColor), input: lum(getComputedStyle(document.querySelector('.sr-q')).backgroundColor),
        mark: getComputedStyle(document.querySelector('.sr-m')).backgroundColor, text: lum(getComputedStyle(document.querySelector('.sr-gt')).color) };
    });
    check(dark.panel < 0.2 && dark.input < 0.2 && dark.text > 0.6 && dark.mark !== 'rgb(255, 229, 138)', '深色模式颜色跟着变 ' + JSON.stringify(dark), fails);
    await page.emulateMedia({ colorScheme: 'light' });

    // ---- 手机宽度 ----
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(page, 300);
    const box = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, panel: r('.side-right'), center: r('.center'),
        q: r('.sr-q'), wide: [...document.querySelectorAll('.sr-panel *')].filter((e) => e.getBoundingClientRect().right > 391).map((e) => e.className).slice(0, 5) };
    });
    check(box.panel.width > 300 && box.panel.height > 200 && box.panel.left >= 0 && box.panel.right <= 390, '手机：面板看得见 ' + JSON.stringify(box.panel), fails);
    check(box.sw <= 390 && box.bw <= 390 && !box.wide.length, '手机：没有横向溢出 ' + JSON.stringify(box.wide), fails);
    check(box.center.height > 150 && box.center.bottom <= box.panel.top + 1, '手机：正文在上面，面板不挡正文', fails);
    check(!(await page.isVisible('.demon-canvas')), '手机：面板开着时小恶魔让开，不挡按钮', fails);
    await page.click('.sr-hit >> nth=1');
    await wait(page, 300);
    check((await page.$$('.cm-find-cur')).length === 1, '手机：点结果能跳过去', fails);
    await page.click('.side-right .panel-head button[aria-label="关闭"]');
    await wait(page, 200);
    check(!(await page.isVisible('.sr-panel')), '手机：能关掉面板', fails);
    check(await page.isVisible('.demon-canvas'), '手机：关掉面板小恶魔回来', fails);
    await page.setViewportSize({ width: 1360, height: 860 });

    // ---- 专注模式里按 Ctrl+F：先退出专注模式 ----
    await page.click('.cm-content');
    await press(page, 'F11');
    await wait(page, 200);
    await press(page, 'Control+f');
    await wait(page, 300);
    check(await page.isVisible('.sr-panel .sr-q') && !(await page.$('.ws.focus')), '专注模式里打开查找：退出专注，面板看得见', fails);
    await press(page, 'Escape');

    check(errors.length === 0, '没有页面报错 ' + errors.join(' | '), fails);
  } catch (e) {
    fails.push('异常：' + e.message);
    console.log('  ✗ 异常：' + e.stack);
    try { await page.screenshot({ path: path.join(require('os').tmpdir(), 'search-test-fail.png') }); } catch (_) { /* 截图失败不管 */ }
  }
  await browser.close();
}

(async () => {
  const dist = process.argv[2] || path.join(__dirname, '../dist');
  const fails = [];
  await unit(fails);
  await e2e(dist, fails);
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
