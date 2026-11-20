import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AppFile } from './app-file';
import { checkAppFileText } from './app-file-check';
import { designHints } from './design-hints';
import { registry } from './test-helpers';

// 设计建议（D-599）：AI 常这样写、我们的预设里一处也没有的三种。预设一条都不能触发：触发了就是规则错了。

const DIR = join(__dirname, 'fixtures', 'portal-apps');
const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 20) };
const read = (name: string) => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as AppFile;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const habits = () => read('tinkrum-app-habits.json') as any;

describe('designHints', () => {
  it('has nothing to say about any of our presets', () => {
    const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
      apps: { file: string }[];
    };
    for (const app of manifest.apps)
      expect([app.file, designHints(read(app.file))]).toEqual([app.file, []]);
  });

  it('is part of a passing check', () => {
    const result = checkAppFileText(
      readFileSync(join(DIR, 'tinkrum-app-habits.json'), 'utf8'),
      ctx,
    );
    expect(result.ok && result.hints).toEqual([]);
  });

  it('suggests an add button for a form that opens the page', () => {
    const d = habits();
    d.pages[1].blocks.splice(1, 0, {
      id: 'add',
      look: 'form',
      show: { mode: 'inline' },
      tools: [{ as: 'submit', label: 'Add', do: 'create', table: 'habits-habits', ask: 'all' }],
    });
    expect(designHints(d)).toEqual([
      'pages.1.blocks.1 (block "add"): the page opens with a form of 4 fields before anything else; use one add button instead (a "button" block whose tool is {"do": "create", "table": …, "ask": "all"}) and put what the page shows first',
    ]);
    // 三个字段以内放在开头没关系。
    d.pages[1].blocks[1].tools[0].ask = ['name', 'goal', 'part'];
    expect(designHints(d)).toEqual([]);
  });

  it('suggests an add button for a long form anywhere on a page', () => {
    const d = habits();
    for (const id of ['mood', 'place', 'with'])
      d.tables[1].fields.push({ id, name: id, type: 'text' });
    d.pages[1].blocks.push({
      id: 'log',
      look: 'form',
      show: { mode: 'inline' },
      tools: [{ as: 'submit', label: 'Log', do: 'create', table: 'habits-checkins', ask: 'all' }],
    });
    expect(designHints(d)).toEqual([
      expect.stringMatching(
        /^pages\.1\.blocks\.2 \(block "log"\): an inline form with 7 fields is long/,
      ),
    ]);
  });

  it('asks for a page for one entry when another table links to it', () => {
    const d = habits();
    // 去掉「一个习惯」的页面：点开一个习惯看不到它的打卡。
    d.pages = d.pages.filter((p: { of?: string }) => p.of !== 'habits-habits');
    for (const page of d.pages)
      for (const b of page.blocks) {
        delete b.opens;
        for (const c of b.children ?? []) delete c.opens;
      }
    expect(designHints(d)).toEqual([
      'tables.0 ("habits-habits"): habits-checkins link to its entries, but there is no page for one habits-habits entry, so tapping one cannot show its habits-checkins entries; add a page with "of": "habits-habits" that lists habits-checkins filtered by {"field": "habit", "op": "is", "value": "$record"}, and set "opens" to that page on the blocks that list habits-habits',
    ]);
  });

  it('notices a header that repeats the title bar of a page outside the bar', () => {
    const d = habits();
    d.app.bar = d.app.bar.filter((x: string) => x !== 'page:habits-insights');
    d.pages[2].title = 'Insights';
    d.pages[2].blocks.unshift({ id: 'h', look: 'header', show: { title: 'Insights' } });
    expect(designHints(d)).toEqual([
      'pages.2.blocks.0 (block "h"): this page is not in the bar, so its title "Insights" is already shown at the top; remove this header or give it other text',
    ]);
    // 底栏里的页面没有标题栏，标题块就是它的标题。
    d.app.bar.splice(1, 0, 'page:habits-insights');
    expect(designHints(d)).toEqual([]);
  });
});
