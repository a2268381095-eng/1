// 历史版本：存法和合并规则的单元测试（node 直接跑）+ 浏览器里的流程测试（Playwright，假时钟快进）
//   node build.mjs --out /tmp/xemo-versions && node tests/versions.test.cjs /tmp/xemo-versions
//   只跑单元测试：node tests/versions.test.cjs --unit
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { newBook, setText, getText, check } = require('./helpers.cjs');

const SRC = path.join(__dirname, '../src/features/versions');
const load = (f) => import(pathToFileURL(path.join(SRC, f)).href);

// 固定种子的随机数，失败了能复现
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const POOL = ['雨', '下', '到', '第三天', '林栀', '没有', '抬头', '。', '，', '“走吧。”', '门铃', '响了', '\n', '　　', '信', '旧', 'Tom', '42', '😀', '……', '她', '回头', '看了一眼', '\n\n'];
function words(r, n) { let s = ''; for (let i = 0; i < n; i++) s += POOL[Math.floor(r() * POOL.length)]; return s; }
function edit(r, text) {
  const k = r();
  const pos = Math.floor(r() * (text.length + 1));
  if (k < 0.35) return text.slice(0, pos) + words(r, 1 + Math.floor(r() * 6)) + text.slice(pos);
  if (k < 0.6) { const end = Math.min(text.length, pos + Math.floor(r() * 12)); return text.slice(0, pos) + text.slice(end); }
  if (k < 0.85) { const end = Math.min(text.length, pos + Math.floor(r() * 8)); return text.slice(0, pos) + words(r, 1 + Math.floor(r() * 3)) + text.slice(end); }
  if (k < 0.97) return text + '\n　　' + words(r, 5 + Math.floor(r() * 20));
  return words(r, 10 + Math.floor(r() * 40));   // 偶尔整章重写
}

// ---------------- 单元测试 ----------------
async function unit(fails) {
  const E = await load('engine.js');
  const { makeDelta, applyDelta, encode, decodeRow, textAt, chainState, sortRows, planKeep, compactChain, bucketOf, alignRows, foldRows,
    dayLabel, whenLabel, FULL_EVERY, HOUR, DAY } = E;

  console.log('补丁');
  const r0 = rng(7);
  let ok = true;
  for (let i = 0; i < 400; i++) {
    const a = words(r0, Math.floor(r0() * 60)), b = r0() < 0.5 ? edit(r0, a) : words(r0, Math.floor(r0() * 60));
    const d = makeDelta(a, b);
    if (applyDelta(a, d) !== b) { ok = false; console.log('  反例', JSON.stringify(a), JSON.stringify(b)); break; }
  }
  check(ok, '随机 400 对文字：补丁套回去和原文一字不差（含 emoji、换行、全角空格）', fails);
  check(JSON.stringify(makeDelta('　　雨下到第三天。', '　　雨下到第四天。')) === JSON.stringify([6, -1, '四', 2]), '补丁只记改动：[保留 6, 删 1, 加「四」, 保留 2]', fails);
  let threw = 0;
  for (const bad of [['短', [5]], ['原文', [1]], ['原文', [-3]], ['原文', [{}]], [null, [1]]]) { try { applyDelta(bad[0], bad[1]); } catch (_) { threw++; } }
  check(threw === 5, '补丁和底稿对不上时报错，不会悄悄还原错字', fails);
  check(encode(null, '第一版', 0).kind === 'full' && encode('甲乙丙', '甲乙丙丁', FULL_EVERY - 1).kind === 'full', '第一版、每 20 版存全文', fails);
  const longA = '　　' + '雨下到第三天，林栀没有抬头。'.repeat(20);
  check(encode(longA, longA + '门铃响了。', 3).kind === 'patch', '小改动存补丁', fails);
  check(encode('甲乙', '完全不同的一段话', 1).kind === 'full', '补丁比全文还长时直接存全文', fails);
  let lenErr = false;
  try { decodeRow({ kind: 'full', data: '甲乙', len: 3 }, null); } catch (_) { lenErr = true; }
  check(lenErr, '还原出来长度不对会报错', fails);

  console.log('记录 → 合并 → 每一版都能还原');
  const now0 = new Date(2026, 9, 8, 15, 30).getTime();
  function record(rows, text, ts) {
    const prev = rows.length ? textAt(rows, rows.length - 1) : null;
    const st = chainState(rows);
    const enc = encode(prev, text, st ? st.sinceFull : 0);
    rows.push({ id: 'v' + String(rows.length).padStart(5, '0'), chapterId: 'c1', ts, kind: enc.kind, data: enc.data, words: text.length, len: text.length });
  }
  function maxRun(rows) { let run = 0, m = 0; for (const r of rows) { run = r.kind === 'full' ? 0 : run + 1; m = Math.max(m, run); } return m; }
  function applyPlan(rows, plan) {
    if (!plan) return rows;
    const dels = new Set(plan.dels);
    const puts = new Map(plan.puts.map((r) => [r.id, r]));
    return sortRows(rows.filter((r) => !dels.has(r.id)).map((r) => puts.get(r.id) || r));
  }
  function verify(rows, truth, now, tag) {
    let bad = 0;
    rows.forEach((r, i) => { let t; try { t = textAt(rows, i); } catch (_) { t = null; } if (t !== truth.get(r.id)) bad++; });
    const tierOk = (() => {
      const seen = new Set();
      for (const r of rows) { const b = bucketOf(r.ts, now); if (b && seen.has(b)) return false; if (b) seen.add(b); }
      return true;
    })();
    return { bad, tierOk, run: maxRun(rows) };
  }
  let allGood = true, totalBefore = 0, totalAfter = 0, sawFullDeleted = false;
  for (let seed = 1; seed <= 12; seed++) {
    const r = rng(seed * 97);
    const truth = new Map();
    let rows = [];
    let text = words(r, 30);
    // 30 天前开始写：有时隔几分钟，有时隔几小时、几天
    let ts = now0 - 30 * DAY;
    while (ts < now0 - 60000) {
      text = edit(r, text);
      record(rows, text, ts);
      truth.set(rows[rows.length - 1].id, text);
      const g = r();
      ts += g < 0.6 ? 60000 + Math.floor(r() * 10 * 60000) : g < 0.9 ? Math.floor(r() * 5 * HOUR) : Math.floor(r() * 2 * DAY);
    }
    const before = rows.length;
    const original = rows.slice();
    const bad0 = verify(rows, truth, now0).bad;
    const fullsBefore = new Set(rows.filter((x) => x.kind === 'full').map((x) => x.id));
    const plan = compactChain(rows, now0);
    if (plan && plan.dels.some((id) => fullsBefore.has(id))) sawFullDeleted = true;
    rows = applyPlan(rows, plan);
    const v1 = verify(rows, truth, now0);
    // 24 小时内的一版都不能少；最新一版一定在
    const ids = new Set(rows.map((x) => x.id));
    const recentKept = original.filter((x) => now0 - x.ts < DAY).every((x) => ids.has(x.id)) && ids.has(original[original.length - 1].id);
    const again = compactChain(rows, now0);
    // 时间往后走 3 天、10 天再合并
    const rowsLater = applyPlan(rows, compactChain(rows, now0 + 3 * DAY));
    const v2 = verify(rowsLater, truth, now0 + 3 * DAY);
    const rowsLater2 = applyPlan(rowsLater, compactChain(rowsLater, now0 + 10 * DAY));
    const v3 = verify(rowsLater2, truth, now0 + 10 * DAY);
    const good = bad0 === 0 && v1.bad === 0 && v1.tierOk && recentKept && v1.run <= FULL_EVERY - 1 && !again
      && v2.bad === 0 && v2.tierOk && v2.run <= FULL_EVERY - 1 && v3.bad === 0 && v3.tierOk && rowsLater2.length <= rowsLater.length;
    if (!good) { allGood = false; console.log('  种子', seed, { bad0, v1, recentKept, again: !!again, v2, v3 }); }
    totalBefore += before; totalAfter += rows.length;
  }
  check(allGood, '12 组随机编辑序列：合并前后、往后 3 天和 10 天再合并，留下的每一版都还原成当时的文字；补丁链不超过 19 节；合并第二次没东西可删', fails);
  check(totalAfter < totalBefore, `合并后变少了：${totalBefore} → ${totalAfter} 版`, fails);
  check(sawFullDeleted, '删掉过存全文的版本，后面的补丁也能重新接上', fails);

  console.log('合并规则');
  const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
  const now = at(8, 15, 30);
  const R = (list) => list.map((ts, i) => ({ id: 'r' + i, ts }));
  const rows = R([
    new Date(2026, 8, 30, 9, 0).getTime(), new Date(2026, 8, 30, 10, 0).getTime(), new Date(2026, 8, 30, 22, 0).getTime(),   // 8 天前：同一天三版 → 留最后一版
    at(5, 10, 5), at(5, 10, 40), at(5, 11, 2),           // 3 天前：10 点两版 → 留 10:40；11 点一版
    at(7, 16, 0), at(7, 16, 20), at(7, 16, 40),          // 不到 24 小时：全留
    at(8, 15, 0), at(8, 15, 1), at(8, 15, 2),
  ]);
  const keep = planKeep(rows, now);
  check(JSON.stringify(keep) === JSON.stringify([false, false, true, false, true, true, true, true, true, true, true, true]),
    '24 小时内全留、一周内每小时留最后一份、更早每天留最后一份 ' + keep.map((k) => (k ? 1 : 0)).join(''), fails);
  check(planKeep(R([at(1, 9, 0)]), now)[0] === true, '只有一版时总会留下', fails);
  check(bucketOf(now - 1000, now) === null && bucketOf(now + 5000, now) === null, '24 小时内和时间在未来的不合并', fails);
  check(compactChain(rows.map((x) => ({ ...x, kind: 'full', data: 'x' })).slice(6), now) === null, '没什么可删时不动', fails);
  let corrupt = false;
  try { compactChain([{ id: 'a', ts: at(1, 1, 0), kind: 'full', data: '甲' }, { id: 'b', ts: at(1, 2, 0), kind: 'patch', data: [9] }, { id: 'c', ts: now, kind: 'patch', data: [1] }], now); } catch (_) { corrupt = true; }
  check(corrupt, '链上有坏数据时报错（调用方跳过这一章，不在坏数据上动手）', fails);

  console.log('左右对比');
  const r1 = rng(11);
  let alignOk = true;
  for (let i = 0; i < 300; i++) {
    let a = words(r1, Math.floor(r1() * 50));
    const b = r1() < 0.7 ? edit(r1, edit(r1, a)) : words(r1, Math.floor(r1() * 50));
    const rows2 = alignRows(a, b);
    const L = rows2.map((x) => (x.same ? x.text : x.l.filter((p) => p.t <= 0).map((p) => p.s).join(''))).join('');
    const Rr = rows2.map((x) => (x.same ? x.text : x.r.filter((p) => p.t >= 0).map((p) => p.s).join(''))).join('');
    const lOnly = rows2.every((x) => x.same || (x.l.every((p) => p.t <= 0) && x.r.every((p) => p.t >= 0)));
    const flat = foldRows(rows2, 1).flatMap((it) => (it.fold ? it.fold : [it.row]));
    const foldOk = flat.length === rows2.length && flat.every((x, k) => x === rows2[k]) && foldRows(rows2, 1).every((it) => !it.fold || it.fold.length > 1);
    if (L !== a || Rr !== b || !lOnly || !foldOk) { alignOk = false; console.log('  反例', JSON.stringify(a), JSON.stringify(b)); break; }
  }
  check(alignOk, '随机 300 对：左边拼起来是现在、右边拼起来是那时；折叠不丢段、不打乱顺序', fails);
  const paras = Array.from({ length: 12 }, (_, i) => `　　第${i + 1}段，雨还在下。`);
  const changedParas = paras.slice(); changedParas[1] = '　　第2段，雨停了。'; changedParas[10] = '　　第11段，门铃响了。';
  const ar = alignRows(changedParas.join('\n'), paras.join('\n'));
  const fr = foldRows(ar, 1);
  check(ar.filter((x) => !x.same).length === 2 && fr.some((x) => x.fold && x.fold.length === 6), '两处改动，各留一段上下文，中间 6 段没改的折起来', fails);
  const chg = ar.find((x) => !x.same);
  check(chg.l.some((p) => p.t === -1 && p.s.includes('停')) && chg.r.some((p) => p.t === 1 && p.s.includes('还在下')), '改动标在字上：左边「停」、右边「还在下」', fails);

  console.log('显示');
  check(dayLabel(now - 1000, now) === '今天' && dayLabel(now - DAY, now) === '昨天' && dayLabel(at(5, 10, 0), now) === '10月5日 周一'
    && dayLabel(new Date(2025, 2, 2).getTime(), now) === '2025年3月2日', '分组标题：今天 / 昨天 / 10月5日 周一 / 2025年3月2日', fails);
  check(whenLabel(at(5, 9, 7), now) === '10月5日 09:07' && whenLabel(now, now) === '今天 15:30', '一版的时间：10月5日 09:07', fails);
}

// ---------------- 浏览器流程 ----------------
async function launch(dist, { width = 1360, height = 860 } = {}) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.clock.install({ time: new Date('2026-10-08T10:00:00') });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('file://' + path.resolve(dist) + '/index.html');
  await page.waitForSelector('.topbar');
  return { browser, ctx, page, errors };
}

/** 直接读数据库里某一章的版本（按时间排好） */
const rowsOf = (page, cid) => page.evaluate((cid) => new Promise((res, rej) => {
  const rq = indexedDB.open('xiaoemo-wenshu');
  rq.onsuccess = () => {
    const db = rq.result;
    const q = db.transaction('versions').objectStore('versions').index('chapterId').getAll(cid);
    q.onsuccess = () => { db.close(); res(q.result.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))); };
    q.onerror = () => rej(q.error);
  };
  rq.onerror = () => rej(rq.error);
}), cid);
/** 等到这一章正好有 n 版（机器忙的时候数据库慢一点） */
async function waitRows(page, cid, n, ms = 6000) {
  const end = Date.now() + ms;
  let rows = await rowsOf(page, cid);
  while (rows.length !== n && Date.now() < end) { await page.waitForTimeout(150); rows = await rowsOf(page, cid); }
  return rows;
}
const putRows = (page, rows) => page.evaluate((rows) => new Promise((res, rej) => {
  const rq = indexedDB.open('xiaoemo-wenshu');
  rq.onsuccess = () => {
    const db = rq.result;
    const t = db.transaction('versions', 'readwrite');
    rows.forEach((r) => t.objectStore('versions').put(r));
    t.oncomplete = () => { db.close(); res(); };
    t.onerror = () => rej(t.error);
  };
}), rows);
const curId = (page) => page.evaluate(() => location.hash.split('/')[3]);
const toastText = (page) => page.$$eval('.toast .toast-msg', (els) => els.map((e) => e.textContent).join(' | '));
async function clickToastUndo(page, has) {
  const ts = await page.$$('.toast');
  for (const t of ts) if ((await t.textContent()).includes(has)) { await (await t.$('.toast-act')).click(); break; }
  await page.waitForTimeout(700);
}
async function closeToasts(page) { for (const x of await page.$$('.toast-x')) await x.click().catch(() => {}); await page.waitForTimeout(250); }
/**
 * 假时钟往后拨 ms 毫秒（到点的定时器各跑一次），再等页面把数据库的事做完。
 * Playwright 的假时钟在「时间照常走」时偶尔会被同时进行的同步拨回去，所以拨完核对一下，没到就再拨。
 */
async function forward(page, ms) {
  const now = () => page.evaluate(() => Date.now());
  const target = (await now()) + ms;
  for (let i = 0; i < 6; i++) {
    const left = target - (await now());
    if (left <= 0) break;
    await page.clock.fastForward(left);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(300);
}

const para = (n, fn) => Array.from({ length: n }, (_, i) => fn(i + 1)).join('\n');
const T1 = para(12, (i) => `　　第${i}段。雨下到第三天，林栀没有抬头。`);
const T2 = T1.replace('第2段。雨下到第三天', '第2段。雨停了');
const T3 = T2.replace('第11段。雨下到第三天，林栀没有抬头。', '第11段。门铃响了，她回头看了一眼。') + '\n　　第13段。信是旧的。';
const T3b = T3 + '再补一句。';
const T4 = T3b.replace('　　第6段。雨下到第三天，林栀没有抬头。\n', '');

async function flows(dist, fails) {
  const E = await load('engine.js');
  const decodeAll = (rows) => rows.map((_, i) => { try { return E.textAt(rows, i); } catch (_) { return null; } });

  console.log('记录：第一次马上记，之后至少隔 1 分钟');
  const { browser, page, errors } = await launch(dist);
  await newBook(page, '历史测试', [{ title: '门铃', text: T1 }]);
  const c1 = await curId(page);
  let rows = await waitRows(page, c1, 1);
  check(rows.length === 1 && E.textAt(rows, 0) === T1 && rows[0].kind === 'full', '第一次保存就记了一版（全文）', fails);
  await setText(page, T2);
  await page.waitForTimeout(1500);
  check((await rowsOf(page, c1)).length === 1, '不到 1 分钟的保存先不记', fails);
  await forward(page, 61000);
  rows = await waitRows(page, c1, 2);
  check(rows.length === 2 && E.textAt(rows, 1) === T2 && rows[1].kind === 'patch', '够 1 分钟后补记了一版（只存改动）', fails);
  await setText(page, T3);
  await page.waitForTimeout(1500);
  await setText(page, T3b);
  await page.waitForTimeout(1500);
  await forward(page, 61000);
  rows = await waitRows(page, c1, 3);
  check(rows.length === 3 && E.textAt(rows, 2) === T3b, '1 分钟内改了两次，只记最后的样子', fails);
  check(rows.length === 3 && rows[1].ts - rows[0].ts >= 60000 && rows[2].ts - rows[1].ts >= 60000, '两次记录至少隔 60 秒', fails);
  await setText(page, T4);
  await page.waitForTimeout(1500);   // 这一次还没到 1 分钟，没进历史

  console.log('面板：列表、对比');
  await page.click('.tool-btn[data-cmd="versions.open"]');
  await page.waitForSelector('.ver-item');
  check((await page.$$('.ver-item')).length === 3, '列出 3 版', fails);
  check((await page.textContent('.ver-day')) === '今天', '按天分组：今天', fails);
  check((await page.getAttribute('.tool-btn[data-cmd="versions.open"]', 'aria-pressed')) === 'true', '顶栏「历史」按钮按下', fails);
  const deltas = await page.$$eval('.ver-item .ver-delta', (els) => els.map((e) => e.textContent));
  check(deltas[2] === '最早' && /^[+−±]/.test(deltas[0]) && /^[+−]/.test(deltas[1]), '每版写比上一版多 / 少多少字：' + deltas.join(' '), fails);
  check((await page.textContent('.ver-top')).includes('第一章') && (await page.textContent('.ver-top')).includes('共 3 版'), '顶上写着哪一章、共几版', fails);
  await page.click('.ver-item[data-i="0"]');
  await page.waitForSelector('.ver-overlay');
  check(await page.isVisible('.ver-overlay .ver-cols'), '点一版：正文区上面出现左右对比', fails);
  const cmp = await page.evaluate(() => ({
    sum: document.querySelector('.ver-sum').textContent,
    ins: [...document.querySelectorAll('.ver-row .ver-cell:first-child .ver-ins')].map((e) => e.textContent).join('|'),
    del: [...document.querySelectorAll('.ver-row .ver-cell:last-child .ver-del')].map((e) => e.textContent).join('|'),
    folds: document.querySelectorAll('.ver-fold').length,
    head: document.querySelector('.ver-cols').textContent,
  }));
  check(cmp.head.includes('现在') && cmp.head.includes('那时'), '左边现在、右边那时', fails);
  check(cmp.ins.includes('门铃响了') && cmp.ins.includes('停了') && cmp.del.includes('下到第三天'), '改动处标色：左边绿色是后来加的、右边红色是后来删掉的', fails);
  check(cmp.sum.includes('处不同') && cmp.folds >= 1, '写着几处不同；没改的段折起来 ' + cmp.sum, fails);
  await page.click('.ver-fold');
  check((await page.$$('.ver-fold')).length === cmp.folds - 1, '点开折起来的段', fails);
  await page.click('.ver-only input');
  check((await page.$$('.ver-fold')).length === 0 && (await page.$$('.ver-row.same')).length >= 8, '取消「只看改动处」显示全文', fails);
  await page.click('.ver-only input');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(!(await page.$('.ver-overlay')) && (await page.$('.ver-list')), 'Esc 先关对比，面板还在', fails);
  check((await getText(page)) === T4, '只是看看，正文没动', fails);

  console.log('恢复和撤销');
  await page.click('.ver-item[data-i="0"]');
  await page.waitForSelector('.ver-overlay .ver-restore:not([disabled])');
  await page.click('.ver-restore');
  await page.waitForTimeout(800);
  check((await getText(page)) === T1, '恢复成最早那一版', fails);
  check(!(await page.$('.ver-overlay')), '恢复后关掉对比，回到列表', fails);
  check((await toastText(page)).includes('已恢复到'), '出提示条「已恢复到……的版本」', fails);
  rows = await waitRows(page, c1, 4);
  const texts = decodeAll(rows);
  check(rows.length === 4 && texts[3] === T4 && rows[3].note === '恢复前', '恢复前先把现在的正文记了一版（标着「恢复前」）', fails);
  await page.waitForTimeout(400);
  check((await page.$$eval('.ver-item .ver-tag', (els) => els.map((e) => e.textContent))).includes('恢复前'), '列表里能看到「恢复前」', fails);
  await clickToastUndo(page, '已恢复到');
  check((await getText(page)) === T4, '点提示条上的「撤销」，正文回到恢复前', fails);
  await closeToasts(page);
  // 再恢复一次，用 Ctrl+Z 撤销
  await page.click('.ver-item[data-i="1"]');
  await page.waitForSelector('.ver-overlay .ver-restore:not([disabled])');
  await page.click('.ver-restore');
  await page.waitForTimeout(800);
  check((await getText(page)) === T2, '恢复成第二版', fails);
  await page.click('.cm-content');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(700);
  check((await getText(page)) === T4, '在正文里按 Ctrl+Z 整体撤销恢复', fails);
  await closeToasts(page);
  await page.waitForTimeout(1200);

  console.log('换章、Esc、问小恶魔');
  await page.click('.cm-content');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(500);
  await setText(page, '　　第二章的开头。');
  await page.waitForTimeout(1500);
  const c2 = await curId(page);
  check(c2 !== c1 && (await waitRows(page, c2, 1)).length === 1, '新的一章第一次保存也记了一版', fails);
  check(await page.$('.ver-list'), '换章时面板还开着', fails);
  await page.waitForTimeout(400);
  check((await page.textContent('.ver-top')).includes('第二章') && (await page.$$('.ver-item')).length === 1, '面板跟着换成这一章的版本', fails);
  await page.click('.ch-item[data-id="' + c1 + '"]');
  await page.waitForTimeout(700);
  check((await page.textContent('.ver-top')).includes('第一章') && (await page.$$('.ver-item')).length === 4, '换回第一章，列表也换回来', fails);
  await page.click('.ver-item[data-i="0"]');
  await page.waitForSelector('.ver-overlay');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(200);
  check((await page.getAttribute('.ver-item.cur', 'data-i')) === '1' && (await page.textContent('.ver-sub')).includes('右边'), '对比开着时按上下键换着看', fails);
  await page.click('.ver-head .icon-btn[aria-label="返回"]');
  await page.waitForTimeout(200);
  check(!(await page.$('.ver-overlay')), '对比左上角的返回回到列表', fails);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(!(await page.$('.ver-list')) && (await page.getAttribute('.tool-btn[data-cmd="versions.open"]', 'aria-pressed')) === 'false', '再按 Esc 关掉面板', fails);
  await page.keyboard.press('F1');
  await page.waitForSelector('.help-search');
  await page.fill('.help-search', '历史');
  check((await page.$$eval('.help-item .help-t', (els) => els.map((e) => e.textContent))).includes('本章历史版本'), '问小恶魔搜「历史」能找到', fails);
  await page.fill('.help-search', '改错了');
  const found = await page.$$eval('.help-item .help-t', (els) => els.map((e) => e.textContent));
  check(found.includes('本章历史版本'), '搜「改错了」也能找到', fails);
  await page.click('.help-item:has-text("本章历史版本")');
  await page.waitForSelector('.ver-list');
  check(true, '从小恶魔那里点开面板', fails);
  await page.keyboard.press('Escape');

  console.log('合并旧版本：启动时和每小时');
  const now = await page.evaluate(() => Date.now());
  const D = E.DAY, H = E.HOUR;
  const dayStart = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  // 第二章前面补一串旧版本：10 天前同一天 3 版、3 天前同一小时 3 版，用补丁接起来
  const old = [];
  const OP = '　　' + '旧稿里的一段话，写得比较长。'.repeat(6);
  const oldTexts = [OP + '一', OP + '一二', OP + '一二三', OP + '四', OP + '四五', OP + '四五六'];
  const d10 = dayStart(now - 10 * D) + 9 * H, d3 = dayStart(now - 3 * D) + 14 * H;
  const oldTs = [d10, d10 + 2 * H, d10 + 5 * H, d3 + 60000, d3 + 20 * 60000, d3 + 40 * 60000];
  oldTexts.forEach((t, i) => {
    const prev = old.length ? E.textAt(old, old.length - 1) : null;
    old.push({ id: 'vold' + i, chapterId: c2, ts: oldTs[i], kind: i === 0 ? 'full' : 'patch', data: i === 0 ? t : E.makeDelta(prev, t), words: t.length, len: t.length });
  });
  await putRows(page, old);
  check(decodeAll(await rowsOf(page, c2)).every((t) => t != null), '补进去的旧版本链是好的', fails);
  await page.reload();
  await page.waitForSelector('.cm-content');
  await forward(page, 5000);   // 启动后 4 秒合并
  rows = await waitRows(page, c2, 3);
  let texts2 = decodeAll(rows);
  check(rows.length === 3 && texts2[0] === OP + '一二三' && texts2[1] === OP + '四五六' && texts2[2] === '　　第二章的开头。',
    '启动时合并：10 天前那天留最后一版，3 天前那个小时留最后一版，还原出来字都对 ' + JSON.stringify(texts2), fails);
  check(rows[0].kind === 'full' && rows[1].kind === 'patch', '留下的补丁按新的上一版重新算过', fails);
  // 23 小时多以前的同一小时 3 版：现在不动，过一小时就该合并
  const nowB = await page.evaluate(() => Date.now());
  const hb = new Date(nowB - 23.5 * H); hb.setMinutes(0, 0, 0);
  const recent = [];
  ['　　近稿。', '　　近稿，加一句。', '　　近稿，加两句。'].forEach((t, i) => {
    recent.push({ id: 'vnear' + i, chapterId: c2, ts: hb.getTime() + (i + 1) * 60000, kind: 'full', data: t, words: t.length, len: t.length });
  });
  await putRows(page, recent);
  await forward(page, 3600 * 1000 + 1000);
  rows = await waitRows(page, c2, 4);
  texts2 = decodeAll(rows);
  check(rows.length === 4 && texts2.includes('　　近稿，加两句。') && !texts2.includes('　　近稿。') && texts2.every((t) => t != null),
    '每小时合并一次：过了 24 小时的那一小时只留最后一版 ' + rows.length, fails);
  await page.click('.ch-item[data-id="' + c2 + '"]');
  await page.waitForTimeout(600);
  await page.click('.tool-btn[data-cmd="versions.open"]');
  await page.waitForSelector('.ver-item');
  const days = await page.$$eval('.ver-day', (els) => els.map((e) => e.textContent));
  check(days.length === 4 && days[0] === '今天' && /月.*日 周/.test(days[3]), '面板里旧版本按天分组：' + days.join(' / '), fails);
  await page.click('.ver-item[data-i="0"]');
  await page.waitForSelector('.ver-overlay .ver-restore:not([disabled])');
  await page.click('.ver-restore');
  await page.waitForTimeout(800);
  check((await getText(page)) === OP + '一二三', '合并过的旧版本也能恢复', fails);
  await page.waitForTimeout(400);
  check(await page.$$eval('.ver-item', (els) => !!els[0].querySelector('.ver-tag.now')), '恢复后的正文记成最新一版，标着「和现在一样」', fails);
  await clickToastUndo(page, '已恢复到');
  check((await getText(page)) === '　　第二章的开头。', '撤销后回到原来的正文', fails);
  await page.waitForTimeout(1500);
  check(!(await page.$('.ver-tag.now')), '撤销以后「和现在一样」跟着去掉', fails);

  console.log('深色模式颜色');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('.ver-item[data-i="0"]');
  await page.waitForSelector('.ver-overlay');
  const dark = await page.evaluate(() => ({
    bg: getComputedStyle(document.querySelector('.ver-overlay')).backgroundColor,
    del: getComputedStyle(document.querySelector('.ver-del')).color,
    list: getComputedStyle(document.querySelector('.side-right')).backgroundColor,
  }));
  check(dark.bg === 'rgb(27, 21, 29)' && dark.del === 'rgb(255, 143, 162)' && dark.list === 'rgb(23, 18, 25)', '深色模式跟着变：' + JSON.stringify(dark), fails);
  await page.emulateMedia({ colorScheme: 'light' });
  if (process.env.SHOT) await page.screenshot({ path: path.join(process.env.SHOT, 'versions-desktop.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  check(errors.length === 0, '没有报错 ' + errors.join(' | '), fails);
  await browser.close();

  console.log('手机宽度（390px）、深色');
  const m = await launch(dist, { width: 390, height: 844 });
  await m.page.emulateMedia({ colorScheme: 'dark' });
  await newBook(m.page, '手机', [{ title: '', text: T1 }]);
  await setText(m.page, T3);
  await m.page.waitForTimeout(1500);
  await forward(m.page, 61000);
  await waitRows(m.page, await curId(m.page), 2);
  await m.page.click('.tool-btn[data-cmd="versions.open"]');
  await m.page.waitForSelector('.ver-item');
  const box1 = await m.page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width, height: b.height }; };
    return { sw: document.documentElement.scrollWidth, panel: r('.side-right'), center: r('.center'), now: document.querySelector('.ver-tag.now') ? 1 : 0,
      demon: getComputedStyle(document.querySelector('.demon')).display };
  });
  check(box1.sw <= 390 && box1.panel && box1.panel.width >= 380 && box1.panel.right <= 390 && box1.panel.height > 400, '手机：版本列表占满一屏，不横向溢出 ' + JSON.stringify(box1), fails);
  check(box1.now === 1, '最新一版和现在一样时标出来', fails);
  if (process.env.SHOT) await m.page.screenshot({ path: path.join(process.env.SHOT, 'versions-mobile-list.png') });
  await m.page.click('.ver-item[data-i="0"]');
  await m.page.waitForSelector('.ver-overlay');
  await m.page.waitForTimeout(200);
  const box2 = await m.page.evaluate(() => {
    const o = document.querySelector('.ver-overlay').getBoundingClientRect();
    const cells = [...document.querySelectorAll('.ver-cols .ver-col-t')].map((e) => e.getBoundingClientRect().width);
    const s = document.querySelector('.ver-scroll');
    return { sw: document.documentElement.scrollWidth, left: o.left, right: o.right, width: o.width, cells, ssw: s.scrollWidth, scw: s.clientWidth,
      restore: document.querySelector('.ver-restore').getBoundingClientRect().right, panel: getComputedStyle(document.querySelector('.side-right')).display,
      bg: getComputedStyle(document.querySelector('.ver-overlay')).backgroundColor, ins: getComputedStyle(document.querySelector('.ver-ins')).color };
  });
  check(box2.sw <= 390 && box2.left >= 0 && box2.right <= 390 && box2.width >= 380 && box2.ssw <= box2.scw && box2.restore <= 390, '手机：对比占满一屏，不横向溢出 ' + JSON.stringify(box2), fails);
  check(box2.cells.length === 2 && box2.cells.every((w) => w > 150), '手机上也是左右并排 ' + box2.cells.join(','), fails);
  check(box2.panel === 'none' && box2.bg === 'rgb(27, 21, 29)' && box2.ins === 'rgb(127, 209, 168)', '深色：' + box2.bg + ' / ' + box2.ins, fails);
  if (process.env.SHOT) await m.page.screenshot({ path: path.join(process.env.SHOT, 'versions-mobile-compare.png') });
  await m.page.click('.ver-head .icon-btn[aria-label="返回"]');
  await m.page.waitForTimeout(200);
  check(await m.page.isVisible('.ver-list'), '手机：返回回到列表', fails);
  await m.page.click('.ver-item[data-i="0"]');
  await m.page.click('.ver-restore');
  await m.page.waitForTimeout(800);
  check((await getText(m.page)) === T1, '手机上也能恢复', fails);
  await m.page.click('.panel-head .icon-btn[aria-label="关闭"]');
  await m.page.waitForTimeout(200);
  check(await m.page.isVisible('.cm-content'), '关掉面板回到正文', fails);
  check(m.errors.length === 0, '没有报错 ' + m.errors.join(' | '), fails);
  await m.browser.close();
}

(async () => {
  const fails = [];
  await unit(fails);
  if (!process.argv.includes('--unit')) await flows(process.argv[2] && process.argv[2] !== '--unit' ? process.argv[2] : path.join(__dirname, '../dist'), fails);
  console.log(fails.length ? `失败 ${fails.length} 项` : '全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
