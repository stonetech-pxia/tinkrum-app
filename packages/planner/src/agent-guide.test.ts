import { BUILTIN_TOOLS, checkAppFileText, createRegistry } from '@morph/core';
import { describe, expect, it } from 'vitest';

import { AGENT_EXAMPLE_APP } from './agent-example';
import { AGENT_PATTERNS } from './agent-patterns';
import {
  appFileJsonSchema,
  buildActionCatalog,
  buildAgentGuide,
  buildPatternsDoc,
  buildRulesDoc,
} from './agent-guide';

// App file writing for other AIs (D-593): generated documentation and JSON Schema are placed in
// docs/agent/; modifying registries, prompts, or App file shapes requires intentionally updating
// them (npx vitest -u); examples within must import as is.

const registry = createRegistry(BUILTIN_TOOLS);
// Relative to this test file.
const DOCS = '../../../docs/agent';
const example = `${JSON.stringify(AGENT_EXAMPLE_APP, null, 2)}\n`;
const ctx = { registry, locale: 'en' as const, now: new Date(2026, 10, 19) };

describe('agent guide', () => {
  it('guide', async () => {
    await expect(buildAgentGuide(registry, example)).toMatchFileSnapshot(
      `${DOCS}/tinkrum-app-guide.md`,
    );
  });

  it('action catalog', async () => {
    await expect(buildActionCatalog(registry)).toMatchFileSnapshot(
      `${DOCS}/tinkrum-app-actions.md`,
    );
  });

  it('rules', async () => {
    await expect(buildRulesDoc(registry)).toMatchFileSnapshot(`${DOCS}/tinkrum-app-rules.md`);
  });

  it('patterns', async () => {
    await expect(buildPatternsDoc(AGENT_PATTERNS)).toMatchFileSnapshot(
      `${DOCS}/tinkrum-app-patterns.md`,
    );
  });

  // Structural pattern (D-603): each imports as is, with nothing to fix and no design suggestions; English only.
  it('every pattern imports as it is, with nothing to fix and no suggestions', () => {
    // The 9th pattern "Connected with data" was added by D-616.
    expect(AGENT_PATTERNS).toHaveLength(9);
    for (const p of AGENT_PATTERNS) {
      const result = checkAppFileText(JSON.stringify(p.app), ctx);
      expect([p.name, result.ok && result.warnings, result.ok && result.hints]).toEqual([
        p.name,
        [],
        [],
      ]);
    }
    expect(buildPatternsDoc(AGENT_PATTERNS)).not.toMatch(
      /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/,
    );
  });

  it('JSON Schema', async () => {
    await expect(`${JSON.stringify(appFileJsonSchema(), null, 2)}\n`).toMatchFileSnapshot(
      `${DOCS}/tinkrum-app.schema.json`,
    );
  });

  it('example file', async () => {
    await expect(example).toMatchFileSnapshot(`${DOCS}/example-plants.json`);
  });

  it('the example imports as it is, with nothing left to fix', () => {
    const result = checkAppFileText(example, ctx);
    expect(result.ok && result.warnings).toEqual([]);
    // No design suggestions (D-602) either: the example is written following suggestions (a plant has its own page).
    expect(result.ok && result.hints).toEqual([]);
    expect(result.ok && result.summary).toEqual({
      name: 'Plants',
      pages: 3,
      tables: 2,
      quickActions: 1,
      reminders: 1,
    });
  });

  it('leaves out operations and the parts of Tink that are about the conversation', () => {
    const guide = buildAgentGuide(registry, example);
    expect(guide).not.toContain('type Plan =');
    expect(guide).not.toContain('type Op =');
    expect(guide).not.toMatch(/^1\. Change only what was asked/m);
    expect(guide).not.toMatch(/^5\. Undo, revert/m);
    // Writing all IDs (D-595): other AIs have written field IDs like dueDate, causing imports to be rejected.
    expect(guide).toContain('**Every id** (the app, pages, blocks, tables, fields, choice options');
    expect(guide).toContain('`"due-date"`, not `"dueDate"`');
    // Self-check (D-594): run scripts that perform the same checks as import first, and only hand over to the user if it says OK.
    expect(guide).toContain('node tinkrum-check.js app.json');
    expect(guide).toContain('https://tinkrum.stonetech.dev/assets/agent/tinkrum-check.js');
    // English only (Founder 2026-11-19): Tink's Chinese and French example sentences are not included.
    expect(guide).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/);
    expect(guide).not.toMatch(/rappelle-moi|l'accueil|"jours"/);
    // Short version (D-598): Tink's rules are omitted, action catalog is placed in a separate file, and the guide points to where to find it.
    expect(guide).not.toContain('## Rules');
    expect(guide).not.toContain('## Built-in tool catalog');
    expect(guide).toContain('https://tinkrum.stonetech.dev/assets/agent/tinkrum-app-actions.md');
    expect(guide.length).toBeLessThan(60_000);
    // Design suggestions (D-602): follow them unless the user explicitly requested otherwise.
    expect(guide).toContain('apply them unless the person asked for it this way');
    // Repeating dates (D-602): subscriptions, bills, etc., use schedule fields or date offsets rather than manually edited dates.
    expect(guide).toContain('A date that comes back');
    // **Start from a pattern.** (D-603).
    expect(guide).toContain('**Start from a pattern.**');
    expect(guide).toContain('https://tinkrum.stonetech.dev/assets/agent/tinkrum-app-patterns.md');
  });

  it('the action catalog is English only and lists the actions', () => {
    const catalog = buildActionCatalog(registry);
    expect(catalog).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/);
    expect(catalog).toContain('records.toExcel');
    expect(catalog).toContain('## Quick-action presets');
    // Quick action rules (D-604) accompany the action catalog.
    expect(catalog).toContain('## Rules for quick actions');
    expect(catalog).toMatch(/^20\. Building quick actions/m);
  });

  // Keep feature rules in a separate file (D-604): the main guide cannot be shortened, but documentation is necessary; the guide clearly states where to read it.
  it('keeps the feature rules in their own file, English only, and the guide points to it', () => {
    const rules = buildRulesDoc(registry);
    expect(rules).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/);
    expect(rules).not.toMatch(/rappelle-moi|l'accueil|"jours"/);
    for (const n of [32, 42, 43, 44, 46, 62]) expect(rules).toMatch(new RegExp(`^${n}\\. `, 'm'));
    // Omit conversation, draft, and entire phone rules: 1 only change what needs changing, 23 user-visible terminology, 39 home screen.
    for (const n of [1, 23, 39]) expect(rules).not.toMatch(new RegExp(`^${n}\\. `, 'm'));
    expect(rules).toContain('days(today, {due})');
    // Empty parentheses following function names are not leftovers from deletion; keep them.
    expect(rules).toContain('compared in if()');
    const guide = buildAgentGuide(registry, example);
    expect(guide).toContain('https://tinkrum.stonetech.dev/assets/agent/tinkrum-app-rules.md');
  });

  it('the rules a look doc cites for what an app can do are in the rules file', async () => {
    // Rules invisible to external AIs cause unknown syntax errors (D-604): every "(rule N)" in registration tables must exist in rule files or action catalogs.
    const guide = await buildAgentGuide(registry, example);
    const given = new Set<number>();
    for (const doc of [buildRulesDoc(registry), buildActionCatalog(registry)])
      for (const line of doc.split('\n')) {
        const n = /^(\d+)\. /.exec(line);
        if (n) given.add(Number(n[1]));
      }
    // Excludes rules discussing Tink dialogue or overall phone operation; ignored if the guide states it is invisible. Restricts checks solely to newly added summary-type syntaxes.
    for (const n of [77, 78, 79]) expect(given.has(n)).toBe(true);
    expect(guide).toContain('rule 78');
  });
});
