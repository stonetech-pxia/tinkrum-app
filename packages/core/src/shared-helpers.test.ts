import { describe, expect, it } from 'vitest';

import { localDate, localDateStamp } from './field-values';
import { escapeHtml } from './html';
import { clamp } from './math';

describe('shared helpers', () => {
  it.each([
    [2026, 0, 1, '2026-01-01'],
    [2024, 1, 29, '2024-02-29'],
    [2026, 11, 31, '2026-12-31'],
  ] as const)(
    'formats the local calendar date %i/%i/%i with either filename separator',
    (year, month, day, expected) => {
      const date = new Date(year, month, day, 0, 5);
      expect(localDate(date)).toBe(expected);
      expect(localDateStamp(date)).toBe(expected.replace(/-/g, ''));
    },
  );
  it.each([
    [-5, 0, 10, 0],
    [15, 0, 10, 10],
    [2.5, 0, 10, 2.5],
    [-5, -10, -1, -5],
    [8, 3, 3, 3],
    [Infinity, 0, 10, 10],
    [-Infinity, 0, 10, 0],
  ])('clamps %s to the explicit interval [%s, %s]', (value, lower, upper, expected) => {
    expect(clamp(value, lower, upper)).toBe(expected);
  });
  it('escapes HTML text while preserving apostrophes when requested for existing CSS strings', () => {
    expect(escapeHtml(`<b title="O'Neil">A&B</b>`)).toBe(
      '&lt;b title=&quot;O&#39;Neil&quot;&gt;A&amp;B&lt;/b&gt;',
    );
    expect(escapeHtml(`O'Neil & "Co"`, { apostrophes: false })).toBe("O'Neil &amp; &quot;Co&quot;");
  });
});
