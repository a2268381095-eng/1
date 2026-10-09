// AI 对话：Ctrl+Shift+J 打开右侧栏面板、上下文长度实时显示、Ctrl+Enter 发送（不新建章节）、确认卡、流式回复、
// 继续追问带上前面的对话、提示词时存「实际发送」、复制、插入正文和撤销（提示条 / Ctrl+Z）、从这里分叉（互不影响、撤销）、
// 对话列表切换 / 改标题 / 删除和撤销、新开对话彻底清空、出错把话放回输入框、中途停止留下已回来的部分、沿用模型不再确认、
// 暂存盒就地打开和「继续追问」、草稿保留 / 丢弃、书架上用弹窗和 Ctrl+Z、六套风格形态不同、深色、手机宽度
const { launch, newBook, getText, check } = require('./helpers.cjs');
const pause = (page, ms) => page.waitForTimeout(ms);

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
  const all = (store) => idb((db, store) => new Promise((res) => { const q = db.transaction([store]).objectStore(store).getAll(); q.onsuccess = () => res(q.result); }), store);
  const chats = async () => (await all('chats')).sort((a, b) => a.createdAt - b.createdAt);
  const palette = async (title) => {
    await page.keyboard.press('F1');
    await page.waitForSelector('.help-search');
    await page.fill('.help-search', title);
    await page.click(`.help-item:has(.help-t:text-is("${title}"))`);
    await pause(page, 400);
  };
  const aiDone = (n, scope = '') => page.waitForFunction(([n, scope]) => document.querySelectorAll(scope + ' .chat-msg.ai:not(.live)').length === n && !document.querySelector('.chat.busy'), [n, scope], { timeout: 10000 });
  const confirmSend = async (prompt) => {
    await page.waitForSelector('.ai-card');
    if (prompt) await page.selectOption('.ai-card select[aria-label="提示词"]', prompt);
    await page.click('.modal-foot .btn.primary:has-text("发送")');
  };
  const toastAct = async (text) => { await page.click(`.toast:has-text("${text}") .toast-act`); await pause(page, 300); };

  // 接好测试用假接口，提示词库里放一条
  await idb((db) => new Promise((res) => {
    const t = db.transaction(['kv', 'prompts'], 'readwrite');
    t.objectStore('kv').put({ key: 'ai:config', value: { providers: { mock: { key: 'good', models: [{ id: 'mock-small', name: 'mock-small' }], testModel: 'mock-small', ok: true } }, prices: {}, cheap: null } });
    t.objectStore('prompts').put({ id: 'pr-test', name: '测试用', group: '', text: '改一改：', feature: '', order: 1, uses: 0, pinned: false });
    t.oncomplete = res;
  }));
  const bookId = await newBook(page, '对话测试', [{ title: '门铃', text: '　　雨下到第三天。门铃响了。' }]);
  const original = await getText(page);

  // ---------------- 打开 ----------------
  console.log('打开');
  check(await page.$('.ws .topbar [data-cmd="chat.new"]') !== null, '写作界面顶栏有「对话」入口', fails);
  await page.keyboard.press('Control+Shift+J');
  await page.waitForSelector('.side-right .chat');
  check((await page.textContent('.side-right .panel-head')).includes('AI 对话'), 'Ctrl+Shift+J 在右侧栏打开对话面板', fails);
  check(await page.$('.side-right .panel-head .icon-btn[aria-label="关闭"]') !== null, '面板右上角有关闭', fails);
  check(await page.$('.chat-empty') !== null && (await page.textContent('.chat-ask')).includes('发送'), '新对话是空的，按钮是「发送」', fails);
  check(await page.isVisible('.chat-new') && await page.isVisible('.chat-ask'), '「新开对话」和发送按钮常驻', fails);
  check((await page.textContent('.chat-ctx')).includes('约 0 token'), '上下文长度：约 0 token', fails);
  check(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('chat-in')), '打开后光标在输入框', fails);
  await page.fill('.chat-in', '今天写什么。想不出来。');
  const ctx1 = await page.textContent('.chat-ctx-n');
  check(/约 [1-9]\d* token/.test(ctx1), '打字时上下文长度实时变：' + ctx1, fails);

  // ---------------- 发送：确认卡 → 流式 → 存进对话、暂存盒 ----------------
  console.log('发送');
  const chBefore = await page.$$eval('.ch-item', (e) => e.length);
  await page.press('.chat-in', 'Control+Enter');
  await page.waitForSelector('.ai-card');
  check(true, 'Ctrl+Enter 发送前弹确认卡', fails);
  check((await page.textContent('.ai-card')).includes('这次说的话'), '确认卡里列出「这次说的话」', fails);
  check(!(await page.textContent('.ai-est')).includes('带上前面'), '第一句没有历史', fails);
  await confirmSend();   // 用提示词库里的「测试用」
  await aiDone(1);
  check((await page.$$eval('.ch-item', (e) => e.length)) === chBefore, 'Ctrl+Enter 不会新建章节', fails);
  const r1 = await page.textContent('.chat-msg.ai .chat-text');
  check(r1.includes('今天写什么，真的。'), '回复流式显示：' + r1.trim(), fails);
  check(await page.$('.chat-msg.user .chat-sent') !== null, '用了提示词时能看到实际发送的内容', fails);
  let cs = await chats();
  check(cs.length === 1 && cs[0].messages.length === 2 && cs[0].bookId === bookId && cs[0].title === '今天写什么。想不出来。', '对话存进 chats 表：' + JSON.stringify(cs.map((c) => [c.title, c.messages.length])), fails);
  check(cs[0].messages[0].sent && cs[0].messages[0].sent.includes('改一改') && cs[0].messages[1].model === 'mock-small' && cs[0].forkOf === null, '存了实际发送和模型', fails);
  const st1 = await all('stash');
  check(st1.length === 1 && st1[0].feature === 'chat' && st1[0].bookId === bookId, '回复进了暂存盒（对话）', fails);
  check((await page.textContent('.chat-ask')).includes('继续追问'), '有了内容后按钮是「继续追问」', fails);
  check(await page.isVisible('.chat-reuse') && (await page.textContent('.chat-reuse')).includes('mock-small'), '出现「沿用 mock-small」选项（默认不勾）', fails);

  // ---------------- 继续追问：带上前面的对话 ----------------
  console.log('继续追问');
  await page.fill('.chat-in', '再说一句。');
  await page.click('.chat-ask');
  await page.waitForSelector('.ai-card');
  const est2 = await page.textContent('.ai-est');
  check(est2.includes('带上前面 2 条对话'), '继续追问带上前面的对话：' + est2, fails);
  await confirmSend('__temp');
  await aiDone(2);
  cs = await chats();
  check(cs[0].messages.length === 4 && cs[0].messages[2].content === '再说一句。' && !cs[0].messages[2].sent, '追问存进同一个对话，提示词留空时不另存', fails);
  check((await page.textContent('.chat-ctx-k')).includes('4 条'), '上下文显示 4 条', fails);

  // ---------------- 复制、插入正文、撤销 ----------------
  console.log('插入正文');
  await page.click('.chat-msg.ai[data-i="1"] .chat-copy');
  await page.waitForSelector('.toast:has-text("复制")');
  check(true, '复制有提示', fails);
  await page.click('.chat-msg.ai[data-i="1"] .chat-insert');
  await pause(page, 500);
  check((await getText(page)).includes('今天写什么，真的。'), '插入到正文', fails);
  await toastAct('已插入正文');
  await pause(page, 400);
  check((await getText(page)) === original, '提示条撤销后恢复原文', fails);
  await page.click('.chat-msg.ai[data-i="3"] .chat-insert');
  await pause(page, 500);
  check((await getText(page)).includes('再说一句，真的。'), '再插一次', fails);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  await pause(page, 500);
  check((await getText(page)) === original, 'Ctrl+Z 一步撤销插入', fails);

  // ---------------- 分叉 ----------------
  console.log('分叉');
  const firstId = cs[0].id;
  await page.click('.chat-msg.ai[data-i="1"] .chat-fork');
  await page.waitForSelector('.chat-forknote');
  cs = await chats();
  const fork = cs.find((c) => c.forkOf);
  check(cs.length === 2 && fork && fork.messages.length === 2 && fork.forkOf.chatId === firstId && fork.forkOf.index === 1, '从第 2 条分叉出新对话', fails);
  check((await page.textContent('.chat-title')).includes('分叉'), '分叉的标题：' + await page.textContent('.chat-title'), fails);
  check((await page.$$('.chat-msg')).length === 2 && (await page.textContent('.chat-ctx-k')).includes('2 条'), '分叉后的上下文只有前 2 条', fails);
  await page.fill('.chat-in', '换个方向。');
  await page.press('.chat-in', 'Control+Enter');
  await page.waitForSelector('.ai-card');
  check((await page.textContent('.ai-est')).includes('带上前面 2 条对话'), '分叉里追问只带分叉点之前的', fails);
  await confirmSend();
  await aiDone(2);
  cs = await chats();
  const a = cs.find((c) => c.id === firstId), b = cs.find((c) => c.id === fork.id);
  check(a.messages.length === 4 && a.messages[2].content === '再说一句。' && b.messages.length === 4 && b.messages[2].content === '换个方向。', '分叉和原对话互不影响', fails);
  // 再分叉一次，撤销
  await page.click('.chat-msg.ai[data-i="3"] .chat-fork');
  await pause(page, 300);
  check((await chats()).length === 3, '分叉的分叉', fails);
  await toastAct('已分叉');
  await pause(page, 300);
  check((await chats()).length === 2 && (await page.$$('.chat-msg')).length === 4 && (await page.textContent('.chat-title')).includes('分叉'), '撤销分叉：删掉并回到原来那个', fails);
  await page.click('.chat-forkback');
  await pause(page, 300);
  check((await page.textContent('.chat-title')).includes('今天写什么') && await page.$('.chat-msg.ai[data-i="1"] .chat-forkchip') !== null, '回到原对话，分叉点上有去分叉的标记', fails);

  // ---------------- 对话列表：切换、改标题、删除、撤销 ----------------
  console.log('列表');
  await page.click('.chat-list-btn');
  await page.waitForSelector('.chat-list:not([hidden]) .chat-li');
  check((await page.$$('.chat-li')).length === 2, '列表里有这本书的 2 个对话', fails);
  await page.click(`.chat-li[data-id="${fork.id}"] .chat-li-ren`);
  await page.waitForSelector('.modal input.input');
  await page.fill('.modal input.input', '另一条路');
  await page.press('.modal input.input', 'Enter');
  await pause(page, 300);
  check((await chats()).find((c) => c.id === fork.id).title === '另一条路' && (await page.textContent('.chat-list')).includes('另一条路'), '在列表里改标题', fails);
  await toastAct('标题改好了');
  check((await chats()).find((c) => c.id === fork.id).title.includes('分叉'), '撤销改标题', fails);
  await page.click(`.chat-li[data-id="${fork.id}"] .chat-li-del`);
  await pause(page, 300);
  check((await chats()).length === 1 && (await page.$$('.chat-li')).length === 1, '删除对话', fails);
  await toastAct('已删除对话');
  await pause(page, 200);
  check((await chats()).length === 2 && (await page.$$('.chat-li')).length === 2, '「已删除 · 撤销」恢复', fails);
  await page.keyboard.press('Escape');
  await pause(page, 200);
  check(await page.$('.chat-list[hidden]') !== null && await page.$('.side-right .chat') !== null, 'Esc 先收起列表，面板还在', fails);
  await page.click('.chat-list-btn');
  await page.click(`.chat-li[data-id="${fork.id}"] .chat-li-main`);
  await pause(page, 300);
  check((await page.textContent('.chat-title')).includes('分叉') && (await page.$$('.chat-msg')).length === 4, '从列表切换对话', fails);
  await page.click('.chat-title');
  await page.waitForSelector('.modal input.input');
  await page.fill('.modal input.input', '换方向');
  await page.press('.modal input.input', 'Enter');
  await pause(page, 300);
  check((await page.textContent('.chat-title')).includes('换方向'), '点标题改名', fails);

  // ---------------- 新开对话、出错 ----------------
  console.log('新开对话');
  await page.click('.chat-new');
  await pause(page, 200);
  check(await page.$('.chat-empty') !== null && (await page.$$('.chat-msg')).length === 0 && (await page.textContent('.chat-ctx')).includes('约 0 token'), '新开对话彻底清空上下文', fails);
  check((await page.$$('.chat-recent-i')).length === 2, '空对话里列出可以接着聊的', fails);
  await page.fill('.chat-in', '【报错】');
  await page.press('.chat-in', 'Control+Enter');
  await confirmSend();
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('故意出错') && await page.$('.modal-foot .btn:has-text("重试")') !== null, '出错时中文说明 + 重试', fails);
  await page.click('.modal-foot .btn:has-text("知道了")');
  await pause(page, 300);
  check((await page.inputValue('.chat-in')) === '【报错】' && (await page.$$('.chat-msg')).length === 0 && (await chats()).length === 2, '出错后这句话放回输入框，不留半截', fails);
  // 取消确认卡也一样
  await page.fill('.chat-in', '算了不问了。');
  await page.press('.chat-in', 'Control+Enter');
  await page.waitForSelector('.ai-card');
  await page.click('.modal-foot .btn:has-text("取消")');
  await pause(page, 300);
  check((await page.inputValue('.chat-in')) === '算了不问了。' && (await page.$$('.chat-msg')).length === 0, '取消确认卡，话还在输入框里', fails);

  // ---------------- 中途停止 ----------------
  console.log('停止');
  const stashN = (await all('stash')).length;
  await page.fill('.chat-in', '一二三四五六七八九十。'.repeat(40));
  await page.press('.chat-in', 'Control+Enter');
  await confirmSend();
  await page.waitForFunction(() => { const t = document.querySelector('.chat-msg.ai.live .chat-text'); return t && t.textContent.length > 12; });
  check(await page.isVisible('.chat-stop') && await page.isDisabled('.chat-ask') && await page.isVisible('.chat-ask'), '回复时有「停止」，两个按钮还在（暂时不能点）', fails);
  await page.click('.chat-stop');
  await page.waitForSelector('.chat-msg.ai .chat-stopped');
  cs = await chats();
  const stopped = cs[cs.length - 1];
  check(cs.length === 3 && stopped.messages.length === 2 && stopped.messages[1].stopped && stopped.messages[1].content.length < 500, '停止后留下已经回来的部分：' + (stopped.messages[1] || {}).content?.length, fails);
  check((await all('stash')).length === stashN, '停下的不进暂存盒', fails);
  check(!(await page.isVisible('.chat-stop')) && !(await page.isDisabled('.chat-ask')), '停止后按钮恢复', fails);

  // ---------------- 沿用模型，不再确认 ----------------
  await page.check('.chat-reuse input');
  await page.fill('.chat-in', '不用确认了。');
  await page.press('.chat-in', 'Control+Enter');
  await aiDone(2);
  check(await page.$('.ai-card') === null && (await page.textContent('.chat-msg.ai[data-i="3"] .chat-text')).includes('不用确认了，真的。'), '勾上「沿用」后直接发送', fails);
  await page.uncheck('.chat-reuse input');

  // ---------------- 暂存盒就地打开，「继续追问」接回对话 ----------------
  console.log('暂存盒');
  await page.click('.chat-stash');
  await page.waitForSelector('.stash-modal .stash-card');
  check(await page.$('.side-right .chat') !== null, '暂存盒在对话上面打开，对话面板还在', fails);
  const nCards = (await page.$$('.stash-modal .stash-card')).length;
  check(nCards === (await all('stash')).filter((r) => r.feature === 'chat').length, '抽屉里只列对话的结果：' + nCards, fails);
  const nChats = (await chats()).length;
  await page.click('.stash-modal .stash-card:first-child .stash-ask');
  await pause(page, 500);
  cs = await chats();
  check(cs.length === nChats + 1 && await page.$('.stash-modal') === null && (await page.$$('.chat-msg')).length === 2, '「继续追问」新建一个以那条结果开头的对话，抽屉收起', fails);
  await page.fill('.chat-in', '接着问。');
  await page.press('.chat-in', 'Control+Enter');
  await page.waitForSelector('.ai-card');
  check((await page.textContent('.ai-est')).includes('带上前面 2 条对话'), '从暂存盒接回来的对话能继续追问', fails);
  await page.click('.modal-foot .btn:has-text("取消")');
  await pause(page, 200);

  // ---------------- 草稿：保留 / 丢弃 ----------------
  console.log('草稿');
  await page.fill('.chat-in', '没写完的话');
  await page.click('.side-right .panel-head .icon-btn[aria-label="关闭"]');
  await page.waitForSelector('.modal:has-text("保留草稿")');
  await page.click('.modal-foot .btn:has-text("保留草稿")');
  await pause(page, 300);
  check(await page.$('.side-right .chat') === null, '关掉面板', fails);
  await page.click('.ws .topbar [data-cmd="chat.new"]');
  await page.waitForSelector('.side-right .chat');
  await pause(page, 200);
  check((await page.inputValue('.chat-in')) === '没写完的话', '再打开草稿还在', fails);
  await page.focus('.chat-in');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal:has-text("保留草稿")');
  await page.click('.modal-foot .btn:has-text("丢弃")');
  await pause(page, 300);
  await palette('打开 AI 对话');
  await page.waitForSelector('.side-right .chat');
  await pause(page, 200);
  check((await page.inputValue('.chat-in')) === '', '选了丢弃，草稿清掉', fails);
  check((await page.$$('.chat-msg')).length > 0, '「打开 AI 对话」接着上次的对话', fails);

  // ---------------- 六套风格形态不同、深色 ----------------
  console.log('风格');
  const sig = await page.evaluate(() => {
    const root = document.documentElement, was = root.dataset.paper, out = {};
    for (const p of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
      root.dataset.paper = p;
      const ai = getComputedStyle(document.querySelector('.chat-msg.ai')), aa = getComputedStyle(document.querySelector('.chat-msg.ai'), '::after');
      const us = getComputedStyle(document.querySelector('.chat-msg.user')), mk = getComputedStyle(document.querySelector('.chat-title'), '::before');
      const btn = getComputedStyle(document.querySelector('.chat-ask')), g = getComputedStyle(document.querySelector('.chat-gauge'));
      out[p] = [ai.borderRadius, ai.clipPath, aa.content, us.borderRadius, us.borderLeftWidth, mk.content, mk.width, mk.clipPath, btn.borderRadius, btn.clipPath, g.height].join('|');
    }
    root.dataset.paper = was;
    return out;
  });
  check(new Set(Object.values(sig)).size === 6, '六套风格的气泡、标记、按钮、上下文条形态各不相同', fails);
  const shapes = await page.evaluate(() => {
    const root = document.documentElement, was = root.dataset.paper, wasM = root.dataset.motion, r = { btn: [], anim: [], msg: [] };
    root.dataset.motion = 'full';
    for (const p of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
      root.dataset.paper = p;
      r.btn.push(getComputedStyle(document.querySelector('.chat-new')).borderRadius);
      r.anim.push(getComputedStyle(document.querySelector('.chat')).animationName);
      const m = document.querySelector('.chat-msg.ai'); m.classList.add('chat-enter');
      r.msg.push(getComputedStyle(m).animationName); m.classList.remove('chat-enter');
    }
    root.dataset.paper = was; root.dataset.motion = wasM;
    return r;
  });
  check(new Set(shapes.btn).size >= 5, '按钮形状按风格变：' + shapes.btn.join(' '), fails);
  check(new Set(shapes.anim).size === 6 && new Set(shapes.msg).size === 6, '面板和消息的出场动画六套各不相同', fails);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const dark = await page.$eval('.chat-msg.ai', (c) => [getComputedStyle(c.querySelector('.chat-text')).color, getComputedStyle(c).backgroundColor]);
  check(dark[0] !== 'rgb(44, 33, 39)' && dark[1] !== 'rgb(255, 250, 252)', '深色模式气泡跟着变：' + dark.join(' '), fails);
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  // ---------------- 手机宽度 ----------------
  console.log('手机');
  await page.setViewportSize({ width: 390, height: 844 });
  await pause(page, 300);
  const m1 = await page.evaluate(() => {
    const r = document.querySelector('.side-right'), f = document.querySelector('.chat-foot').getBoundingClientRect(), msgs = document.querySelector('.chat-msgs');
    return { doc: document.documentElement.scrollWidth, shown: getComputedStyle(r).display !== 'none' && r.getBoundingClientRect().height > 300,
      foot: f.bottom <= innerHeight + 1 && f.right <= 391, over: msgs.scrollWidth - msgs.clientWidth, center: document.querySelector('.center').getBoundingClientRect().height > 80 };
  });
  check(m1.doc <= 390 && m1.shown && m1.foot && m1.over <= 0 && m1.center, '手机上对话在下面大半屏、正文在上面、不横向溢出：' + JSON.stringify(m1), fails);
  await page.setViewportSize({ width: 1360, height: 860 });
  await pause(page, 200);

  // ---------------- 书架：弹窗 ----------------
  console.log('书架');
  await page.keyboard.press('Escape');
  await pause(page, 300);
  await page.click('.ws .topbar .icon-btn[aria-label="返回"]');
  await page.waitForSelector('.shelf');
  await page.keyboard.press('Control+Shift+J');
  await page.waitForSelector('.modal.chat-modal .chat[data-mode="modal"]');
  check((await page.$$('.chat-modal .chat-li, .chat-modal .chat-recent-i')).length === 0, '书架上打开的是不属于作品的对话（弹窗）', fails);
  await page.fill('.chat-in', '书外面的话。');
  await page.press('.chat-in', 'Control+Enter');
  await confirmSend();
  await aiDone(1, '.chat-modal');
  cs = await chats();
  const loose = cs.find((c) => !c.bookId);
  check(loose && loose.messages.length === 2 && await page.$('.chat-modal .chat-insert') === null, '存成不属于作品的对话，没有「插入正文」', fails);
  await page.click('.chat-modal .chat-title');
  await page.waitForSelector('.modal input.input');
  await page.fill('.modal input.input', '闲聊');
  await page.press('.modal input.input', 'Enter');
  await pause(page, 300);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  await pause(page, 300);
  check((await chats()).find((c) => c.id === loose.id).title === '书外面的话。', '弹窗里 Ctrl+Z 撤销改名', fails);
  await page.setViewportSize({ width: 390, height: 844 });
  await pause(page, 300);
  const m2 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, foot: document.querySelector('.chat-foot').getBoundingClientRect().bottom <= innerHeight }));
  check(m2.doc <= 390 && m2.foot, '手机上弹窗不溢出：' + JSON.stringify(m2), fails);
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.keyboard.press('Escape');
  await pause(page, 300);
  check(await page.$('.chat-modal') === null, 'Esc 关掉弹窗', fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
