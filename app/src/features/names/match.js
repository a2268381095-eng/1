// 正文里找名字。
// 设定库里的名字和别名拼成一个正则（长的在前，「林小栀」先于「林」），只认两个字以上的，单字名太容易撞上普通字。
// 本地找新名字（不花 token，可能不准）：说话的人（「某某说 / 道 / 笑……」，第一个字是常见姓）和带地名、门派、节日尾巴的词，出现两次以上才算。

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** terms: [{ id, name, aliases, color, kind }] → { re, byText: Map(文字 → term) } 或 null */
export function buildMatcher(terms) {
  const byText = new Map();
  for (const t of terms) {
    for (const s of [t.name, ...(t.aliases || [])]) {
      const w = String(s || "").trim();
      if (w.length < 2 || byText.has(w)) continue;
      byText.set(w, t);
    }
  }
  if (!byText.size) return null;
  const words = [...byText.keys()].sort((a, b) => b.length - a.length);
  return { re: new RegExp(words.map(esc).join("|"), "g"), byText };
}

/** 一段文字里所有出现的位置：[{ from, to, text, term }] */
export function findAll(m, text, offset = 0) {
  if (!m) return [];
  const out = [];
  m.re.lastIndex = 0;
  for (let r = m.re.exec(text); r; r = m.re.exec(text)) out.push({ from: offset + r.index, to: offset + r.index + r[0].length, text: r[0], term: m.byText.get(r[0]) });
  return out;
}

/** 每个设定在这段文字里出现几次：Map(term.id → { term, n, first }) */
export function countTerms(m, text) {
  const map = new Map();
  for (const x of findAll(m, text)) {
    const cur = map.get(x.term.id) || { term: x.term, n: 0, first: x.from };
    cur.n++;
    map.set(x.term.id, cur);
  }
  return map;
}

// ---------------- 本地找新名字 ----------------
const SURNAME1 = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗郑梁谢宋唐许韩冯邓曹彭曾萧肖田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付傅方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤温柳楚燕云顾凌沐苏洛秋宁谢裴纪商季池蓝聂岳卫景霍封慕楚司";
const SURNAME2 = ["欧阳", "司马", "上官", "诸葛", "东方", "慕容", "南宫", "独孤", "令狐", "皇甫", "公孙", "轩辕", "端木", "西门", "长孙", "宇文", "夏侯", "尉迟", "百里", "东郭", "南门", "第五", "钟离", "澹台", "公冶", "太史"];
const SAY = "说|道|问|笑|喊|叫|答|想|看|望|叹|哼|骂|吼|嘀咕|点头|摇头|皱眉|低声|轻声|冷声|沉声|开口|抬头|回头|转身|愣";
const SAY_RE = new RegExp(`(?:^|[，。！？；：、“”「」『』（）《》\\s…—])([\\u4e00-\\u9fa5]{2,4}?)(?=${SAY})`, "gm");
// 地名、门派、节日这些尾巴；短的常用词（上山、大门、关节……）排除
const TAIL = { 城: "place", 镇: "place", 村: "place", 寨: "place", 峰: "place", 岭: "place", 谷: "place", 崖: "place", 岛: "place", 洲: "place", 州: "place", 郡: "place",
  国: "place", 宫: "place", 殿: "place", 阁: "place", 楼: "place", 府: "place", 寺: "place", 庙: "place", 关: "place", 港: "place", 山: "place", 河: "place", 江: "place", 湖: "place", 海: "place", 林: "place", 原: "place",
  宗: "faction", 派: "faction", 帮: "faction", 盟: "faction", 门: "faction", 教: "faction", 会: "faction", 堂: "faction",
  节: "festival", 祭: "festival", 剑: "item", 刀: "item", 枪: "item", 丹: "item", 珠: "item", 镜: "item", 塔: "place" };
const LONG_ONLY = new Set("山河江湖海林原关门教会堂节楼".split(""));   // 这些尾巴要三个字以上才算
const STOP = new Set(("上山 下山 进山 出山 深山 高山 大山 江湖 江山 山河 大河 小河 河岸 大海 出海 林子 树林 森林 竹林 山林 平原 草原 高原 大门 出门 进门 开门 关门 房门 城门 家门 宫门 山门 门派 宗门 帮派 王国 帝国 天国 全国 外国 中国 回国 出国 王宫 皇宫 宫殿 大殿 正殿 楼阁 高楼 大楼 上楼 下楼 阁楼 寺庙 大会 开会 学会 机会 社会 一会 不会 都会 只会 也会 才会 就会 还会 天堂 食堂 课堂 殿堂 礼堂 关节 季节 细节 情节 章节 环节 礼节 时节 春节 祭祀 宝剑 长剑 短剑 舞剑 拔剑 长刀 短刀 拔刀 菜刀 长枪 手枪 灵丹 仙丹 珍珠 明珠 眼珠 眼镜 铜镜 镜子 宝塔 高塔 城市 城里 进城 出城 全城 京城 都城 县城 小镇 乡镇 山村 农村 村子 全村 海岛 小岛 岛上 山峰 高峰 山岭 山谷 峡谷 悬崖 山崖 九州 神州 本州 宗教 教会 帮会 公会 联盟 同盟 结盟 港口 码头 关口 海关 过关 难关 相关 有关 无关 开关 机关 关系 关心 关于 宫里 殿下 府上 府里 王府 官府 政府").split(" "));
const BAD_FIRST = new Set("的了是在和与就都也又而把被让给从到向往对于这那一个们我你他她它么吗呢吧啊着过还很太最更再已不没别".split(""));
const BAD_IN = new Set("的了是在和与就都也着过么吗呢吧啊们我你他她它这那".split(""));   // 名字中间不会有的字

function bump(map, k, kind) { const c = map.get(k) || { name: k, kind, n: 0 }; c.n++; map.set(k, c); }

/** text：要找的正文；known：设定库里已有的名字和别名、忽略过的（Set）。返回 [{ name, kind, n }]，按次数排 */
export function localFind(text, known = new Set()) {
  const found = new Map();
  // 说话的人
  SAY_RE.lastIndex = 0;
  for (let r = SAY_RE.exec(text); r; r = SAY_RE.exec(text)) {
    const w = r[1];
    const ok = SURNAME2.some((s) => w.startsWith(s) && w.length >= 3) || (SURNAME1.includes(w[0]) && w.length <= 3);
    if (ok && !BAD_FIRST.has(w[0]) && ![...w.slice(1)].some((ch) => BAD_IN.has(ch))) bump(found, w, "person");
  }
  // 带尾巴的地名、门派、节日、物品：从尾巴往前取 1–4 个字，次数不掉的最长那个
  const tailRe = new RegExp(`[${Object.keys(TAIL).join("")}]`, "g");
  const counts = new Map();
  for (let r = tailRe.exec(text); r; r = tailRe.exec(text)) {
    const end = r.index + 1;
    for (let k = 1; k <= 4; k++) {
      const start = end - 1 - k;
      if (start < 0) break;
      const w = text.slice(start, end);
      if (!/^[一-龥]+$/.test(w)) break;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const tails = new Map();
  for (const [w, n] of counts) {
    if (n < 2 || w.length < 2) continue;
    const tail = w[w.length - 1];
    if (LONG_ONLY.has(tail) && w.length < 3) continue;
    if (STOP.has(w) || BAD_FIRST.has(w[0]) || [...w.slice(1, -1)].some((ch) => BAD_IN.has(ch))) continue;
    // 往前多一个字次数不掉 → 短的那个只是长名字的一截（「云宗」是「青云宗」的一截）
    const longer = [...counts.entries()].some(([x, m]) => x.length === w.length + 1 && x.endsWith(w) && m >= n * 0.8 && !BAD_FIRST.has(x[0]));
    if (longer) continue;
    tails.set(w, { name: w, kind: TAIL[tail], n });
  }
  // 长的把短的盖住：「青云宗」在了，「云宗」不要
  for (const w of [...tails.keys()]) if ([...tails.keys()].some((x) => x !== w && x.endsWith(w) && tails.get(x).n >= tails.get(w).n * 0.8)) tails.delete(w);
  for (const [w, c] of tails) if (!found.has(w)) found.set(w, c);
  const covered = (w) => [...known].some((k) => k === w || (k.length >= 2 && (k.includes(w) || w.includes(k))));
  return [...found.values()].filter((c) => c.n >= 2 && !covered(c.name)).sort((a, b) => b.n - a.n).slice(0, 40);
}

// ---------------- 读 AI 找到的名字 ----------------
const KIND_WORDS = [
  ["person", /人物|角色|人名|人$|姓名|主角|配角|反派/], ["place", /地点|地名|地方|城市|国家|场景|位置/], ["item", /物品|道具|法宝|武器|兵器|宝物|器物/],
  ["faction", /势力|门派|组织|宗门|帮派|家族|阵营/], ["skill", /功法|技能|招式|法术|魔法|心法/], ["creature", /生物|妖兽|魔兽|怪物|种族|灵兽/], ["festival", /节日|节庆|庆典|节/],
];
export const kindOfWord = (w) => { for (const [k, re] of KIND_WORDS) if (re.test(w || "")) return k; return null; };

/**
 * AI 的回答 → [{ name, kind }]。认这些写法：「名字｜分类」「名字（分类）」「分类：名字、名字」「- 名字：说明」、JSON。
 * 只留正文里真的出现过的名字（AI 编出来的不要）。
 */
export function parseNames(answer, text) {
  const out = new Map();
  const add = (name, kind) => {
    name = String(name || "").replace(/^[\s\-*•·\d.、）)]+/, "").replace(/[「」『』“”"《》【】\s*]/g, "").trim();
    if (name.length < 2 || name.length > 12 || !text.includes(name)) return;
    if (!out.has(name) || (!out.get(name).kind && kind)) out.set(name, { name, kind: kind || null });
  };
  const s = String(answer || "").trim();
  try {
    const j = JSON.parse(s.replace(/^```(?:json)?|```$/g, "").trim());
    const walk = (v, kind = null) => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, kind));
      else if (v && typeof v === "object") {
        if (v.name || v.名字) add(v.name || v.名字, kindOfWord(v.type || v.kind || v.category || v.分类 || "") || kind);
        else for (const [k, x] of Object.entries(v)) walk(x, kindOfWord(k) || kind);
      } else if (typeof v === "string") add(v, kind);
    };
    walk(j);
    if (out.size) return [...out.values()];
  } catch (_) { /* 不是 JSON，按行读 */ }
  let section = null;
  for (const raw of s.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^#*\s*([^：:｜|]{1,8})[：:]\s*$/);
    if (head) { section = kindOfWord(head[1]); continue; }
    let m = line.match(/^[\-*•·\d.、\s]*([^｜|：:（(]+?)\s*[｜|]\s*([^｜|]+)/);
    if (m) { add(m[1], kindOfWord(m[2]) || section); continue; }
    m = line.match(/^[\-*•·\d.、\s]*([^（(：:]+?)\s*[（(]([^）)]+)[）)]/);
    if (m) { add(m[1], kindOfWord(m[2]) || section); continue; }
    m = line.match(/^[\-*•·\d.、\s]*([^：:]{1,8})[：:]\s*(.+)$/);
    if (m) {
      const k = kindOfWord(m[1]);
      if (k) { m[2].split(/[、，,；;\s]+/).forEach((w) => add(w, k)); continue; }
      add(m[1], section); continue;
    }
    line.split(/[、，,；;]+/).forEach((w) => add(w, section));
  }
  return [...out.values()];
}
