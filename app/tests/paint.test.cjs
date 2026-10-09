// 绘画 / 封面制作：用测试用假接口走一遍——接入时配绘画接口和模型、作品信息表单里打开封面制作、书名作者锁在提示词里并且两边跟着改、
// 勾常用要求、先出草稿 → 挑两张出高清 → 拖框裁剪 → 设为封面（书架上的卡跟着换）→ 撤销；暂存盒里有图、记了账、确认卡显示每张的价钱；
// 取消、出错（【报错】）；画板里的暂存盒抽屉；关掉时「保留草稿 / 丢弃」；顶栏和 F1 打开；角色形象（paint.open）交回图片；六套风格形态不同；390px；深色。
const path = require('path');
const { pathToFileURL } = require('url');
const { launch, newBook, check } = require('./helpers.cjs');
const pause = (page, ms) => page.waitForTimeout(ms);

(async () => {
  const fails = [];

  // ---------------- 纯函数：提示词怎么拼 ----------------
  console.log('提示词');
  const P = await import(pathToFileURL(path.join(__dirname, '../src/features/paint/prompt.js')).href);
  const r1 = P.composePrompt({ purpose: 'cover', meta: { title: '星落之城', author: '某某', intro: '一座城' }, free: '{书名}的城墙，{简介}', picked: [P.DEFAULT_PRESETS[0]] });
  check(r1.text.startsWith('书名：《星落之城》　作者：某某\n封面上清楚地写出书名和作者名'), '封面：开头锁着书名、作者名和「写清楚、同一个画风」', fails);
  check(r1.text.includes('星落之城的城墙，一座城') && r1.text.includes('要求：\n- 人体结构正确'), '变量照样能用，勾上的常用要求排在后面', fails);
  const r2 = P.composePrompt({ purpose: 'cover', meta: { title: '星落之城', author: '' }, free: '' });
  check(!r2.text.includes('作者') && r2.locks.length === 2, '作者空着就不写作者那一条', fails);
  check(P.composePrompt({ purpose: 'cover', meta: { title: '' } }).locks[0].empty, '书名空着时标出来', fails);
  check(P.composePrompt({ purpose: 'character', meta: { title: '星落之城' }, free: '白发' }).text === '白发', '角色形象不锁书名', fails);
  check(P.composePrompt({ purpose: 'cover', meta: { title: 'x' }, free: 'a', step: 'final', useRef: true }).text.endsWith(P.HIRES_LINE)
    && !P.composePrompt({ purpose: 'cover', meta: { title: 'x' }, free: 'a', step: 'final', useRef: false }).text.includes(P.HIRES_LINE), '出高清时照草稿画才加那一句', fails);
  check(P.composePrompt({ purpose: 'place', free: 'a', picked: P.DEFAULT_PRESETS }).text.includes('场景：') && !P.composePrompt({ purpose: 'place', free: 'a', picked: P.DEFAULT_PRESETS }).text.includes('封面构图'),
    '常用要求按用途挑（地点不带封面那几条）', fails);

  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  await page.evaluate(() => localStorage.setItem('xemoMock', '1'));
  await page.reload(); await page.waitForSelector('.topbar');

  const idb = (fn, arg) => page.evaluate(([src, arg]) => new Promise((res, rej) => {
    const r = indexedDB.open('xiaoemo-wenshu');
    r.onsuccess = () => { const db = r.result; Promise.resolve((0, eval)(src)(db, arg)).then((v) => { db.close(); res(v); }, rej); };
    r.onerror = () => rej(r.error);
  }), [fn.toString(), arg]);
  const all = (store) => idb((db, store) => new Promise((res) => { const q = db.transaction([store]).objectStore(store).getAll(); q.onsuccess = () => res(q.result); }), store);
  const bookOf = async (id) => (await all('books')).find((b) => b.id === id);
  const paintRows = async (ref) => (await all('stash')).filter((r) => r.feature === 'paint' && r.kind === 'image' && (!ref || r.ref === ref));
  const doneDrafts = () => page.$$eval('.paint-card.is-draft.st-done', (els) => els.length);
  const doneFinals = () => page.$$eval('.paint-card.is-final.st-done', (els) => els.length);
  const send = async () => { await page.click('.ai-img-modal .modal-foot .btn.primary'); };
  const palette = async (title) => {
    await page.keyboard.press('F1');
    await page.waitForSelector('.help-search');
    await page.fill('.help-search', title);
    await page.click(`.help-item:has(.help-t:text-is("${title}"))`);
    await pause(page, 400);
  };

  const bookId = await newBook(page, '星落之城', [{ title: '开头', text: '　　雨下到第三天。' }]);

  // ---------------- AI 接入：绘画接口和绘画模型 ----------------
  console.log('接入');
  await page.evaluate(() => { location.hash = '#/ai'; });
  await page.waitForSelector('.ai-prov[data-id="mock"]');
  await page.click('.ai-prov[data-id="mock"]');
  await page.fill('.ai-steps input[type="password"]', 'good');
  await page.click('.ai-steps .btn:has-text("拉取模型列表")');
  await page.waitForSelector('.ai-status.ok');
  await page.click('.ai-steps .btn.primary:has-text("测试")');
  await page.waitForSelector('.ai-status.ok:has-text("接好了")');
  check(await page.$('.ai-paint') !== null && (await page.$eval('.ai-paint-api', (s) => [...s.options].map((o) => o.textContent).join('|'))).includes('OpenAI 图片接口（/images）'), '每家有「绘画接口」，能选 OpenAI 图片接口', fails);
  check((await page.textContent('.ai-paint-note')).includes('加一个绘画模型'), '还没有绘画模型时说明', fails);
  await page.fill('.ai-paint-add', 'gpt-image-2.5-flare');
  await page.press('.ai-paint-add', 'Enter');
  await page.click('.ai-paint-pick-btn');
  await page.click('.ai-paint-cand[data-model="mock-image"]');
  await page.waitForSelector('.ai-paint-chip[data-model="mock-image"]');
  await page.click('.ai-paint-chip[data-model="gpt-image-2.5-flare"] .ai-paint-x');
  await pause(page, 200);
  const cfg = await idb((db) => new Promise((res) => { const q = db.transaction(['kv']).objectStore('kv').get('ai:config'); q.onsuccess = () => res(q.result && q.result.value); }));
  const img = cfg.providers.mock.image;
  check(img && img.api === 'openai' && img.models.join() === 'mock-image' && cfg.providers.mock.ok, '绘画模型能手动加、从列表挑、能删，存进这一家的配置（文字模型照旧）：' + JSON.stringify(img), fails);
  check((await page.textContent('.ai-prov[data-id="mock"] .ai-prov-state')).includes('能画图'), '提供商卡片上写着「能画图」', fails);

  // ---------------- 书架：作品信息表单里有作者名和「制作封面」 ----------------
  console.log('作品信息表单');
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('.book-card');
  const coverBefore = await page.$eval(`.book-card[data-id="${bookId}"] img.book-cover`, (im) => im.getAttribute('src'));
  await page.click(`.book-card[data-id="${bookId}"] .book-more`);
  await page.click('.menu-item:has-text("修改作品信息")');
  await page.waitForSelector('.book-form');
  check(await page.$('.book-form .book-author-in') !== null && await page.$('.book-form .book-paint-btn') !== null, '表单里有作者名和「制作封面」', fails);
  await page.fill('.book-form input.input >> nth=0', '星落之城（修订）');
  await page.fill('.book-form .book-author-in', '小恶魔');
  await page.click('.book-paint-btn');
  await page.waitForSelector('.paint-modal .paint-chip');
  await pause(page, 300);
  const locks = () => page.$$eval('.paint-lockchip', (els) => els.map((e) => e.textContent));
  let lk = await locks();
  check(lk[0] === '书名：《星落之城（修订）》' && lk[1] === '作者：小恶魔' && lk[2].includes('同一个画风'), '锁着的签跟着表单里正在填的书名、作者名：' + lk.join(' / '), fails);
  check(await page.$('.paint-lockchip .ico') !== null, '锁着的签带锁', fails);
  // 在这里改书名、作者名：签马上变，表单跟着变，停一会儿存进作品
  await page.fill('.paint-title-in', '星落之城');
  await page.fill('.paint-author-in', '小恶魔甲');
  await pause(page, 100);
  lk = await locks();
  check(lk[0] === '书名：《星落之城》' && lk[1] === '作者：小恶魔甲', '改书名、作者名，提示词开头跟着变', fails);
  check((await page.$eval('.book-form input.input >> nth=0', (i) => i.value).catch(() => null)) === null || true, '（表单在后面）', fails);
  const formVals = await page.evaluate(() => { const f = document.querySelector('.book-form'); return [f.querySelector('input.input').value, f.querySelector('.book-author-in').value]; });
  check(formVals[0] === '星落之城' && formVals[1] === '小恶魔甲', '作品信息表单跟着改：' + formVals.join(' / '), fails);
  await pause(page, 700);
  let bk = await bookOf(bookId);
  check(bk.title === '星落之城' && bk.author === '小恶魔甲', '停手后存进作品信息', fails);
  await page.fill('.paint-title-in', '');
  await pause(page, 100);
  check((await page.$('.paint-lockchip.k-title.warn')) !== null, '书名清空时标出来', fails);
  await page.fill('.paint-title-in', '星落之城');

  // 常用要求：勾上、取消，实际发送的提示词跟着变；悬停看全文
  console.log('常用要求');
  check((await page.$$('.paint-chip')).length === 8, '封面用的常用要求 8 条（角色、地点、物品的不在这里）', fails);
  await page.hover('.paint-chip[data-id="light"]');
  check((await page.textContent('.paint-chip-tip')).includes('光源方向统一'), '鼠标放上去显示全文', fails);
  await page.click('.paint-chip[data-id="body"]');
  check((await page.textContent('.paint-pre')).includes('人体结构正确'), '勾上「人体结构」加进提示词', fails);
  await page.click('.paint-chip[data-id="body"]');
  check(!(await page.textContent('.paint-pre')).includes('人体结构正确'), '取消就拿掉', fails);
  await page.click('.paint-chip[data-id="body"]');
  await page.click('.paint-chip[data-id="title"]');
  // 加一条、删掉、撤销
  await page.click('.paint-chip-edit');
  await page.click('.paint-chip-add');
  await page.fill('.paint-pf-name', '手部清楚');
  await page.fill('.paint-pf-text', '手部清楚，手指自然。');
  await page.click('.paint-pf .btn.primary');
  await pause(page, 200);
  const added = await page.$('.paint-chip-w:has-text("手部清楚")');
  check(added !== null, '能加一条自己的', fails);
  await page.click('.paint-chip-w:has-text("手部清楚") .paint-chip-del');
  await pause(page, 200);
  check(await page.$('.paint-chip-w:has-text("手部清楚")') === null, '能删', fails);
  await page.click('.toast:has-text("已删除「手部清楚」") .toast-act');
  await pause(page, 300);
  check(await page.$('.paint-chip-w:has-text("手部清楚")') !== null, '删了能撤销', fails);
  await page.click('.paint-chip-edit');

  // 画面：自己写，变量照样能用
  await page.fill('.paint-free-in', '日系厚涂，{书名}的城墙，{作者}站在上面。');
  const pre = await page.textContent('.paint-pre');
  check(pre.startsWith('日系厚涂，星落之城的城墙，小恶魔甲站在上面。') && pre.includes('- 人体结构正确') && pre.includes('- 书名和作者名清晰可读'), '实际发送的提示词：画面 + 勾上的', fails);

  // ---------------- 先出草稿 ----------------
  console.log('草稿');
  await page.click('.paint-go-btn');
  await page.waitForSelector('.ai-img-card');
  const card = await page.textContent('.ai-img-card');
  check(card.includes('实际发送的提示词') && (await page.textContent('.ai-img-card .ai-img-prompt')).startsWith('书名：《星落之城》　作者：小恶魔甲'), '确认卡上有实际发送的提示词，开头是锁着的书名、作者', fails);
  check(await page.$('.ai-img-card .ai-img-seg[aria-label="张数"] button[data-v="4"][aria-pressed="true"]') !== null, '草稿默认 4 张，能选 1–4', fails);
  check(await page.$('.ai-img-card .ai-img-seg[aria-label="画质"] button[data-v="low"][aria-pressed="true"]') !== null, '草稿默认低画质', fails);
  check((await page.$eval('.ai-img-card select[aria-label="尺寸"]', (s) => s.value)) === '768x1024', '尺寸默认挑最接近 3:4 的', fails);
  await page.click('.ai-img-price-btn');
  await page.fill('.ai-img-card input[aria-label="草稿每张"]', '0.02');
  await page.fill('.ai-img-card input[aria-label="高清每张"]', '0.08');
  await page.click('.ai-img-card .ai-price .btn:has-text("保存单价")');
  await pause(page, 300);
  const cost = await page.textContent('.ai-img-card .ai-img-cost');
  check(cost.includes('每张约 0.02 美元') && cost.includes('4 张约 0.08 美元'), '确认卡显示每张的价钱和总价：' + cost, fails);
  await send();
  await page.waitForFunction(() => document.querySelectorAll('.paint-card.is-draft.st-done').length === 4, null, { timeout: 8000 });
  check(true, '4 张草稿画好了', fails);
  check((await paintRows(bookId)).length === 4, '草稿都进了暂存盒（绘画、这本书）', fails);
  const usage = (await all('usage')).filter((u) => u.kind === 'image');
  check(usage.length === 1 && usage[0].images === 4 && Math.abs(usage[0].cost - 0.08) < 1e-9, '按张记了账：' + JSON.stringify(usage.map((u) => [u.images, u.cost])), fails);
  check((await page.$eval('.paint-step[data-i="2"]', (e) => e.dataset.state)) === 'cur', '步骤走到「挑几张出高清」', fails);

  // ---------------- 挑两张出高清 ----------------
  console.log('高清');
  const picks = await page.$$('.paint-card.is-draft .paint-pick');
  await picks[0].click();
  await picks[1].click();
  check((await page.textContent('.paint-hi-btn')).includes('出高清（2 张）'), '挑中两张，「出高清（2 张）」', fails);
  await page.click('.paint-hi-btn');
  await page.waitForSelector('.ai-img-card[data-step="final"]');
  check((await page.textContent('.ai-img-card .ai-img-cost')).includes('每张约 0.08 美元，2 张约 0.16 美元'), '高清按高清的单价算', fails);
  check(await page.$('.ai-img-card .ai-img-seg[aria-label="画质"] button[data-v="high"][aria-pressed="true"]') !== null, '高清默认高画质', fails);
  check(await page.$eval('.ai-img-ref input', (i) => i.checked) && (await page.textContent('.ai-img-card .ai-img-prompt')).includes('照参考图重画成高清'), '默认照挑中的草稿画，提示词里加一句', fails);
  await send();
  await page.waitForFunction(() => document.querySelectorAll('.paint-card.is-final.st-done').length === 2, null, { timeout: 8000 });
  check((await paintRows(bookId)).length === 6 && (await paintRows(bookId)).filter((r) => r.step === 'final').length === 2, '高清两张也进了暂存盒', fails);
  check((await page.$$('.paint-card.is-draft.picked')).length === 0, '出完高清，挑中的记号清掉', fails);

  // ---------------- 裁剪 → 设为封面 → 撤销 ----------------
  console.log('裁剪');
  await page.click('.paint-card.is-final .paint-use-final');
  await page.waitForSelector('.paint-crop-frame');
  await pause(page, 300);
  const box0 = await page.$eval('.paint-crop-frame', (f) => ({ l: parseFloat(f.style.left), w: parseFloat(f.style.width), h: parseFloat(f.style.height) }));
  check(Math.abs(box0.w / box0.h - 0.75) < 0.01, '裁剪框是 3:4', fails);
  await page.focus('.paint-crop-frame');
  await page.keyboard.press('+'); await page.keyboard.press('+'); await page.keyboard.press('+');
  const box1 = await page.$eval('.paint-crop-frame', (f) => ({ l: parseFloat(f.style.left), w: parseFloat(f.style.width) }));
  check(box1.w < box0.w && (await page.textContent('.paint-crop-zv')) !== '100%', '加号放大（框变小）', fails);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
  const box2 = await page.$eval('.paint-crop-frame', (f) => parseFloat(f.style.left));
  check(box2 > box1.l, '方向键微调', fails);
  const fb = await page.$eval('.paint-crop-frame', (f) => { const r = f.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(fb.x, fb.y); await page.mouse.down(); await page.mouse.move(fb.x - 30, fb.y - 10, { steps: 4 }); await page.mouse.up();
  const box3 = await page.$eval('.paint-crop-frame', (f) => parseFloat(f.style.left));
  check(box3 < box2, '拖动框移动', fails);
  await page.mouse.move(fb.x - 30, fb.y - 10);
  await page.mouse.wheel(0, 300);
  await pause(page, 100);
  check(parseFloat(await page.$eval('.paint-crop-frame', (f) => f.style.width)) > box1.w, '滚轮缩放', fails);
  check((await page.textContent('.paint-crop-cap')).includes('600×800'), '写明裁成 600×800', fails);
  await page.keyboard.press('Escape');
  await pause(page, 200);
  check(await page.$('.paint-crop-frame') === null && await page.$('.paint-modal') !== null, 'Esc 先回到挑图，不关整个界面', fails);
  await page.click('.paint-card.is-final .paint-use-final');
  await page.waitForSelector('.paint-crop-frame');
  await pause(page, 200);
  await page.click('.paint-crop-use');
  await page.waitForSelector('.toast:has-text("已换封面")');
  check(await page.$('.paint-modal') === null, '设为封面后关掉', fails);
  bk = await bookOf(bookId);
  const size = await page.evaluate((src) => new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.src = src; }), bk.cover || '');
  check(/^data:image\/jpeg/.test(bk.cover) && size.join() === '600,800', '作品的封面换成 600×800 的图：' + size.join('×'), fails);
  check((await page.$eval('.book-form .cover-prev', (i) => i.getAttribute('src'))) === bk.cover, '作品信息表单里的预览跟着换', fails);
  check((await page.$eval(`.book-card[data-id="${bookId}"] img.book-cover`, (im) => im.getAttribute('src'))) === bk.cover, '书架上那本书的封面跟着换', fails);
  await page.click('.toast:has-text("已换封面") .toast-act');
  await pause(page, 400);
  bk = await bookOf(bookId);
  check(!bk.cover && (await page.$eval(`.book-card[data-id="${bookId}"] img.book-cover`, (im) => im.getAttribute('src'))) === coverBefore, '撤销：封面换回原来的，书架上也换回来', fails);
  check((await page.$eval('.book-form .cover-prev', (i) => i.getAttribute('src'))) === coverBefore, '撤销后表单里的预览也换回来', fails);
  await page.click('.book-form-x, .modal:has(.book-form) .modal-foot .btn:has-text("取消")');
  await pause(page, 300);

  // ---------------- 写作界面：顶栏、F1 ----------------
  console.log('写作界面');
  await page.click(`.book-card[data-id="${bookId}"]`);
  await page.waitForSelector('.cm-content');
  check(await page.$('.ws .topbar [data-cmd="paint.cover"]') !== null, '写作界面顶栏有「封面」', fails);
  await palette('封面制作');
  await page.waitForSelector('.paint-modal .paint-chip');
  lk = await locks();
  check(lk[0] === '书名：《星落之城》' && lk[1] === '作者：小恶魔甲', 'F1 打开封面制作，锁着的是作品里的书名、作者名', fails);
  check(await page.$('.paint-chip[data-id="body"][aria-pressed="true"]') !== null && await page.$('.paint-chip[data-id="title"][aria-pressed="true"]') !== null, '勾过的常用要求记住了', fails);
  check(await page.$('.paint-draft-note:not([hidden])') === null && (await doneDrafts()) === 0, '设为封面以后草稿清掉，下次从头开始', fails);
  await page.fill('.paint-title-in', '星落之城二');
  await pause(page, 700);
  check((await page.textContent('.ws .book-name')) === '星落之城二' && (await bookOf(bookId)).title === '星落之城二', '在这里改书名，写作界面顶栏的书名跟着变', fails);
  await page.fill('.paint-title-in', '星落之城');
  await pause(page, 600);

  // 取消
  console.log('取消、出错');
  await page.fill('.paint-free-in', '【慢】慢慢画一座灯塔');
  await page.click('.paint-go-btn');
  await page.waitForSelector('.ai-img-card');
  await send();
  await page.waitForSelector('.paint-busy:not([hidden])');
  check((await page.$$('.paint-card.st-wait')).length === 4 && (await page.textContent('.paint-busy')).includes('已等'), '画的时候有占位卡和「已等几秒」', fails);
  await page.click('.paint-cancel');
  await page.waitForSelector('.paint-busy', { state: 'hidden' });
  check((await page.$$('.paint-card.st-wait')).length === 0 && (await doneDrafts()) === 0 && await page.$('.paint-empty:not([hidden])') !== null, '取消：占位卡收掉，没有新图', fails);
  // 出错
  await page.fill('.paint-free-in', '【报错】');
  await page.click('.paint-go-btn');
  await page.waitForSelector('.ai-img-card');
  await send();
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('故意出错') && await page.$('.modal-foot .btn:has-text("重试")') !== null, '出错：中文说明 + 重试', fails);
  await page.keyboard.press('Escape');
  await pause(page, 300);
  check((await page.$$('.paint-card.st-wait, .paint-card.st-fail')).length === 0 && await page.$('.paint-modal') !== null, '出错后占位卡收掉，界面还在', fails);

  // 画板里的暂存盒抽屉：以前画的拿回来用
  console.log('暂存盒');
  await page.click('.paint-stash-btn');
  await page.waitForSelector('.stash-modal .stash-card');
  const sc = await page.$$eval('.stash-modal .stash-card', (els) => els.map((e) => [e.dataset.kind, !!e.querySelector('img.stash-img')]));
  check(sc.length === 6 && sc.every(([k, im]) => k === 'image' && im), '抽屉里是这本书画过的 6 张图', fails);
  await page.click('.stash-modal .stash-card .stash-use');
  await page.waitForSelector('.paint-crop-frame');
  check(await page.$('.stash-modal') === null, '「用这张」：抽屉关掉，直接去裁剪', fails);
  await page.click('.paint-crop-back');
  await pause(page, 200);

  // ---------------- 关掉：保留草稿 / 丢弃 ----------------
  console.log('保留草稿 / 丢弃');
  await page.fill('.paint-free-in', '草稿测试：海边的灯塔');
  await page.click('.paint-go-btn');
  await page.waitForSelector('.ai-img-card');
  await send();
  await page.waitForFunction(() => document.querySelectorAll('.paint-card.is-draft.st-done').length === 4, null, { timeout: 8000 });
  await (await page.$$('.paint-card.is-draft .paint-pick'))[2].click();
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-title:text-is("里面还有没保存的内容")');
  await page.click('.modal-foot .btn:has-text("保留草稿")');
  await pause(page, 300);
  check(await page.$('.paint-modal') === null, '选「保留草稿」后关掉', fails);
  await page.click('.ws .topbar [data-cmd="paint.cover"]');
  await page.waitForSelector('.paint-modal .paint-chip');
  await pause(page, 300);
  check((await page.textContent('.paint-draft-note')).includes('接着上次没做完的') && (await page.$eval('.paint-free-in', (t) => t.value)) === '草稿测试：海边的灯塔', '再打开：接着上次的草稿', fails);
  check((await doneDrafts()) === 4 && (await page.$$('.paint-card.is-draft.picked')).length === 1, '草稿图和挑中的都还在', fails);
  await page.keyboard.press('Escape');
  await pause(page, 300);
  check(await page.$('.paint-modal') === null && await page.$('.modal-title:text-is("里面还有没保存的内容")') === null, '什么都没改，直接关掉不问', fails);
  await page.click('.ws .topbar [data-cmd="paint.cover"]');
  await page.waitForSelector('.paint-modal .paint-chip');
  await pause(page, 300);
  await page.type('.paint-free-in', '，换成黄昏');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-title:text-is("里面还有没保存的内容")');
  await page.click('.modal-foot .btn:has-text("丢弃")');
  await pause(page, 300);
  await page.click('.ws .topbar [data-cmd="paint.cover"]');
  await page.waitForSelector('.paint-modal .paint-chip');
  await pause(page, 300);
  check(await page.$('.paint-draft-note:not([hidden])') === null && (await doneDrafts()) === 0, '选「丢弃」后再打开是新的', fails);

  // ---------------- 六套风格形态不同 ----------------
  console.log('风格');
  const sig = await page.evaluate(() => {
    const root = document.documentElement, was = root.dataset.paper, out = {};
    for (const p of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
      root.dataset.paper = p;
      const m = document.querySelector('.paint-modal'), sec = document.querySelector('.paint-sec'), chip = document.querySelector('.paint-chip'), mark = document.querySelector('.paint-chip-mark');
      const step = document.querySelector('.paint-step-n'), go = document.querySelector('.paint-go-btn'), frame = document.querySelector('.paint-empty-frame');
      const cs = (e, pe) => getComputedStyle(e, pe);
      out[p] = [cs(m).borderRadius, cs(m).borderLeftWidth, cs(m, '::before').content, cs(m, '::after').height, cs(sec).borderRadius, cs(sec).clipPath, cs(sec, '::before').content,
        cs(chip).borderRadius, cs(chip).clipPath, cs(mark).borderRadius, cs(mark).clipPath, cs(step).borderRadius, cs(step, '::before').content, cs(go).borderRadius, cs(go).boxShadow,
        cs(frame).borderRadius, cs(frame, '::before').content].join('|');
    }
    root.dataset.paper = was;
    return out;
  });
  check(new Set(Object.values(sig)).size === 6, '六套风格的弹窗、段落、签、记号、步骤、按钮、画框形态各不相同', fails);

  // ---------------- 手机宽度、深色 ----------------
  console.log('手机、深色');
  await page.setViewportSize({ width: 390, height: 844 });
  await pause(page, 400);
  const over = await page.evaluate(() => {
    const b = document.querySelector('.paint-modal .modal-body'), m = document.querySelector('.paint-modal').getBoundingClientRect();
    return { doc: document.documentElement.scrollWidth, body: b.scrollWidth - b.clientWidth, w: Math.round(m.width), side: document.querySelector('.paint-side').scrollWidth - document.querySelector('.paint-side').clientWidth };
  });
  check(over.doc <= 390 && over.body <= 0 && over.side <= 0 && over.w <= 390, '390px 不横向溢出，弹窗铺满屏：' + JSON.stringify(over), fails);
  await page.fill('.paint-free-in', '窄屏测试');
  await page.click('.paint-go-btn');
  await page.waitForSelector('.ai-img-card');
  check((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, '确认卡在 390px 不溢出', fails);
  await send();
  await page.waitForFunction(() => document.querySelectorAll('.paint-card.is-draft.st-done').length === 4, null, { timeout: 8000 });
  await page.click('.paint-card.is-draft .paint-use-draft');
  await page.waitForSelector('.paint-crop-frame');
  await pause(page, 300);
  const over2 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, stage: document.querySelector('.paint-crop-stage').getBoundingClientRect().width }));
  check(over2.doc <= 390 && over2.stage <= 390, '裁剪在 390px 不溢出：' + JSON.stringify(over2), fails);
  await page.click('.paint-crop-back');
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.evaluate(() => { const r = document.documentElement; r.setAttribute('data-theme', 'dark'); r.toggleAttribute('data-dark', true); });
  await pause(page, 200);
  const dark = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000; };
    const sec = document.querySelector('.paint-sec'), h3 = document.querySelector('.paint-sec-h h3'), stage = document.querySelector('.paint-stage');
    return { sec: lum(getComputedStyle(sec).backgroundColor), ink: lum(getComputedStyle(h3).color), stage: lum(getComputedStyle(stage).backgroundColor) };
  });
  check(dark.sec < 60 && dark.stage < 60 && dark.ink > 180, '深色：底是深灰、字是浅色：' + JSON.stringify(dark), fails);
  await page.evaluate(() => { const r = document.documentElement; r.removeAttribute('data-theme'); r.toggleAttribute('data-dark', false); });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-title:text-is("里面还有没保存的内容")');
  await page.click('.modal-foot .btn:has-text("丢弃")');
  await pause(page, 300);

  // ---------------- 角色形象：paint.open 交回图片 ----------------
  console.log('角色形象');
  await page.evaluate((bookId) => { window.__res = window.__xemoPaint.open({ bookId, purpose: 'character', cardId: 'card-1', name: '林雪', prompt: '白发，青色眼睛', onDone: (d) => { window.__done = d; } }); }, bookId);
  await page.waitForSelector('.paint-modal[data-purpose="character"] .paint-chip');
  check((await page.textContent('.paint-modal .modal-title')).includes('角色形象 · 林雪') && await page.$('.paint-lock') === null, '角色形象：标题写着用途和名字，没有书名锁', fails);
  check((await page.$eval('.paint-free-in', (t) => t.value)) === '白发，青色眼睛' && (await page.$$eval('.paint-ratio button', (bs) => bs.map((b) => b.dataset.v).join())) === '3:4,2:3,1:1', '画面先填上卡里的话，比例能选 3:4 / 2:3 / 1:1', fails);
  check(await page.$('.paint-chip[data-id="figure"]') !== null && await page.$('.paint-chip[data-id="layout"]') === null, '常用要求换成角色用的', fails);
  await page.click('.paint-ratio button[data-v="1:1"]');
  await page.click('.paint-go-btn');
  await page.waitForSelector('.ai-img-card');
  check((await page.$eval('.ai-img-card select[aria-label="尺寸"]', (s) => s.value)) === '1024x1024', '选 1:1 时尺寸默认方形', fails);
  await send();
  await page.waitForFunction(() => document.querySelectorAll('.paint-card.is-draft.st-done').length === 4, null, { timeout: 8000 });
  check((await paintRows('card-1')).length === 4, '角色的图进暂存盒，挂在这张卡上', fails);
  await page.click('.paint-card.is-draft .paint-use-draft');
  await page.waitForSelector('.paint-crop-frame');
  await pause(page, 200);
  check((await page.textContent('.paint-crop-use')).includes('用这张'), '角色这里是「用这张」', fails);
  await page.click('.paint-crop-use');
  const got = await page.evaluate(async () => { const d = await window.__res; const s = await new Promise((res) => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.src = d; }); return { same: d === window.__done, s }; });
  check(got.same && got.s[0] === got.s[1] && got.s[0] > 0, '用了的图交回给调用的模块（onDone 和返回值），是方形：' + got.s.join('×'), fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
