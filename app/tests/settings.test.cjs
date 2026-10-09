// 设置：纯函数的单元测试（node 直接跑）+ 浏览器里的流程测试（Playwright）
//   node build.mjs --out /tmp/xemo-settings && node tests/settings.test.cjs /tmp/xemo-settings
//   只跑单元测试：node tests/settings.test.cjs --unit
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { launch, newBook, getText, chapterList, check } = require('./helpers.cjs');

const load = (f) => import(pathToFileURL(path.join(__dirname, '../src/features/settings', f)).href);

// ---------------- 单元测试 ----------------
async function unit(fails) {
  const T = await load('logic.js');
  console.log('字体');
  const opts = T.fontOptions([{ id: 'uf1', name: '我的楷书' }]);
  check(opts.length === 9 && opts[8].id === 'uf1' && opts[8].custom && opts[8].stack.startsWith('"uf1"'), '内置 8 种 + 上传的，上传的用 id 当字体名', fails);
  check(opts.map((o) => o.id).slice(0, 8).join() === 'system,serif,sans,kai,yozai,xiaolai,xiaowei,kuaile', '内置字体 id（原来的 system/serif/sans/kai/kuaile 都还在）', fails);
  const names = Object.fromEntries(T.FONT_CHOICES.map((o) => [o.id, o.name]));
  check(names.kai === '霞鹜文楷' && names.yozai === '悠哉字体' && names.xiaolai === '小赖字体' && names.xiaowei === '站酷小薇', '新加霞鹜文楷、悠哉、小赖、站酷小薇（「kai」换成打包的霞鹜文楷）', fails);
  const bundled = T.FONT_CHOICES.filter((o) => o.file);
  const fontDir = path.join(__dirname, '../assets/fonts');
  check(bundled.length === 4 && bundled.every((o) => o.stack.startsWith('"' + o.family + '"') && fs.existsSync(path.join(fontDir, o.file))),
    '打包的四个字体：字体栈第一个就是它，woff2 在 assets/fonts/', fails);
  check(bundled.every((o) => fs.existsSync(path.join(fontDir, o.file.replace(/\.woff2$/, '-OFL.txt')))), '每个字体旁边放着 OFL 许可证', fails);
  const css = fs.readFileSync(path.join(__dirname, '../src/styles/fonts.css'), 'utf8');
  check(bundled.every((o) => css.includes(`font-family: "${o.family}"; src: url("fonts/${o.file}") format("woff2")`)) && (css.match(/font-display: swap/g) || []).length === 4,
    'fonts.css 给每个字体写了 @font-face（fonts/ 相对路径、font-display: swap）', fails);
  check(T.fontStack('kai').startsWith('"LXGW WenKai"') && T.fontStack('system') === T.FONT_CHOICES[0].stack && T.fontStack('uf1').startsWith('"uf1", '), 'fontStack：内置的取字体栈，不认识的当作上传的字体名', fails);
  const fi = T.fontFileInfo('霞鹜_文楷.TTF');
  check(fi.ok && fi.ext === 'ttf' && fi.name === '霞鹜 文楷', '文件名：扩展名不分大小写，名字去掉扩展名', fails);
  check(T.fontFileInfo('a.woff2').ok && T.fontFileInfo('b.otf').ok && !T.fontFileInfo('c.txt').ok && !T.fontFileInfo('无扩展名').ok, '只认 ttf/otf/woff/woff2', fails);
  check(T.uniqueName('楷书', ['楷书', '楷书 2']) === '楷书 3' && T.uniqueName('宋', ['楷书']) === '宋', '重名加编号', fails);
  check(T.fmtSize(500) === '500 B' && T.fmtSize(2048) === '2 KB' && T.fmtSize(3.4 * 1024 * 1024) === '3.4 MB', '文件大小', fails);

  console.log('设置值');
  const src = { a: 1, keys: { x: 'Mod-k' } };
  const p = T.pick(src, ['a', 'keys', 'none']);
  src.keys.x = 'Mod-j';
  check(p.a === 1 && p.keys.x === 'Mod-k' && 'none' in p, 'pick 复制一份，后来的改动不影响', fails);
  check(T.same({ a: [1] }, { a: [1] }) && !T.same({ a: 1 }, { a: 2 }), 'same', fails);
  const defaults = { theme: 'auto', uiFont: 'system', textFont: 'serif', textSize: 18, lineHeight: 1.9, textWidth: 720, hoverDelay: 500, keys: {}, themeNames: false };
  check(T.same(T.resetPatch('look', defaults), { theme: 'auto', uiFont: 'system', textFont: 'serif', textSize: 18, lineHeight: 1.9, textWidth: 720 }), '外观恢复默认只动外观几项', fails);
  check(T.same(T.resetPatch('shelf', defaults), { hoverDelay: 500 }) && T.same(T.resetPatch('keys', defaults), { keys: {} }), '书架、快捷键恢复默认', fails);
  check(T.clampNum(17.4, 14, 30, 1) === 17 && T.clampNum(99, 14, 30, 1) === 30 && T.clampNum(2.04, 1.4, 2.6, 0.1) === 2 && T.clampNum('x', 0, 1) === null, '数字限定范围、按步长取整', fails);

  console.log('快捷键');
  check(T.parseKey('Mod-Shift-f').key === 'f' && T.parseKey('Mod--').key === '-' && T.parseKey('Mod--').mods.join() === 'Mod', '拆开组合键（减号键）', fails);
  check(T.checkKey('Mod-Shift-k') === '' && T.checkKey('Alt-1') === '' && T.checkKey('F5') === '' && T.checkKey('Shift-F3') === '', '能用的：Ctrl+Shift+K、Alt+1、F5、Shift+F3', fails);
  check(T.checkKey('a').includes('Ctrl') && T.checkKey('Shift-a').includes('Ctrl'), '单按字母、Shift+字母：要带上 Ctrl 或 Alt', fails);
  check(T.checkKey('Mod-Shift').includes('再按') && T.checkKey('Mod-Escape').includes('Esc') && T.checkKey('Mod- ').includes('空格') && T.checkKey('Mod--').includes('减号'), '只按了修饰键、Esc、空格、减号不行', fails);
  const items = [
    { id: 'help.open', key: 'F1', area: 'global' },
    { id: 'book.x', key: 'F1', area: 'book' },
    { id: 'edit.undo', key: 'Mod-z', area: 'book' },
    { id: 'trash.undo', key: 'Mod-z', area: 'trash' },
    { id: 'search.open', key: 'Mod-f', area: 'book' },
    { id: 'format.open', key: 'Mod-f', area: 'book' },
    { id: 'nav.shelf', key: '', area: 'global' },
  ];
  const cf = T.findConflicts(items);
  check(cf['help.open'] && cf['help.open'][0] === 'book.x' && cf['book.x'][0] === 'help.open', '和「随处能用」的命令同键：冲突', fails);
  check(!cf['edit.undo'] && !cf['trash.undo'], '不同界面里的同一个键（写作时 / 回收站里的撤销）不算冲突', fails);
  check(cf['search.open'] && cf['format.open'], '同一个界面里同键：冲突', fails);
  check(!cf['nav.shelf'], '没有快捷键的不算', fails);
  check(T.same(T.withKey({}, 'a', 'Mod-k', ''), { a: 'Mod-k' }) && T.same(T.withKey({ a: 'Mod-k' }, 'a', 'Mod-f', 'Mod-f'), {}) && T.same(T.withKey({ a: 'Mod-k', b: 'F2' }, 'a', '', ''), { b: 'F2' }),
    '改回默认、清除时不再记着', fails);
  check(T.areaOf('help.open', false) === 'global' && T.areaOf('chapter.new', true) === 'book' && T.areaOf('search.open', true) === 'book' && T.areaOf('trash.undo', true) === 'trash' && T.areaOf('settings.undo', true) === 'settings',
    '命令属于哪个界面', fails);

  console.log('报错记录');
  const old = [{ at: 3, what: 'c' }, { at: 1, what: 'a' }];
  const cur = [{ at: 5, what: 'new' }];
  const merged = T.mergeLog(cur, old);
  check(merged.map((e) => e.what).join() === 'new,c,a', '撤销清空：清掉的放回去，新记的留着，按时间排', fails);
  check(T.mergeLog(merged, old).length === 3, '不会放两遍', fails);
  check(T.removeLog(merged, old).map((e) => e.what).join() === 'new', '重做清空：只去掉当时清掉的', fails);
  const txt = T.logText([{ at: 0, what: '保存失败', why: '空间满了', detail: 'QuotaExceededError' }], () => 'T');
  check(txt === 'T  保存失败\n可能的原因：空间满了\n详细信息：\nQuotaExceededError', '整理成纯文本', fails);
}

// ---------------- 浏览器 ----------------
function idb(page, op, store, value) {
  return page.evaluate(([op, store, value]) => new Promise((resolve, reject) => {
    const req = indexedDB.open('xiaoemo-wenshu');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(store, op === 'all' || op === 'get' ? 'readonly' : 'readwrite');
      const os = t.objectStore(store);
      const r = op === 'all' ? os.getAll() : op === 'get' ? os.get(value) : op === 'put' ? os.put(value) : os.delete(value);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        let out = r.result;
        if (out && out.value && out.value.data instanceof ArrayBuffer) out = { ...out, value: { ...out.value, data: out.value.data.byteLength } };
        t.oncomplete = () => { db.close(); resolve(out); };
      };
    };
  }), [op, store, value]);
}

const settings = async (page) => ((await idb(page, 'get', 'kv', 'settings')) || {}).value || {};
const pause = (page, ms = 250) => page.waitForTimeout(ms);
const hash = (page) => page.evaluate(() => location.hash);
const lastToast = (page, text) => page.locator('.toast:not(.out)', { hasText: text }).last();
const cssVar = (page, name) => page.evaluate((n) => document.documentElement.style.getPropertyValue(n), name);
async function until(page, fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await page.waitForTimeout(60);
  }
}
async function setRange(page, sel, values) {
  await page.evaluate(([sel, values]) => {
    const el = document.querySelector(sel);
    for (const v of values) { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }
  }, [sel, values]);
}
const findFont = () => ['/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));

async function flows(dist, fails) {
  const { browser, page, errors } = await launch(dist);
  // 打包的字体从哪里读的
  const fontFiles = [];
  page.on('response', (r) => { if (/\/fonts\/[^/]+\.woff2$/.test(r.url())) fontFiles.push({ url: r.url(), status: r.status() }); });

  console.log('打开设置');
  await pause(page, 1500);   // 等她说完开场白
  await page.click('.shelf .tool-btn:has-text("设置")');
  await page.waitForSelector('.st-group');
  check((await hash(page)) === '#/settings', '书架上点「设置」进 #/settings', fails);
  const groups = await page.$$eval('.st-group', (els) => els.map((e) => e.dataset.group).join());
  check(groups === 'look,demon,shelf,keys,names,errlog', '分组：外观、小恶魔、书架、快捷键、主题彩蛋、报错记录（没带作品时没有「当前作品」）' + groups, fails);
  check(!!(await page.$('.st .topbar [aria-label="返回"]')) && (await page.textContent('.st .topbar .title')) === '设置', '左上角有返回，标题是「设置」', fails);
  check(await page.$eval('.st .topbar [aria-label="撤销"]', (b) => b.disabled), '还没改东西时撤销是灰的', fails);
  check(await page.$$eval('.st-row .help-tip', (els) => els.length >= 15 && els.every((e) => e.dataset.tip)), '每项旁边有小问号，带说明', fails);
  const tipText = await until(page, () => page.evaluate(() => document.querySelector('.demon-text').textContent.includes('马上生效') && document.querySelector('.demon-text').textContent));
  check(!!tipText, '第一次打开时小恶魔说明一句', fails);
  check(await page.$eval('.demon-bubble', (b) => b.children.length === 1 && b.firstElementChild.classList.contains('demon-text')), '气泡里只有台词，上面没有名字', fails);
  check((await settings(page)).tipsSeen['settings-first'], '说明看过一次就记下来', fails);

  console.log('主题');
  await page.click('#st-look [aria-label="主题"] button[data-v="dark"]');
  await until(page, () => page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
  const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bgDark === 'rgb(20, 20, 21)', '换成深色：界面马上变深 ' + bgDark, fails);
  check((await settings(page)).theme === 'dark', '马上存好', fails);
  check(await page.$eval('#st-look [aria-label="主题"] button[data-v="dark"]', (b) => b.getAttribute('aria-pressed') === 'true'), '按钮显示选中', fails);
  await page.click('.st .topbar [aria-label="撤销"]');
  await until(page, () => page.evaluate(() => !document.documentElement.dataset.theme));
  check(!(await page.evaluate(() => document.documentElement.dataset.theme)) && (await settings(page)).theme === 'auto', '右上角撤销：回到跟随系统', fails);
  await page.click('.st .topbar [aria-label="重做"]');
  await until(page, () => page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
  check((await settings(page)).theme === 'dark', '重做：又是深色', fails);
  await page.click('.st-group-title >> nth=0');
  await page.keyboard.press('Control+z');
  await until(page, () => page.evaluate(() => !document.documentElement.dataset.theme));
  check((await settings(page)).theme === 'auto', 'Ctrl+Z 也能撤销', fails);

  console.log('字体、字号');
  const want = { kai: ['霞鹜文楷', 'LXGW WenKai'], yozai: ['悠哉字体', 'Yozai'], xiaolai: ['小赖字体', 'Xiaolai SC'], xiaowei: ['站酷小薇', 'ZCOOL XiaoWei'] };
  const firstFam = (f) => f.split(',')[0].replace(/"/g, '').trim();
  const cards = await page.$$eval('#st-look [data-key="textFont"] .st-fcard', (bs) => bs.map((b) => ({ id: b.dataset.v, name: b.querySelector('.st-fcard-n').textContent,
    sample: b.querySelector('.st-fcard-sample').textContent, fam: getComputedStyle(b.querySelector('.st-fcard-sample')).fontFamily })));
  check(cards.length === 8 && cards.every((c) => c.sample === '林小满把药篓往肩上提了提。'), '正文字体是一排卡片，每张写同一句样句 ' + cards.length, fails);
  check(Object.entries(want).every(([id, [name, fam]]) => cards.some((c) => c.id === id && c.name === name && firstFam(c.fam) === fam)),
    '霞鹜文楷、悠哉、小赖、站酷小薇都有卡片：样句用它自己的字体，下面一行是名字', fails);
  const pills = await page.$$eval('#st-look [data-key="uiFont"] .st-fpill', (bs) => bs.map((b) => ({ id: b.dataset.v, text: b.textContent, fam: getComputedStyle(b).fontFamily })));
  check(pills.length === 8 && Object.entries(want).every(([id, [name, fam]]) => pills.some((p) => p.id === id && p.text === name && firstFam(p.fam) === fam)),
    '界面字体是一排圆按钮，名字用它自己的字体写', fails);
  const famStatus = () => page.evaluate((fams) => fams.map((fam) => [...document.fonts].filter((f) => f.family.replace(/"/g, '') === fam).map((f) => f.status).join()),
    Object.values(want).map((w) => w[1]));
  await until(page, async () => (await famStatus()).every((st) => st === 'loaded'), 10000);
  check((await famStatus()).every((st) => st === 'loaded'), '设置页用到的四个打包字体都加载好了 ' + (await famStatus()).join('|'), fails);
  const fontBase = 'file://' + path.resolve(dist) + '/fonts/';
  check(['lxgw-wenkai', 'yozai', 'xiaolai-sc', 'zcool-xiaowei'].every((f) => fontFiles.some((r) => r.url === fontBase + f + '.woff2' && r.status === 200)),
    '字体文件从 dist/fonts/ 读的，不联网 ' + fontFiles.map((r) => r.url.split('/').pop() + ' ' + r.status).join(','), fails);
  check(await page.evaluate(() => document.fonts.check('18px "Yozai"', '林小满把药篓往肩上提了提。') && document.fonts.check('18px "Xiaolai SC"', '霞鹜文楷')), '样句里的字字体里都有', fails);
  await page.click('#st-look [data-key="textFont"] .st-fcard[data-v="yozai"]');
  await until(page, async () => (await settings(page)).textFont === 'yozai');
  check(firstFam(await cssVar(page, '--f-text')) === 'Yozai' && firstFam(await page.$eval('.st-preview', (e) => getComputedStyle(e).fontFamily)) === 'Yozai', '点卡片：正文字体换成悠哉，预览跟着变', fails);
  check(await page.$eval('#st-look [data-key="textFont"] .st-fcard[data-v="yozai"]', (b) => b.getAttribute('aria-pressed') === 'true')
    && await page.$$eval('#st-look [data-key="textFont"] .st-fcard[aria-pressed="true"]', (bs) => bs.length === 1), '只有点的那张卡片是选中的', fails);
  await page.click('#st-look [data-key="uiFont"] .st-fpill[data-v="xiaolai"]');
  await until(page, async () => (await settings(page)).uiFont === 'xiaolai');
  check(firstFam(await page.evaluate(() => getComputedStyle(document.body).fontFamily)) === 'Xiaolai SC' && firstFam(await page.$eval('.st-name', (e) => getComputedStyle(e).fontFamily)) === 'Xiaolai SC',
    '点按钮：界面字体换成小赖，界面上的字跟着换', fails);
  await page.click('.st .topbar [aria-label="撤销"]');
  await until(page, async () => (await settings(page)).uiFont === 'system');
  check((await settings(page)).uiFont === 'system' && (await settings(page)).textFont === 'yozai', '撤销一步：界面字体回去，正文字体还是悠哉', fails);
  await page.click('#st-look [data-key="textFont"] button[data-v="kai"]');
  await until(page, async () => (await cssVar(page, '--f-text')).includes('WenKai'));
  check((await cssVar(page, '--f-text')).includes('WenKai'), '正文字体换成楷体', fails);
  check((await page.$eval('.st-preview', (e) => getComputedStyle(e).fontFamily)).includes('WenKai'), '预览那一行跟着变', fails);
  await page.click('#st-look [data-key="uiFont"] button[data-v="kuaile"]');
  await until(page, async () => (await cssVar(page, '--f-ui')).includes('KuaiLe'));
  check((await cssVar(page, '--f-ui')).includes('KuaiLe') && (await settings(page)).textFont === 'kai', '界面字体和正文字体分开设置', fails);
  await setRange(page, '.st-range[data-key="textSize"]', [20, 22, 24]);
  await until(page, async () => (await cssVar(page, '--text-size')) === '24px');
  check((await cssVar(page, '--text-size')) === '24px' && (await page.textContent('.st-range[data-key="textSize"] + .st-out')) === '24 px', '拖字号：马上生效，旁边显示数字', fails);
  await page.click('.st .topbar [aria-label="撤销"]');
  await until(page, async () => (await cssVar(page, '--text-size')) === '18px');
  check((await cssVar(page, '--text-size')) === '18px', '拖一次滑块算一步撤销', fails);
  await setRange(page, '.st-range[data-key="lineHeight"]', [2.2]);
  await setRange(page, '.st-range[data-key="textWidth"]', [900]);
  await until(page, async () => (await cssVar(page, '--text-width')) === '900px');
  check((await cssVar(page, '--text-lh')) === '2.2' && (await cssVar(page, '--text-width')) === '900px', '行高、正文宽度', fails);

  console.log('外观恢复默认');
  await page.click('#st-look .st-reset');
  await page.waitForSelector('.modal');
  check((await page.textContent('.modal')).includes('上传的字体文件会留着'), '先确认，说清楚会改什么', fails);
  await page.click('.modal-foot .btn:has-text("恢复默认")');
  await lastToast(page, '已恢复默认').waitFor();
  let s = await settings(page);
  check(s.textFont === 'kai' && s.uiFont === 'system' && s.lineHeight === 1.9 && s.textWidth === 720, '外观全部回到默认', fails);
  await lastToast(page, '已恢复默认').locator('.toast-act').click();
  await until(page, async () => (await settings(page)).textFont === 'kai');
  s = await settings(page);
  check(s.textFont === 'kai' && s.uiFont === 'kuaile' && s.lineHeight === 2.2 && s.textWidth === 900, '提示条上撤销：一步全回来', fails);
  await page.click('#st-look .st-reset');
  await page.click('.modal-foot .btn:has-text("恢复默认")');
  await lastToast(page, '已恢复默认').waitFor();

  console.log('上传字体');
  const fontFile = findFont();
  let fontId = null;
  if (!fontFile) console.log('  （这台机器上没找到测试用的字体文件，跳过）');
  else {
    await page.setInputFiles('[data-role="font-file"]', fontFile);
    await page.waitForSelector('.st-font-item');
    s = await settings(page);
    fontId = s.customFonts[0] && s.customFonts[0].id;
    const rec = await idb(page, 'get', 'kv', 'font:' + fontId);
    check(s.customFonts.length === 1 && s.customFonts[0].name === path.basename(fontFile).replace(/\.ttf$/, '').replace(/_/g, ' '), '记下字体名字', fails);
    check(rec && rec.value.data > 10000 && rec.value.size === fs.statSync(fontFile).size, '文件存进 kv font:<id>', fails);
    check(await page.evaluate((id) => [...document.fonts].some((f) => f.family.replace(/"/g, '') === id && f.status === 'loaded'), fontId), '用 FontFace 加载好了', fails);
    check(await page.$$eval('#st-look [data-key="textFont"] .st-fcard', (bs) => bs.length) === 9 && await page.$$eval('#st-look [data-key="uiFont"] .st-fpill', (bs) => bs.length) === 9,
      '正文、界面字体里都多了一个', fails);
    check(await page.$eval(`#st-look [data-key="textFont"] .st-fcard[data-v="${fontId}"]`, (b) => b.querySelector('.st-ftag').textContent === '上传'
      && getComputedStyle(b.querySelector('.st-fcard-sample')).fontFamily.includes(b.dataset.v)), '上传的字体也有样句卡片，标着「上传」', fails);
    await lastToast(page, '已添加字体').waitFor();
    await page.click('.st-font-item .st-use-text');
    await until(page, async () => (await settings(page)).textFont === fontId);
    check((await cssVar(page, '--f-text')).includes(fontId), '用作正文', fails);
    await page.click('.st-font-item .st-font-del');
    await lastToast(page, '已删除字体').waitFor();
    s = await settings(page);
    check(!s.customFonts.length && s.textFont === 'kai' && !(await idb(page, 'get', 'kv', 'font:' + fontId)), '删除：列表、文件都去掉，正文换回默认字体', fails);
    await lastToast(page, '已删除字体').locator('.toast-act').click();
    await until(page, async () => (await settings(page)).customFonts.length === 1);
    s = await settings(page);
    check(s.customFonts.length === 1 && s.textFont === fontId && !!(await idb(page, 'get', 'kv', 'font:' + fontId)), '撤销删除：字体回来，正文又用上它', fails);

    console.log('刷新后字体还在');
    await page.reload();
    await page.waitForSelector('.topbar');
    await until(page, () => page.evaluate((id) => [...document.fonts].some((f) => f.family.replace(/"/g, '') === id && f.status === 'loaded'), fontId));
    check(await page.evaluate((id) => [...document.fonts].some((f) => f.family.replace(/"/g, '') === id && f.status === 'loaded'), fontId), '启动时把上传的字体加载好', fails);
    check(!(await page.$('.modal')), '没有弹报错', fails);

    console.log('字体文件丢了');
    await idb(page, 'del', 'kv', 'font:' + fontId);
    await page.reload();
    await page.waitForSelector('.modal .notice');
    check((await page.textContent('.notice-what')).includes('没加载出来') && (await page.textContent('.notice-why')).length > 0, '启动时加载不了：中文报错卡', fails);
    await page.click('.modal-foot .btn:has-text("打开设置")');
    await page.waitForSelector('.st-font-item .st-bad');
    check((await hash(page)) === '#/settings' && (await page.textContent('.st-font-item .st-bad')).includes('没加载出来'), '点「打开设置」：列表里标出来', fails);
    check(await page.$eval('.st-font-item .st-use-text', (b) => b.disabled), '坏的字体不能选用', fails);
    await page.click('.st-font-item .st-font-del');
    await lastToast(page, '已删除字体').waitFor();
    check(!(await settings(page)).customFonts.length && (await settings(page)).textFont === 'kai', '删掉坏的，正文换回默认字体', fails);
    await page.setInputFiles('[data-role="font-file"]', fontFile);
    await page.waitForSelector('.st-font-item:not(:has(.st-bad))');
  }

  console.log('坏文件');
  if (!(await page.$('.st-group'))) { await page.evaluate(() => { location.hash = '#/settings'; }); await page.waitForSelector('.st-group'); }
  await page.setInputFiles('[data-role="font-file"]', { name: '坏字体.ttf', mimeType: 'font/ttf', buffer: Buffer.from('这不是字体文件'.repeat(20)) });
  await page.waitForSelector('.modal .notice');
  check((await page.textContent('.notice-what')).includes('坏字体') && (await page.textContent('.notice-why')).includes('损坏'), '字体文件坏了：中文报错卡，说出了什么事和原因', fails);
  check(await page.locator('.modal-foot .btn', { hasText: '换一个文件' }).count() === 1, '有「换一个文件」按钮', fails);
  await page.click('.modal-foot .btn:has-text("知道了")');
  await page.setInputFiles('[data-role="font-file"]', { name: '说明.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForSelector('.modal .notice');
  check((await page.textContent('.notice-what')).includes('不是字体文件'), '不是字体文件：直接说', fails);
  await page.click('.modal-foot .btn:has-text("知道了")');
  await pause(page, 300);
  check(fontFile ? (await settings(page)).customFonts.length === 1 : true, '坏文件没加进列表', fails);

  console.log('报错记录');
  await until(page, async () => (await page.$$('.st-err')).length >= 2);
  const errs = await page.$$eval('.st-err', (els) => els.map((e) => ({ t: e.querySelector('.st-err-time').textContent, what: e.querySelector('.st-err-what').textContent, detail: !!e.querySelector('details') })));
  check(errs.length >= 2 && errs[0].what.includes('不是字体文件') && errs[1].what.includes('坏字体') && errs[0].t.startsWith('今天'), '报错记录：新的在前，带时间 ' + JSON.stringify(errs.slice(0, 2)), fails);
  check(errs[1].detail, '原文折叠在详细信息里', fails);
  const nErr = errs.length;
  await page.click('.st-err-clear');
  await lastToast(page, '已清空').waitFor();
  check(!!(await page.$('.st-err-none')) && ((await idb(page, 'get', 'kv', 'errlog')).value.length === 0), '清空', fails);
  await lastToast(page, '已清空').locator('.toast-act').click();
  await until(page, async () => (await page.$$('.st-err')).length === nErr);
  check((await page.$$('.st-err')).length === nErr, '撤销清空：全部回来', fails);
  check(!(await page.textContent('.st-errs')).includes('null'), '列表里没有多余的字', fails);
  const many = Array.from({ length: 60 }, (_, i) => ({ at: Date.now() - (i + 10) * 60000, what: '测试错误 ' + i, why: '', detail: '' }));
  const curLog = (await idb(page, 'get', 'kv', 'errlog')).value;
  await idb(page, 'put', 'kv', { key: 'errlog', value: [...curLog, ...many] });
  await page.click('.st .topbar [aria-label="返回"]');
  await page.waitForSelector('.shelf');
  await page.goForward();
  await page.waitForSelector('.st-err-more');
  check((await page.$$('.st-err')).length === 50 && (await page.textContent('.st-err-more')).includes('再显示'), '记录多时先显示 50 条', fails);
  await page.click('.st-err-more');
  check((await page.$$('.st-err')).length === nErr + 60 && !(await page.$('.st-err-more')), '点「再显示」看到全部', fails);
  check((await page.textContent('.st-err-count')).includes(String(nErr + 60)), '显示总条数', fails);

  console.log('小恶魔');
  await page.click('#st-demon input[data-name="demonOn"]');
  await until(page, () => page.evaluate(() => document.querySelector('.demon').classList.contains('off')));
  check(await page.evaluate(() => document.querySelector('.demon').classList.contains('off')), '隐藏小恶魔', fails);
  await page.click('#st-demon input[data-name="demonOn"]');
  await until(page, () => page.evaluate(() => !document.querySelector('.demon').classList.contains('off')));
  await page.click('#st-demon [aria-label="大小"] button[data-v="2"]');
  await until(page, () => page.evaluate(() => document.querySelector('.demon').style.getPropertyValue('--demon-scale') === '2'));
  check((await settings(page)).demonScale === 2, '大小 2×', fails);
  await page.click('#st-demon [aria-label="大小"] button[data-v="1"]');
  await page.click('#st-demon .st-style[data-v="sailor"]');
  await until(page, async () => (await settings(page)).demonStyle === 'sailor');
  check(await page.$eval('#st-demon .st-style[data-v="sailor"]', (b) => b.getAttribute('aria-pressed') === 'true'), '书架上穿水手服', fails);
  const thumb = await page.$eval('#st-demon .st-style[data-v="sailor"] .st-thumb', (e) => getComputedStyle(e).backgroundImage);
  check(thumb.includes('sprites/sailor/idle.png'), '缩略图用待机动作的第一帧', fails);
  const line = await until(page, () => page.evaluate(() => document.querySelector('.demon-bubble.on') && document.querySelector('.demon-text').textContent));
  check(!!line && await page.$eval('.demon-bubble', (b) => b.children.length === 1), '换装后她打个招呼，气泡里只有台词：' + line, fails);
  await page.click('#st-demon [aria-label="话多少"] button[data-v="quiet"]');
  await page.fill('#st-demon .st-num', '12');
  await until(page, async () => (await settings(page)).idleMinutes === 12);
  s = await settings(page);
  check(s.demonChatty === 'quiet' && s.idleMinutes === 12, '话少、停笔 12 分钟算久', fails);
  const seenBefore = Object.keys(s.tipsSeen).length;
  await page.click('#st-demon .st-tips');
  await lastToast(page, '会重新出现').waitFor();
  check(Object.keys((await settings(page)).tipsSeen).length === 0 && seenBefore > 0, '重新显示功能说明：看过的记录清掉', fails);
  await lastToast(page, '会重新出现').locator('.toast-act').click();
  await until(page, async () => Object.keys((await settings(page)).tipsSeen).length === seenBefore);
  check(Object.keys((await settings(page)).tipsSeen).length === seenBefore, '也能撤销', fails);

  console.log('书架');
  await setRange(page, '.st-range[data-key="hoverDelay"]', [1200]);
  await until(page, async () => (await settings(page)).hoverDelay === 1200);
  check((await page.textContent('.st-range[data-key="hoverDelay"] + .st-out')) === '1.2 秒', '悬停 1.2 秒显示详情', fails);

  console.log('快捷键');
  await page.fill('.st-key-q', '回到书架');
  await page.waitForSelector('.st-key[data-id="nav.shelf"]');
  await page.click('.st-key[data-id="nav.shelf"] .st-key-edit');
  await page.waitForSelector('.st-key.rec');
  await page.keyboard.press('a');
  await page.waitForSelector('.st-key-err');
  check((await page.textContent('.st-key-err')).includes('要带上 Ctrl'), '单按字母：提示要带上 Ctrl 或 Alt', fails);
  await page.keyboard.press('Escape');
  await pause(page, 150);
  check(!(await page.$('.st-key.rec')) && (await hash(page)) === '#/settings', 'Esc 取消录制，不会退出设置', fails);
  await page.click('.st-key[data-id="nav.shelf"] .st-key-edit');
  await page.keyboard.press('Control+Shift+Y');
  await until(page, async () => ((await settings(page)).keys || {})['nav.shelf'] === 'Mod-Shift-y');
  check(((await settings(page)).keys || {})['nav.shelf'] === 'Mod-Shift-y', '记下新的组合键', fails);
  check((await page.textContent('.st-key[data-id="nav.shelf"] .st-kbd')) === 'Ctrl+Shift+Y', '列表里显示 Ctrl+Shift+Y', fails);
  await page.click('.st-group-title >> nth=0');
  await page.keyboard.press('Control+Shift+Y');
  await page.waitForSelector('.shelf');
  check((await hash(page)) === '#/', '新快捷键马上能用', fails);
  await page.goBack();
  await page.waitForSelector('.st-key-q');
  await page.fill('.st-key-q', '新建作品');
  await page.click('.st-key[data-id="book.new"] .st-key-edit');
  await page.keyboard.press('F1');
  await page.waitForSelector('.modal');
  check((await page.textContent('.modal')).includes('找功能'), '和「找功能（F1）」冲突：提示', fails);
  await page.click('.modal-foot .btn:has-text("换一个")');
  await page.waitForSelector('.st-key[data-id="book.new"].rec');
  check(true, '点「换一个」接着录', fails);
  await page.keyboard.press('Alt+n');
  await until(page, async () => ((await settings(page)).keys || {})['book.new'] === 'Alt-n');
  check(((await settings(page)).keys || {})['book.new'] === 'Alt-n', '换成 Alt+N', fails);
  await page.click('.st-key[data-id="book.new"] .st-key-reset');
  await until(page, async () => !((await settings(page)).keys || {})['book.new']);
  check(!((await settings(page)).keys || {})['book.new'], '没有默认键的命令：清除', fails);
  await page.click('.st .topbar [aria-label="撤销"]');
  await until(page, async () => ((await settings(page)).keys || {})['book.new'] === 'Alt-n');
  check(((await settings(page)).keys || {})['book.new'] === 'Alt-n', '撤销清除', fails);
  await page.fill('.st-key-q', '找功能');
  await page.click('.st-key[data-id="help.open"] .st-key-edit');
  await page.keyboard.press('F2');
  await until(page, async () => ((await settings(page)).keys || {})['help.open'] === 'F2');
  await page.click('.st-key[data-id="help.open"] .st-key-reset');
  await until(page, async () => !((await settings(page)).keys || {})['help.open']);
  check((await page.textContent('.st-key[data-id="help.open"] .st-kbd')) === 'F1', '有默认键的命令：恢复默认', fails);
  await page.click('#st-keys .st-reset');
  await page.click('.modal-foot .btn:has-text("恢复默认")');
  await lastToast(page, '已恢复默认').waitFor();
  check(JSON.stringify((await settings(page)).keys) === '{}', '快捷键整组恢复默认', fails);

  console.log('主题彩蛋');
  await page.click('#st-names input[data-name="themeNames"]');
  await until(page, async () => (await page.textContent('.st .topbar .title')) === '签订契约');
  check((await page.textContent('.st .topbar .title')) === '签订契约', '打开后标题叫「签订契约」', fails);
  await page.click('.st .topbar [aria-label="返回"]');
  await page.waitForSelector('.shelf');
  check(await page.locator('.shelf .tool-btn', { hasText: '地狱' }).count() === 1 && await page.locator('.shelf .tool-btn', { hasText: '签订契约' }).count() === 1, '书架上也改名', fails);
  await page.click('.shelf .tool-btn:has-text("签订契约")');
  await page.waitForSelector('.st-group');
  await page.click('#st-names .st-reset');
  await page.click('.modal-foot .btn:has-text("恢复默认")');
  await until(page, async () => (await page.textContent('.st .topbar .title')) === '设置');
  check((await settings(page)).themeNames === false, '一键改回', fails);

  console.log('当前作品');
  await page.click('.st .topbar [aria-label="返回"]');
  await page.waitForSelector('.shelf');
  const bookId = await newBook(page, '设置测试', [{ title: '开头', text: '　　第一段。' }, { title: '', text: '　　第二章。' }]);
  await page.click('.ws .topbar [aria-label="设置"]');
  await page.waitForSelector('#st-book');
  check((await hash(page)) === '#/settings/' + bookId, '写作界面右上角进 #/settings/<作品>', fails);
  check((await page.textContent('#st-book .st-group-title')).includes('《设置测试》'), '多一组「当前作品」', fails);
  await page.click('#st-book [aria-label="章节号"] button[data-v="num"]');
  await until(page, async () => (await idb(page, 'get', 'books', bookId)).numbering === 'num');
  check((await idb(page, 'get', 'books', bookId)).numbering === 'num', '章节号改成第1章', fails);
  await page.click('#st-book input[data-name="useVolumes"]');
  await until(page, async () => (await idb(page, 'get', 'books', bookId)).useVolumes === true);
  let book = await idb(page, 'get', 'books', bookId);
  let chs = (await idb(page, 'all', 'chapters')).filter((c) => c.bookId === bookId);
  check(book.useVolumes && book.volumes.length === 1 && chs.every((c) => c.volumeId === book.volumes[0].id), '打开分卷：建第一卷，章节放进去', fails);
  await page.click('.st .topbar [aria-label="撤销"]');
  await until(page, async () => (await idb(page, 'get', 'books', bookId)).useVolumes === false);
  chs = (await idb(page, 'all', 'chapters')).filter((c) => c.bookId === bookId);
  check(chs.every((c) => !c.volumeId) && !(await page.$eval('#st-book input[data-name="useVolumes"]', (c) => c.checked)), '撤销分卷：章节也放回去', fails);
  await page.click('#st-book input[data-name="autoIndent"]');
  await page.click('#st-book [aria-label="段间空行"] button[data-v="1"]');
  await page.fill('#st-book .st-num', '5000');
  await page.click('#st-book .st-style[data-v="hanfu"]');
  await until(page, async () => (await idb(page, 'get', 'books', bookId)).demonStyle === 'hanfu');
  book = await idb(page, 'get', 'books', bookId);
  check(book.autoIndent === false && book.paraGap === 1 && book.dailyGoal === 5000 && book.demonStyle === 'hanfu', '自动空两格、段间空行、每日目标、小恶魔风格都存进这本书', fails);
  await page.click('#st-look [data-key="textFont"] .st-fcard[data-v="xiaowei"]');
  await until(page, async () => (await settings(page)).textFont === 'xiaowei');
  check(await page.$eval('#st-book .st-style[data-v="auto"] .st-style-sub', (e) => e.textContent.startsWith('现在会穿')), '「按作品类型」说明现在会穿哪套', fails);
  await page.click('.st .topbar [aria-label="返回"]');
  await page.waitForSelector('.cm-content');
  check((await hash(page)).startsWith('#/book/' + bookId), '返回写作界面', fails);
  const edFont = await page.$eval('.cm-content', (e) => getComputedStyle(e).fontFamily);
  check(edFont.split(',')[0].replace(/"/g, '') === 'ZCOOL XiaoWei', '正文字体换成站酷小薇：编辑器跟着换 ' + edFont, fails);
  await until(page, () => page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'ZCOOL XiaoWei' && f.status === 'loaded')));
  check(await page.evaluate(() => document.fonts.check('20px "ZCOOL XiaoWei"', '第一段')), '编辑器里的字用打包的站酷小薇显示', fails);
  const list = await chapterList(page);
  check(list[0].startsWith('第1章'), '章节列表用「第1章」' + list[0], fails);
  check((await page.textContent('.statusbar')).includes('5,000'), '状态栏用新的字数目标', fails);
  await page.click('.cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('新段');
  await pause(page, 200);
  const text = await getText(page);
  check(text.endsWith('第二章。\n\n新段'), '回车：空一行、不空两格 ' + JSON.stringify(text), fails);

  console.log('当前作品恢复默认');
  await page.click('.ws .topbar [aria-label="设置"]');
  await page.waitForSelector('#st-book');
  await page.click('#st-book .st-reset');
  await page.click('.modal-foot .btn:has-text("恢复默认")');
  await lastToast(page, '已恢复默认').waitFor();
  book = await idb(page, 'get', 'books', bookId);
  check(book.numbering === 'zh' && book.autoIndent === true && book.paraGap === 0 && book.dailyGoal === 3000 && book.demonStyle === 'auto', '这本书的设置回到默认', fails);
  await lastToast(page, '已恢复默认').locator('.toast-act').click();
  await until(page, async () => (await idb(page, 'get', 'books', bookId)).numbering === 'num');
  book = await idb(page, 'get', 'books', bookId);
  check(book.numbering === 'num' && book.dailyGoal === 5000 && book.demonStyle === 'hanfu', '撤销：一步全回来', fails);

  console.log('问小恶魔');
  await page.click('.st .topbar [aria-label="返回"]');
  await page.waitForSelector('.cm-content');
  await page.keyboard.press('F1');
  await page.fill('.help-search', '快捷键');
  await pause(page, 100);
  check((await page.textContent('.help-item >> nth=0')).includes('自定义快捷键'), '搜「快捷键」能找到', fails);
  await page.click('.help-item >> nth=0');
  await page.waitForSelector('#st-keys');
  await pause(page, 200);
  const inView = await page.evaluate(() => { const r = document.querySelector('#st-keys').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; });
  check((await hash(page)) === '#/settings/' + bookId && inView, '点了直接到快捷键那一组', fails);
  await page.keyboard.press('F1');
  await page.fill('.help-search', '深色');
  await pause(page, 100);
  await page.click('.help-item:has-text("深色")');
  await lastToast(page, '已换成').waitFor();
  check((await settings(page)).theme !== 'auto', '「深色 / 浅色切换」马上换', fails);
  await lastToast(page, '已换成').locator('.toast-act').click();
  await until(page, async () => (await settings(page)).theme === 'auto');
  check((await settings(page)).theme === 'auto', '提示条上撤销', fails);

  console.log('手机宽度、深色');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const g of ['look', 'demon', 'book', 'keys', 'errlog']) {
    await page.evaluate((g) => document.querySelector('#st-' + g).scrollIntoView(), g);
    await pause(page, 100);
  }
  const fit = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const main = document.querySelector('.st-main');
    const over = [...document.querySelectorAll('.st-group, .st-row, .st-row *, .st-key, .st-key *, .topbar > *')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width && r.right > W + 0.5;
    });
    return { W, sw: document.documentElement.scrollWidth, main: main.scrollWidth - main.clientWidth, over: over.slice(0, 5).map((e) => e.className || e.tagName) };
  });
  check(fit.sw <= fit.W && fit.main <= 0 && !fit.over.length, '390px 宽不横向溢出 ' + JSON.stringify(fit), fails);
  await page.emulateMedia({ colorScheme: 'dark' });
  await pause(page, 200);
  const dark = await page.evaluate(() => {
    // rgb(…) 是 0–255；color-mix 算出来的是 color(srgb 0–1 …)
    const lum = (c) => { const m = c.match(/\d*\.?\d+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / (c.startsWith('color(') ? 1 : 255); };
    const g = getComputedStyle(document.querySelector('.st-group'));
    const n = getComputedStyle(document.querySelector('.st-name'));
    const b = getComputedStyle(document.querySelector('.st-seg button'));
    const st = getComputedStyle(document.querySelector('.st-style'));
    const fc = getComputedStyle(document.querySelector('.st-fcard'));
    const fs = getComputedStyle(document.querySelector('.st-fcard-sample'));
    const fp = getComputedStyle(document.querySelector('.st-fpill[aria-pressed="true"]'));
    return { bg: lum(g.backgroundColor), ink: lum(n.color), btn: lum(b.backgroundColor), btnInk: lum(b.color), card: lum(st.backgroundColor),
      fcard: lum(fc.backgroundColor), fink: lum(fs.color), fpill: lum(fp.backgroundColor), fpillInk: lum(fp.color) };
  });
  check(dark.bg < 0.2 && dark.btn < 0.2 && dark.card < 0.2 && dark.ink > 0.7 && dark.btnInk > 0.5, '深色模式：底色深、字浅 ' + JSON.stringify(dark), fails);
  check(dark.fcard < 0.2 && dark.fpill < 0.25 && dark.fink > 0.7 && dark.fpillInk > 0.5, '深色模式：字体卡片、按钮也是深底浅字', fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
}

(async () => {
  const fails = [];
  await unit(fails);
  if (!process.argv.includes('--unit')) {
    const dist = process.argv[2] || path.join(__dirname, '../dist');
    try { await flows(dist, fails); }
    catch (e) { fails.push('浏览器测试中断：' + e.message); console.log('  ✗ ' + (e.stack || e.message)); }
  }
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
