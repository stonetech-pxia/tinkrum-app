import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appFileJsonText, checkAppFileText } from './app-file-check';
import { CURRENT_SCHEMA_VERSION } from './schema';
import { registry } from './test-helpers';

// 检查 App 文件（D-593）：别的 AI 写的文件，导入前说清楚哪里不对，说法要能照着改。

const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 19) };
const DIR = join(__dirname, 'fixtures', 'portal-apps');
const habitsText = readFileSync(join(DIR, 'tinkrum-app-habits.json'), 'utf8');
const habits = () => JSON.parse(habitsText) as Record<string, any>;
const check = (data: unknown) => checkAppFileText(JSON.stringify(data), ctx);
const problems = (data: unknown) => {
  const result = check(data);
  if (result.ok) throw new Error('expected problems');
  return result.problems;
};

describe('checkAppFileText', () => {
  it('passes every portal app, with what it adds', () => {
    const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
      apps: { file: string; name: string; pages: string[]; tables: string[] }[];
    };
    for (const app of manifest.apps) {
      const result = checkAppFileText(readFileSync(join(DIR, app.file), 'utf8'), ctx);
      expect(result.ok && result.warnings).toEqual([]);
      expect(result.ok && result.summary).toMatchObject({
        name: app.name,
        pages: app.pages.length,
        tables: app.tables.length,
      });
    }
  });

  it('reads JSON that a chat assistant wrapped in a code block or a sentence', () => {
    expect(appFileJsonText('Here it is:\n```json\n{"a": 1}\n```\nEnjoy!')).toBe('{"a": 1}');
    expect(checkAppFileText(`Sure!\n\`\`\`json\n${habitsText}\n\`\`\``, ctx).ok).toBe(true);
  });

  it('says why when it is not JSON or not an app file', () => {
    expect(checkAppFileText('hello', ctx)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/^not valid JSON/)],
    });
    expect(problems([1, 2])).toEqual(['the file must be one JSON object']);
    expect(problems({ format: 'morph-app-config' })).toEqual([
      'format must be "tinkrum-app" (got "morph-app-config")',
    ]);
  });

  it('names what is missing from the outside of the file', () => {
    const { schemaVersion: _, ...rest } = habits();
    expect(problems(rest)).toEqual([expect.stringMatching(/^schemaVersion: /)]);
  });

  // D-607：39 → 40 只加了单选的 multiple；39 的文件（网站上的预设）照样逐项说清楚。
  it('checks a file of the previous version in detail when migrating it changes nothing else', () => {
    const d = habits();
    expect(d.schemaVersion).toBe(CURRENT_SCHEMA_VERSION - 1);
    d.pages[0].blocks[0].look = 'banner';
    expect(problems(d)[0]).toMatch(/^pages\.0\.blocks\.0\.look: "banner" is not a valid look/);
  });

  it('tells a newer file to use the current version', () => {
    expect(problems({ ...habits(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 })[0]).toContain(
      `write schemaVersion ${CURRENT_SCHEMA_VERSION}`,
    );
  });

  it('gives the path from the top of the file for a wrong shape', () => {
    const d = habits();
    d.pages[0].blocks[0].look = 'banner';
    d.app.theme.primaryColor = 'purple';
    expect(problems(d)).toEqual([
      'app.theme.primaryColor: color must be #RRGGBB (got "purple")',
      expect.stringMatching(
        /^pages\.0\.blocks\.0\.look: "banner" is not a valid look; use one of .*"header"/,
      ),
    ]);
  });

  it('names the block and the table when a reference is wrong', () => {
    const d = habits();
    d.pages[0].blocks[3].source.table = 'nope';
    expect(problems(d)).toEqual([
      'pages.0.blocks.3 (block "orbs"): data table nope does not exist; tables in this file: habits-habits, habits-checkins',
    ]);
  });

  it('rejects an id the phone already has, so the agent prefixes its ids', () => {
    const d = habits();
    d.pages[0].id = 'home';
    d.app.bar[0] = 'page:home';
    expect(problems(d)).toEqual(['page home already exist']);
  });

  it('migrates an older file before checking it, like the import does', () => {
    const d = habits();
    d.schemaVersion = CURRENT_SCHEMA_VERSION - 1;
    expect(check(d).ok).toBe(true);
  });

  it('caps a long list of problems', () => {
    const d = habits();
    for (const page of d.pages) for (const block of page.blocks) block.look = 'banner';
    for (const table of d.tables) for (const field of table.fields) field.type = 'string';
    const count = (key: 'pages' | 'tables', inner: 'blocks' | 'fields') =>
      d[key].reduce((n: number, x: Record<string, unknown[]>) => n + x[inner]!.length, 0);
    const wrong = count('pages', 'blocks') + count('tables', 'fields');
    expect(wrong).toBeGreaterThan(20);
    const list = problems(d);
    expect(list).toHaveLength(21);
    expect(list[20]).toBe(`…and ${wrong - 20} more`);
  });
});

// 报错带改法（D-597）：别的 AI 只拿着这份文件，照着报错就要能改对，不用回去翻指南。
describe('checkAppFileText says how to fix it', () => {
  it('turns a wrong id into the right one', () => {
    const d = habits();
    d.tables[1].fields[3].id = 'Note_Text';
    expect(problems(d)).toEqual([
      'tables.1.fields.3.id: "Note_Text" is not a valid id (lowercase letters, digits and -, starting with a letter); write "note-text" and use it everywhere this id is referenced',
    ]);
    const e = habits();
    e.pages[1].blocks[1].show.trailing = 'streakDays';
    expect(problems(e)).toEqual([
      'pages.1.blocks.1.show.trailing: "streakDays" is not a valid id (lowercase letters, digits and -, starting with a letter); write "streak-days"',
    ]);
  });

  it('takes "page:" off where only a page id goes', () => {
    const d = habits();
    d.pages[1].blocks[1].opens = 'page:habits-habit';
    expect(problems(d)).toEqual([
      'pages.1.blocks.1.opens: "page:habits-habit" is not a valid id; this place takes the id alone: write "habits-habit"',
    ]);
  });

  it('tells text in a record block from a misspelled field id', () => {
    const d = habits();
    d.pages[1].blocks[1].show.title = 'My habits';
    expect(problems(d)).toEqual([
      `pages.1.blocks.1.show.title: "My habits" is text, but show.title takes a field id of the block's table; put text in a header block or the page title`,
    ]);
  });

  it('lists the allowed values and guesses the meant one', () => {
    const d = habits();
    d.pages[1].blocks[1].source.sort.direction = 'descending';
    d.pages[1].icon = 'calendar-days';
    expect(problems(d)).toEqual([
      'pages.1.icon: icon must be a listed icon name or a single emoji (got "calendar-days"; did you mean "calendar"?)',
      'pages.1.blocks.1.source.sort.direction: "descending" is not allowed here; use one of "asc"|"desc" (did you mean "desc"?)',
    ]);
  });

  it('says what is missing and what does not belong', () => {
    const d = habits();
    delete d.pages[1].blocks[1].show;
    d.pages[1].blocks[0].look = 'header';
    d.pages[1].blocks[0].title = 'My habits';
    expect(problems(d)).toEqual([
      'pages.1.blocks.0: Unrecognized key: "title"; remove it, it does not belong here',
      'pages.1.blocks.1.show: missing; this is required (object)',
    ]);
  });

  it('names the place in the file and what the file has for a wrong reference', () => {
    const d = habits();
    d.pages[0].blocks[3].source.table = 'habits-habit';
    d.pages[1].blocks[1].show.subtitles = ['plans'];
    expect(problems(d)).toEqual([
      'pages.0.blocks.3 (block "orbs"): data table habits-habit does not exist; tables in this file: habits-habits, habits-checkins (did you mean "habits-habits"?)',
      'pages.1.blocks.1 (block "list"): show.subtitles plans is not a field of habits-habits; fields of habits-habits: name, goal, part, plan, last, today, streak (did you mean "plan"?)',
    ]);
  });

  it('finds the right block when two pages use the same block id', () => {
    const d = habits();
    d.pages[3].blocks[1].show.title = 'stat';
    expect(problems(d)).toEqual([
      expect.stringMatching(
        /^pages\.3\.blocks\.1 \(block "cal"\): show\.title stat is not a field of habits-checkins/,
      ),
    ]);
  });

  it('explains the bar, duplicate block ids and choice defaults', () => {
    const d = habits();
    d.app.bar[1] = 'page:habits-list';
    expect(problems(d)).toEqual([
      'app.bar.1: "page:habits-list" is not a page in this file; pages in this file: page:habits-home, page:habits-habits, page:habits-insights, page:habits-habit',
    ]);
    const e = habits();
    e.pages[0].blocks[1].id = 'h';
    expect(problems(e)).toEqual([
      'pages.0.blocks.0, pages.0.blocks.1: these blocks on page habits-home all have the id "h"; give each block its own id',
    ]);
    const f = habits();
    f.tables[1].fields[2].default = 'finished';
    expect(problems(f)).toEqual([
      expect.stringMatching(
        /^tables\.1\.fields\.2 \(field "status" of habits-checkins\): .*finished.*; options: done, skip$/,
      ),
    ]);
  });
});
