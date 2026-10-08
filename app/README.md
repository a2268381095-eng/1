# 小恶魔文书 · 开发说明

本地中文写作软件。网页版（单文件 `dist/index.html`），数据存在浏览器的 IndexedDB；以后套 Tauri 做桌面版。

```
npm install
npm run build                        # → dist/index.html + dist/sprites/
node build.mjs --out /tmp/xxx        # 输出到别的目录（并行测试时用）
node tests/smoke.test.cjs /tmp/xxx   # 浏览器自动测试（Playwright）
```

## 目录

- `src/core/` 公用：
  - `db.js` 存储（唯一碰 IndexedDB 的地方）。表：books、chapters、versions、trash、undo、kv。`db.get/put/del/all/byIndex/tx/getKV/setKV`，`uid()`。
  - `store.js` 作品和章节：`listBooks/getBook/createBook/updateBook/trashBook`、`listChapters/getChapter/createChapter/updateChapter/saveContent/moveChapter/setOrder/trashChapter`、`listTrash/restoreFromTrash/purgeTrash/purgeOldTrash`、`todayWords/getStats`。
  - `bus.js` 事件：`bus.on(type, fn)`、`bus.emit(type, data)`，事件清单写在文件开头。小恶魔靠事件接话。
  - `nav.js` 界面切换：`nav.route(name, "/path/:id?", render(params, restore))`、`nav.go(path)`、`nav.back()`、`nav.onLeave(() => state)`（离开时记住滚动位置等，回来时作为 restore 传回）。
  - `ui.js` 界面件：`h()` 造元素、`icon(name)`、`modal({title, body, actions, isDirty, wide})`、`choose/confirm/prompt`、`toast(msg, {action:{label, run}})`、`notice({what, why, actions, detail})`（中文报错卡：出了什么事 / 可能原因 / 按钮）、`pushLayer({onClose, isDirty})`（Esc 关最上层）、`helpTip(text)`（小问号）。
  - `undo.js` 软件层面的撤销：`undo.push({label, undo, redo})`，批量操作只 push 一条。
  - `commands.js` 命令表：`commands.register({id, title, keywords, hint, key, when, run})`。小恶魔的「你想做什么？」和快捷键都从这里取。
  - `settings.js` 全局设置：`getSettings()`、`setSettings(patch)`（发 `settings:changed`）、`label(name)`（主题彩蛋改名）。
  - `text.js` `countWords`、`chapterLabel`、`zhNumber`、`fmtTime`、`todayKey`。
- `src/features/editor/workspace.js` 写作界面，导出 `ws`：
  - `ws.book`、`ws.chapters`、`ws.current`、`ws.editor`、`ws.selectedIds()`、`ws.labelOf(c)`（第一章）、`ws.fullTitle(c)`、`ws.textOf(id)`（含没保存的）
  - `ws.openChapter(id, {anchor, head, scroll})`、`ws.refresh()`、`ws.reloadBook()`
  - `ws.openPanel({title, render(body), onClose, isDirty, wide})` 右侧栏放面板（Esc / × 关闭，关掉回到要点）
  - `ws.applyBatch(label, [{chapterId, after}])` 批量改正文，算一步撤销，返回撤销条目
  - `ws.els()` → `{center, edHost, right, list}`（正文区可以放覆盖层）
  - `ws.editor`：`getText()`、`select(from, to)`、`mark([{from, to, cls}])`（高亮，cls 有 cm-find / cm-find-cur / cm-del / cm-ins）、`flush()`、`focus()`、`view`（CodeMirror EditorView）
- `src/features/demon/demon.js` 小恶魔：`tip(key, text)` 第一次用某功能时说一句说明；`react(event, {text, act})`；也可以 `bus.emit("demon:say", {text, act})`。
- `src/features/<功能>/index.js` 每个功能 export `register()`，在 `features/index.js` 登记。样式写在同目录的 `.css`，构建时自动收集。

## 规矩

- 界面文字全部中文，短句，少形容词。禁用句式：「不是……而是……」「一字一顿」「不像……倒像……」「指尖泛白」。
- 每个界面左上角有返回；每个面板、弹窗右上角有关闭，Esc 关最上层；改了一半的内容关闭前问「保留草稿 / 丢弃」。
- 改数据的操作都能撤销，批量算一步；删除后出「已删除 · 撤销」提示条，错过了去回收站找。
- 一件事在它自己的界面里做完，不跳到别的板块。
- 出错用 `notice()`：出了什么事、可能的原因、现在可以怎么做（能直接点的按钮），英文原文折叠在详细信息里。
- 配色用 `src/styles/base.css` 里的变量（深色模式自动跟着变）。
