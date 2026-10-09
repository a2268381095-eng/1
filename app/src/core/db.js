// 本地数据库（IndexedDB）。所有数据都在这台电脑上，断网照常用。
// 以后换成桌面版（Tauri + SQLite）时，只需要换掉这个文件，接口不变。

const DB_NAME = "xiaoemo-wenshu";
const DB_VERSION = 3;

// 表：
//   books     作品          { id, title, intro, tags, cover, ... }
//   chapters  章节          { id, bookId, order, title, content, points, words, ... }  索引 bookId
//   versions  章节历史版本   { id, chapterId, ts, kind: "full"|"patch", data }       索引 chapterId
//   trash     回收站        { id, kind, bookId, title, data, deletedAt }             索引 bookId
//   undo      每章撤销记录   { chapterId, json }
//   kv        设置和杂项     { key, value }
//   usage     AI 调用记账    { id, at, providerId, model, feature, bookId, input, output, cost, currency }   索引 bookId
//   stash     暂存盒         { id, at, bookId, feature, kind: "text"|"image", ... }                     索引 bookId
//   prompts   提示词库       { id, name, group, text, order, uses, pinned }
//   chats     AI 对话        { id, bookId, feature, messages, parentId, ... }                           索引 bookId
//   lore      设定库         每本书一条分类和阶梯 { id: "meta:<书id>" }，每张设定卡一条 { id, type: "card", ... }   索引 bookId（见 core/lore.js）
//   loreimg   设定卡的图片原图 { id, bookId, data }
const SCHEMA = {
  books: { keyPath: "id" },
  chapters: { keyPath: "id", indexes: ["bookId"] },
  versions: { keyPath: "id", indexes: ["chapterId"] },
  trash: { keyPath: "id", indexes: ["bookId"] },
  undo: { keyPath: "chapterId" },
  kv: { keyPath: "key" },
  usage: { keyPath: "id", indexes: ["bookId"] },
  stash: { keyPath: "id", indexes: ["bookId"] },
  prompts: { keyPath: "id" },
  chats: { keyPath: "id", indexes: ["bookId"] },
  lore: { keyPath: "id", indexes: ["bookId"] },
  loreimg: { keyPath: "id" },
};

let dbp = null;

function request(version) {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(SCHEMA)) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: def.keyPath });
        (def.indexes || []).forEach((ix) => os.createIndex(ix, ix));
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("数据库被另一个窗口占用"));
  });
}

function open() {
  if (dbp) return dbp;
  dbp = (async () => {
    let db;
    // 用过更新版本的软件（版本号更高）：按现有版本打开
    try { db = await request(DB_VERSION); }
    catch (e) { if (!e || e.name !== "VersionError") throw e; db = await request(0); }
    // 表定义里加了新表但版本号没跟上：再升一级补上
    if (Object.keys(SCHEMA).some((n) => !db.objectStoreNames.contains(n))) {
      const v = db.version + 1;
      db.close();
      db = await request(v);
    }
    // 另一个窗口要升级数据库：先让出来，下次用时重新打开
    db.onversionchange = () => { db.close(); dbp = null; };
    return db;
  })();
  return dbp;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = "readonly") {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  open,
  async get(name, key) { return wrap((await store(name)).get(key)); },
  async all(name) { return wrap((await store(name)).getAll()); },
  async put(name, value) { await wrap((await store(name, "readwrite")).put(value)); return value; },
  async del(name, key) { return wrap((await store(name, "readwrite")).delete(key)); },
  async byIndex(name, index, value) { return wrap((await store(name)).index(index).getAll(value)); },
  async clear(name) { return wrap((await store(name, "readwrite")).clear()); },

  /** 一次事务里改多张表，要么全成功要么全不改。fn(stores) 里用 stores.<表名>.put/delete。 */
  async tx(names, fn) {
    const db = await open();
    const t = db.transaction(names, "readwrite");
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    const result = await fn(stores);
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("保存被中断"));
    });
    return result;
  },

  // 设置和杂项
  async getKV(key, fallback = null) {
    const row = await this.get("kv", key);
    return row ? row.value : fallback;
  },
  async setKV(key, value) { return this.put("kv", { key, value }); },
};

export function uid(prefix = "") {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + r[0].toString(36) + r[1].toString(36).slice(0, 4);
}
