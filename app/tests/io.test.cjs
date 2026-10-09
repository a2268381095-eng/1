// 导入、导出、整本备份：纯函数的单元测试（node 直接跑）+ 浏览器里的流程测试（Playwright）
//   node build.mjs --out /tmp/xemo-io && node tests/io.test.cjs /tmp/xemo-io
//   只跑单元测试：node tests/io.test.cjs --unit
//   截图：SHOT=/某个目录 node tests/io.test.cjs /tmp/xemo-io
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { launch, newBook, setText, getText, chapterList, check } = require('./helpers.cjs');

// 这台机器默认不是 UTF-8 时，浏览器会把中文文件名的下载改叫「download」
process.env.LANG = process.env.LC_ALL = 'C.UTF-8';

const load = (f) => import(pathToFileURL(path.join(__dirname, '../src/features/io', f)).href);

// GBK、Big5 编码：用 TextDecoder 反查出每个字的字节
function codec(enc) {
  const map = new Map();
  const dec = new TextDecoder(enc);
  for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x40; b <= 0xfe; b++) {
    const ch = dec.decode(new Uint8Array([a, b]));
    if (ch.length === 1 && ch !== '\ufffd' && !map.has(ch)) map.set(ch, [a, b]);
  }
  return (s) => {
    const out = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else { const v = map.get(ch); if (!v) throw new Error(enc + ' 里没有「' + ch + '」'); out.push(...v); }
    }
    return Buffer.from(out);
  };
}
const utf16 = (s, be, bom) => {
  const b = Buffer.alloc(s.length * 2 + (bom ? 2 : 0));
  let o = 0;
  if (bom) { b[0] = be ? 0xfe : 0xff; b[1] = be ? 0xff : 0xfe; o = 2; }
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (be) b.writeUInt16BE(c, o + 2 * i); else b.writeUInt16LE(c, o + 2 * i); }
  return b;
};

const NOVEL = [
  '风起青萍',
  '　　简介：一个关于雨的故事。',
  '',
  '第一章 门铃',
  '　　雨下到第三天。',
  '　　林栀没有抬头，她把信放回去。',
  '',
  '第二章：旧信',
  '　　信封是空的。',
  '第二节课下课后，他走了。',
  '',
  '第３章 归来',
  '　　他回来了，我们都没有说话。',
  '第九章',
  '　　这一行跟在假章名后面。',
  '第四章 夜',
  '　　夜里很安静。',
].join('\r\n');

// ---------------- 单元测试 ----------------
async function unit(fails) {
  const P = await load('parse.js');
  const gbk = codec('gb18030'), big5 = codec('big5');

  console.log('章节号');
  const nums = { 一: 1, 十二: 12, 一百零五: 105, 两千零二十四: 2024, 一二三: 123, '１２': 12, '7': 7, 十万: 100000, 一万二千: 12000, 壹佰: 100, 二十: 20 };
  for (const [s, n] of Object.entries(nums)) check(P.parseCnNumber(s) === n, `${s} → ${n}`, fails);
  check(Number.isNaN(P.parseCnNumber('第x')), '认不出来的是 NaN', fails);

  console.log('认章名');
  const hd = (s, md) => P.matchHeading(s, { md });
  const same = (s, want, msg, md) => { const got = hd(s, md); const ok = want ? got && Object.keys(want).every((k) => got[k] === want[k]) : got === null; check(ok, msg + (ok ? '' : '  得到 ' + JSON.stringify(got)), fails); };
  same('第一章 门铃', { type: 'chapter', unit: '章', num: 1, title: '门铃' }, '第一章 门铃');
  same('　　第１２章：雨夜', { unit: '章', num: 12, title: '雨夜' }, '全角数字、冒号、行首空格');
  same('第 3 章', { num: 3, title: '' }, '阿拉伯数字带空格、没有章名');
  same('第十二回 夜奔', { unit: '回', num: 12, title: '夜奔' }, '第X回');
  same('第五节　转机', { unit: '节', num: 5, title: '转机' }, '第X节');
  same('第一百零五章', { num: 105 }, '一百零五');
  same('第二章风起云涌', { num: 2, title: '风起云涌' }, '章名直接接在后面');
  same('第三章 你是谁？', { title: '你是谁？' }, '章名带问号');
  same('正文 第8章 归来', { num: 8, title: '归来' }, '「正文」前缀');
  same('第一卷 少年行', { type: 'volume', unit: '卷', num: 1, title: '少年行' }, '第一卷是卷名');
  same('## 第五章 风起', { num: 5, title: '风起' }, 'md 的 ## 第五章', true);
  same('楔子', { unit: 'special', title: '楔子' }, '楔子');
  same('番外一 小剧场', { unit: 'special', title: '番外一 小剧场' }, '番外一');
  same('前言：写在前面', { unit: 'special', title: '前言 写在前面' }, '前言：xx');
  same('第二节课下课后，他走了', null, '第二节课……是正文');
  same('第一回合', null, '第一回合是正文');
  same('第三章写到这里他停了下来，看见窗外的雨一直没停，天色暗了下去。', null, '长句子是正文');
  same('序幕拉开了', null, '序幕不是序');
  check(P.matchMdHeading('## 开端', 2).title === '开端' && !P.matchMdHeading('### 开端', 2), 'md 指定级别的 # 标题', fails);

  console.log('认编码');
  const text = NOVEL;
  const trad = '第一章 門鈴\n　　雨下到第三天。林梔沒有抬頭，她把信放回去，說：「你來了。」\n　　他點點頭，沒有說話。這是我們最後一次見面。';
  const enc = (b) => P.detectEncoding(new Uint8Array(b)).encoding;
  check(enc(Buffer.from(text, 'utf8')) === 'utf-8', 'UTF-8', fails);
  const bomU8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  check(P.detectEncoding(new Uint8Array(bomU8)).bom && enc(bomU8) === 'utf-8' && P.decodeAs(new Uint8Array(bomU8), 'utf-8') === text, 'UTF-8 带 BOM，解出来不带 BOM', fails);
  check(enc(gbk(text)) === 'gb18030' && P.decodeAs(new Uint8Array(gbk(text)), 'gb18030') === text, 'GBK', fails);
  check(enc(big5(trad)) === 'big5', 'Big5', fails);
  check(enc(utf16(text, false, true)) === 'utf-16le' && P.decodeAs(new Uint8Array(utf16(text, false, true)), 'utf-16le') === text, 'UTF-16 LE 带 BOM', fails);
  check(enc(utf16(text, true, true)) === 'utf-16be', 'UTF-16 BE 带 BOM', fails);
  check(enc(utf16(text, false, false)) === 'utf-16le', 'UTF-16 LE 没有 BOM', fails);
  check(enc(utf16(text, true, false)) === 'utf-16be', 'UTF-16 BE 没有 BOM', fails);
  check(enc(Buffer.from('Hello world.\nPlain ASCII.')) === 'utf-8', '纯英文按 UTF-8', fails);
  const broken = Buffer.concat([Buffer.from(text.repeat(3), 'utf8'), Buffer.from([0xff])]);
  check(enc(broken) === 'utf-8', 'UTF-8 末尾坏了一个字节，还是 UTF-8', fails);
  check(!P.looksGarbled(text), '正常中文不算乱码', fails);
  check(P.looksGarbled(P.decodeAs(new Uint8Array(gbk(text)), 'utf-8')), 'GBK 当成 UTF-8 解：乱码', fails);
  check(P.looksGarbled(P.decodeAs(new Uint8Array(Buffer.from(text, 'utf8')), 'gb18030')), 'UTF-8 当成 GBK 解：乱码', fails);
  check(P.looksGarbled(P.decodeAs(new Uint8Array(big5(trad)), 'gb18030')), 'Big5 当成 GBK 解：乱码', fails);

  console.log('拆章');
  const counts = P.scanHeadings(text);
  check(counts['章'] === 5 && counts['节'] === 0 && counts['卷'] === 0, '数出 5 处第X章（第二节课不算）', fails);
  const du = P.defaultUnits({ 章: 3, 节: 9, 回: 0, 卷: 1, special: 1, md: {} });
  check(JSON.stringify(du.units) === '["章","卷","special"]', '有「章」时「节」默认不拆', fails);
  check(JSON.stringify(P.defaultUnits({ 章: 0, 节: 4, 回: 0, 卷: 1, special: 0, md: {} }, { volumes: false }).units) === '["节"]', '没有章用节；追加到不分卷的书时卷名不认', fails);
  let r = P.splitText(text, { units: ['章'] });
  check(r.preface === '风起青萍\n　　简介：一个关于雨的故事。', '第一个章名前面的算开头（\\r\\n 换成 \\n）', fails);
  check(r.items.length === 5 && r.items.map((i) => i.title).join('|') === '门铃|旧信|归来||夜', '五章，章名去掉了第X章', fails);
  check(r.items[1].content === '　　信封是空的。\n第二节课下课后，他走了。', '正文保留缩进、去掉首尾空行', fails);
  const gaps = P.numberGaps(r.items);
  check(gaps.length === 2 && gaps[0].index === 3 && gaps[0].prev === 3 && gaps[1].index === 4, '第3章后面是第9章、第9章后面是第4章：两处不连续', fails);
  check(!P.canMergeUp(r.items, 0) && P.canMergeUp(r.items, 3), '第一项不能并到上一章', fails);
  const merged = P.mergeUp(r.items, 3);
  check(merged.length === 4 && merged[2].content === '　　他回来了，我们都没有说话。\n第九章\n　　这一行跟在假章名后面。' && r.items.length === 5, '并到上一章：章名行放回正文，原数组不变', fails);
  check(P.numberGaps(merged).length === 0, '并完章节号就连续了', fails);

  const vt = '楔子\n很久以前。\n第一卷 少年\n卷首语。\n第一章 出发\n走了。\n第二章 路上\n还在走。\n第二卷 青年\n第一章 到了\n到了。';
  r = P.splitText(vt, P.defaultUnits(P.scanHeadings(vt)));
  check(r.items.map((i) => i.type[0] + ':' + i.title).join('|') === 'c:楔子|v:少年|c:|c:出发|c:路上|v:青年|c:到了', '卷名、卷首语、楔子', fails);
  check(P.numberGaps(r.items).length === 0, '换卷后从第一章重新数不算断', fails);
  let a = P.assemble(r);
  check(a.volumes.length === 2 && a.chapters.length === 5 && a.chapters.map((c) => c.vol).join(',') === '0,0,0,0,1', '楔子算进第一卷', fails);
  a = P.assemble(r, { leadIntoFirst: false });
  check(a.chapters[0].vol === null, '追加时第一卷前面的章不进新卷', fails);

  const pr = P.splitText(text, { units: ['章'] });
  a = P.assemble(pr, { prefaceMode: 'own', prefaceTitle: '楔子' });
  check(a.chapters.length === 6 && a.chapters[0].title === '楔子' && a.chapters[0].content.startsWith('风起青萍'), '开头单独一章「楔子」', fails);
  a = P.assemble(pr, { prefaceMode: 'merge' });
  check(a.chapters.length === 5 && a.chapters[0].title === '门铃' && a.chapters[0].content.startsWith('风起青萍\n') && a.chapters[0].content.endsWith('她把信放回去。'), '开头并入第一章', fails);
  a = P.assemble(pr, { prefaceMode: 'drop' });
  check(a.chapters.length === 5 && !a.chapters[0].content.includes('风起青萍'), '开头不导入', fails);
  a = P.assemble(P.splitText('只有一段正文。\n第二行。'));
  check(a.chapters.length === 1 && a.chapters[0].title === '' && a.chapters[0].content === '只有一段正文。\n第二行。', '没有章名：整篇一章', fails);

  const md = '---\ntitle: x\n---\n# 我的书\n\n## 开端\n\n第一段。\n\n## 发展\n\n第二段。\n';
  const mc = P.scanHeadings(md, { md: true });
  const mu = P.defaultUnits(mc);
  check(mu.mdLevel === 2 && mu.units.length === 0, 'md 没有第X章：按数量最多的 ## 拆', fails);
  r = P.splitText(md, { ...mu, md: true });
  check(r.items.length === 2 && r.items[0].title === '开端' && r.items[1].content === '第二段。' && r.preface === '# 我的书', 'md 拆出两章，元信息去掉', fails);

  console.log('导出');
  const book = { title: '雨', intro: '一个故事。', numbering: 'zh', useVolumes: true, volumes: [{ id: 'v1', title: '少年' }, { id: 'v2', title: '' }] };
  const chs = [
    { id: 'c1', title: '出发', content: '走了。\n\n\n还在走。', volumeId: 'v1' },
    { id: 'c2', title: '', content: '到了。', volumeId: 'v1' },
    { id: 'c3', title: '回来', content: '# 不是标题\n- 也不是列表', volumeId: 'v2' },
  ];
  let parts = P.exportParts(book, chs, ['c1', 'c2', 'c3']);
  check(parts.map((p) => p.label + (p.title ? ' ' + p.title : '')).join('|') === '第一卷 少年|第一章 出发|第二章|第二卷|第三章 回来', '整本：卷名和章节号', fails);
  parts = P.exportParts({ ...book, numbering: 'num' }, chs, ['c3']);
  check(parts.map((p) => p.label).join('|') === '第2卷|第3章', '只导第三章：章节号还是第3章', fails);
  let out = P.exportText(P.exportParts(book, chs, ['c1', 'c2']), { fmt: 'txt', book, header: true });
  check(out === '雨\n\n一个故事。\n\n第一卷 少年\n\n第一章 出发\n\n走了。\n\n\n还在走。\n\n第二章\n\n到了。\n', 'txt：书名、简介、卷名、章名', fails);
  out = P.exportText(P.exportParts(book, chs, ['c1']), { fmt: 'txt', transform: (t) => t.split('\n').filter((l) => l.trim()).map((l) => '　　' + l).join('\n\n') });
  check(out === '第一卷 少年\n\n第一章 出发\n\n　　走了。\n\n　　还在走。\n', 'txt：排版只动正文，章名不缩进', fails);
  out = P.exportText(P.exportParts(book, chs, ['c3']), { fmt: 'md', book, header: true });
  check(out === '# 雨\n\n一个故事。\n\n## 第二卷\n\n### 第三章 回来\n\n\\# 不是标题\n\n\\- 也不是列表\n', 'md：# 书名、## 卷、### 章，每段一个空行，行首记号转义', fails);
  out = P.exportText(P.exportParts({ ...book, useVolumes: false }, chs, ['c2']), { fmt: 'md' });
  check(out === '## 第二章\n\n到了。\n', 'md：不分卷时章用 ##', fails);
  check(P.safeFileName('a/b:c*?"<>|d.txt ') === 'a b c d.txt' && P.safeFileName('  ') === '未命名' && P.safeFileName('..x') === 'x', '文件名去掉不能用的字', fails);
  check(P.baseName('风起.txt') === '风起' && P.baseName('雨.xemo.json') === '雨' && P.baseName('a.b.md') === 'a.b', '去掉扩展名', fails);
  check(P.extOf('X.TXT') === 'txt' && P.extOf('雨.xemo.json') === 'xemo' && P.extOf('noext') === '', '扩展名', fails);

  console.log('整本备份');
  const bk = { id: 'b1', title: '雨', intro: '', tags: ['都市'], cover: 'javascript:alert(1)', volumes: [{ id: 'v1', title: '少年' }], useVolumes: true, lastChapterId: 'c2' };
  const bc = [
    { id: 'c2', bookId: 'b1', order: 2, title: '二', content: '第二章正文', points: [{ id: 'p1', text: '伏笔', done: false }], volumeId: 'v1' },
    { id: 'c1', bookId: 'b1', order: 1, title: '一', content: '第一章', points: [], volumeId: 'gone' },
  ];
  const data = P.makeBackup([{ book: bk, chapters: bc, stats: { '2026-10-08': 120 } }], 1000);
  check(data.app === 'xiaoemo-wenshu' && data.version === 1 && data.books[0].chapters[0].id === 'c1', '备份：标记、版本、章节按顺序', fails);
  let pb = P.parseBackup(JSON.stringify(data));
  check(pb.ok && pb.books.length === 1 && pb.exportedAt === 1000, '读回来', fails);
  const b0 = pb.books[0];
  check(b0.chapters[1].points[0].text === '伏笔' && b0.stats['2026-10-08'] === 120 && b0.book.tags[0] === '都市', '要点、码字记录、标签都在', fails);
  check(b0.book.cover === '' && b0.chapters[0].volumeId === null && b0.chapters[1].words === 5, '不像图片的封面去掉；卷不存在的 volumeId 清空；字数重算', fails);
  check(P.parseBackup('\uFEFF' + JSON.stringify(data)).ok, '带 BOM 也能读', fails);
  check(P.parseBackup('不是 json').reason === 'notjson' && P.parseBackup('{"a":1}').reason === 'notbackup', '不是备份文件', fails);
  check(P.parseBackup(JSON.stringify({ ...data, version: 9 })).reason === 'newer', '新版软件的备份', fails);
  check(P.parseBackup(JSON.stringify({ ...data, books: [{ book: { title: '没 id' } }] })).reason === 'empty', '没有能用的作品', fails);
  let n = 0;
  const cp = P.withNewIds(b0, (p) => p + 'new' + (++n));
  check(cp.book.id === 'bnew1' && cp.chapters.every((c) => c.bookId === 'bnew1' && c.id.startsWith('cnew')) && cp.book.lastChapterId === cp.chapters[1].id && b0.book.id === 'b1',
    '另存为新书：作品、章节都换新 id，原来的不变', fails);
  check(P.totalWords(b0.chapters) === 8, '总字数', fails);
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
      r.onsuccess = () => { const out = r.result; t.oncomplete = () => { db.close(); resolve(out); }; };
    };
  }), [op, store, value]);
}
const kv = async (page, key) => { const r = await idb(page, 'get', 'kv', key); return r ? r.value : undefined; };
const pause = (page, ms = 300) => page.waitForTimeout(ms);
const hash = (page) => page.evaluate(() => location.hash);
const toastText = (page) => page.evaluate(() => [...document.querySelectorAll('.toast:not(.out) .toast-msg')].map((e) => e.textContent).join(' / '));
async function clickToastUndo(page, text) {
  await page.locator('.toast:not(.out)', { hasText: text }).last().locator('.toast-act').click();
  await pause(page, 600);
}
async function closeToasts(page) {
  for (const x of await page.$$('.toast:not(.out) .toast-x')) await x.click().catch(() => {});
  await pause(page, 250);
}
const rows = (page) => page.$$eval('.io-row', (els) => els.map((e) => ({
  i: e.dataset.i, no: e.querySelector('.io-no').textContent,
  title: (e.querySelector('input.io-title') || {}).value ?? e.querySelector('.io-title').textContent,
  gap: !!e.querySelector('.io-gap'), vol: e.classList.contains('vol'),
})));

/** 点导入弹窗里的「选一个文件」，选这个文件 */
async function chooseFile(page, name, buffer, mimeType = 'text/plain') {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.io-drop')]);
  await fc.setFiles({ name, mimeType, buffer });
}
async function openImportFromShelf(page) {
  await page.click('.shelf .topbar button:has-text("导入")');
  await page.waitForSelector('.io-drop');
}
async function runCommand(page, q, title) {
  await page.keyboard.press('F1');
  await page.waitForSelector('.help-search');
  await page.fill('.help-search', q);
  await page.click(`.help-item:has(.help-t:text-is("${title}"))`);
}
async function download(page, click) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  const p = await dl.path();
  return { name: dl.suggestedFilename(), text: fs.readFileSync(p, 'utf8') };
}
const allChapterTexts = async (page, bookId) => (await idb(page, 'all', 'chapters')).filter((c) => c.bookId === bookId).sort((a, b) => a.order - b.order);

async function flows(dist, fails) {
  const gbk = codec('gb18030');
  const shot = process.env.SHOT;
  const { browser, page, errors } = await launch(dist);

  console.log('导入弹窗');
  await openImportFromShelf(page);
  const startText = await page.textContent('.io-start');
  check(startText.includes('txt、md') && startText.includes('docx、epub') && startText.includes('下一版支持') && startText.includes('.xemo.json'), '说明支持的格式，docx、epub 下一版支持', fails);
  check(await page.isVisible('.modal .modal-x'), '右上角有关闭', fails);
  await chooseFile(page, '旧稿.docx', Buffer.from('PK'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  await page.waitForSelector('.modal-title:has-text("DOCX 下一版支持")');
  check(true, '选了 docx：说明下一版支持', fails);
  await page.click('.modal-foot .btn:has-text("换一个文件")');
  await page.waitForSelector('.io-drop');

  console.log('导入 GBK 的 txt：预览');
  await chooseFile(page, '风起青萍.txt', gbk(NOVEL));
  await page.waitForSelector('.io-pv');
  if (shot) await page.screenshot({ path: path.join(shot, 'io-preview.png') });
  check((await page.$eval('.io-enc', (e) => e.value)) === 'gb18030', '自动认出 GBK', fails);
  check(await page.isHidden('.io-warn'), '没有乱码提示', fails);
  check((await page.$eval('.io-fields input.input', (e) => e.value)) === '风起青萍', '书名默认取文件名', fails);
  let rs = await rows(page);
  check(rs.length === 6 && rs[0].title === '楔子' && rs[1].no === '第二章' && rs[1].title === '门铃' && rs[2].title === '旧信' && rs[3].title === '归来' && rs[5].title === '夜',
    '认出 5 章 + 开头的楔子：' + rs.map((r) => r.no + r.title).join('、'), fails);
  check(rs.filter((r) => r.gap).length === 2 && (await page.textContent('.io-sum')).includes('2 处章节号不连续'), '标出 2 处章节号不连续', fails);
  check((await page.textContent('.io-sum')).startsWith('共 6 章'), '共 6 章', fails);

  console.log('换编码：乱码提示');
  await page.selectOption('.io-enc', 'utf-8');
  await pause(page);
  check(await page.isVisible('.io-warn') && (await page.textContent('.io-warn')).includes('乱码'), '换成 UTF-8：提示像乱码', fails);
  await page.click('.io-warn button:has-text("GBK")');
  await pause(page);
  check(await page.isHidden('.io-warn') && (await rows(page)).length === 6, '点提示里的 GBK：恢复正常', fails);

  console.log('并到上一章、撤销、改章名、楔子怎么放');
  check(await page.$eval('.io-row[data-i="0"] .io-merge', (e) => e.disabled), '第一章不能并到上一章', fails);
  await page.click('.io-row[data-i="3"] .io-merge');
  await pause(page);
  rs = await rows(page);
  check(rs.length === 5 && rs.every((r) => !r.gap) && (await page.textContent('.io-sum')).startsWith('共 5 章'), '「第九章」并到上一章：剩 5 章，章节号连续了', fails);
  await page.click('.io-listbar button:has-text("撤销上一步")');
  await pause(page);
  check((await rows(page)).length === 6, '撤销上一步：又是 6 行', fails);
  await page.click('.io-row[data-i="3"] .io-merge');
  await page.fill('.io-row[data-i="3"] input.io-title', '长夜');
  await page.check('.io-pre input[value="merge"]');
  await pause(page);
  check((await rows(page)).length === 4 && (await page.textContent('.io-sum')).startsWith('共 4 章'), '开头并入第一章：共 4 章', fails);
  await page.check('.io-pre input[value="own"]');
  await pause(page);
  check((await rows(page)).length === 5, '改回单独一章', fails);

  console.log('关掉时问「保留草稿 / 丢弃」，下次接着用');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-title:has-text("里面还有没保存的内容")');
  await page.click('.modal-foot .btn:has-text("保留草稿")');
  await pause(page, 500);
  check(!(await page.$('.io-pv')), '保留草稿后关掉了', fails);
  check((await kv(page, 'io:import-draft')).items.length === 4, '草稿存在 kv', fails);
  await openImportFromShelf(page);
  await chooseFile(page, '风起青萍.txt', gbk(NOVEL));
  await page.waitForSelector('.io-pv');
  rs = await rows(page);
  check(await page.isVisible('.io-note') && rs.length === 5 && rs[4].title === '长夜', '再选同一个文件：接着上次的调整', fails);

  console.log('确认导入');
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('.cm-content');
  await pause(page, 500);
  const cl = await chapterList(page);
  check(cl.join('、') === '第一章|楔子、第二章|门铃、第三章|旧信、第四章|归来、第五章|长夜', '建好了 5 章：' + cl.join('、'), fails);
  check((await toastText(page)).includes('已导入《风起青萍》，5 章'), '提示条：已导入', fails);
  const bookId = (await hash(page)).split('/')[2];
  let chs = await allChapterTexts(page, bookId);
  check(chs[3].content === '　　他回来了，我们都没有说话。\n第九章\n　　这一行跟在假章名后面。' && chs[0].content === '风起青萍\n　　简介：一个关于雨的故事。', '正文对：并进去的「第九章」在第四章里', fails);
  check(chs.every((c) => c.words === c.content.replace(/\s/g, '').length || c.words > 0), '字数算好了', fails);
  check(!(await kv(page, 'io:import-draft')), '导入后草稿清掉', fails);
  check(((await kv(page, 'settings')).tipsSeen || {})['io-import'], '第一次导入时小恶魔说明了一句', fails);
  const books1 = await idb(page, 'all', 'books');
  check(books1.length === 1 && books1[0].title === '风起青萍' && !books1[0].useVolumes, '书架上一本《风起青萍》', fails);

  console.log('提示条「撤销」：新书放进回收站');
  await clickToastUndo(page, '已导入');
  await pause(page, 500);
  check((await hash(page)) === '#/', '回到书架', fails);
  check((await idb(page, 'all', 'books')).length === 0 && (await idb(page, 'all', 'chapters')).length === 0, '书架上没有了', fails);
  let trash = await idb(page, 'all', 'trash');
  check(trash.length === 1 && trash[0].kind === 'book' && trash[0].data.chapters.length === 5, '整本在回收站里（5 章）', fails);
  check((await toastText(page)).includes('《风起青萍》放进回收站了'), '提示条：放进回收站了', fails);
  await page.locator('.toast:not(.out)', { hasText: '放进回收站了' }).locator('.toast-act').click();
  await pause(page, 600);
  check((await idb(page, 'all', 'books')).length === 1 && (await idb(page, 'all', 'trash')).length === 0 && (await page.$$('.book-card')).length === 1,
    '点「恢复」：又回到书架上', fails);
  await closeToasts(page);

  console.log('书架上拖一个 md 进来');
  const mdText = '# 测试 md\n\n## 开端\n\n第一段。\n\n## 发展\n\n第二段。\n';
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], '测试 md.md', { type: 'text/markdown' }));
    const target = document.querySelector('.shelf-main') || document.body;
    for (const type of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.__mask = !!document.querySelector('.io-dropmask');
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, mdText);
  await page.waitForSelector('.io-pv');
  check(await page.evaluate(() => window.__mask), '拖进来时显示「松手就导入」', fails);
  check(!(await page.$('.io-dropmask')), '松手后提示收起', fails);
  rs = await rows(page);
  check(rs.length === 3 && rs[1].title === '开端' && rs[2].title === '发展', 'md 按 ## 拆成两章，开头的「# 测试 md」算楔子', fails);
  await page.check('.io-pre input[value="drop"]');
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('.cm-content');
  await pause(page, 500);
  check((await chapterList(page)).join('、') === '第一章|开端、第二章|发展', '导入两章，开头不要', fails);
  const mdBook = (await hash(page)).split('/')[2];
  await closeToasts(page);

  console.log('在作品里导入，追加到当前作品');
  await runCommand(page, '导入', '导入作品');
  await page.waitForSelector('.io-drop');
  await chooseFile(page, '续写.txt', utf16('第一章 续一\n接着写。\n第二章 续二\n又写了一段。', false, true));
  await page.waitForSelector('.io-pv');
  check((await page.$eval('.io-enc', (e) => e.value)) === 'utf-16le', '认出 UTF-16（带 BOM）', fails);
  check((await page.$eval('.io-fields select', (e) => e.options[1].textContent)).includes('（正在写）'), '正在写的这本排在最前', fails);
  await page.selectOption('.io-fields select', mdBook);
  await pause(page);
  check(await page.isHidden('.io-fields .field:has-text("书名")'), '追加时不用填书名', fails);
  rs = await rows(page);
  check(rs.map((r) => r.no).join('、') === '第三章、第四章', '章节号接着往下数', fails);
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('.toast:has-text("已追加 2 章")');
  await pause(page, 500);
  check((await chapterList(page)).join('、') === '第一章|开端、第二章|发展、第三章|续一、第四章|续二', '追加了两章', fails);
  check((await page.$eval('.ch-item.cur .ch-item-t', (e) => e.textContent)) === '续一' && (await getText(page)) === '接着写。', '打开追加的第一章', fails);
  await clickToastUndo(page, '已追加');
  await pause(page, 500);
  check((await chapterList(page)).join('、') === '第一章|开端、第二章|发展', '撤销：追加的两章拿掉了', fails);
  check((await page.$eval('.ch-item.cur .ch-item-t', (e) => e.textContent)) === '发展', '当前章换到还在的章', fails);
  check((await idb(page, 'all', 'chapters')).filter((c) => c.bookId === mdBook).length === 2, '库里也只剩两章', fails);
  await closeToasts(page);

  console.log('导出 txt');
  check(await page.isVisible('.ws .topbar .tool-btn[data-cmd="io.export"]'), '写作界面顶栏有「导出」', fails);
  await page.click('.ws .topbar .tool-btn[data-cmd="io.export"]');
  await page.waitForSelector('.io-ex');
  if (shot) await page.screenshot({ path: path.join(shot, 'io-export.png') });
  check((await page.$eval('.io-seg[aria-label="格式"] [aria-pressed="true"]', (e) => e.dataset.v)) === 'txt', '默认 txt', fails);
  check((await page.$eval('.io-seg[aria-label="导出范围"] [aria-pressed="true"]', (e) => e.dataset.v)) === 'book', '默认整本', fails);
  check((await page.textContent('.io-ex')).includes('docx、epub、pdf 下一版支持'), '说明 docx、epub、pdf 下一版支持', fails);
  check((await page.textContent('.io-out')).includes('第一章 开端'), '预览开头的样子', fails);
  let dl = await download(page, () => page.click('.modal-foot .btn.primary'));
  check(dl.name === '测试 md.txt', '文件名：测试 md.txt', fails);
  check(dl.text === '测试 md\n\n第一章 开端\n\n第一段。\n\n第二章 发展\n\n第二段。\n', 'txt 内容：' + JSON.stringify(dl.text), fails);
  check((await toastText(page)).includes('已导出「测试 md.txt」'), '提示条：已导出', fails);
  check(((await kv(page, 'settings')).tipsSeen || {})['io-export'], '第一次导出时小恶魔说明了一句', fails);
  await closeToasts(page);

  console.log('网文平台排版');
  await page.click('.ws .topbar .tool-btn[data-cmd="io.export"]');
  await page.waitForSelector('.io-ex');
  await page.check('input[data-opt="platform"]');
  await pause(page);
  check((await page.$eval('.io-scheme', (e) => e.value)) === '网文平台', '方案默认「网文平台」', fails);
  check((await page.textContent('.io-out')).includes('　　第一段。'), '预览里段首空两格', fails);
  await page.uncheck('input[data-opt="header"]');
  dl = await download(page, () => page.click('.modal-foot .btn.primary'));
  check(dl.text === '第一章 开端\n\n　　第一段。\n\n第二章 发展\n\n　　第二段。\n', '排好的 txt：' + JSON.stringify(dl.text), fails);
  check((await getText(page)) === '第二段。', '作品里的正文没动', fails);
  const lastEx = await kv(page, 'io:export');
  check(lastEx && lastEx.platform === true && lastEx.header === false, '记住这次的选择', fails);
  await closeToasts(page);

  console.log('存为方案（能撤销）');
  await page.click('.ws .topbar .tool-btn[data-cmd="io.export"]');
  await page.waitForSelector('.io-ex');
  check(await page.$eval('input[data-opt="platform"]', (e) => e.checked), '下次打开还勾着网文平台排版', fails);
  await page.click('.io-rules > summary');
  await page.uncheck('.io-rules-grid input[data-rule="quotes"]');
  await pause(page);
  check((await page.$eval('.io-scheme', (e) => e.value)) === '', '改了规则：方案显示「自定义」', fails);
  await page.click('.io-opts button:has-text("存为方案")');
  await page.fill('.modal input.input:focus', '投稿用');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast:has-text("已存为方案「投稿用」")');
  let schemes = await kv(page, 'format:schemes');
  check(Array.isArray(schemes) && schemes.some((s) => s.name === '投稿用' && s.rules.quotes === false), '方案存进 format:schemes', fails);
  check((await page.$eval('.io-scheme', (e) => e.value)) === '投稿用', '下拉框选中「投稿用」', fails);
  await clickToastUndo(page, '已存为方案');
  schemes = await kv(page, 'format:schemes');
  check(!(schemes || []).some((s) => s.name === '投稿用') && !(await page.$('.io-scheme option[value="投稿用"]')), '撤销：方案拿掉了', fails);

  console.log('自己挑、选中的几章、md');
  await page.click('.io-seg[aria-label="导出范围"] [data-v="pick"]');
  await page.click('.io-pick button:has-text("全不选")');
  check(await page.$eval('.modal-foot .btn.primary', (e) => e.disabled) && (await page.textContent('.io-out-wrap')).includes('至少挑一章'), '一章都不挑：不能导出', fails);
  await page.check('.io-pick-item input >> nth=1');
  check((await page.$eval('.io-name-in', (e) => e.value)) === '测试 md 第二章 发展', '只挑第二章：文件名带章名', fails);
  await page.uncheck('input[data-opt="platform"]');
  dl = await download(page, () => page.click('.modal-foot .btn.primary'));
  check(dl.text === '第二章 发展\n\n第二段。\n', '只导出第二章', fails);
  await closeToasts(page);
  await page.click('.ch-item:nth-child(1)', { modifiers: ['Control'] });
  await page.waitForSelector('.sel-bar:not([hidden])');
  await page.click('.ws .topbar .tool-btn[data-cmd="io.export"]');
  await page.waitForSelector('.io-ex');
  check((await page.$eval('.io-seg[aria-label="导出范围"] [aria-pressed="true"]', (e) => e.textContent)) === '选中的 2 章', '章节列表里选了两章：范围默认「选中的 2 章」', fails);
  await page.click('.io-seg[aria-label="格式"] [data-v="md"]');
  await page.check('input[data-opt="header"]');
  dl = await download(page, () => page.click('.modal-foot .btn.primary'));
  check(dl.name === '测试 md.md' && dl.text === '# 测试 md\n\n## 第一章 开端\n\n第一段。\n\n## 第二章 发展\n\n第二段。\n', 'md：' + dl.name + ' ' + JSON.stringify(dl.text), fails);
  await closeToasts(page);
  await page.click('.sel-bar button:has-text("取消选择")');

  console.log('整本备份');
  await page.click('.ch-item:nth-child(1)');
  await pause(page);
  await page.fill('.pt-add', '伏笔：信封');
  await page.keyboard.press('Enter');
  await pause(page, 500);
  await runCommand(page, '备份', '整本备份');
  const [bdl] = await Promise.all([page.waitForEvent('download'), pause(page, 10)]);
  const backupName = bdl.suggestedFilename();
  const backupText = fs.readFileSync(await bdl.path(), 'utf8');
  const backup = JSON.parse(backupText);
  check(backupName === '测试 md.xemo.json', '文件名：测试 md.xemo.json', fails);
  check(backup.app === 'xiaoemo-wenshu' && backup.books.length === 1 && backup.books[0].chapters.length === 2, '备份里一本书、两章', fails);
  check(backup.books[0].chapters[0].points.some((p) => p.text === '伏笔：信封') && typeof backup.books[0].stats === 'object', '要点和码字记录也在', fails);
  check((await toastText(page)).includes('已备份《测试 md》'), '提示条：已备份', fails);
  await closeToasts(page);
  await setText(page, '改过了。');
  await pause(page, 1500);

  console.log('从备份恢复：另存为一本新书');
  await page.click('.ws .topbar [aria-label="返回"]');
  await page.waitForSelector('.shelf');
  await openImportFromShelf(page);
  await chooseFile(page, backupName, Buffer.from(backupText), 'application/json');
  await page.waitForSelector('.modal-title:has-text("书架上已经有《测试 md》")');
  if (shot) await page.screenshot({ path: path.join(shot, 'io-restore-ask.png') });
  await page.click('.modal-foot .btn:has-text("另存为一本新书")');
  await page.waitForSelector('.toast:has-text("已恢复《测试 md（备份）》")');
  await pause(page, 400);
  let books = await idb(page, 'all', 'books');
  const copy = books.find((b) => b.title === '测试 md（备份）');
  check(books.length === 3 && copy && copy.id !== mdBook, '书架上多了《测试 md（备份）》，id 不一样', fails);
  check((await page.$$('.book-card')).length === 3, '书架刷新了', fails);
  chs = await allChapterTexts(page, copy.id);
  check(chs.length === 2 && chs[0].content === '第一段。' && chs[0].points.length === 1, '恢复的是备份时的正文和要点', fails);
  await clickToastUndo(page, '已恢复');
  books = await idb(page, 'all', 'books');
  trash = await idb(page, 'all', 'trash');
  check(books.length === 2 && trash.some((t) => t.kind === 'book' && t.bookId === copy.id), '撤销：新的那本放进回收站', fails);
  await closeToasts(page);

  console.log('从备份恢复：覆盖');
  await openImportFromShelf(page);
  await chooseFile(page, backupName, Buffer.from(backupText), 'application/json');
  await page.waitForSelector('.modal-title:has-text("书架上已经有")');
  await page.click('.modal-foot .btn:has-text("覆盖")');
  await page.waitForSelector('.toast:has-text("已恢复《测试 md》")');
  chs = await allChapterTexts(page, mdBook);
  trash = await idb(page, 'all', 'trash');
  const oldEntry = trash.find((t) => t.bookId === mdBook);
  check(chs.length === 2 && chs[0].content === '第一段。', '覆盖：正文换成备份里的', fails);
  check(oldEntry && oldEntry.data.chapters.some((c) => c.content === '改过了。'), '覆盖前的那本放进回收站了', fails);
  await clickToastUndo(page, '已恢复');
  chs = await allChapterTexts(page, mdBook);
  trash = await idb(page, 'all', 'trash');
  check(chs[0].content === '改过了。' && !trash.some((t) => t.id === oldEntry.id), '撤销：改过的那本回来，回收站里那条也拿掉', fails);
  await closeToasts(page);

  console.log('备份里有好几本');
  const two = JSON.parse(backupText);
  two.books.push({ book: { ...two.books[0].book, id: 'bOther', title: '另一本' }, chapters: [{ id: 'cOther1', order: 1, title: '独章', content: '另一本的正文。' }], stats: {} });
  await openImportFromShelf(page);
  await chooseFile(page, '两本.xemo.json', Buffer.from(JSON.stringify(two)), 'application/json');
  await page.waitForSelector('.io-rs-row');
  const rsRows = await page.$$eval('.io-rs-row', (els) => els.map((e) => e.textContent));
  check(rsRows.length === 2 && rsRows[0].includes('书架上已经有这本') && rsRows[1].includes('书架上没有'), '列出两本：已有的问怎么恢复，没有的直接放', fails);
  check((await page.$eval('.io-rs-mode', (e) => e.value)) === 'copy', '已有的默认另存为新书', fails);
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('.toast:has-text("已恢复 2 本作品")');
  books = await idb(page, 'all', 'books');
  check(books.some((b) => b.id === 'bOther') && books.filter((b) => b.title === '测试 md（备份）').length === 1 && books.length === 4, '两本都放上书架', fails);
  await clickToastUndo(page, '已恢复 2 本');
  books = await idb(page, 'all', 'books');
  check(books.length === 2 && !books.some((b) => b.id === 'bOther'), '一次撤销两本都拿掉', fails);
  await closeToasts(page);

  console.log('书架上备份全部作品');
  await runCommand(page, '备份', '整本备份');
  await page.waitForSelector('.io-ex');
  check((await page.$eval('.io-seg[aria-label="格式"] [aria-pressed="true"]', (e) => e.dataset.v)) === 'backup'
    && (await page.$eval('.io-seg[aria-label="备份范围"] [aria-pressed="true"]', (e) => e.dataset.v)) === 'all', '在书架上：默认备份全部作品', fails);
  dl = await download(page, () => page.click('.modal-foot .btn.primary'));
  const allBk = JSON.parse(dl.text);
  check(/^小恶魔文书备份 \d{4}-\d{2}-\d{2}\.xemo\.json$/.test(dl.name) && allBk.books.length === 2, '一个文件里两本：' + dl.name, fails);
  await closeToasts(page);

  console.log('不是备份的 json');
  await openImportFromShelf(page);
  await chooseFile(page, '别的.json', Buffer.from('{"foo":1}'), 'application/json');
  await page.waitForSelector('.notice');
  check((await page.textContent('.notice')).includes('不是小恶魔文书的备份') && await page.isVisible('.modal-foot .btn:has-text("换一个文件")'), '报错卡：不是备份，能直接换一个文件', fails);
  await page.click('.modal-foot .btn:has-text("知道了")');

  console.log('问小恶魔能搜到');
  const search = async (q) => { await page.keyboard.press('F1'); await page.waitForSelector('.help-search'); await page.fill('.help-search', q); const r = await page.$$eval('.help-item .help-t', (els) => els.map((e) => e.textContent)); await page.keyboard.press('Escape'); await pause(page, 150); return r; };
  check((await search('备份')).includes('整本备份') && (await search('备份')).includes('从备份恢复'), '搜「备份」：整本备份、从备份恢复', fails);
  check((await search('拆章')).includes('导入作品'), '搜「拆章」：导入作品', fails);
  check((await search('网文平台')).includes('导出'), '搜「网文平台」：导出', fails);

  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();

  console.log('手机宽度、深色模式');
  const mob = await launch(dist, { width: 390, height: 844 });
  await mob.page.emulateMedia({ colorScheme: 'dark' });
  const mp = mob.page;
  await openImportFromShelf(mp);
  await chooseFile(mp, '风起青萍.txt', gbk(NOVEL));
  await mp.waitForSelector('.io-pv');
  const over = () => mp.evaluate(() => {
    const m = document.querySelector('.modal');
    const r = m.getBoundingClientRect();
    const body = m.querySelector('.modal-body');
    return { doc: document.documentElement.scrollWidth, left: r.left, right: r.right, bw: body.scrollWidth, bcw: body.clientWidth };
  });
  let sz = await over();
  check(sz.doc <= 390 && sz.left >= 0 && sz.right <= 390 && sz.bw <= sz.bcw, '390px：导入预览不横向溢出 ' + JSON.stringify(sz), fails);
  const bg = await mp.$eval('.io-list', (e) => getComputedStyle(e).backgroundColor);
  check(bg === 'rgb(27, 27, 29)', '深色模式：列表用深色纸色 ' + bg, fails);
  if (shot) await mp.screenshot({ path: path.join(shot, 'io-preview-mobile-dark.png') });
  await mp.click('.modal-foot .btn.primary');
  await mp.waitForSelector('.cm-content');
  await closeToasts(mp);
  await mp.click('.ws .topbar .tool-btn[data-cmd="io.export"]');
  await mp.waitForSelector('.io-ex');
  await mp.check('input[data-opt="platform"]');
  await mp.click('.io-rules > summary');
  sz = await over();
  check(sz.doc <= 390 && sz.left >= 0 && sz.right <= 390 && sz.bw <= sz.bcw, '390px：导出弹窗不横向溢出 ' + JSON.stringify(sz), fails);
  if (shot) await mp.screenshot({ path: path.join(shot, 'io-export-mobile-dark.png') });
  const mdl = await download(mp, () => mp.click('.modal-foot .btn.primary'));
  check(mdl.text.includes('第六章 夜') && mdl.text.includes('　　夜里很安静。'), '手机上也能导出', fails);
  check(mob.errors.length === 0, '没有报错 ' + mob.errors.join(' | '), fails);
  await mob.browser.close();
}

(async () => {
  const fails = [];
  await unit(fails);
  if (!process.argv.includes('--unit')) await flows(process.argv[2] || path.join(__dirname, '../dist'), fails);
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
