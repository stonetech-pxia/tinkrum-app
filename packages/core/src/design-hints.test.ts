import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AppFile } from './app-file';
import { checkAppFileText } from './app-file-check';
import { designHints } from './design-hints';
import { registry } from './test-helpers';

// Design suggestions (D-602): six rules determined by the founder after reviewing before-and-after comparison screenshots. Conditions are written logically without narrowing to bypass presets: if a preset hits it, update the preset.

const DIR = join(__dirname, 'fixtures', 'portal-apps');
const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 20) };
const read = (name: string) => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as AppFile;
const habits = () => read('tinkrum-app-habits.json') as any;

describe('designHints', () => {
  // None of our presets trigger any suggestions: Founder agreed on 2026-11-20 to update Wallet, Focus, and Reading according to suggestions.
  it('has nothing to say about any of our presets', () => {
    const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
      apps: { file: string }[];
    };
    const said = manifest.apps.flatMap((app) =>
      designHints(read(app.file)).map((h) => `${app.file} ${h}`),
    );
    expect(said).toEqual([]);
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
      'pages.1.blocks.1 (block "add"): the page opens with a form of 4 fields before anything else; use one add button instead (a "button" block whose tool is {"do": "create", "table": …, "ask": "all"}) and put what the page shows first; see pattern 1 in tinkrum-app-patterns.md',
    ]);
    // Having three fields or fewer at the beginning is fine.
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
    // Remove the "A Habit" page: tapping a habit does not show its check-ins.
    d.pages = d.pages.filter((p: { of?: string }) => p.of !== 'habits-habits');
    for (const page of d.pages)
      for (const b of page.blocks) {
        delete b.opens;
        for (const c of b.children ?? []) delete c.opens;
      }
    expect(designHints(d)).toEqual([
      'tables.0 ("habits-habits"): habits-checkins link to its entries, but there is no page for one habits-habits entry, so tapping one cannot show its habits-checkins entries; add a page with "of": "habits-habits" that lists habits-checkins filtered by {"field": "habit", "op": "is", "value": "$record"}, and set "opens" to that page on the blocks that list habits-habits; see pattern 8 in tinkrum-app-patterns.md',
    ]);
  });

  it('suggests progress when a total sits next to what may be its goal', () => {
    const d = habits();
    d.tables[0].fields.push({
      id: 'done',
      name: 'Done',
      type: 'rollup',
      table: 'habits-checkins',
      via: 'habit',
      aggregate: 'count',
    });
    d.pages[1].blocks[1].show = { title: 'name', subtitles: ['goal'], trailing: 'done' };
    expect(designHints(d)).toEqual([
      'pages.1.blocks.1 (block "list"): it shows "done" and "goal" side by side; if "goal" is the goal or limit for "done", show the progress instead: "trailing": "done", "format": {"kind": "progress", "goal": "goal", "style": "bar"} (it reads "done / goal" with a bar); see patterns 2 and 3 in tinkrum-app-patterns.md',
    ]);
    d.pages[1].blocks[1].show.format = { kind: 'progress', goal: 'goal' };
    expect(designHints(d)).toEqual([]);
  });

  it('notices a row button that adds a new entry of the same table', () => {
    const d = habits();
    d.pages[1].blocks[1].tools.push({
      as: 'button',
      label: 'Add',
      do: 'create',
      table: 'habits-habits',
      ask: 'all',
    });
    expect(designHints(d)).toEqual([
      expect.stringMatching(
        /^pages\.1\.blocks\.1 \(block "list"\): every row gets a button that adds a new habits-habits entry/,
      ),
    ]);
  });

  it('asks for a header between two lists that follow each other, of any tables', () => {
    const d = habits();
    const second = {
      id: 'more',
      look: 'list',
      source: { table: 'habits-habits' },
      show: { title: 'name' },
    };
    d.pages[1].blocks.splice(2, 0, second);
    expect(designHints(d)).toEqual([
      'pages.1.blocks.2 (block "more"): this list comes right after another list with no header between them, so people cannot tell the two apart; put a header block before each list; see pattern 8 in tinkrum-app-patterns.md',
    ]);
    d.pages[1].blocks.splice(2, 0, { id: 'h2', look: 'header', show: { title: 'More' } });
    expect(designHints(d)).toEqual([]);
  });

  it('notices an optional field as the row title', () => {
    const d = habits();
    d.tables[0].fields.push({ id: 'nickname', name: 'Nickname', type: 'text' });
    d.pages[1].blocks[1].show.title = 'nickname';
    expect(designHints(d)).toEqual([
      'pages.1.blocks.1 (block "list"): the row title "nickname" is optional, so entries without it show the table\'s name and the day they were added instead; use a field that is always filled as the title (a required field, or a date with a default) and move "nickname" to subtitles; see pattern 3 in tinkrum-app-patterns.md',
    ]);
  });
});
