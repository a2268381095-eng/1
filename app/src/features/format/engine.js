// 一键排版的规则引擎（纯函数，不碰界面）。导出时的「网文平台排版」也用这里。
// 占位：format 模块会补全。接口先定下来：
//   RULES          规则清单 [{ id, name, desc, default: bool, optional: bool }]
//   DEFAULT_RULES  { [ruleId]: bool, paraGap: 0|1 }
//   formatText(text, rules) → 排版后的文字（只动空白和标点，不改文字；对同一段文字再排一次结果不变）
//   getSchemes() / saveScheme(name, rules) / deleteScheme(name)   排版方案（存在 kv "format:schemes"）

export const RULES = [];
export const DEFAULT_RULES = { paraGap: 0 };
export function formatText(text) { return text; }
export async function getSchemes() { return [{ name: "默认", rules: { ...DEFAULT_RULES } }]; }
export async function saveScheme() {}
export async function deleteScheme() {}
