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
      'app.theme.primaryColor: color must be #RRGGBB',
      'pages.0.blocks.0.look: not a valid look',
    ]);
  });

  it('names the block and the table when a reference is wrong', () => {
    const d = habits();
    d.pages[0].blocks[3].source.table = 'nope';
    expect(problems(d)).toEqual(['orbs: data table nope does not exist']);
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
