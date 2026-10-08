// 正文编辑器（CodeMirror 6）。每章一份编辑状态，切走再切回来还能接着撤销；撤销记录也存进数据库，重开软件还在。
// 停止输入约 1 秒自动保存。批量操作（全书替换、一键排版）通过 applyText 写入，按一次撤销整体还原。
import { EditorState, Compartment, StateEffect, StateField, Annotation } from "@codemirror/state";
import { EditorView, keymap, drawSelection, placeholder, Decoration } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, undo as cmUndo, redo as cmRedo, undoDepth, historyField } from "@codemirror/commands";
import DiffMatchPatch from "diff-match-patch";
import { db } from "../../core/db.js";
import { bus } from "../../core/bus.js";
import { getSettings } from "../../core/settings.js";

const dmp = new DiffMatchPatch();
// Chrome 的 EditContext 输入方式在切换章节（整体换掉编辑状态）时会报错，中文输入法也更稳的是传统方式
EditorView.EDIT_CONTEXT = false;
export const External = Annotation.define();   // 不是作者打字产生的改动（批量替换、排版、恢复版本）

// 其他功能往编辑器里加东西（选中工具栏、AI 改过的段落标记等）：addEditorExtension(ext)
const plugins = new Compartment();
const pluginList = [];
const views = new Set();
export function addEditorExtension(ext) {
  pluginList.push(ext);
  for (const v of views) v.dispatch({ effects: plugins.reconfigure([...pluginList]) });
}

// ---------------- 高亮（查找结果、排版预览用） ----------------
export const setMarks = StateEffect.define();   // value: [{ from, to, cls }]
const marksField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) {
      deco = Decoration.set(e.value.filter((m) => m.to > m.from).map((m) => Decoration.mark({ class: m.cls || "cm-find" }).range(m.from, m.to)), true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 求两段文字之间最小的改动（保留光标和滚动位置），返回 CodeMirror changes */
export function minimalChanges(before, after) {
  const diffs = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(diffs);
  const changes = [];
  let pos = 0;
  for (const [op, text] of diffs) {
    if (op === 0) pos += text.length;
    else if (op === -1) { changes.push({ from: pos, to: pos + text.length }); pos += text.length; }
    else changes.push({ from: pos, insert: text });
  }
  return changes;
}

/**
 * 建一个编辑器。opts:
 *   parent           挂载的元素
 *   getBook()        当前作品（取 autoIndent、paraGap）
 *   onSave(id, text) 自动保存
 *   onDocChange(id, text, tr)   每次内容变化
 *   beforeUndo(id, depth)       Ctrl+Z 前问一下：返回 true 表示外面接管（批量撤销）
 */
export function createEditor(opts) {
  const states = new Map();      // chapterId → EditorState
  const theme = new Compartment();
  let currentId = null;
  let saveTimer = 0, undoTimer = 0;
  let lastInput = 0, idleTimer = 0, idleSent = false;

  const indentEnter = (view) => {
    const book = opts.getBook();
    const indent = book && book.autoIndent !== false ? "　　" : "";
    const gap = book && book.paraGap ? "\n" : "";
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: "\n" + gap + indent },
      selection: { anchor: from + 1 + gap.length + indent.length },
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  };

  const smartUndo = (view) => {
    if (opts.beforeUndo && opts.beforeUndo(currentId, undoDepth(view.state))) return true;
    return cmUndo(view);
  };

  const extensions = [
    history({ minDepth: 300, newGroupDelay: 700 }),
    drawSelection(),
    EditorView.lineWrapping,
    placeholder("从这里开始写……"),
    EditorView.contentAttributes.of({ spellcheck: "false", lang: "zh-CN", "aria-label": "正文" }),
    marksField,
    plugins.of([...pluginList]),
    keymap.of([
      { key: "Enter", run: indentEnter },
      { key: "Mod-z", run: smartUndo, preventDefault: true },
      { key: "Mod-y", run: cmRedo, preventDefault: true },
      { key: "Mod-Shift-z", run: cmRedo, preventDefault: true },
      ...historyKeymap.filter((k) => !["Mod-z", "Mod-y", "Mod-Shift-z"].includes(k.key)),
      ...defaultKeymap.filter((k) => k.key !== "Enter" && k.key !== "Mod-Enter"),   // Ctrl+Enter 是「新建章节」
    ]),
    theme.of(themeExt()),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged || !currentId) return;
      const id = currentId;
      const text = u.state.doc.toString();
      states.set(id, u.state);
      opts.onDocChange && opts.onDocChange(id, text, u);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flush(), 1000);
      clearTimeout(undoTimer);
      undoTimer = setTimeout(() => persistUndo(id), 4000);
      const typed = u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete"));
      if (typed) noteTyping();
    }),
  ];

  const view = new EditorView({ parent: opts.parent, state: EditorState.create({ doc: "", extensions }) });
  views.add(view);

  function themeExt() {
    const s = getSettings();
    return EditorView.theme({
      "&": { fontSize: s.textSize + "px", height: "100%" },
      ".cm-content": { fontFamily: "var(--f-text)", lineHeight: String(s.lineHeight), maxWidth: s.textWidth + "px", margin: "0 auto", padding: "28px 32px 45vh" },
    });
  }

  function noteTyping() {
    const t = Date.now();
    if (!lastInput || t - lastInput > 60000 || idleSent) bus.emit("typing:start", {});
    lastInput = t;
    idleSent = false;
    clearTimeout(idleTimer);
    const mins = getSettings().idleMinutes || 5;
    idleTimer = setTimeout(() => { idleSent = true; bus.emit("typing:idle", { minutes: mins }); }, mins * 60000);
  }

  async function persistUndo(id) {
    const st = states.get(id);
    if (!st) return;
    try { await db.put("undo", { chapterId: id, json: st.toJSON({ history: historyField }) }); } catch (_) { /* 撤销记录存不进去不影响写字 */ }
  }

  /** 马上保存当前章（切章、关窗口前调用） */
  async function flush() {
    clearTimeout(saveTimer);
    if (!currentId) return;
    const id = currentId, text = view.state.doc.toString();
    await opts.onSave(id, text);
  }

  async function stateFor(chapter) {
    if (states.has(chapter.id)) {
      const st = states.get(chapter.id);
      if (st.doc.toString() === chapter.content) return st;
    }
    try {
      const row = await db.get("undo", chapter.id);
      if (row && row.json && row.json.doc === chapter.content) {
        return EditorState.fromJSON(row.json, { extensions }, { history: historyField });
      }
    } catch (_) { /* 旧的撤销记录读不出来就从头开始 */ }
    return EditorState.create({ doc: chapter.content, extensions });
  }

  return {
    view,
    get id() { return currentId; },
    /** 打开某一章。restore = { anchor, head, scroll } 还原光标和滚动 */
    async open(chapter, restore) {
      if (currentId && currentId !== chapter.id) { await flush(); persistUndo(currentId); }
      const st = await stateFor(chapter);
      currentId = chapter.id;
      states.set(chapter.id, st);
      view.setState(st);
      view.dispatch({ effects: [theme.reconfigure(themeExt()), plugins.reconfigure([...pluginList])] });
      if (restore && restore.anchor != null) {
        const len = view.state.doc.length;
        view.dispatch({ selection: { anchor: Math.min(restore.anchor, len), head: Math.min(restore.head ?? restore.anchor, len) } });
      }
      requestAnimationFrame(() => {
        if (restore && restore.scroll != null) view.scrollDOM.scrollTop = restore.scroll;
      });
    },
    close() { currentId = null; },
    getText: () => view.state.doc.toString(),
    flush,
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    position: () => ({ anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, scroll: view.scrollDOM.scrollTop }),
    refreshTheme() { view.dispatch({ effects: theme.reconfigure(themeExt()) }); },
    undo: () => smartUndo(view),
    redo: () => cmRedo(view),
    depth: () => undoDepth(view.state),
    /** 某一章的撤销深度（批量撤销判断用） */
    depthOf(id) { const st = id === currentId ? view.state : states.get(id); return st ? undoDepth(st) : -1; },
    /** 选中并滚到 [from, to) */
    select(from, to = from) {
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    },
    /** 标出几段（查找结果、预览），cls 默认 cm-find */
    mark(ranges) { view.dispatch({ effects: setMarks.of(ranges || []) }); },
    /**
     * 外部改写某一章的全文（批量替换、排版、恢复版本）。
     * 打开着的章直接在编辑器里改（进撤销记录）；缓存里的章同步更新缓存。返回改完后这一章的撤销深度。
     */
    applyText(id, text) {
      if (id === currentId) {
        const before = view.state.doc.toString();
        if (before === text) return undoDepth(view.state);
        view.dispatch({ changes: minimalChanges(before, text), annotations: External.of(true), userEvent: "external" });
        return undoDepth(view.state);
      }
      const st = states.get(id);
      if (st) {
        const before = st.doc.toString();
        if (before !== text) {
          const next = st.update({ changes: minimalChanges(before, text), annotations: External.of(true) }).state;
          states.set(id, next);
          return undoDepth(next);
        }
        return undoDepth(st);
      }
      return -1;
    },
    forget(id) { states.delete(id); },
  };
}
