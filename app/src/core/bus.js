// 事件总线：各功能之间互相通知，小恶魔也靠它知道你在做什么。
//
// 常用事件（data 字段）：
//   app:open                          打开软件
//   route                { name, params }  切换界面
//   book:created/updated/deleted     { book }
//   chapter:created      { chapter }
//   chapter:deleted      { chapter }   删到回收站之后
//   chapter:delete-ask   { chapter }   删整章之前（确认框弹出时）
//   chapter:opened       { chapter }
//   chapter:moved        { chapter }
//   content:saved        { chapter, text }   自动保存写进去之后
//   save:failed          { error }
//   typing:start         开始码字（停了一会儿又开始打字）
//   typing:idle          { minutes }   停笔很久
//   goal:reached         { words, goal }  今天的字数目标达成
//   points:all-done      { chapter }   本章要点全部打勾
//   format:done          { count }    一键排版写回之后
//   search:done          { count }
//   replace:done         { count }
//   undo / redo          { label }
//   help:open            作者点了「找不到功能」
//   selection:changed    { ids }       章节列表多选变了
//   panel:opened / panel:closed  { el, wide }  右侧栏放了 / 关了一个面板
//   version:restored     { chapter, ts }  恢复了历史版本
//   trash:restored       { entries, into? }   从回收站恢复
//   trash:purged         { count, all }   彻底删除 / 清空
//   io:imported          { book, chapters }   导入完成
//   io:exported          { format, count }    导出完成
//   io:backup / io:restored              整本备份 / 从备份恢复
//   ai:start / ai:done / ai:error / ai:cancel  { feature }  AI 调用开始、完成、出错、取消
//   stash:changed        暂存盒有变化
//   demon:say            { event, text? }  直接让小恶魔说话

const handlers = new Map();

export const bus = {
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type).delete(fn);
  },
  emit(type, data = {}) {
    for (const fn of handlers.get(type) || []) {
      try { fn(data, type); } catch (e) { console.error("[bus]", type, e); }
    }
    for (const fn of handlers.get("*") || []) {
      try { fn(data, type); } catch (e) { console.error("[bus *]", type, e); }
    }
  },
};
