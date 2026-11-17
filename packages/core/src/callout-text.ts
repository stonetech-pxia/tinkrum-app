// 提示卡的文字里能写两种占位（D-580）：{count} 是符合条件的记录有几条，{sum:字段} 是这些记录某个数字字段的合计。
// 只在画的时候按本机上的记录算出来，不存进配置（底线 14），AI 看不到记录的内容（底线 2）。

export type CalloutToken = { kind: 'count' } | { kind: 'sum'; field: string };

const TOKEN = /\{(count|sum:[a-z][a-z0-9-]{0,47})\}/g;

/** 文字里的占位，按出现的顺序。 */
export function calloutTokens(text: string): CalloutToken[] {
  return [...text.matchAll(TOKEN)].map((m) => {
    const raw = m[1]!;
    return raw === 'count' ? { kind: 'count' } : { kind: 'sum', field: raw.slice(4) };
  });
}

/** 把占位换成算好的文字：count 给条数，sum 由调用方按字段的样子（金额、数字）格式化。 */
export function fillCallout(
  text: string,
  values: { count: string; sum: (field: string) => string },
): string {
  return text.replace(TOKEN, (_all, raw: string) =>
    raw === 'count' ? values.count : values.sum(raw.slice(4)),
  );
}
