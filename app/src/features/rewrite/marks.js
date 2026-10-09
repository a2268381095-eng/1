// 编辑器里的三样东西：正在对比的那段原文（跟着前后的改动挪位置）、刚采用的那段闪一下、AI 改过的段落留淡色底。
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin } from "@codemirror/view";
import { ws } from "../editor/workspace.js";

// ---------------- 正在对比的原文 ----------------
export const setPending = StateEffect.define();   // { from, to } 或 null
const srcMark = Decoration.mark({ class: "rw-src" });
const pendingField = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPending)) return e.value;
    if (v && tr.docChanged) {
      const from = tr.changes.mapPos(v.from, 1);
      v = { from, to: Math.max(from, tr.changes.mapPos(v.to, -1)) };
    }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => (v && v.to > v.from ? Decoration.set([srcMark.range(v.from, v.to)]) : Decoration.none)),
});
export const pendingOf = (state) => state.field(pendingField, false) || null;

// ---------------- 刚采用的那段闪一下 ----------------
const setFlash = StateEffect.define();
const flashMark = Decoration.mark({ class: "rw-just" });
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setFlash)) deco = e.value && e.value.to > e.value.from ? Decoration.set([flashMark.range(e.value.from, e.value.to)]) : Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
let flashTimer = 0;
export function flash(from, to) {
  const v = ws.editor && ws.editor.view;
  if (!v) return;
  v.dispatch({ effects: setFlash.of({ from, to: Math.min(to, v.state.doc.length) }) });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { const w = ws.editor && ws.editor.view; if (w) w.dispatch({ effects: setFlash.of(null) }); }, 1800);
}

// ---------------- AI 改过的段落：行的文字等于记下的段落时加淡色底 ----------------
const refresh = StateEffect.define();
const lineDeco = Decoration.line({ class: "rw-ai-line" });
let marksOn = true;
let cacheArr = null, cacheSet = null;
function aiSet() {
  const arr = ws.current && ws.current.aiParas;
  if (!marksOn || !arr || !arr.length) return null;
  if (arr !== cacheArr) { cacheArr = arr; cacheSet = new Set(arr); }
  return cacheSet;
}
function build(view) {
  const set = aiSet();
  if (!set) return Decoration.none;
  const b = new RangeSetBuilder();
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (line.from > last && line.text.trim() && set.has(line.text)) { b.add(line.from, line.from, lineDeco); last = line.from; }
      pos = line.to + 1;
    }
  }
  return b.finish();
}
const marksPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refresh)))) this.decorations = build(u.view);
  }
}, { decorations: (p) => p.decorations });

export function refreshMarks() {
  const v = ws.editor && ws.editor.view;
  if (v && ws.current) v.dispatch({ effects: refresh.of(null) });
}
export function setMarksOn(on) { marksOn = !!on; refreshMarks(); }

/** 编辑器扩展（addEditorExtension 用）；watcher 是选区变化的回调 */
export function editorExtensions(watcher) {
  return [pendingField, flashField, marksPlugin, EditorView.updateListener.of(watcher)];
}
