// 设定库：分类、设定卡（角色卡）、自定义字段、别名、晋升阶梯（模板、粘贴）、按章节记等级、所在地、服装、上传图、
// AI 补全（测试用假接口）、删除和回收站、给别的模块的命令、Esc / 关闭 / 草稿、手机宽度、深色、整页
//   node build.mjs --out /tmp/xemo-lore && node tests/lore.test.cjs /tmp/xemo-lore
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, newBook, check } = require('./helpers.cjs');

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
      r.onsuccess = () => { const out = r.result; t.oncomplete = () => { db.close(); resolve(out); }; };
    };
  }), [op, store, value]);
}
const pause = (page, ms = 250) => page.waitForTimeout(ms);
const cards = async (page) => (await idb(page, 'all', 'lore')).filter((r) => r.type === 'card');
const cardBy = async (page, name) => (await cards(page)).find((c) => c.name === name);
const metaOf = async (page, bookId) => idb(page, 'get', 'lore', 'meta:' + bookId);
const run = (page, id, arg) => page.evaluate(([id, arg]) => window.__xemoLore.run(id, arg), [id, arg]);
const toast = (page, text) => page.locator('.toast:not(.out)', { hasText: text }).last();

/** 一张 8×8 的小 PNG（自己拼：IHDR + IDAT + IEND） */
function tinyPng() {
  const zlib = require('zlib');
  const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = [];
  for (let y = 0; y < 8; y++) { rows.push(0); for (let x = 0; x < 8; x++) rows.push(220, 120 + y * 10, 170, 255); }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
  const file = path.join(os.tmpdir(), 'xemo-lore-test.png');
  fs.writeFileSync(file, png);
  return file;
}

/** 点开一个分类、新建一张卡 */
async function newCard(page, tab, name) {
  if (tab) await page.click(`.lr-tab:has-text("${tab}")`);
  await page.click('.lr-new');
  await page.fill('.lr-new-in', name);
  await page.keyboard.press('Enter');
  await page.waitForSelector(`.lr-cv .lr-name >> nth=0`);
  await page.waitForFunction((n) => { const i = document.querySelector('.lr-cv .lr-name'); return i && i.value === n; }, name);
}
/** 回到列表 */
async function backToList(page) {
  for (let i = 0; i < 4 && await page.$('.lr-cv'); i++) { await page.click('.lr-cv .lr-back'); await pause(page, 150); }
  await page.waitForSelector('.lr-items');
}
/** 改一个字段：点一下，写，回车 / Ctrl+回车 */
async function setField(page, label, text) {
  const row = page.locator('.lr-field', { has: page.locator('.lr-fl', { hasText: label }) }).first();
  await row.locator('.lr-fv').click();
  const input = row.locator('.lr-ed-in');
  await input.fill(text);
  await input.press('Control+Enter');
  await pause(page, 250);
}

(async () => {
  const dist = process.argv[2] || __dirname + '/../dist';
  const { browser, page, errors } = await launch(dist);
  const fails = [];
  await page.evaluate(() => localStorage.setItem('xemoMock', '1'));
  await page.reload(); await page.waitForSelector('.topbar');
  const bookId = await newBook(page, '设定测试', [{ title: '入门', text: '　　林晚推开门。' }, { title: '试剑', text: '　　剑光一闪。' }, { title: '下山', text: '　　山门外下着雨。' }]);

  console.log('打开设定库');
  await page.click('.topbar [data-cmd="lore.open"]');
  await page.waitForSelector('.side-right .lr-root .lr-tabs');
  const tabs = await page.$$eval('.lr-tab .lr-tab-t', (l) => l.map((x) => x.textContent));
  check(['全部', '人物', '地点', '物品', '势力', '功法/技能', '生物', '节日', '体系'].every((t) => tabs.includes(t)), '默认分类：' + tabs.join(' '), fails);
  check(!!(await page.$('.ws.wide-right')), '在写作界面右侧宽面板里打开，正文还在', fails);
  await pause(page, 300);
  const kv = await idb(page, 'get', 'kv', 'settings');
  check(kv && kv.value.tipsSeen && kv.value.tipsSeen.lore, '第一次打开时小恶魔说了一句', fails);
  check(!!(await page.$('.lr-none .btn.primary')), '空的时候有说明和「新建人物」', fails);

  console.log('分类：新建、改名、换颜色、加字段、删空分类，都能撤销');
  await page.click('.lr-tab-add');
  await page.fill('.modal input.input', '种族');
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('.lr-tab[aria-selected="true"]:has-text("种族")');
  check(true, '新建分类「种族」，切到它', fails);
  await page.click('.lr-catgear');
  await page.waitForSelector('.lr-cs');
  await page.fill('.lr-cs .field input.input >> nth=0', '种族群');
  await page.click('.lr-cs-c >> nth=3');
  await page.click('.lr-cs .btn:has-text("加字段")');
  await page.fill('.modal >> nth=-1 >> input.input', '寿命');
  await page.click('.modal >> nth=-1 >> .modal-foot .btn.primary');
  await pause(page, 150);
  await page.click('.lr-cs-modal .modal-foot .btn.primary:has-text("保存")');
  await page.waitForSelector('.lr-tab:has-text("种族群")');
  let meta = await metaOf(page, bookId);
  let race = meta.cats.find((c) => c.name === '种族群');
  check(race && race.color === '#7c8fd0' && race.fields.some((f) => f.name === '寿命'), '改名、换颜色、加字段（一步保存）', fails);
  await page.click('.topbar [aria-label="撤销"]');
  await page.waitForSelector('.lr-tab:has-text("种族")');
  meta = await metaOf(page, bookId);
  check(meta.cats.some((c) => c.name === '种族') && !meta.cats.some((c) => c.name === '种族群'), '撤销：分类设置整个回到改之前', fails);
  await page.click('.lr-tab:has-text("种族")');
  await page.click('.lr-catgear');
  await page.click('.lr-cs-del');
  await toast(page, '已删掉分类「种族」').waitFor();
  check(!(await page.$('.lr-tab:has-text("种族")')), '删掉空分类', fails);
  await toast(page, '已删掉分类「种族」').locator('.toast-act').click();
  await page.waitForSelector('.lr-tab:has-text("种族")');
  check(true, '提示条上「撤销」把分类找回来', fails);

  console.log('新建人物卡，快速填写');
  await newCard(page, '人物', '林晚');
  check(!!(await page.$('.lr-quick')), '新卡显示「新角色，还差形象和设定」', fails);
  check((await page.textContent('.lr-img')).includes('还没有形象') && (await page.textContent('.lr-img')).includes('Ctrl+V'), '没图时：大字占位、上传、AI 生成、拖进来 / Ctrl+V 的说明', fails);
  check((await page.textContent('.lr-img .lr-ph-g')) === '角', '人物的占位字是「角」', fails);
  await page.fill('.lr-quick-f >> nth=0 >> input', '白发、左眼下有泪痣');
  await page.keyboard.press('Enter');
  await pause(page);
  await page.fill('.lr-quick-f >> nth=1 >> input', '青云宗外门弟子');
  await page.keyboard.press('Enter');
  await pause(page);
  await page.fill('.lr-quick-f >> nth=2 >> input', '嘴硬心软。');
  await page.keyboard.press('Enter');
  await pause(page);
  let lin = await cardBy(page, '林晚');
  meta = await metaOf(page, bookId);
  const person = meta.cats.find((c) => c.kind === 'person');
  const fid = (name) => person.fields.find((f) => f.name === name).id;
  check(JSON.stringify(lin.traits) === '["白发","左眼下有泪痣"]' && lin.fields[fid('身份')] === '青云宗外门弟子' && lin.fields[fid('性格')] === '嘴硬心软。',
    '快速填写：辨识特征、身份、性格一句话都存进卡里', fails);
  check(await page.$$eval('.lr-traits .lr-chip', (l) => l.length) === 2, '辨识特征显示成两枚标签', fails);
  await page.click('.lr-name');
  await pause(page, 500);
  check(!(await page.$('.lr-quick')), '三样都写了，焦点离开后快速填写收起来', fails);

  console.log('字段：点一下改，空的显示「点击填写」，自定义字段');
  check((await page.textContent('.lr-field:has-text("外貌") .lr-fv')) === '点击填写', '空字段显示「点击填写」', fails);
  check((await page.textContent('.lr-field:has-text("外貌") .lr-fl small')).includes('画图'), '外貌标着「会用来画图」', fails);
  await setField(page, '外貌', '白发及腰，青色眼睛');
  lin = await cardBy(page, '林晚');
  check(lin.fields[fid('外貌')] === '白发及腰，青色眼睛', '外貌存好', fails);
  check((await page.$$('.ch-item')).length === 3, '在字段里按 Ctrl+回车只是保存，不会新建章节', fails);
  await page.click('.lr-add-field');
  await page.fill('.lr-add-in', '灵根属性');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.lr-field:has-text("灵根属性")');
  meta = await metaOf(page, bookId);
  check(meta.cats.find((c) => c.kind === 'person').fields.some((f) => f.name === '灵根属性'), '自定义字段「灵根属性」加到人物分类上', fails);
  await setField(page, '灵根属性', '火');

  console.log('别名');
  await page.click('.lr-aliases .lr-add');
  await page.fill('.lr-add-in', '晚晚、林姑娘');
  await page.keyboard.press('Enter');
  await pause(page);
  await page.keyboard.press('Escape');
  lin = await cardBy(page, '林晚');
  check(JSON.stringify(lin.aliases) === '["晚晚","林姑娘"]', '别名用顿号一次加两个', fails);

  console.log('新建第二个人物，自定义字段每张人物卡都有');
  await backToList(page);
  check(await page.$$eval('.lr-item', (l) => l.length) === 1, '返回列表', fails);
  await newCard(page, '人物', '苏墨');
  check(!!(await page.$('.lr-field:has-text("灵根属性")')), '苏墨的卡上也有「灵根属性」', fails);
  await backToList(page);

  console.log('搜索、只看有空字段');
  await page.click('.lr-tab[data-tab="all"]');
  await page.fill('.lr-q', '晚晚');
  await pause(page, 300);
  check(await page.$$eval('.lr-item-name', (l) => l.map((x) => x.textContent).join()) === '林晚', '按别名搜到林晚', fails);
  await page.fill('.lr-q', '青云宗');
  await pause(page, 300);
  check(await page.$$eval('.lr-item-name', (l) => l.map((x) => x.textContent).join()) === '林晚', '按字段内容搜到', fails);
  await page.fill('.lr-q', '');
  await pause(page, 300);
  await newCard(page, '节日', '灯节');
  for (const [k, v] of [['日子', '正月十五'], ['习俗', '放河灯'], ['由来', '纪念山神'], ['备注', '主线第三卷']]) await setField(page, k, v);
  await backToList(page);
  await page.click('.lr-tab[data-tab="all"]');
  await page.click('.lr-filter');
  await pause(page, 200);
  let names = await page.$$eval('.lr-item-name', (l) => l.map((x) => x.textContent));
  check(names.includes('林晚') && names.includes('苏墨') && !names.includes('灯节'), '「有空字段」：填满的灯节不显示：' + names.join(), fails);
  await page.click('.lr-filter');

  console.log('晋升阶梯：模板、粘贴文字');
  await page.click('.lr-tab[data-tab="sys"]');
  await page.click('.lr-sys-new .btn:has-text("从模板导入")');
  await page.click('.lr-menu .menu-item:has-text("修仙境界")');
  await page.waitForSelector('.lr-ladder');
  meta = await metaOf(page, bookId);
  let xian = meta.ladders.find((l) => l.name === '修仙境界');
  check(xian && xian.levels.length === 10 && xian.levels[1].name === '炼气' && xian.levels[1].need && xian.levels[1].ratio, '修仙境界整套导入：10 级，有突破条件、人数比例', fails);
  await page.click('.lr-sys-new .btn:has-text("粘贴文字")');
  await page.fill('.lr-paste input.input', '社会身份');
  await page.fill('.lr-paste-ta', '奴隶 → 自由身 → 侍从 → 见习骑士');
  await pause(page, 100);
  check((await page.textContent('.lr-paste .muted')).includes('4 级'), '粘贴一行箭头：认出 4 级', fails);
  await page.click('.lr-paste-modal .modal-foot .btn.primary');
  await page.waitForSelector('.lr-ladder:has-text("社会身份")');
  await page.click('.lr-sys-new .btn:has-text("粘贴文字")');
  await page.fill('.lr-paste input.input', '斗气');
  await page.fill('.lr-paste-ta', '1. 斗者：能把斗气放出体外\n2. 斗师：斗气凝成铠甲；突破：斗气化形；代价：三年苦修；比例：千中一');
  await pause(page, 100);
  await page.click('.lr-paste-modal .modal-foot .btn.primary');
  await page.waitForSelector('.lr-ladder:has-text("斗气")');
  meta = await metaOf(page, bookId);
  const dq = meta.ladders.find((l) => l.name === '斗气');
  const sh = meta.ladders.find((l) => l.name === '社会身份');
  check(sh && sh.levels.map((l) => l.name).join() === '奴隶,自由身,侍从,见习骑士', '箭头写法拆成 4 级', fails);
  check(dq && dq.levels[0].name === '斗者' && dq.levels[0].power === '能把斗气放出体外' && dq.levels[1].need === '斗气化形' && dq.levels[1].cost === '三年苦修' && dq.levels[1].ratio === '千中一',
    '「名称：说明；突破：…；代价：…；比例：…」拆进各项', fails);
  await page.click('.lr-ladder:has-text("社会身份") .lr-ladder-head .icon-btn');
  await page.click('.lr-menu .menu-item:has-text("删掉这条阶梯")');
  await toast(page, '已删掉「社会身份」').waitFor();
  await toast(page, '已删掉「社会身份」').locator('.toast-act').click();
  await page.waitForSelector('.lr-ladder:has-text("社会身份")');
  check(true, '删阶梯能撤销', fails);

  console.log('角色卡：按章节记等级，看时间线');
  await page.click('.lr-tab[data-tab="all"]');
  await page.click('.lr-item:has-text("林晚")');
  await page.waitForSelector('.lr-lad');
  check(await page.$$eval('.lr-lad', (l) => l.length) === 3, '每条阶梯一行（3 条）', fails);
  const xianRow = '.lr-lad-row:has(.lr-lad-n:text-is("修仙境界")) .lr-lad';
  check((await page.textContent(xianRow)).includes('未设定'), '没设时显示「未设定」', fails);
  await page.click(xianRow);
  await page.selectOption('.lr-lvpick select', { index: 1 });
  await page.click('.lr-lvopt:has-text("凡人")');
  await pause(page);
  await page.click(xianRow);
  await page.selectOption('.lr-lvpick select', { index: 2 });
  await page.click('.lr-lvopt:has-text("炼气")');
  await pause(page);
  let tl = await page.textContent('.lr-lad-row:has(.lr-lad-n:text-is("修仙境界")) .lr-tl');
  check(tl.replace(/\s+/g, '') === '第1章凡人→第2章炼气', '时间线：' + tl.replace(/\s+/g, ' '), fails);
  let row = await page.textContent(xianRow);
  check(row.includes('炼气') && row.includes('第 3 章时'), '在写第三章：显示第三章时的等级「炼气」：' + row, fails);
  check(await page.$$eval(xianRow + ' .lr-bars i.on', (l) => l.length) === 2, '柱子亮到第二级', fails);
  await page.click('.ch-item >> nth=0');
  await pause(page, 400);
  row = await page.textContent(xianRow);
  check(row.includes('凡人') && row.includes('第 1 章时'), '切到第一章：显示「凡人」', fails);
  const ctx1 = await run(page, 'cards.context', { bookId, ids: [lin.id], chapterId: (await idb(page, 'all', 'chapters')).filter((c) => c.bookId === bookId).sort((a, b) => a.order - b.order)[0].id });
  check(ctx1.includes('修仙境界：凡人') && ctx1.includes('身份：青云宗外门弟子') && ctx1.includes('辨识特征：白发、左眼下有泪痣') && ctx1.includes('灵根属性：火'), 'cards.context 按章节给等级：' + ctx1.replace(/\n/g, ' | '), fails);
  const ctxNow = await run(page, 'cards.context', { bookId, ids: [lin.id] });
  check(ctxNow.includes('修仙境界：炼气') && ctxNow.includes('又叫晚晚、林姑娘'), '不给章节时是最新的等级', fails);

  console.log('所在地：搜地点卡，找不到就地新建');
  await page.click('.lr-pin');
  await page.fill('.lr-pick-q', '青云山');
  await page.click('.lr-pick-new');
  await page.waitForSelector('.lr-pin.set');
  check((await page.textContent('.lr-pin')).includes('青云山'), '所在地显示「青云山」', fails);
  lin = await cardBy(page, '林晚');
  const qys = await cardBy(page, '青云山');
  meta = await metaOf(page, bookId);
  check(qys && meta.cats.find((c) => c.id === qys.cat).kind === 'place' && lin.placeId === qys.id, '新建的「青云山」是地点卡，林晚的所在地指向它', fails);
  await page.click('.lr-place .lr-go');
  await page.waitForFunction(() => document.querySelector('.lr-cv .lr-name').value === '青云山');
  check((await page.textContent('.lr-refs')).includes('林晚'), '地点卡上列出「在这里」的人物', fails);
  check((await page.textContent('.lr-img .lr-ph-g')) === '地', '地点的占位字是「地」', fails);
  await page.click('.lr-cv .lr-back');
  await page.waitForFunction(() => document.querySelector('.lr-cv .lr-name').value === '林晚');
  check(true, '返回上一张卡（林晚）', fails);

  console.log('关联');
  await page.click('.lr-links .lr-add');
  await page.fill('.lr-pick-rel', '师兄');
  await page.fill('.lr-pick-q', '苏');
  await page.click('.lr-pick-i:has-text("苏墨")');
  await page.waitForSelector('.lr-links .lr-chip:has-text("苏墨")');
  check((await page.textContent('.lr-links .lr-chip')).includes('师兄 · 苏墨'), '关联：师兄 · 苏墨', fails);

  console.log('服装卡');
  await page.click('.lr-th-add');
  await page.click('.lr-pick-chip:has-text("伪装")');
  await page.waitForSelector('.lr-outfit');
  check((await page.textContent('.lr-th.on')).includes('伪装'), '加「伪装」并切过去', fails);
  check((await page.textContent('.lr-img')).includes('「伪装」还没有图'), '形象区换成这套服装的', fails);
  await page.locator('.lr-outfit .lr-fv').click();
  await page.locator('.lr-outfit .lr-ed-in').fill('灰斗篷，兜帽压低');
  await page.locator('.lr-outfit .lr-ed-in').press('Control+Enter');
  await pause(page);
  const chs = (await idb(page, 'all', 'chapters')).filter((c) => c.bookId === bookId).sort((a, b) => a.order - b.order);
  await page.selectOption('.lr-outfit-range select >> nth=0', chs[1].id);
  await pause(page);
  lin = await cardBy(page, '林晚');
  check(lin.outfits.length === 1 && lin.outfits[0].desc === '灰斗篷，兜帽压低' && lin.outfits[0].fromId === chs[1].id && lin.outfit === lin.outfits[0].id, '服装：名字、样子、从第二章起穿、当前服装', fails);
  // 复制图片后在形象区按 Ctrl+V：图进了这套服装
  const png64 = fs.readFileSync(tinyPng()).toString('base64');
  await page.focus('.lr-img');
  await page.evaluate((b64) => {
    const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer(); dt.items.add(new File([u], 'p.png', { type: 'image/png' }));
    document.querySelector('.lr-img').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png64);
  await page.waitForSelector('.lr-img.has');
  lin = await cardBy(page, '林晚');
  check(lin.outfits[0].img && /^data:image\//.test(lin.outfits[0].img.thumb) && !lin.img, 'Ctrl+V 粘贴：图放进「伪装」这套，原形象不变', fails);
  check(!!(await page.$('.lr-th.on .lr-th-pic img')), '服装缩略图换成这张图', fails);
  await page.click('.lr-th >> nth=0');
  await pause(page);
  check((await page.textContent('.lr-th.on')).includes('原形象') && !(await page.$('.lr-outfit')), '点「原形象」切回来', fails);

  console.log('上传图');
  await page.setInputFiles('.lr-img input[type=file]', tinyPng());
  await page.waitForSelector('.lr-img.has');
  lin = await cardBy(page, '林晚');
  const imgs = await idb(page, 'all', 'loreimg');
  check(lin.img && /^data:image\//.test(lin.img.thumb) && imgs.some((i) => i.id === lin.img.id), '图存进本地：卡上缩略图 + 原图另存', fails);
  check(!!(await page.$('.lr-th:not(.lr-th-add) .lr-th-dot')), '原形象有图：绿点', fails);
  await page.click('.lr-img .lr-paint');
  await page.waitForSelector('.paint-modal, .toast:has-text("绘画功能马上就来")');
  if (await page.$('.paint-modal')) {
    check((await page.textContent('.paint-modal .modal-title')).includes('林晚'), '「AI 生成」就地打开绘画，带着这张卡：' + (await page.textContent('.paint-modal .modal-title')), fails);
    await page.click('.paint-modal .modal-x');
    await pause(page, 200);
    if (await page.$('.modal-foot .btn:has-text("丢弃")')) await page.click('.modal-foot .btn:has-text("丢弃")');
    await page.waitForFunction(() => !document.querySelector('.paint-modal'));
  } else check(true, '「AI 生成」：绘画还没有时提示「马上就来」', fails);
  check(!!(await page.$('.lr-cv')), '关掉绘画回到这张卡', fails);

  console.log('记一笔');
  await page.click('.lr-log-btn');
  await page.fill('.lr-log-ta', '突破炼气，和师兄吵了一架');
  await page.click('.lr-log-form .btn.primary');
  await page.waitForSelector('.lr-log-i');
  lin = await cardBy(page, '林晚');
  const cur = await page.evaluate(() => location.hash.split('/')[3]);
  check(lin.log.length === 1 && lin.log[0].chapterId === chs[0].id, '记一笔，默认记在正在写的这一章', fails);
  check((await page.textContent('.lr-log-i')).includes('第 1 章'), '显示是第几章记的', fails);

  console.log('Esc、草稿');
  await page.locator('.lr-field:has-text("备注") .lr-fv').click();
  await page.locator('.lr-field:has-text("备注") .lr-ed-in').fill('写了一半');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal:has-text("里面还有没保存的内容")');
  await page.click('.modal-foot .btn:has-text("丢弃")');
  await pause(page);
  lin = await cardBy(page, '林晚');
  check(!lin.fields[fid('备注')] && !!(await page.$('.lr-cv')), 'Esc：先问，选「丢弃」只收起输入框，卡还开着', fails);
  await page.locator('.lr-field:has-text("备注") .lr-fv').click();
  await page.locator('.lr-field:has-text("备注") .lr-ed-in').fill('保留这句');
  await page.keyboard.press('Escape');
  await page.click('.modal-foot .btn:has-text("保留草稿")');
  await pause(page);
  lin = await cardBy(page, '林晚');
  check(lin.fields[fid('备注')] === '保留这句', '选「保留草稿」：存进卡里', fails);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.lr-items');
  check(!(await page.$('.lr-cv')), '卡片里按 Esc 回到列表', fails);

  console.log('AI 补全（测试用假接口）');
  await page.click('.lr-item:has-text("林晚")');
  await page.click('.lr-ai-btn');
  await page.waitForSelector('.ai-setup-modal');
  await page.click('.ai-setup-modal .ai-prov[data-id="mock"]');
  await page.fill('.ai-steps input[type="password"]', 'good');
  await page.click('.ai-steps .btn:has-text("拉取模型列表")');
  await page.waitForSelector('.ai-status.ok');
  await page.click('.ai-steps .btn.primary:has-text("测试")');
  await page.waitForSelector('.ai-status.ok:has-text("接好了")');
  await page.waitForSelector('.ai-card', { timeout: 6000 });
  check((await page.textContent('.modal-title')).includes('设定卡'), '确认卡标题：确认调用 · 设定卡', fails);
  const people = await page.$$eval('.ai-ctx-p', (l) => l.map((x) => x.textContent));
  check(people.includes('林晚') && people.includes('苏墨') && !people.includes('青云山') && !people.includes('灯节'), '确认卡「人物」只列人物卡：' + people.join(), fails);
  check((await page.textContent('.ai-input summary')).includes('这张卡现在的内容'), '发送的是这张卡的内容', fails);
  await page.fill('.ai-card textarea', '把空着的字段补上，按「字段：内容」写：');
  await page.click('.modal-foot .btn.primary:has-text("发送")');
  await page.waitForSelector('.lr-ai-item', { timeout: 8000 });
  const sug = await page.$$eval('.lr-ai-item', (l) => l.map((x) => x.textContent));
  check(sug.length === 1 && sug[0].includes('性格') && sug[0].includes('真的'), 'AI 的结果拆成字段建议：' + sug.join(' / '), fails);
  await page.click('.lr-ai-yes');
  await pause(page, 300);
  lin = await cardBy(page, '林晚');
  check(lin.fields[fid('性格')] === '嘴硬心软，真的。', '采用：写进性格', fails);
  check((await page.textContent('.lr-ai-item')).includes('已采用'), '这一条标成「已采用」', fails);
  await toast(page, '已采用').locator('.toast-act').click();
  await pause(page, 400);
  lin = await cardBy(page, '林晚');
  check(lin.fields[fid('性格')] === '嘴硬心软。', '撤销采用：性格回到原来的', fails);
  const st = (await idb(page, 'all', 'stash')).filter((r) => r.feature === 'cards');
  check(st.length === 1 && st[0].ref === lin.id, 'AI 结果进了暂存盒（这张卡名下）', fails);
  await page.click('.lr-stash-btn');
  await page.waitForSelector('.stash-drawer .stash-card');
  check(!!(await page.$('.stash-drawer :text("拿来补全")')), '暂存盒抽屉：这张卡的结果可以「拿来补全」', fails);
  await page.click('.stash-drawer :text("拿来补全")');
  await page.waitForSelector('.lr-ai-item');
  check(true, '从暂存盒拿来的结果也拆成建议', fails);

  console.log('给别的模块的命令');
  const list = await run(page, 'cards.list', { bookId });
  const linItem = list.find((x) => x.name === '林晚');
  check(list.length === 4 && linItem && linItem.cat === '人物' && linItem.kind === 'person' && linItem.color && linItem.aliases.includes('晚晚'), 'cards.list：全部卡，带分类、颜色、别名', fails);
  const places = await run(page, 'cards.list', { bookId, cat: '地点' });
  check(places.length === 1 && places[0].name === '青云山', 'cards.list 按分类筛', fails);
  const terms = await run(page, 'lore.terms', { bookId });
  check(terms.some((t) => t.name === '林晚' && t.aliases.includes('林姑娘') && t.color), 'lore.terms：名字、别名、颜色', fails);
  const made = await run(page, 'cards.new', { bookId, cat: '物品', name: '青霜剑', silent: true });
  check(made && made.name === '青霜剑' && (await cardBy(page, '青霜剑')), 'cards.new（silent）建卡不打开', fails);

  console.log('删除 → 撤销 → 回收站恢复');
  if (!(await page.$('.lr-cv'))) await page.click('.lr-item:has-text("苏墨")');
  else { await backToList(page); await page.click('.lr-item:has-text("苏墨")'); }
  await page.click('.lr-cv-head .icon-btn[aria-label="这张卡的更多操作"]');
  await page.click('.lr-menu .menu-item:has-text("删除这张卡")');
  await toast(page, '已删除「苏墨」').waitFor();
  check(!(await cardBy(page, '苏墨')) && (await idb(page, 'all', 'trash')).some((t) => t.kind === 'lore' && t.title === '苏墨'), '删除：卡进了回收站', fails);
  check(!(await page.$('.lr-cv')) && !(await page.$('.lr-item:has-text("苏墨")')), '删完回到列表', fails);
  await toast(page, '已删除「苏墨」').locator('.toast-act').click();
  await page.waitForSelector('.lr-item:has-text("苏墨")');
  check((await cardBy(page, '苏墨')) && !(await idb(page, 'all', 'trash')).some((t) => t.kind === 'lore'), '提示条撤销：卡回来，回收站里没了', fails);
  await page.click('.lr-item:has-text("苏墨")');
  await page.click('.lr-cv-head .icon-btn[aria-label="这张卡的更多操作"]');
  await page.click('.lr-menu .menu-item:has-text("删除这张卡")');
  await toast(page, '已删除「苏墨」').waitFor();
  await page.click('.lr-tab[data-tab="all"]');
  await page.evaluate((id) => { location.hash = '#/trash/' + id; }, bookId);
  await page.waitForSelector('.trash-item[data-kind="lore"]');
  check((await page.textContent('.trash-item[data-kind="lore"]')).includes('「苏墨」') && (await page.textContent('.trash-item[data-kind="lore"] .trash-kind')) === '设定卡', '回收站里是「设定卡」苏墨', fails);
  await page.click('.trash-item[data-kind="lore"] .trash-peek');
  await page.waitForSelector('.modal .trash-read');
  check((await page.textContent('.modal .trash-read')).includes('苏墨'), '回收站里能看内容', fails);
  await page.keyboard.press('Escape');
  await page.click('.trash-item[data-kind="lore"] .trash-restore');
  await toast(page, '已恢复').waitFor();
  check(!!(await cardBy(page, '苏墨')), '回收站恢复：卡回到设定库', fails);
  await toast(page, '已恢复').locator('.toast-act:has-text("打开")').click();
  await page.waitForSelector('.lr-page .lr-cv .lr-name');
  check((await page.inputValue('.lr-page .lr-cv .lr-name')) === '苏墨' && (await page.evaluate(() => location.hash)).startsWith('#/lore/' + bookId), '「打开」进整页设定库，直接打开这张卡', fails);

  console.log('整页：返回、撤销');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.lr-page .lr-items');
  await page.click('.lr-page .lr-item:has-text("苏墨")');
  await page.fill('.lr-page .lr-name', '苏墨白');
  await page.keyboard.press('Enter');
  await pause(page);
  check(!!(await cardBy(page, '苏墨白')), '整页里改名', fails);
  await page.click('.lr-page .lr-back');
  await page.locator('.lr-page .lr-q').click();
  await page.locator('.lr-page .lr-q').blur();
  await page.keyboard.press('Control+z');
  await pause(page, 400);
  check(!!(await cardBy(page, '苏墨')), '整页里 Ctrl+Z 撤销改名', fails);
  await page.click('.lr-page .topbar [aria-label="重做"]');
  await pause(page, 400);
  check(!!(await cardBy(page, '苏墨白')), '整页顶栏「重做」', fails);
  await page.click('.lr-page .topbar [aria-label="返回"]');
  await page.waitForSelector('.trash, .ws');
  check(!(await page.$('.lr-page')), '左上角返回离开整页', fails);

  console.log('F1 找功能');
  await page.evaluate((id) => { location.hash = '#/book/' + id; }, bookId);
  await page.waitForSelector('.cm-content');
  await page.keyboard.press('F1');
  await page.fill('.help-search', '设定库');
  await pause(page, 100);
  check((await page.textContent('.help-item >> nth=0')).includes('设定库'), '问小恶魔「设定库」能搜到', fails);
  await page.click('.help-item >> nth=0');
  await page.waitForSelector('.side-right .lr-root');
  check(true, '从找功能打开设定库面板', fails);
  await page.click('.side-right .panel-head [aria-label="关闭"]');
  await pause(page, 200);
  check(!(await page.$('.side-right .lr-root')), '面板右上角 × 关闭', fails);

  console.log('六套风格：形态不同');
  await page.click('.topbar [data-cmd="lore.open"]');
  await page.click('.lr-item:has-text("林晚")');
  await page.waitForSelector('.lr-sheet');
  const sig = await page.evaluate(() => {
    const r = document.documentElement;
    const keep = { paper: r.dataset.paper, palette: r.getAttribute('data-palette') };
    const out = {};
    for (const p of ['magical', 'sailor', 'hanfu', 'gothic', 'detective', 'adventurer']) {
      r.dataset.paper = p;
      if (p === 'magical') r.removeAttribute('data-palette'); else r.setAttribute('data-palette', p);
      const sheet = getComputedStyle(document.querySelector('.lr-sheet'));
      const before = getComputedStyle(document.querySelector('.lr-sheet'), '::before');
      const bar = getComputedStyle(document.querySelector('.lr-bars i'));
      const chip = getComputedStyle(document.querySelector('.lr-traits .lr-chip'));
      const th = getComputedStyle(document.querySelector('.lr-th-pic'));
      out[p] = [sheet.borderTopLeftRadius, before.content, before.width, bar.clipPath, bar.borderTopLeftRadius, bar.rotate, bar.backgroundImage.slice(0, 30),
        chip.clipPath, chip.borderLeftWidth, chip.rotate, th.borderTopLeftRadius, th.rotate].join(' | ');
    }
    r.dataset.paper = keep.paper;
    if (keep.palette) r.setAttribute('data-palette', keep.palette); else r.removeAttribute('data-palette');
    return out;
  });
  const uniq = new Set(Object.values(sig));
  check(uniq.size === 6, '六套风格的卡面、柱子、标签、缩略图各不一样（' + uniq.size + ' 种）', fails);

  console.log('深色：中性灰，字看得清');
  const dark = await page.evaluate(() => {
    const r = document.documentElement;
    r.setAttribute('data-theme', 'dark'); r.setAttribute('data-dark', '');
    const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r1, g1, b1]) => { const f = (c) => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }; return .2126 * f(r1) + .7152 * f(g1) + .0722 * f(b1); };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };
    const bg = rgb(getComputedStyle(document.querySelector('.lr-sheet')).backgroundColor);
    const ink = rgb(getComputedStyle(document.querySelector('.lr-name')).color);
    const muted = rgb(getComputedStyle(document.querySelector('.lr-fl')).color);
    const out = { bg, spread: Math.max(...bg) - Math.min(...bg), ink: contrast(ink, bg), muted: contrast(muted, bg) };
    r.removeAttribute('data-theme'); r.removeAttribute('data-dark');
    return out;
  });
  check(dark.bg[0] > 20 && dark.spread <= 8 && dark.ink >= 7 && dark.muted >= 3, `深色卡面是中性灰（${dark.bg}），正文对比 ${dark.ink.toFixed(1)}，次要字 ${dark.muted.toFixed(1)}`, fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();

  console.log('手机宽度 390');
  const m = await launch(dist, { width: 390, height: 800 });
  const mid = await newBook(m.page, '手机', [{ title: '一', text: '　　雨。' }]);
  await m.page.evaluate(() => { const b = [...document.querySelectorAll('.topbar [data-cmd="lore.open"]')][0]; b.scrollIntoView(); b.click(); });
  await m.page.waitForSelector('.lr-root');
  await m.page.click('.lr-none .btn.primary');
  await m.page.fill('.lr-new-in', '林晚');
  await m.page.keyboard.press('Enter');
  await m.page.waitForSelector('.lr-sheet');
  await m.page.waitForTimeout(300);
  const mob = await m.page.evaluate(() => {
    const body = document.querySelector('.lr-panel-body');
    const sheet = getComputedStyle(document.querySelector('.lr-sheet'));
    return { doc: document.documentElement.scrollWidth, body: body.scrollWidth - body.clientWidth, cols: sheet.gridTemplateColumns.split(' ').length, h: body.clientHeight };
  });
  check(mob.doc <= 390 && mob.body <= 1, `手机宽度没有横向滚动（页面 ${mob.doc}，面板多出 ${mob.body}）`, fails);
  check(mob.cols === 1 && mob.h > 400, `卡片竖着排成一列，面板够高（${mob.h}px）`, fails);
  await m.page.goto(m.page.url().replace(/#.*/, '') + '#/lore/' + mid);
  await m.page.waitForSelector('.lr-page .lr-items');
  const mob2 = await m.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, main: (() => { const x = document.querySelector('.lr-page-main'); return x.scrollWidth - x.clientWidth; })() }));
  check(mob2.doc <= 390 && mob2.main <= 1, '整页在手机宽度也不横向滚动', fails);
  check(m.errors.length === 0, '手机：没有报错 ' + m.errors.join(' | '), fails);
  await m.browser.close();

  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})();
