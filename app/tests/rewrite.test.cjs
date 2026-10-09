// 选中调用：选中浮出工具栏 → 确认卡 → 结果在原地对比（并排 / 行内 / 按句）→ 逐句采用、两边直接改、选中一段单独采用、
// 再出一版（多栏）、暂存盒就地再对比 → 完成写回（一步撤销）；AI 标记、清除标记撤销；原文改过不写回；出错；草稿；手机宽度；六套风格形态。
//   node build.mjs --out /tmp/xemo2-rewrite && node tests/rewrite.test.cjs /tmp/xemo2-rewrite
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { launch, newBook, getText, check } = require('./helpers.cjs');

const L1 = '　　雨下到第三天。门铃响了。';
const L2 = '　　林栀没有抬头。她在写信。';

const view = (page, fn, arg) => page.evaluate(([src, a]) => {
  const v = document.querySelector('.cm-content').cmView.view;
  return new Function('v', 'a', src)(v, a);
}, [fn, arg]);
const docText = (page) => view(page, 'return v.state.doc.toString()');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用键盘选中第 n 行（作者的选择操作，会触发自动弹出） */
async function selectLine(page, n = 1) {
  await page.click('.cm-content');
  await page.keyboard.press('Control+Home');
  for (let i = 1; i < n; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
}
async function idb(page, fn) {
  return page.evaluate((src) => new Promise((res, rej) => {
    const r = indexedDB.open('xiaoemo-wenshu');
    r.onsuccess = () => { try { new Function('db', 'res', src)(r.result, res); } catch (e) { rej(e); } };
    r.onerror = () => rej(r.error);
  }), fn);
}
const counts = (page) => idb(page, `const t = db.transaction(['stash', 'usage']); const a = t.objectStore('stash').count(), b = t.objectStore('usage').count(); t.oncomplete = () => res([a.result, b.result]);`);
async function addPrompts(page, n) {
  await idb(page, `const t = db.transaction('prompts', 'readwrite'); const s = t.objectStore('prompts');
    for (let i = 0; i < ${n}; i++) s.put({ id: 'pr' + i, name: i === 0 ? '改紧凑' : '提示词' + i, group: '', text: i === 0 ? '把这段改得更紧凑：' : '第' + i + '条：', feature: '', order: i, uses: ${n} - i, pinned: false, createdAt: Date.now(), updatedAt: Date.now() });
    t.oncomplete = () => res(true);`);
}
async function waitResult(page) {
  await page.waitForSelector('.rw-panel');
  await page.waitForFunction(() => !document.querySelector('.rw-live') && document.querySelector('.rw-panel .rw-ok') && !document.querySelector('.rw-panel .rw-ok').disabled, null, { timeout: 10000 });
}
async function send(page) {
  await page.waitForSelector('.ai-card');
  await page.click('.modal-foot .btn.primary:has-text("发送")');
}

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await page.evaluate(() => localStorage.setItem('xemoMock', '1'));
  await page.reload(); await page.waitForSelector('.topbar');
  await newBook(page, '改写测试', [{ title: '开头', text: L1 + '\n' + L2 }]);

  // ---------- 没有提示词：工具栏只有「写一个提示词」 ----------
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar', { timeout: 3000 });
  const chips0 = await page.$$eval('.rw-bar .rw-chip', (a) => a.map((b) => b.textContent));
  check(chips0.length === 1 && chips0[0] === '写一个提示词', '没有提示词时只显示「写一个提示词」：' + chips0.join('|'), fails);
  // 工具栏不挡选区
  const cover = await page.evaluate(() => {
    const v = document.querySelector('.cm-content').cmView.view;
    const { from, to } = v.state.selection.main;
    const a = v.coordsAtPos(from), b = v.coordsAtPos(to, -1);
    const r = document.querySelector('.rw-bar').getBoundingClientRect();
    return r.bottom <= a.top + 1 || r.top >= b.bottom - 1;
  });
  check(cover, '工具栏不挡住选中的文字', fails);
  await page.keyboard.press('Escape');
  await sleep(150);
  check(!(await page.$('.rw-bar')), 'Esc 收起工具栏', fails);
  // 打字时不出来
  await page.keyboard.press('End');
  await page.keyboard.type('嗯');
  await sleep(900);
  check(!(await page.$('.rw-bar')), '打字时不出现工具栏', fails);
  await page.keyboard.press('Backspace');
  // 「写一个提示词」→ 提示词库弹窗（prompts 模块装好时）
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar');
  await page.click('.rw-bar .rw-write');
  const prModal = await page.waitForSelector('.modal', { timeout: 3000 }).catch(() => null);
  check(!!prModal, '「写一个提示词」打开提示词库弹窗', fails);
  if (prModal) { await page.keyboard.press('Escape'); await sleep(250); if (await page.$('.modal-back')) { await page.keyboard.press('Escape'); await sleep(250); } }

  // ---------- 有 8 个提示词：直接列 6 个，其余在「更多」 ----------
  await addPrompts(page, 8);
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar .rw-chip');
  const chips = await page.$$eval('.rw-bar .rw-bar-main .rw-chip', (a) => a.map((b) => b.textContent));
  check(chips.length === 8 && chips[0] === '改紧凑' && chips.includes('更多') && chips.includes('临时写一个'), '列 6 个提示词 + 更多 + 临时写一个：' + chips.join('|'), fails);
  await page.click('.rw-bar .rw-more');
  check((await page.$$('.rw-bar-menu .rw-menu-i')).length === 2, '「更多」里是剩下的 2 个', fails);

  // ---------- 第一次调用：就地接入 → 确认卡 → 流式进对比面板 ----------
  await page.click('.rw-bar .rw-chip:has-text("改紧凑")');
  await page.waitForSelector('.ai-setup-modal');
  await page.click('.ai-setup-modal .ai-prov[data-id="mock"]');
  await page.fill('.ai-steps input[type="password"]', 'good');
  await page.click('.ai-steps .btn:has-text("拉取模型列表")');
  await page.waitForSelector('.ai-status.ok');
  await page.click('.ai-steps .btn.primary:has-text("测试")');
  await page.waitForSelector('.ai-status.ok:has-text("接好了")');
  await send(page);
  await page.waitForSelector('.rw-panel .rw-live, .rw-panel .rw-cell', { timeout: 8000 });
  check(true, '结果流式进对比面板', fails);
  await waitResult(page);
  const inCenter = await page.evaluate(() => !!document.querySelector('.center > .rw-panel') && !document.querySelector('.modal-back'));
  check(inCenter, '对比面板在正文区里展开，没有弹新窗口', fails);
  const side = await page.$$eval('.rw-colh', (a) => a.map((x) => x.querySelector('.rw-colh-t').textContent));
  check(side.length === 2 && side[0] === '原文', '并排：左原文右 AI：' + side.join('|'), fails);
  check((await page.textContent('.rw-cell[data-src="0"] .rw-text')).includes('真的'), '右边是 AI 版本', fails);
  const [s1, u1] = await counts(page);
  check(s1 === 1 && u1 === 1, `进了暂存盒、记了账：${s1} 条 / ${u1} 笔`, fails);
  check(!!(await page.$('.ed-host .rw-src')), '正文里标出正在对比的原文', fails);

  // 按句：逐句采用 / 保留原文
  await page.click('.rw-seg button[data-view="sent"]');
  check((await page.$$('.rw-sent')).length === 2, '按句：两句有改动', fails);
  await page.click('.rw-sent >> nth=0 >> .rw-opt[data-src="-1"] .rw-pick');
  const sum1 = await page.textContent('.rw-sum');
  check(sum1.includes('采用 1') && sum1.includes('保留 1'), '逐句挑：' + sum1, fails);
  // 行内
  await page.click('.rw-seg button[data-view="inline"]');
  check(!!(await page.$('.rw-inline .rw-ins')) && !!(await page.$('.rw-inline .rw-iseg.off')), '行内：标出新增，没采用的句子单独标着', fails);
  // 完成 → 写回，一步撤销
  await page.click('.rw-ok');
  await page.waitForSelector('.rw-panel', { state: 'detached' });
  await sleep(400);
  let t = await docText(page);
  check(t.split('\n')[0] === '　　雨下到第三天。门铃响了，真的。', '完成：只把挑中的写回选中的那段：' + t.split('\n')[0], fails);
  check(t.split('\n')[1] === L2, '别的段落不动', fails);
  check(!!(await page.$('.cm-line.rw-ai-line')), 'AI 改过的段落留淡色标记', fails);
  await page.click('.cm-content');
  await page.keyboard.press('Control+z');
  await sleep(600);
  t = await docText(page);
  check(t === L1 + '\n' + L2, '按一次撤销全部还原', fails);
  check(!(await page.$('.cm-line.rw-ai-line')), '撤销后标记也没了', fails);

  // ---------- 再出一版：不弹确认卡，三栏对比，两边能直接改 ----------
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar .rw-chip');
  await page.click('.rw-bar .rw-chip:has-text("改紧凑")');
  await send(page);
  await waitResult(page);
  await page.click('.rw-seg button[data-view="side"]');
  await page.click('.rw-again');
  await sleep(250);
  check(!(await page.$('.ai-card')), '再出一版不再弹确认卡', fails);
  await waitResult(page);
  const cols = await page.$$eval('.rw-colh .rw-colh-t', (a) => a.map((x) => x.textContent));
  check(cols.length === 3 && cols[2] === '第 2 版', '多版并排：' + cols.join('|'), fails);
  // 在第 2 版里直接打字，然后直接点完成（改动先记下再写回）
  const cell = '.rw-cell[data-src="1"] .rw-text >> nth=0';
  await page.click(cell);
  await page.keyboard.press('Control+End');
  await page.keyboard.type('好');
  await page.click('.rw-ok');
  await page.waitForSelector('.rw-panel', { state: 'detached' });
  await sleep(300);
  t = await docText(page);
  check(t.split('\n')[0].endsWith('真的。好'), '在 AI 版本里直接改的字写回了：' + t.split('\n')[0], fails);
  await page.click('.cm-content'); await page.keyboard.press('Control+z'); await sleep(500);
  check((await docText(page)) === L1 + '\n' + L2, '撤销还原', fails);

  // ---------- 选中 AI 版本的一段单独采用 ----------
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar .rw-chip');
  await page.click('.rw-bar .rw-chip:has-text("改紧凑")');
  await send(page);
  await waitResult(page);
  await page.click('.rw-none');
  check((await page.textContent('.rw-sum')).includes('采用 0'), '全部放弃', fails);
  await page.evaluate(() => {
    const ins = document.querySelector('.rw-cell[data-src="0"] .rw-ins');
    const r = document.createRange(); r.selectNodeContents(ins);
    const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.waitForSelector('.rw-frag:not([hidden])', { timeout: 2000 });
  await page.click('.rw-frag');
  await page.click('.rw-ok');
  await page.waitForSelector('.rw-panel', { state: 'detached' });
  await sleep(300);
  t = await docText(page);
  check(t.split('\n')[0] === '　　雨下到第三天，真的。门铃响了。', '只采用了选中的那一小段：' + t.split('\n')[0], fails);
  await page.click('.cm-content'); await page.keyboard.press('Control+z'); await sleep(500);

  // ---------- 对比期间原文被改过：不写回 ----------
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar .rw-chip');
  await page.click('.rw-bar .rw-chip:has-text("改紧凑")');
  await send(page);
  await waitResult(page);
  await view(page, 'v.dispatch({ changes: { from: 4, insert: "乙" }, userEvent: "input" })');
  await page.click('.rw-ok');
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('改过了'), '原文改过：提示不写回', fails);
  await page.click('.modal-foot .btn:has-text("知道了")');
  t = await docText(page);
  check(!t.includes('真的') && t.includes('乙'), '正文没被覆盖', fails);
  await page.click('.rw-cancel');
  await sleep(300);
  check(!(await page.$('.rw-panel')), '取消：什么都不改，关掉面板', fails);
  await view(page, 'v.dispatch({ changes: { from: 4, to: 5 } })');

  // ---------- 改了一半关掉：保留草稿 → 接着上次 ----------
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar .rw-chip');
  await page.click('.rw-bar .rw-chip:has-text("改紧凑")');
  await send(page);
  await waitResult(page);
  await page.click('.rw-seg button[data-view="sent"]');
  await page.click('.rw-sent >> nth=1 >> .rw-opt[data-src="-1"] .rw-pick');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal:has-text("保留草稿")');
  await page.click('.modal-foot .btn:has-text("保留草稿")');
  await sleep(300);
  check(!(await page.$('.rw-panel')), '选「保留草稿」后关掉', fails);
  await selectLine(page, 2);
  await page.waitForSelector('.rw-bar .rw-resume');
  await page.click('.rw-bar .rw-resume');
  await page.waitForSelector('.rw-panel');
  check((await page.textContent('.rw-sum')).includes('采用 1') && (await page.textContent('.rw-sum')).includes('保留 1'), '接着上次：挑过的还在', fails);
  await page.click('.rw-ok');
  await page.waitForSelector('.rw-panel', { state: 'detached' });
  await sleep(300);
  t = await docText(page);
  check(t.split('\n')[0] === '　　雨下到第三天，真的。门铃响了。', '草稿接着做完写回：' + t.split('\n')[0], fails);

  // ---------- 清除 AI 标记（可撤销） ----------
  check(!!(await page.$('.cm-line.rw-ai-line')), '有 AI 标记', fails);
  await selectLine(page, 2);
  await page.waitForSelector('.rw-bar');
  await page.click('.rw-bar .rw-bar-opts');
  await page.click('.rw-bar-menu .rw-menu-i:has-text("清除 AI 标记")');
  await page.waitForSelector('.modal:has-text("清除 AI 标记")');
  await page.click('.modal-foot .btn:has-text("本章")');
  await sleep(300);
  check(!(await page.$('.cm-line.rw-ai-line')), '清除本章的 AI 标记', fails);
  await page.click('.toast:has-text("AI 标记") .toast-act:has-text("撤销")');
  await sleep(400);
  check(!!(await page.$('.cm-line.rw-ai-line')), '撤销后标记回来', fails);
  await page.click('.cm-content'); await page.keyboard.press('Control+z'); await sleep(500);

  // ---------- 关掉自动弹出：选中不弹，Ctrl+Shift+A / Ctrl+J 手动弹 ----------
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar');
  await page.click('.rw-bar .rw-bar-opts');
  await page.click('.rw-bar-menu label:has-text("选中时自动弹出")');
  await sleep(200);
  await page.keyboard.press('Escape');
  await sleep(150);
  if (await page.$('.rw-bar')) { await page.keyboard.press('Escape'); await sleep(150); }
  await selectLine(page, 2);
  await sleep(1000);
  check(!(await page.$('.rw-bar')), '关了自动弹出：选中不弹', fails);
  await page.keyboard.press('Control+Shift+A');
  await page.waitForSelector('.rw-bar', { timeout: 2000 }).catch(() => null);
  check(!!(await page.$('.rw-bar')), 'Ctrl+Shift+A 手动弹出', fails);
  await page.keyboard.press('Escape'); await sleep(150);
  await page.click('.cm-content'); await selectLine(page, 2);
  await page.keyboard.press('Control+j');
  await page.waitForSelector('.rw-bar', { timeout: 2000 }).catch(() => null);
  check(!!(await page.$('.rw-bar')), 'Ctrl+J 也是打开工具栏', fails);
  await page.click('.rw-bar .rw-bar-opts');
  await page.click('.rw-bar-menu label:has-text("选中时自动弹出")');
  const auto = await idb(page, `const q = db.transaction('kv').objectStore('kv').get('rewrite:auto'); q.onsuccess = () => res(q.result && q.result.value);`);
  check(auto === true, '开关存在 kv rewrite:auto', fails);
  await page.keyboard.press('Escape'); await sleep(150);

  // ---------- 鼠标拖选也会弹 ----------
  await page.click('.cm-content');
  const pts = await page.evaluate(() => {
    const v = document.querySelector('.cm-content').cmView.view;
    const line = v.state.doc.line(2);
    const a = v.coordsAtPos(line.from + 2), b = v.coordsAtPos(line.to - 1);
    return [a.left + 1, (a.top + a.bottom) / 2, b.right, (b.top + b.bottom) / 2];
  });
  await page.mouse.move(pts[0], pts[1]); await page.mouse.down(); await page.mouse.move(pts[2], pts[3], { steps: 6 });
  await sleep(400);
  check(!(await page.$('.rw-bar')), '按着鼠标拖选时不弹', fails);
  await page.mouse.up();
  await page.waitForSelector('.rw-bar', { timeout: 2000 }).catch(() => null);
  check(!!(await page.$('.rw-bar')), '鼠标松开后浮出工具栏', fails);

  // ---------- 暂存盒就地再对比 ----------
  const hasStash = await page.$('.rw-bar .rw-bar-stash');
  await page.click('.rw-bar .rw-bar-stash');
  const drawer = await page.waitForSelector('.stash-drawer', { timeout: 3000 }).catch(() => null);
  if (drawer) {
    await page.waitForSelector('.stash-drawer .stash-use', { timeout: 3000 }).catch(() => null);
    const n = (await page.$$('.stash-drawer .stash-use')).length;
    check(n >= 4, `暂存盒抽屉只列这一章的选中调用：${n} 条`, fails);
    await page.click('.stash-drawer .stash-use >> nth=0');
    await page.waitForSelector('.rw-panel');
    await page.click('.rw-seg button[data-view="side"]');
    check((await page.$$('.rw-colh')).length === 2 && (await page.textContent('.rw-panel .rw-body')).includes('真的'), '采用暂存盒里的一条：拿来再对比', fails);
    await page.click('.rw-panel .rw-stash');
    await page.waitForSelector('.stash-drawer .stash-use');
    await page.waitForSelector('.stash-drawer .stash-use >> nth=1');
    await page.click('.stash-drawer .stash-use >> nth=1');
    await sleep(300);
    check((await page.$$('.rw-colh')).length === 3, '对比面板里从暂存盒再加一版', fails);
    if (await page.$('.side-right .stash-drawer')) { await page.click('.side-right .panel-head .icon-btn[aria-label="关闭"]'); await sleep(200); }
    // 继续追问：对话模块装好时打开对话
    await page.click('.rw-panel .rw-ask');
    await sleep(400);
    check(errors.length === 0, '继续追问不报错', fails);
    if (await page.$('.modal-back')) { await page.keyboard.press('Escape'); await sleep(200); }
    while (await page.$('.side-right .panel-head .icon-btn[aria-label="关闭"]')) { await page.click('.side-right .panel-head .icon-btn[aria-label="关闭"]'); await sleep(200); if (await page.$('.modal:has-text("保留草稿")')) await page.click('.modal-foot .btn:has-text("丢弃")'); }
    await page.click('.rw-cancel');
    if (await page.$('.modal:has-text("保留草稿")')) await page.click('.modal-foot .btn:has-text("丢弃")');
    await sleep(300);
  } else {
    check(!!hasStash, '暂存盒按钮在（抽屉模块还没装好）', fails);
  }

  // ---------- 临时写一个 + 出错 ----------
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar .rw-temp');
  await page.click('.rw-bar .rw-temp');
  await page.waitForSelector('.ai-card');
  await page.waitForFunction(() => document.querySelector('.ai-card select[aria-label="提示词"]').value === '__temp', null, { timeout: 2000 }).catch(() => null);
  check(await page.$eval('.ai-card select[aria-label="提示词"]', (s) => s.value === '__temp'), '临时写一个：确认卡里直接是「临时写一个」', fails);
  await page.fill('.ai-card textarea', '【报错】');
  await page.click('.modal-foot .btn.primary:has-text("发送")');
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('故意出错') && !!(await page.$('.modal-foot .btn:has-text("重试")')), '出错：中文说明 + 重试', fails);
  await page.keyboard.press('Escape');
  await sleep(300);
  check(!(await page.$('.rw-panel')), '出错后不留空的对比面板', fails);

  // ---------- 六套风格：形态不一样 ----------
  await selectLine(page, 1);
  await page.waitForSelector('.rw-bar .rw-chip');
  await page.click('.rw-bar .rw-chip:has-text("改紧凑")');
  await send(page);
  await waitResult(page);
  await page.click('.rw-seg button[data-view="side"]');
  const looks = await page.evaluate(() => {
    const root = document.documentElement, keep = root.dataset.paper;
    const out = {};
    for (const p of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
      root.dataset.paper = p;
      const panel = getComputedStyle(document.querySelector('.rw-panel'));
      const mark = getComputedStyle(document.querySelector('.rw-title'), '::before').content;
      const take = getComputedStyle(document.querySelector('.rw-take'));
      out[p] = [panel.borderTopLeftRadius, panel.clipPath, panel.borderTopWidth, panel.borderTopStyle, mark, take.borderTopLeftRadius, take.clipPath].join('|');
    }
    root.dataset.paper = keep;
    return out;
  });
  const sigs = new Set(Object.values(looks));
  check(sigs.size === 6, '六套风格的面板形态各不相同（' + sigs.size + ' 种）', fails);
  const marks = new Set(Object.values(looks).map((s) => s.split('|')[4]));
  check(marks.size === 6, '标题前的小标记六套不同', fails);
  // 深色
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const dark = await page.evaluate(() => {
    const c = getComputedStyle(document.querySelector('.rw-cell')).backgroundColor.match(/[\d.]+/g).map(Number);
    const ink = getComputedStyle(document.querySelector('.rw-text')).color.match(/[\d.]+/g).map(Number);
    return [(c[0] + c[1] + c[2]) / 3, (ink[0] + ink[1] + ink[2]) / 3];
  });
  check(dark[0] < 90 && dark[1] > 150, '深色模式：底深字浅 ' + dark.map(Math.round).join('/'), fails);
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.click('.rw-cancel');
  await sleep(300);
  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();

  // ---------- 手机宽度 390 ----------
  {
    const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    const ctx = await b.newContext({ viewport: { width: 390, height: 780 }, reducedMotion: 'reduce', hasTouch: false });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('file://' + require('path').resolve(dist) + '/index.html');
    await p.waitForSelector('.topbar');
    await p.evaluate(() => localStorage.setItem('xemoMock', '1'));
    await p.reload(); await p.waitForSelector('.topbar');
    await newBook(p, '手机', [{ title: '', text: L1 + '\n' + L2 }]);
    await idb(p, `const t = db.transaction(['kv', 'prompts'], 'readwrite');
      t.objectStore('kv').put({ key: 'ai:config', value: { providers: { mock: { key: 'good', models: [{ id: 'mock-small', name: 'mock-small' }], testModel: 'mock-small', ok: true } }, prices: {}, cheap: null } });
      t.objectStore('prompts').put({ id: 'p1', name: '改紧凑', group: '', text: '改紧凑：', feature: '', order: 1, uses: 0, pinned: false });
      t.oncomplete = () => res(true);`);
    await selectLine(p, 1);
    await p.waitForSelector('.rw-bar .rw-chip', { timeout: 3000 });
    const barOk = await p.evaluate(() => { const r = document.querySelector('.rw-bar').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
    check(barOk, '手机：工具栏在屏幕里', fails);
    await p.click('.rw-bar .rw-chip:has-text("改紧凑")');
    await send(p);
    await waitResult(p);
    for (const v of ['side', 'inline', 'sent']) {
      await p.click(`.rw-seg button[data-view="${v}"]`);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      const pr = await p.evaluate(() => { const r = document.querySelector('.rw-panel').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; });
      check(over <= 0 && pr, `手机：${v} 视图不横向溢出`, fails);
    }
    await p.click('.rw-ok');
    await p.waitForSelector('.rw-panel', { state: 'detached' });
    check((await getText(p)).includes('真的'), '手机：完成写回', fails);
    check(errs.length === 0, '手机：没有报错 ' + errs.join(' | '), fails);
    await b.close();
  }
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
