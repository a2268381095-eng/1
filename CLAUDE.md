# 小恶魔文书

本地自用的中文写作软件。完整需求在用户的文档《小恶魔文书 · 完整功能需求》：
https://claude.ai/artifact/5qDbaq5hUWxRFzHuvwhaEL

## 和用户协作

- 拿不准用户喜好时，先做 1–2 个预览让用户挑，不要全部做完再给看。
- 用户喜欢二次元风格。
- **动态效果是用户定的最高规则**：界面、点击、小恶魔、每个功能的反馈都要有动效，并且做出各自的特色（按小恶魔的风格换道具、换配色），不能偷懒做得单调。系统要求减少动态效果时可以关，但默认要热闹。
- **动静结合**：按审美判断哪里动、动多少，不机械地划分「这里静、那里动」。写字区域以不打扰阅读为准；热闹放在打字连击、里程碑、点击反馈这些时刻，有起有落。
- 对用户说话用中文；用户的写作偏好：少用比喻和形容词，禁止「不是……而是……」「一字一顿」「不像……倒像……」「指尖泛白」这几种句式。

## 小恶魔助手（`assistant_sprite/`）

- 设定：从异世界来的小恶魔，外表是正常可爱的二次元少女（粉发、青色瞳孔、小恶魔尾巴）。不要赛博、机甲、阴暗风。
- 比例：正常二次元少女比例（约 5–6 头身），不用 Q 版。新风格的像素画布约 128×224；原稿 59×81 保留作为初稿。
- 新服装、新姿势：用户用 GPT image 按《小恶魔参考图需求单》出参考图（https://claude.ai/code/artifact/46d878c3-d573-4617-bf07-f1b9c515b6be），我用 `assistant_sprite/tools/pixelize_sheet.py` 转像素再手修。不要凭空画新姿势，用户看过觉得尴尬。
- 5 套默认整体风格：每套的服装、发型、袜子、姿势、道具、性格配成一整套，不混搭；按作品题材切换。服装和发型都能换。
- 每套至少 7 种动作：`idle` 待机、`wave` 打招呼、`point` 指路、`think` 思考、`cheer` 欢呼、`shock` 吓一跳、`doze` 打瞌睡。每套按自己的特点画不同姿势，原稿也要有多种姿势。说话和眨眼叠加在动作上，不算数。
- 原稿 `styles/default/` 保持用户画的样子（白色长袜），黑丝之类的变化放在其他风格里。
- 台词：**小恶魔的个性永远是核心**，每套服装是同一个小恶魔的不同表现（元气、文雅、腹黑……），不能变成另一个人。写作相关的内容（字数、章节、伏笔、节奏、排版）适量加入，不能盖过她的个性。
- 预览页「小恶魔衣橱」：https://claude.ai/artifact/GgLruVPhDvngsmqvfhhBEo（`assistant_sprite/wardrobe.html`，用 `tools/make_wardrobe_page.py` 生成，改完在原路径重新发布）。
- 画风规矩、文件格式和工具用法见 `assistant_sprite/styles/README.md`。
- 说话气泡里只放台词，不显示名字。

## 写作软件（`app/`）

- 第一版预览：https://claude.ai/artifact/11CP9vz8Rnka9HoJ6f5KWg（`app/dist/index.html`，`cd app && npm run build` 生成；发布时带上 `dist/sprites/` 里的 42 张图）。
- 先做网页版（单文件 HTML，数据在 IndexedDB），以后套 Tauri 做桌面版；`src/core/db.js` 是唯一碰存储的地方。
- 结构：`src/core/`（数据、返回、撤销、浮层、命令表），`src/features/<功能>/`（每个功能一个目录，export `register()`，在 `features/index.js` 登记）。
- 编辑器 CodeMirror 6，每章一份撤销记录；批量改正文走 `ws.applyBatch`，算一步撤销。
- 小恶魔的动画和台词在构建时从 `assistant_sprite/styles/*` 拷进来（`src/generated/sprites.json`）。
- 桌面版：`app/src-tauri/`（Tauri 2，只开窗口）。推送 `app/` 的改动后 GitHub Actions（`.github/workflows/desktop.yml`）在 Windows 上打 NSIS 安装包，在那次运行的 Artifacts 里下载；macOS 手动运行。图标 `app/app-icon.png`，改了以后 `npx tauri icon app-icon.png -o src-tauri/icons`。

## 软件原则

- 作者自由优先：模板、预设都只是起点；AI 调用前必须确认，不预设模型和提示词。
- 一件事从开始到收尾都在它自己的界面里做完，不跳到别的板块（暂存盒也在各功能里就地管理）。
- 返回、关闭、撤销都要做好；批量操作算一步，可以整体撤销。
