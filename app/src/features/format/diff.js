// 排版预览用的改动对比。排版只动空白和标点，所以先按「文字骨架」（去掉空白和标点剩下的字）对齐，
// 两个字之间的空白、标点有变化就算一处改动；万一对不齐，退回普通的逐字对比。
import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();
/** 排版可能改动的字符：空白、标点，以及当破折号、省略号用的 ─ ━ ⋯ */
export const SEP = /[\s\p{P}─━⋯]/u;

/** 去掉空白和标点以后剩下的文字 */
export function skeleton(s) { return Array.from(s || "").filter((c) => !SEP.test(c)).join(""); }

function split(s) {
  const skel = [], gaps = [];
  let g = "";
  for (const c of s) {
    if (SEP.test(c)) g += c;
    else { gaps.push(g); g = ""; skel.push(c); }
  }
  gaps.push(g);
  return { skel, gaps };
}

/**
 * 对比排版前后。返回 { parts: [{ t: 0 不变 | -1 删掉 | 1 加上, s }], count: 改了几处 }
 */
export function diffParts(before, after) {
  before = before || ""; after = after || "";
  const parts = [];
  const push = (t, s) => {
    if (!s) return;
    const last = parts[parts.length - 1];
    if (last && last.t === t) last.s += s;
    else parts.push({ t, s });
  };
  if (before === after) { push(0, before); return { parts, count: 0 }; }
  let count = 0;
  const A = split(before), B = split(after);
  if (A.skel.length === B.skel.length && A.skel.every((c, i) => c === B.skel[i])) {
    for (let i = 0; i < A.gaps.length; i++) {
      const a = A.gaps[i], b = B.gaps[i];
      if (a === b) push(0, a);
      else {
        count++;
        for (const [op, s] of dmp.diff_main(a, b)) push(op, s);
      }
      if (i < A.skel.length) push(0, A.skel[i]);
    }
  } else {
    const d = dmp.diff_main(before, after);
    dmp.diff_cleanupSemantic(d);
    let inHunk = false;
    for (const [op, s] of d) {
      if (op !== 0 && !inHunk) count++;
      inHunk = op !== 0;
      push(op, s);
    }
  }
  return { parts, count };
}
