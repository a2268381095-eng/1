// 提示词库：独立界面、新建（变量按钮）、草稿、编辑 / 复制 / 删除 / 固定 / 拖动排序 / 分组改名（都能撤销）、搜索、
// 导出导入（重复跳过、坏文件报错）、确认卡里「管理提示词库」弹窗、按用得多少排、窄屏、深色、六套风格形态不同
const { launch, newBook, check } = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xemo-prompts-'));
  await page.evaluate(() => localStorage.setItem('xemoMock', '1'));
  await page.reload(); await page.waitForSelector('.topbar');

  const rows = () => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('xiaoemo-wenshu');
    r.onsuccess = () => { const q = r.result.transaction('prompts').objectStore('prompts').getAll(); q.onsuccess = () => res(q.result); };
  }));
  const kv = (key) => page.evaluate((key) => new Promise((res) => {
    const r = indexedDB.open('xiaoemo-wenshu');
    r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result ? q.result.value : null); };
  }), key);
  const names = (sel = '') => page.$$eval(sel + ' .pr-item .pr-open', (els) => els.map((e) => e.textContent));
  const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const undoToast = async (text) => { await page.click(`.toast:has-text("${text}") .toast-act`); await page.waitForTimeout(350); };
  const save = async () => { await page.click('.pr-form-modal .modal-foot .btn.primary'); await page.waitForSelector('.pr-form-modal', { state: 'detached' }); await page.waitForTimeout(250); };
  const mk = async (name, group, text, root = '') => {
    await page.click(root + ' .pr-new');
    await page.waitForSelector('.pr-form');
    if (name) await page.fill('.pr-f-name', name);
    if (group) await page.fill('.pr-f-group', group);
    await page.fill('.pr-f-text', text);
    await save();
  };
  const layerCount = () => page.$$eval('.modal-back', (els) => els.length);

  // ---------- 从「你想做什么？」打开 ----------
  await page.keyboard.press('F1');
  await page.waitForSelector('.help-search');
  await page.fill('.help-search', '提示词');
  await page.waitForTimeout(150);
  const helpItems = await page.$$eval('.help-item .help-t', (els) => els.map((e) => e.textContent));
  check(helpItems.includes('提示词库') && helpItems.includes('新建提示词'), '命令表里能搜到：' + helpItems.slice(0, 4).join('、'), fails);
  await page.click('.help-item:has-text("提示词库")');
  await page.waitForSelector('.pr-empty');
  check((await page.textContent('.pr-empty')).includes('软件不带提示词，写一个自己的'), '空的时候说明「软件不带提示词」', fails);
  check(await page.$('.pr-view .topbar .icon-btn[aria-label="返回"]') !== null, '左上角有返回', fails);
  check((await rows()).length === 0, '软件没有内置任何提示词', fails);

  // ---------- 新建：变量按钮、悬停说明 ----------
  await page.click('.pr-empty .btn.primary');
  await page.waitForSelector('.pr-form');
  check((await page.$$('.pr-var')).length >= 8, '正文旁边一排变量按钮', fails);
  await page.fill('.pr-f-name', '紧凑');
  await page.fill('.pr-f-group', '改写');
  await page.fill('.pr-f-text', '把这段改得紧凑：');
  await page.click('.pr-var[data-var="选中文本"]');
  check((await page.inputValue('.pr-f-text')) === '把这段改得紧凑：{选中文本}', '点变量插入到光标处', fails);
  await page.hover('.pr-var[data-var="本章要点"]');
  check((await page.textContent('.pr-var-hint')).includes('右侧栏的本章要点'), '悬停说明变量的意思', fails);
  check((await page.textContent('.pr-used')).includes('{选中文本}'), '下面列出用到的变量', fails);
  await save();
  let all = await rows();
  check(all.length === 1 && all[0].name === '紧凑' && all[0].group === '改写' && all[0].text.endsWith('{选中文本}'), '保存进库', fails);
  check(await page.$('.pr-group[data-group="改写"] .pr-item') !== null, '按分组列出', fails);
  await clearToasts();

  // ---------- 草稿：保留 / 丢弃 ----------
  await page.click('.pr-new');
  await page.waitForSelector('.pr-form');
  await page.fill('.pr-f-text', '写了一半');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-foot .btn:has-text("保留草稿")');
  await page.click('.modal-foot .btn:has-text("保留草稿")');
  await page.waitForTimeout(300);
  check((await layerCount()) === 0 && ((await kv('prompts:draft:new')) || {}).text === '写了一半', '关闭前问，选「保留草稿」存进 kv', fails);
  await page.click('.pr-new');
  await page.waitForSelector('.pr-form');
  check(await page.$('.pr-draft') !== null && (await page.inputValue('.pr-f-text')) === '写了一半', '再打开接着草稿写', fails);
  await page.click('.pr-form-modal .modal-x');
  await page.waitForSelector('.modal-foot .btn:has-text("丢弃")');
  await page.click('.modal-foot .btn:has-text("丢弃")');
  await page.waitForTimeout(300);
  check((await kv('prompts:draft:new')) === null && (await rows()).length === 1, '选「丢弃」草稿删掉，库里没多东西', fails);
  await page.click('.pr-new');
  await page.waitForSelector('.pr-form');
  check((await page.inputValue('.pr-f-text')) === '' && await page.$('.pr-draft') === null, '丢弃后再打开是空的', fails);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check((await layerCount()) === 0, '没改过的直接关掉', fails);

  // ---------- 再写几条：没起名用第一行 ----------
  await mk('接着写', '续写', '参考 {本章要点}，接着写：{选中文本}');
  await mk('', '改写', '换成第一人称\n{选中文本}');
  await mk('起名', '', '给这一章起三个名字。{章名} {乱写的变量}');
  await mk('乙', '比较', '乙：{选中文本}');
  await mk('甲', '比较', '甲：{选中文本}');
  await clearToasts();
  const groups = await page.$$eval('.pr-group-t', (els) => els.map((e) => e.textContent));
  check(groups.join() === '比较,改写,续写,未分组', '分组按名字排，未分组在最后：' + groups.join('、'), fails);
  check((await names()).includes('换成第一人称'), '没起名字时用正文第一行', fails);
  check(await page.$('.pr-item:has-text("起名") .pr-v.unk') !== null, '不认识的变量标出来', fails);

  // ---------- 编辑 + 撤销 ----------
  const qiming = (await rows()).find((p) => p.name === '起名');
  await page.click('.pr-item:has-text("起名") .pr-open');
  await page.waitForSelector('.pr-form');
  await page.fill('.pr-f-text', '给这一章起五个名字。{章名}');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.pr-form-modal', { state: 'detached' });
  await page.waitForTimeout(300);
  check(((await rows()).find((p) => p.id === qiming.id) || {}).text === '给这一章起五个名字。{章名}', '编辑后保存（Ctrl+Enter）', fails);
  await undoToast('已保存「起名」');
  check(((await rows()).find((p) => p.id === qiming.id) || {}).text === qiming.text, '撤销编辑', fails);

  // ---------- 复制 + 撤销 ----------
  await page.click('.pr-item:has-text("紧凑") [data-act="copy"]');
  await page.waitForTimeout(350);
  check((await names()).includes('紧凑（副本）'), '复制一份叫「紧凑（副本）」', fails);
  await undoToast('已复制一份');
  check(!(await names()).includes('紧凑（副本）') && (await rows()).length === 6, '撤销复制', fails);

  // ---------- 删除 + 撤销 ----------
  await page.click('.pr-item:has-text("起名") [data-act="del"]');
  await page.waitForTimeout(400);
  check(!(await names()).includes('起名') && !(await rows()).some((p) => p.id === qiming.id), '删除', fails);
  check(await page.$('.toast:has-text("已删除「起名」") .toast-act:has-text("撤销")') !== null, '删除后出「已删除 · 撤销」提示条', fails);
  await undoToast('已删除「起名」');
  const back = (await rows()).find((p) => p.id === qiming.id);
  check(back && back.text === qiming.text && back.createdAt === qiming.createdAt, '撤销删除，原样回来', fails);
  await clearToasts();

  // ---------- 固定、拖动调顺序、撤销 ----------
  await page.click('.pr-item:has-text("紧凑") [data-act="pin"]');
  await page.waitForTimeout(300);
  await page.click('.pr-item:has-text("换成第一人称") [data-act="pin"]');
  await page.waitForTimeout(350);
  const pinsSel = '.pr-group[data-group="改写"] .pr-pins';
  check((await names(pinsSel)).join() === '紧凑,换成第一人称', '固定的按固定先后排：' + (await names(pinsSel)).join(), fails);
  const h2 = await (await page.$(pinsSel + ' .pr-item:nth-child(2) .pr-drag')).boundingBox();
  const i1 = await (await page.$(pinsSel + ' .pr-item:nth-child(1)')).boundingBox();
  await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
  await page.mouse.down();
  await page.mouse.move(h2.x + h2.width / 2, i1.y + 6, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  check((await names(pinsSel)).join() === '换成第一人称,紧凑', '拖动调顺序', fails);
  const pinOrder = (await rows()).filter((p) => p.pinned).sort((a, b) => a.order - b.order).map((p) => p.name).join();
  check(pinOrder === '换成第一人称,紧凑', '顺序存进库里', fails);
  await clearToasts();
  await page.focus(pinsSel + ' .pr-item:nth-child(1) .pr-drag');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  check((await names(pinsSel)).join() === '紧凑,换成第一人称', 'Ctrl+Z 撤销顺序', fails);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(400);
  check((await names(pinsSel)).join() === '换成第一人称,紧凑', 'Ctrl+Shift+Z 重做', fails);
  await page.focus(pinsSel + ' .pr-item:nth-child(1) .pr-drag');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  check((await names(pinsSel)).join() === '紧凑,换成第一人称', '键盘 ↓ 也能调顺序', fails);
  check(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('pr-drag')), '调完焦点还在把手上', fails);
  await page.click('.pr-undo');
  await page.waitForTimeout(350);
  check((await names(pinsSel)).join() === '换成第一人称,紧凑', '顶上的撤销按钮', fails);
  await clearToasts();

  // ---------- 搜索 ----------
  await page.fill('.pr-search', '第一人称');
  await page.waitForTimeout(150);
  check((await names()).join() === '换成第一人称' && await page.$('.pr-hit') !== null, '搜索并标出命中的字', fails);
  check(await page.$eval('.pr-item .pr-drag', (b) => b.disabled), '搜索时不能拖动', fails);
  await page.fill('.pr-search', '没有这个词');
  await page.waitForTimeout(150);
  check((await page.textContent('.pr-list')).includes('没有找到'), '没找到时说明', fails);
  await page.click('.pr-nohit .btn');
  check((await names()).length === 6, '清空搜索', fails);

  // ---------- 分组改名 + 撤销 ----------
  await page.click('.pr-group[data-group="续写"] .pr-group-rename');
  await page.waitForSelector('.modal input.input');
  await page.fill('.modal input.input', '写作');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check(await page.$('.pr-group[data-group="写作"]') !== null && await page.$('.pr-group[data-group="续写"]') === null, '分组改名', fails);
  await undoToast('已改成「写作」');
  check(await page.$('.pr-group[data-group="续写"]') !== null, '撤销分组改名', fails);
  await clearToasts();

  // ---------- 导出 ----------
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.pr-export')]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(/^提示词库-\d{8}\.json$/.test(dl.suggestedFilename()) && data.kind === 'prompts' && data.prompts.length === 6, '导出成 .json：' + dl.suggestedFilename(), fails);

  // ---------- 导入 ----------
  await page.setInputFiles('.pr-file', file);
  await page.waitForTimeout(400);
  check((await page.textContent('.toasts')).includes('没有新的提示词：6 条都已经在库里了') && (await rows()).length === 6, '同名同内容的跳过', fails);
  await clearToasts();
  const more = path.join(tmp, 'more.json');
  fs.writeFileSync(more, JSON.stringify({ prompts: [...data.prompts, { name: '新来的', group: '导入', text: '导入的正文 {书名}', pinned: true }, { name: '空的', text: '' }] }));
  await page.setInputFiles('.pr-file', more);
  await page.waitForTimeout(500);
  const it = await page.textContent('.toasts');
  check(it.includes('导入了 1 条，跳过 6 条重复，1 条没有正文，没导入') && (await rows()).length === 7, '导入并说清导入了几条：' + it.replace(/撤销/g, ''), fails);
  check((await rows()).find((p) => p.name === '新来的').uses === 0, '导入的从 0 次开始算', fails);
  await undoToast('导入了 1 条');
  check((await rows()).length === 6 && !(await names()).includes('新来的'), '撤销导入（整批一步）', fails);
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ 这不是 json');
  await page.setInputFiles('.pr-file', bad);
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('这个文件读不出来'), '坏文件用中文说明', fails);
  await page.keyboard.press('Escape');
  fs.writeFileSync(bad, '{"books": []}');
  await page.setInputFiles('.pr-file', bad);
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('这个文件里没有提示词'), '没有提示词的文件也说明', fails);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await clearToasts();

  // ---------- 确认卡里「管理提示词库」：在当前界面弹窗管理，关掉回到确认卡 ----------
  await page.click('.pr-view .topbar .icon-btn[aria-label="返回"]');
  await page.waitForSelector('.shelf');
  await newBook(page, '提示词测试', [{ title: '开头', text: '　　雨下到第三天。门铃响了。' }]);
  await page.click('.cm-content');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+j');
  await page.waitForSelector('.ai-setup-modal');
  await page.click('.ai-setup-modal .ai-prov[data-id="mock"]');
  await page.fill('.ai-steps input[type="password"]', 'good');
  await page.click('.ai-steps .btn:has-text("拉取模型列表")');
  await page.waitForSelector('.ai-status.ok');
  await page.click('.ai-steps .btn.primary:has-text("测试")');
  await page.waitForSelector('.ai-card', { timeout: 8000 });
  const hashBefore = await page.evaluate(() => location.hash);
  await page.click('.ai-card .btn:has-text("管理提示词库")');
  await page.waitForSelector('.pr-modal .pr-item');
  check((await page.evaluate(() => location.hash)) === hashBefore && (await page.textContent('.pr-modal .modal-title')).includes('选中调用'), '在当前界面上弹窗，不跳走', fails);
  await mk('弹窗里写的', '比较', '丙：{选中文本}', '.pr-modal');
  check(await page.$('.pr-modal .pr-item:has-text("弹窗里写的") .pr-feat') !== null, '弹窗里新建的记上是哪个功能用的', fails);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pr-modal', { state: 'detached' });
  await page.waitForTimeout(300);
  const opts = await page.$$eval('.ai-card select[aria-label="提示词"] option', (els) => els.map((e) => e.textContent));
  check(await page.$('.ai-card') !== null && opts.includes('比较 / 弹窗里写的'), '关掉弹窗回到确认卡，下拉框里有新写的', fails);
  await page.selectOption('.ai-card select[aria-label="提示词"]', { label: '比较 / 乙' });
  await page.waitForTimeout(150);
  check((await page.textContent('.ai-card .ai-full pre')).includes('乙：') && (await page.textContent('.ai-card .ai-full pre')).includes('门铃响了'), '发送时 {选中文本} 自动填入', fails);
  await page.click('.modal-foot .btn.primary:has-text("发送")');
  for (let i = 0; i < 40; i++) { if (((await rows()).find((p) => p.name === '乙') || {}).uses === 1) break; await page.waitForTimeout(200); }
  check(((await rows()).find((p) => p.name === '乙') || {}).uses === 1, '用过一次记下来', fails);
  await page.waitForTimeout(600);
  for (let i = 0; i < 4 && (await layerCount()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }

  // ---------- 按用得多少排 ----------
  await page.evaluate(() => { location.hash = '#/prompts'; });
  await page.waitForSelector('.pr-item');
  await page.waitForTimeout(300);
  const cmp = await names('.pr-group[data-group="比较"] .pr-autos');
  check(cmp[0] === '乙', '按用得多少排（乙用过一次排最前）：' + cmp.join(), fails);
  check((await page.textContent('.pr-item:has-text("乙") .pr-uses')) === '用过 1 次' && await page.$('.pr-item:has-text("乙") .pr-heat i.on') !== null, '显示用过几次', fails);

  // ---------- 六套风格：形态不同 ----------
  const sig = await page.evaluate(async () => {
    const r = document.documentElement;
    const keep = { paper: r.dataset.paper, motion: r.dataset.motion, palette: r.getAttribute('data-palette') };
    const out = {};
    for (const p of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
      r.dataset.paper = p; r.dataset.motion = 'full';
      if (p === 'magical') r.removeAttribute('data-palette'); else r.setAttribute('data-palette', p);
      const item = document.querySelector('.pr-item.pinned');
      const cs = getComputedStyle(item);
      const mark = getComputedStyle(document.querySelector('.pr-group-t'), '::before');
      const btn = getComputedStyle(document.querySelector('.pr-new'));
      item.classList.add('pr-in');
      const anim = getComputedStyle(item).animationName;
      item.classList.remove('pr-in');
      out[p] = {
        card: [cs.borderTopLeftRadius, cs.clipPath, cs.borderLeftStyle, cs.borderTopStyle, cs.borderTopWidth].join(' '),
        mark: [mark.content, mark.width, mark.backgroundColor, mark.rotate].join(' '),
        btn: [btn.borderTopLeftRadius, btn.boxShadow, btn.clipPath].join(' '),
        anim,
        pin: [getComputedStyle(item, '::after'), getComputedStyle(item.querySelector('.pr-head'), '::after')]
          .map((x) => [x.content, x.width, x.height, x.borderTopStyle, x.backgroundImage, x.backgroundColor].join(' ')).join(' | '),
        heat: (() => { const x = getComputedStyle(item.querySelector('.pr-heat i')); return [x.clipPath, x.width, x.height, x.borderTopLeftRadius].join(' '); })(),
      };
    }
    r.dataset.paper = keep.paper; r.dataset.motion = keep.motion;
    if (keep.palette) r.setAttribute('data-palette', keep.palette); else r.removeAttribute('data-palette');
    return out;
  });
  for (const k of ['card', 'mark', 'btn', 'anim', 'pin', 'heat']) {
    const vals = Object.values(sig).map((s) => s[k]);
    check(new Set(vals).size === 6, `六套风格的「${k}」各不相同`, fails);
  }

  // ---------- 窄屏 390 ----------
  await page.setViewportSize({ width: 390, height: 820 });
  await page.waitForTimeout(300);
  const ov = await page.evaluate(() => {
    const m = document.querySelector('.pr-main');
    const wide = [...document.querySelectorAll('.pr-root *')].filter((e) => e.getBoundingClientRect().right > 391 && e.getClientRects().length);
    return { doc: document.documentElement.scrollWidth, main: m.scrollWidth - m.clientWidth, wide: wide.map((e) => e.className).slice(0, 3) };
  });
  check(ov.doc <= 390 && ov.main <= 0 && !ov.wide.length, '390px 宽不横向溢出 ' + JSON.stringify(ov), fails);
  await page.click('.pr-item:has-text("接着写") .pr-open');
  await page.waitForSelector('.pr-form');
  const ovm = await page.evaluate(() => {
    const b = document.querySelector('.pr-form-modal .modal-body');
    return { right: document.querySelector('.pr-form-modal').getBoundingClientRect().right, body: b.scrollWidth - b.clientWidth };
  });
  check(ovm.right <= 390 && ovm.body <= 0, '编辑弹窗在窄屏不溢出', fails);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('F1');
  await page.waitForSelector('.help-search');
  await page.fill('.help-search', '管理提示词库');
  await page.waitForTimeout(150);
  await page.click('.help-item:has-text("管理提示词库")');
  await page.waitForSelector('.pr-modal .pr-item');
  const ovp = await page.evaluate(() => {
    const b = document.querySelector('.pr-modal .modal-body');
    return { right: document.querySelector('.pr-modal').getBoundingClientRect().right, body: b.scrollWidth - b.clientWidth };
  });
  check(ovp.right <= 390 && ovp.body <= 0, '管理弹窗在窄屏不溢出', fails);
  await page.click('.pr-modal .modal-x');
  await page.waitForTimeout(200);
  await page.setViewportSize({ width: 1360, height: 860 });

  // ---------- 深色 ----------
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  const dark = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const k = c.startsWith('color(') ? 1 : 255; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / k; };
    const it = document.querySelector('.pr-item');
    const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const probe = document.createElement('i'); probe.style.color = v('--surface'); document.body.append(probe);
    const bg = lum(getComputedStyle(probe).color); probe.remove();
    return { bg, ink: lum(getComputedStyle(it.querySelector('.pr-name')).color), theme: document.documentElement.dataset.theme };
  });
  check(dark.bg < 0.35 && dark.ink > 0.6, '深色模式：底深字浅 ' + JSON.stringify(dark), fails);
  await page.emulateMedia({ colorScheme: 'light' });

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
