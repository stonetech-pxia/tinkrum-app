import { expect, it } from 'vitest';

import { handoffPrompt, type HandoffScope } from './ai-handoff';

const NOW = new Date(2026, 10, 23, 9, 30);
const scopes: HandoffScope[] = [
  { kind: 'new' },
  { kind: 'setup' },
  { kind: 'app', app: 'Books' },
  { kind: 'app', app: 'Books', page: { id: 'books-home', title: 'Shelf' } },
];

it('puts the typed request after the rules, and asks for clarification instead of asking again', () => {
  for (const locale of ['en', 'zh', 'fr'] as const)
    for (const scope of scopes) {
      const empty = handoffPrompt(scope, locale, NOW);
      const typed = handoffPrompt(scope, locale, NOW, {
        attached: true,
        checker: true,
        request: 'USER_REQUEST_SENTINEL',
      });
      expect(empty).not.toContain('USER_REQUEST_SENTINEL');
      expect(typed).toContain('USER_REQUEST_SENTINEL');
      expect(typed.indexOf('USER_REQUEST_SENTINEL')).toBeGreaterThan(typed.indexOf('json'));
      expect(typed).not.toContain(empty.split('\n\n').at(-1));
      expect(handoffPrompt(scope, locale, NOW, { attached: false, request: '  ' })).toBe(empty);
    }
});

it('names the app and the originating page and preserves ids', () => {
  const text = handoffPrompt(scopes[3]!, 'en', NOW, {
    attached: true,
    checker: true,
    fileName: 'books.json',
  });
  expect(text).toContain('“Shelf” (id "books-home")');
  expect(text).toContain('“Books”');
  expect(text).toContain('change this page first');
  expect(text).toContain('Keep every id');
  expect(text).toContain('books.json');
  expect(text).toContain('node tinkrum-check.js');
});

it('describes the whole setup without inventing an app or page', () => {
  const text = handoffPrompt({ kind: 'setup' }, 'en', NOW, {
    attached: true,
    checker: true,
    fileName: 'setup.json',
  });
  expect(text).toContain('whole Tinkrum setup');
  expect(text).toContain('morph-app-config');
  expect(text).toContain('setup.json');
  expect(text).toContain('Keep every id');
});

it('names the attachments and also gives dated links to read them when an app cannot open them (Gemini)', () => {
  for (const locale of ['en', 'zh', 'fr'] as const)
    for (const scope of scopes) {
      const attached = handoffPrompt(scope, locale, NOW, {
        attached: scope.kind !== 'new',
        checker: true,
        docs: true,
      });
      expect(attached).toContain('tinkrum-app-guide.md');
      expect(attached).toContain('tinkrum-app-patterns.md');
      // Gemini can see attachments but cannot read guides and patterns (on-device 2026-11-24): provides a dated URL as a fallback when attachments cannot be opened.
      expect(attached).toContain('tinkrum-app-guide.md?v=20261123');
      expect(attached).toContain('tinkrum-app-patterns.md?v=20261123');
      expect(attached.indexOf('tinkrum-app-guide.md')).toBeLessThan(attached.indexOf('https://'));
      expect(attached).toContain('Open in Tinkrum');
      const fallback = handoffPrompt(scope, locale, NOW);
      expect(fallback).toContain('tinkrum-app-guide.md?v=20261123');
      expect(fallback).toContain('tinkrum-app-patterns.md?v=20261123');
      expect(fallback).not.toContain('node tinkrum-check.js');
    }
});

it('an app without page context names only the app, in Chinese too', () => {
  const text = handoffPrompt({ kind: 'app', app: 'Books' }, 'zh', NOW, {
    attached: true,
    fileName: 'books.json',
  });
  expect(text).toContain('「Books」');
  expect(text).toContain('已有的 ID 一个都不改');
  expect(text).not.toContain('先改这一页');
  expect(text).not.toContain('tinkrum-check.js');
});

it('fallback copy describes the file honestly when there is no checker or no attachment', () => {
  const attached = handoffPrompt({ kind: 'app', app: 'Books' }, 'en', NOW, {
    attached: true,
    fileName: 'books.json',
  });
  expect(attached).toContain('Attached is my current Tinkrum app file (books.json).');
  expect(attached).not.toContain('node tinkrum-check.js');
  const inline = handoffPrompt({ kind: 'app', app: 'Books' }, 'fr', NOW);
  expect(inline).toContain('à la fin de ce message');
  expect(inline).not.toContain('tinkrum-check.js');
});
