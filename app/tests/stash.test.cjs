// 暂存盒：抽屉（右侧栏 / 弹窗）、只列本功能、采用、插入正文和撤销、拖进正文、置顶、标签、继续追问、单删、多选删和撤销；
// 总暂存盒：按作品 / 功能 / 时间筛选、搜索、多选删、Ctrl+Z / 重做、按条件批量删（先显示几条）和撤销；出错提示；六套风格形态不同；手机宽度不溢出
const { launch, newBook, getText, check } = require('./helpers.cjs');
const pause = (page, ms) => page.waitForTimeout(ms);
const DAY = 86400000;

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await page.evaluate(() => localStorage.setItem('xemoMock', '1'));
  await page.reload(); await page.waitForSelector('.topbar');

  const idb = (fn, arg) => page.evaluate(([src, arg]) => new Promise((res, rej) => {
    const r = indexedDB.open('xiaoemo-wenshu');
    r.onsuccess = () => { const db = r.result; Promise.resolve((0, eval)(src)(db, arg)).then((v) => { db.close(); res(v); }, rej); };
    r.onerror = () => rej(r.error);
  }), [fn.toString(), arg]);
  const seed = (rows) => idb((db, rows) => new Promise((res, rej) => {
    const t = db.transaction(['stash'], 'readwrite'); rows.forEach((x) => t.objectStore('stash').put(x)); t.oncomplete = res; t.onerror = () => rej(t.error);
  }), rows);
  const allRows = () => idb((db) => new Promise((res) => { const q = db.transaction(['stash']).objectStore('stash').getAll(); q.onsuccess = () => res(q.result); }));
  const rowOf = async (id) => (await allRows()).find((r) => r.id === id);
  const cards = (scope = '') => page.$$eval(scope + ' .stash-card', (els) => els.map((e) => e.dataset.id));
  const palette = async (title) => {
    await page.keyboard.press('F1');
    await page.waitForSelector('.help-search');
    await page.fill('.help-search', title);
    await page.click(`.help-item:has(.help-t:text-is("${title}"))`);
    await pause(page, 400);
  };

  const bookId = await newBook(page, '暂存测试', [{ title: '门铃', text: '　　雨下到第三天。门铃响了。' }]);
  const chId = await idb((db, bookId) => new Promise((res) => { const q = db.transaction(['chapters']).objectStore('chapters').index('bookId').getAll(bookId); q.onsuccess = () => res(q.result[0].id); }), bookId);
  const now = Date.now();
  const long = '　　这是很长的一段摘要。'.repeat(30);
  const base = { kind: 'text', pinned: false, tags: [], providerId: 'mock', model: 'mock-small', prompt: '帮我改一下', input: '' };
  await seed([
    { ...base, id: 'r1', at: now - 3600e3, bookId, feature: 'rewrite', ref: chId, title: '第一章 门铃 · 选中调用', text: '第一条改写结果。' },
    { ...base, id: 'r2', at: now - 7200e3, bookId, feature: 'chapterName', ref: chId, title: '章名候选', text: '门铃响了' },
    { ...base, id: 'r3', at: now - 10800e3, bookId, feature: 'chapterName', ref: 'other-ch', title: '章名候选', text: '旧信' },
    { ...base, id: 'r4', at: now - 40 * DAY, bookId, feature: 'summary', ref: chId, title: '摘要', text: long },
    { ...base, id: 'r5', at: now - 35 * DAY, bookId, feature: 'summary', ref: chId, title: '摘要', text: '置顶的旧摘要', pinned: true },
    { ...base, id: 'r6', at: now - 3 * DAY, bookId: null, feature: 'chat', ref: null, title: '随便聊聊', text: '不属于作品的对话', tags: ['灵感'] },
    { ...base, id: 'r7', at: now - 50 * DAY, bookId: 'gone-book', feature: 'intro', ref: null, title: '简介', text: '删掉的作品的简介' },
  ]);

  // ---------------- 抽屉：从「你想做什么」打开，放在右侧栏，列出这本书的 ----------------
  console.log('抽屉');
  await palette('打开暂存盒抽屉');
  await page.waitForSelector('.side-right .stash-drawer .stash-card');
  check((await cards('.side-right')).join() === 'r5,r1,r2,r3,r4', '右侧栏抽屉列出这本书的 5 条，置顶的在前：' + (await cards('.side-right')).join(), fails);
  check((await page.textContent('.side-right .panel-head')).includes('暂存盒'), '面板标题是「暂存盒」', fails);
  check(await page.$('.side-right .panel-head .icon-btn[aria-label="关闭"]') !== null, '面板右上角有关闭', fails);
  const meta = await page.textContent('.stash-card[data-id="r1"] .stash-meta');
  check(meta.includes('mock-small') && /今天|\d+:\d+/.test(meta), '每条显示时间和模型：' + meta, fails);
  // 按功能筛
  await page.click('.stash-chips .stash-seg button[data-v="chapterName"]');
  await pause(page, 100);
  check((await cards('.side-right')).join() === 'r2,r3', '只看「起章名」', fails);
  await page.click('.stash-chips .stash-seg button[data-v="all"]');
  // 搜索
  await page.fill('.stash-drawer .stash-q', '旧信');
  await pause(page, 300);
  check((await cards('.side-right')).join() === 'r3', '搜索「旧信」', fails);
  await page.fill('.stash-drawer .stash-q', '没有这个字');
  await pause(page, 300);
  check((await page.textContent('.stash-drawer .stash-list')).includes('没找到'), '搜不到时说明', fails);
  await page.fill('.stash-drawer .stash-q', '');
  await pause(page, 300);
  // 长内容折叠
  check(await page.$('.stash-card[data-id="r4"] .stash-text.folded') !== null, '长内容默认折叠', fails);
  await page.click('.stash-card[data-id="r4"] .stash-fold');
  check(await page.$('.stash-card[data-id="r4"] .stash-text.folded') === null && (await page.textContent('.stash-card[data-id="r4"] .stash-fold')) === '收起', '展开全文', fails);
  await page.click('.stash-card[data-id="r4"] .stash-fold');

  // 插入正文 + 撤销
  await page.click('.cm-content'); await page.keyboard.press('Control+End');
  await page.click('.stash-card[data-id="r1"] .stash-use');
  await pause(page, 500);
  check((await getText(page)).includes('第一条改写结果'), '「插入正文」插到光标处', fails);
  await page.click('.toast:has-text("已插入正文") .toast-act');
  await pause(page, 500);
  check(!(await getText(page)).includes('第一条改写结果'), '插入后能撤销', fails);

  // 置顶 + Ctrl+Z 撤销
  await page.click('.stash-card[data-id="r2"] .stash-pin');
  await pause(page, 300);
  check((await rowOf('r2')).pinned && (await cards('.side-right'))[0] === 'r2' || (await cards('.side-right')).slice(0, 2).includes('r2'), '置顶后排到前面', fails);
  check(await page.$('.stash-card[data-id="r2"].pinned .stash-pin-mark') !== null, '置顶的有标记', fails);
  await page.keyboard.press('Control+z');
  await pause(page, 300);
  check(!(await rowOf('r2')).pinned, 'Ctrl+Z 撤销置顶', fails);

  // 加标签、按标签筛、去掉标签
  await page.click('.stash-card[data-id="r1"] .stash-tag-add');
  await page.waitForSelector('.modal input.input');
  await page.fill('.modal input.input', '备选 要改，备选');
  await page.keyboard.press('Enter');
  await pause(page, 300);
  check(JSON.stringify((await rowOf('r1')).tags) === '["备选","要改"]', '加标签（空格、逗号隔开，去重）：' + JSON.stringify((await rowOf('r1')).tags), fails);
  await page.click('.stash-card[data-id="r1"] .stash-tag[data-tag="备选"]');
  await pause(page, 150);
  check((await cards('.side-right')).join() === 'r1' && (await page.$('.stash-tag-on')) !== null, '点标签只看带这个标签的', fails);
  await page.click('.stash-tag-on');
  await pause(page, 150);
  await page.click('.stash-card[data-id="r1"] .stash-tag-w:has([data-tag="要改"]) .stash-tag-x');
  await pause(page, 300);
  check(JSON.stringify((await rowOf('r1')).tags) === '["备选"]', '去掉一个标签', fails);

  // 单删 + 提示条撤销
  await page.click('.stash-card[data-id="r3"] .stash-del');
  await pause(page, 400);
  check(!(await cards('.side-right')).includes('r3') && !(await rowOf('r3')), '删除一条', fails);
  check(await page.$('.toast:has-text("已删除 1 条") .toast-act') !== null, '出「已删除 · 撤销」提示条', fails);
  await page.click('.toast:has-text("已删除 1 条") .toast-act');
  await pause(page, 400);
  check((await cards('.side-right')).includes('r3') && !!(await rowOf('r3')), '提示条上撤销，放回来了', fails);

  // 多选删 + 撤销；多选时 Esc 先退出多选
  await page.click('.stash-drawer .stash-sel-btn');
  await page.click('.stash-card[data-id="r1"] .stash-pick input');
  await page.click('.stash-card[data-id="r2"]', { position: { x: 200, y: 4 } });
  await pause(page, 100);
  check((await page.textContent('.stash-drawer .stash-selbar')).includes('已选 2 条'), '多选：勾选框和点卡片都能选', fails);
  await page.click('.stash-drawer .stash-del-sel');
  await pause(page, 400);
  const left = await cards('.side-right');
  check(!left.includes('r1') && !left.includes('r2') && left.length === 3, '多选删除，一次删 2 条', fails);
  await page.click('.toast:has-text("已删除 2 条") .toast-act');
  await pause(page, 400);
  check((await cards('.side-right')).length === 5, '多选删除整体撤销', fails);
  await page.click('.stash-drawer .stash-sel-btn');
  check(await page.$('.stash-drawer .stash-pick') !== null, '进入多选', fails);
  await page.keyboard.press('Escape');
  await pause(page, 150);
  check(await page.$('.stash-drawer .stash-pick') === null && await page.$('.side-right .stash-drawer') !== null, 'Esc 先退出多选，抽屉还开着', fails);

  // 拖进正文
  await page.click('.cm-content'); await page.keyboard.press('Control+End');
  const box = await page.$eval('.cm-content', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; });
  await page.dragAndDrop('.stash-card[data-id="r3"]', '.cm-content', { targetPosition: { x: 40, y: 10 } });
  await pause(page, 500);
  let dropped = (await getText(page)).includes('旧信');
  if (!dropped) {
    // 有的环境里 Playwright 的拖放不带数据：用同样的 dataTransfer 手动发一遍
    await page.evaluate(({ x, y }) => {
      const card = document.querySelector('.stash-card[data-id="r3"]');
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const cm = document.querySelector('.cm-content');
      cm.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      cm.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, box);
    await pause(page, 500);
    dropped = (await getText(page)).includes('旧信');
  }
  check(dropped, '把一条拖进正文', fails);
  check(!(await page.evaluate(() => document.body.classList.contains('stash-dragging'))), '拖完正文区的虚线收掉', fails);
  await page.click('.cm-content'); await page.keyboard.press('Control+z'); await pause(page, 300);
  check(!(await getText(page)).includes('旧信'), '拖进来的字在编辑器里能撤销', fails);

  // Esc 关抽屉
  await page.click('.stash-drawer .stash-n');
  await page.keyboard.press('Escape');
  await pause(page, 200);
  check(await page.$('.side-right .stash-drawer') === null, 'Esc 关抽屉', fails);

  // ---------------- 功能自己的抽屉：只列这个功能、这一章的；「采用」交给功能 ----------------
  console.log('功能里的抽屉');
  await page.evaluate((chId) => window.__xemoStash.drawer({ feature: 'chapterName', ref: chId, title: '章名候选', onUse: (row) => { window.__used = row.text; } }), chId);
  await page.waitForSelector('.side-right .stash-drawer .stash-card');
  check((await cards('.side-right')).join() === 'r2', '只列这一章的章名候选（别的章、别的功能不出现）', fails);
  check((await page.textContent('.side-right .panel-head h3')).includes('章名候选'), '标题带上功能给的名字', fails);
  check(await page.$('.stash-drawer .stash-chips:not([hidden])') === null, '指定了功能就不显示功能筛选', fails);
  await page.click('.stash-card[data-id="r2"] .stash-use');
  await pause(page, 200);
  check((await page.evaluate(() => window.__used)) === '门铃响了' && (await page.textContent('.stash-card[data-id="r2"] .stash-use')).includes('已采用'), '「采用」调功能给的 onUse', fails);
  // 继续追问：交给对话模块（还没做时说明）
  await page.click('.stash-card[data-id="r2"] .stash-ask');
  await pause(page, 400);
  check(errors.length === 0, '继续追问不报错', fails);
  await page.keyboard.press('Escape'); await pause(page, 200);
  await page.keyboard.press('Escape'); await pause(page, 200);
  // 复制
  await page.evaluate((chId) => window.__xemoStash.drawer({ feature: 'chapterName', ref: chId }), chId);
  await page.waitForSelector('.side-right .stash-card[data-id="r2"]');
  await page.click('.stash-card[data-id="r2"] .stash-copy');
  await pause(page, 300);
  check(await page.$('.toast:has-text("已复制")') !== null, '复制', fails);

  // ---------------- 不在作品里：弹窗 ----------------
  console.log('弹窗抽屉');
  await page.click('.topbar .icon-btn[aria-label="返回"]');
  await page.waitForSelector('.shelf');
  await page.evaluate(() => window.__xemoStash.drawer({ feature: 'chat', title: '对话' }));
  await page.waitForSelector('.modal.stash-modal .stash-card');
  check((await cards('.stash-modal')).join() === 'r6', '不在作品里用弹窗，只列对话的', fails);
  check(await page.$('.stash-modal .stash-use') === null, '没有可插入的正文时不显示「采用」', fails);
  check(await page.$('.stash-modal .modal-x') !== null, '弹窗右上角有关闭', fails);
  await page.keyboard.press('Escape'); await pause(page, 200);
  check(await page.$('.stash-modal') === null, 'Esc 关弹窗', fails);

  // ---------------- 总暂存盒 ----------------
  console.log('总暂存盒');
  await palette('暂存盒');
  await page.waitForSelector('.stash-view .stash-card');
  check((await page.evaluate(() => location.hash)) === '#/stash', '书架上打开：看全部（#/stash）', fails);
  check(await page.$('.stash-view .topbar .icon-btn[aria-label="返回"]') !== null, '左上角有返回', fails);
  check((await cards('.stash-view')).length === 7, '列出全部 7 条', fails);
  const groups = await page.$$eval('.stash-group-h > span:first-child', (els) => els.map((e) => e.textContent));
  check(groups.join() === '置顶,今天,7 天内,更早', '按 置顶 / 今天 / 7 天内 / 更早 分组：' + groups.join(), fails);
  const bookOpts = await page.$$eval('.stash-book-sel option', (els) => els.map((e) => e.textContent));
  check(bookOpts.some((t) => t.startsWith('《暂存测试》')) && bookOpts.some((t) => t.startsWith('不属于作品')) && bookOpts.some((t) => t.startsWith('作品已删除')), '按作品筛：' + bookOpts.join(' / '), fails);
  await page.selectOption('.stash-book-sel', 'none');
  await pause(page, 150);
  check((await cards('.stash-view')).join() === 'r6', '只看不属于作品的', fails);
  await page.selectOption('.stash-book-sel', 'all');
  await pause(page, 150);
  await page.click('.stash-feats button[data-v="summary"]');
  await pause(page, 150);
  check((await cards('.stash-view')).sort().join() === 'r4,r5', '按功能筛：章节摘要', fails);
  await page.click('.stash-feats button[data-v="all"]');
  await page.click('.stash-when-seg button[data-v="today"]');
  await pause(page, 150);
  check((await cards('.stash-view')).sort().join() === 'r1,r2,r3', '时间：今天', fails);
  await page.click('.stash-when-seg button[data-v="week"]');
  await pause(page, 150);
  check((await cards('.stash-view')).sort().join() === 'r1,r2,r3,r6', '时间：7 天内', fails);
  await page.click('.stash-when-seg button[data-v="older"]');
  await pause(page, 150);
  check((await cards('.stash-view')).sort().join() === 'r4,r5,r7', '时间：更早', fails);
  await page.click('.stash-when-seg button[data-v="all"]');
  await page.click('.stash-toggle');
  await pause(page, 150);
  check((await cards('.stash-view')).join() === 'r5', '只看置顶', fails);
  await page.click('.stash-toggle');
  await page.fill('.stash-view .stash-q', '灵感');
  await pause(page, 300);
  check((await cards('.stash-view')).join() === 'r6', '搜索能搜到标签', fails);
  await page.fill('.stash-view .stash-q', '');
  await pause(page, 300);
  await page.click('.stash-tagbar .stash-tag[data-tag="备选"]');
  await pause(page, 150);
  check((await cards('.stash-view')).join() === 'r1', '按标签筛', fails);
  await page.click('.stash-tagbar .stash-tag[data-tag="备选"]');
  await pause(page, 150);

  // 多选删 + 顶栏撤销 / 重做
  await page.click('.stash-view .stash-sel-btn');
  await page.click('.stash-card[data-id="r6"] .stash-pick input');
  await page.click('.stash-card[data-id="r7"] .stash-pick input');
  await page.click('.stash-view .stash-del-sel');
  await pause(page, 400);
  check((await cards('.stash-view')).length === 5 && !(await rowOf('r6')), '多选删 2 条', fails);
  check(!(await page.$eval('.stash-view .topbar .icon-btn[aria-label="撤销"]', (b) => b.disabled)), '顶栏撤销按钮可用', fails);
  await page.click('.stash-view .topbar .icon-btn[aria-label="撤销"]');
  await pause(page, 400);
  check((await cards('.stash-view')).length === 7, '顶栏撤销：放回来了', fails);
  await page.click('.stash-view .topbar .icon-btn[aria-label="重做"]');
  await pause(page, 400);
  check((await cards('.stash-view')).length === 5, '重做：又删掉了', fails);
  await page.click('.stash-view .stash-n');
  await page.keyboard.press('Control+z');
  await pause(page, 400);
  check((await cards('.stash-view')).length === 7, 'Ctrl+Z 撤销', fails);

  // 按条件批量删：先显示会删几条
  await page.click('.stash-cond-btn');
  await page.waitForSelector('.stash-cond');
  const n1 = await page.textContent('.stash-cond-n');
  check(n1.includes('会删掉 2 条'), '30 天前、没置顶的：会删掉 2 条（' + n1 + '）', fails);
  await page.click('.stash-cond label.check:has-text("保留置顶的") input');
  await pause(page, 100);
  check((await page.textContent('.stash-cond-n')).includes('会删掉 3 条'), '置顶的也删：3 条', fails);
  await page.click('.stash-cond label.check:has-text("保留置顶的") input');
  await page.fill('.stash-cond-days', '45');
  await pause(page, 100);
  check((await page.textContent('.stash-cond-n')).includes('会删掉 1 条'), '45 天前：1 条', fails);
  await page.fill('.stash-cond-days', '30');
  await page.selectOption('.stash-cond select[aria-label="功能"]', 'summary');
  await pause(page, 100);
  check((await page.textContent('.stash-cond-n')).includes('会删掉 1 条'), '只删章节摘要：1 条', fails);
  await page.selectOption('.stash-cond select[aria-label="功能"]', 'all');
  await pause(page, 100);
  check((await page.textContent('.stash-cond-modal .btn.danger')).includes('删掉 2 条'), '确认按钮上写着条数', fails);
  await page.click('.stash-cond-modal .btn.danger');
  await pause(page, 500);
  check((await cards('.stash-view')).length === 5 && !(await rowOf('r4')) && !(await rowOf('r7')) && !!(await rowOf('r5')), '按条件删掉 2 条，置顶的留着', fails);
  await page.click('.toasts .toast:last-child:has-text("已删除 2 条") .toast-act');
  await pause(page, 400);
  check((await cards('.stash-view')).length === 7, '按条件删也能一步撤销', fails);
  await page.click('.stash-cond-btn');
  await page.waitForSelector('.stash-cond');
  await page.fill('.stash-cond-days', '3650');
  await pause(page, 100);
  check((await page.$eval('.stash-cond-modal .btn.danger', (b) => b.disabled)) && (await page.textContent('.stash-cond-n')).includes('没有符合条件的'), '没有符合条件的：不能点删除', fails);
  await page.keyboard.press('Escape'); await pause(page, 200);

  // ---------------- 出错：存储写不进去 ----------------
  console.log('出错');
  await page.evaluate(() => {
    window.__put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v) { if (this.name === 'stash') throw new DOMException('模拟写入失败', 'QuotaExceededError'); return window.__put.apply(this, arguments); };
  });
  await page.click('.stash-card[data-id="r1"] .stash-pin');
  await page.waitForSelector('.notice');
  const nt = await page.textContent('.notice');
  check(nt.includes('没能保存') && nt.includes('可能的原因') && (await page.$('.modal-foot .btn:has-text("重试")')) !== null, '写不进去时中文说明 + 重试', fails);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
  await page.click('.modal-foot .btn:has-text("重试")');
  await pause(page, 400);
  check((await rowOf('r1')).pinned, '重试成功', fails);
  errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('模拟写入失败')));

  // ---------------- 从作品里打开：默认只看这本书 ----------------
  await page.click('.stash-view .topbar .icon-btn[aria-label="返回"]');
  await page.waitForSelector('.shelf');
  await page.click('.book-card');
  await page.waitForSelector('.cm-content');
  await palette('暂存盒');
  await page.waitForSelector('.stash-view .stash-card');
  check((await page.evaluate(() => location.hash)) === '#/stash/' + bookId && (await page.textContent('.stash-title-bar')).includes('《暂存测试》'), '作品里打开：只看这本书', fails);
  check((await cards('.stash-view')).length === 5, '这本书 5 条', fails);
  await page.click('.stash-scope button[data-v="all"]');
  await page.waitForSelector('.stash-book-sel');
  check((await cards('.stash-view')).length === 7, '切到全部作品', fails);
  await page.click('.stash-view .topbar .icon-btn[aria-label="返回"]');
  await page.waitForSelector('.cm-content');
  check(true, '返回回到作品', fails);

  // ---------------- 六套风格形态不同、深色正常 ----------------
  console.log('风格');
  await palette('暂存盒');
  await page.waitForSelector('.stash-view .stash-card');
  const sig = await page.evaluate(() => {
    const root = document.documentElement;
    const was = root.dataset.paper;
    const out = {};
    for (const p of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
      root.dataset.paper = p;
      const c = document.querySelector('.stash-card');
      const cs = getComputedStyle(c), b = getComputedStyle(c, '::before'), a = getComputedStyle(c, '::after');
      const g = getComputedStyle(document.querySelector('.stash-group-h'), '::before');
      const btn = getComputedStyle(document.querySelector('.stash-acts .btn'));
      out[p] = [cs.borderRadius, cs.clipPath, cs.borderLeftWidth, a.content, a.width, b.content, g.content, g.width, g.transform, btn.borderRadius, btn.clipPath].join('|');
    }
    root.dataset.paper = was;
    return out;
  });
  check(new Set(Object.values(sig)).size === 6, '六套风格的卡片、标记、按钮形态各不相同', fails);
  const corners = await page.evaluate(() => {
    const root = document.documentElement, was = root.dataset.paper, r = [];
    for (const p of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) { root.dataset.paper = p; r.push(getComputedStyle(document.querySelector('.stash-acts .btn')).borderRadius); }
    root.dataset.paper = was;
    return r;
  });
  check(new Set(corners).size >= 5, '按钮形状按风格变：' + corners.join(' '), fails);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const dark = await page.$eval('.stash-card', (c) => getComputedStyle(c).color);
  check(dark !== 'rgb(44, 33, 39)', '深色模式字色跟着变：' + dark, fails);
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  // ---------------- 手机宽度 ----------------
  console.log('手机');
  await page.setViewportSize({ width: 390, height: 844 });
  await pause(page, 300);
  const over1 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, main: document.querySelector('.stash-main').scrollWidth - document.querySelector('.stash-main').clientWidth }));
  check(over1.doc <= 390 && over1.main <= 0, '总暂存盒在 390px 不横向溢出：' + JSON.stringify(over1), fails);
  await page.click('.stash-cond-btn');
  await page.waitForSelector('.stash-cond');
  const over2 = await page.evaluate(() => document.documentElement.scrollWidth);
  check(over2 <= 390, '按条件删的弹窗不溢出', fails);
  await page.keyboard.press('Escape'); await pause(page, 200);
  await page.click('.stash-view .topbar .icon-btn[aria-label="返回"]');
  await page.waitForSelector('.cm-content');
  await palette('打开暂存盒抽屉');
  await page.waitForSelector('.side-right .stash-card');
  const over3 = await page.evaluate(() => {
    const r = document.querySelector('.side-right'), d = document.querySelector('.stash-drawer');
    return { shown: getComputedStyle(r).display !== 'none' && r.getBoundingClientRect().height > 100, doc: document.documentElement.scrollWidth, d: d.scrollWidth - d.clientWidth,
      center: document.querySelector('.center').getBoundingClientRect().height > 80 };
  });
  check(over3.shown && over3.center && over3.doc <= 390 && over3.d <= 0, '手机上抽屉在下半屏、正文在上半屏、不溢出：' + JSON.stringify(over3), fails);
  await page.keyboard.press('Escape'); await pause(page, 200);
  await page.setViewportSize({ width: 1360, height: 860 });

  // ---------------- 主题彩蛋：暂存盒 → 恶魔口袋 ----------------
  await idb((db) => new Promise((res) => {
    const s = db.transaction(['kv'], 'readwrite').objectStore('kv');
    const q = s.get('settings');
    q.onsuccess = () => { const v = (q.result && q.result.value) || {}; v.themeNames = true; s.put({ key: 'settings', value: v }).onsuccess = res; };
  }));
  await page.reload(); await page.waitForSelector('.topbar');
  await page.evaluate(() => { location.hash = '#/stash'; });
  await page.waitForSelector('.stash-view');
  check((await page.textContent('.stash-title-bar')).includes('恶魔口袋'), '主题彩蛋：标题变成「恶魔口袋」', fails);

  // ---------------- 读不出来 ----------------
  await page.evaluate(() => {
    window.__getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function () { if (this.name === 'stash') throw new DOMException('模拟读取失败', 'UnknownError'); return window.__getAll.apply(this, arguments); };
  });
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('.shelf');
  await page.evaluate(() => { location.hash = '#/stash'; });
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('读不出来'), '读不出来时中文说明', fails);
  await page.evaluate(() => { IDBObjectStore.prototype.getAll = window.__getAll; });
  await page.click('.modal-foot .btn:has-text("重试")');
  await pause(page, 400);
  check((await cards('.stash-view')).length === 7, '重试后读出来了', fails);
  errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('模拟读取失败')));

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
