import { describe, expect, it } from 'vitest';

import { handoffPrompt } from './ai-handoff';

// 交给别的 AI App 的提示词（D-609、D-611）。
const NOW = new Date(2026, 10, 21, 9, 30);
const GUIDE = 'https://tinkrum.stonetech.dev/assets/agent/tinkrum-app-guide.md?v=20261121';
const PATTERNS = 'https://tinkrum.stonetech.dev/assets/agent/tinkrum-app-patterns.md?v=20261121';

describe('handoffPrompt', () => {
  it('every prompt carries both guide links with today as the version, in every language', () => {
    for (const locale of ['en', 'zh', 'fr'] as const)
      for (const scope of [
        { kind: 'new' as const },
        { kind: 'app' as const, app: 'Books' },
        { kind: 'app' as const, app: 'Books', page: { id: 'books-home', title: 'Shelf' } },
      ]) {
        const text = handoffPrompt(scope, locale, NOW, {
          attached: true,
          checker: true,
          fileName: 'x.json',
        });
        expect(text).toContain(GUIDE);
        expect(text).toContain(PATTERNS);
      }
  });

  it('from a page: names the page and its id, and says to change that page first', () => {
    const text = handoffPrompt(
      { kind: 'app', app: 'Books', page: { id: 'books-home', title: 'Shelf' } },
      'en',
      NOW,
      { attached: true, checker: true, fileName: 'tinkrum-app-books.json' },
    );
    expect(text).toContain('“Shelf” (id "books-home")');
    expect(text).toContain('“Books”');
    expect(text).toMatch(/change this page first/);
    expect(text).toMatch(/Keep every id/);
    expect(text).toContain('tinkrum-app-books.json');
    expect(text).toContain('node tinkrum-check.js');
  });

  it('for the whole app: names the app, not a page', () => {
    const text = handoffPrompt({ kind: 'app', app: 'Books' }, 'zh', NOW, {
      attached: true,
      checker: true,
      fileName: 'tinkrum-app-books.json',
    });
    expect(text).toContain('「Books」');
    expect(text).not.toMatch(/先改这一页/);
    expect(text).toMatch(/已有的 ID 一个都不改/);
  });

  it('with the app file but no checker it does not ask to run the checker', () => {
    const text = handoffPrompt({ kind: 'app', app: 'Books' }, 'en', NOW, {
      attached: true,
      fileName: 'tinkrum-app-books.json',
    });
    expect(text).toContain('Attached is my current Tinkrum app file (tinkrum-app-books.json).');
    expect(text).not.toContain('tinkrum-check.js');
  });

  it('without attachments it says the file follows and does not ask to run the checker', () => {
    const text = handoffPrompt({ kind: 'app', app: 'Books' }, 'fr', NOW, { attached: false });
    expect(text).toMatch(/à la fin de ce message/);
    expect(text).not.toContain('tinkrum-check.js');
  });
});
