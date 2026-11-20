import { ID_PATTERN } from './schema-primitives';

// 报错里的改法（D-597）：别的 AI 写的 App 文件不对时，告诉它「是不是想写 X」「这个 id 改成 Y」，照着就能改。

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length]!;
}

/**
 * 候选里最像 value 的一个：只差大小写和符号、一个是另一个的开头（至少 3 个字），或者只差一两个字。
 * 都不像就不猜：猜错了比不说更误事。
 */
export function closest(value: string, candidates: Iterable<string>): string | undefined {
  const v = normal(value);
  if (!v) return undefined;
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    if (candidate === value) continue;
    const c = normal(candidate);
    if (!c) continue;
    const score =
      c === v
        ? 0
        : Math.min(c.length, v.length) >= 3 && (c.startsWith(v) || v.startsWith(c))
          ? 1
          : distance(v, c) <= (v.length >= 5 ? 2 : 1)
            ? 1 + distance(v, c)
            : Infinity;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** 「（是不是想写 "x"？）」，猜不出来是空字符串。 */
export function didYouMean(value: string, candidates: Iterable<string>, show = JSON.stringify) {
  const guess = closest(value, candidates);
  return guess === undefined ? '' : ` (did you mean ${show(guess)}?)`;
}

/** 把写错的 id 改成合法的写法：opening_balance → opening-balance，dueDate → due-date。改不出来（全是中文）返回 undefined。 */
export function idFrom(value: string): string | undefined {
  const id = value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return ID_PATTERN.test(id) ? id : undefined;
}
