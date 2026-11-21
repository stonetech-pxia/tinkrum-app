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

// 给别的 AI 看的 App 文件写法（D-593）：生成的说明和 JSON Schema 放在 docs/agent/，改了登记表、提示词或 App 文件的
// 形状要有意地更新（npx vitest -u）；里面的示例必须能照原样导入。

const registry = createRegistry(BUILTIN_TOOLS);
// 相对这个测试文件。
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

  // 结构模式（D-603）：每一份都能照原样导入，没有要修的，也没有设计建议；只有英文。
  it('every pattern imports as it is, with nothing to fix and no suggestions', () => {
    // 第 9 种「连接带数据」是 D-616 加的。
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
    // 设计建议（D-602）也没有：示例就是照建议写的（一株植物有自己的页面）。
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
    // 所有 ID 的写法（D-595）：别的 AI 写过 dueDate 这样的字段 ID，导入被拒。
    expect(guide).toContain('**Every id** (the app, pages, blocks, tables, fields, choice options');
    expect(guide).toContain('`"due-date"`, not `"dueDate"`');
    // 自检（D-594）：先跑和导入同一套检查的脚本，说 OK 才交给用户。
    expect(guide).toContain('node tinkrum-check.js app.json');
    expect(guide).toContain('https://tinkrum.stonetech.dev/assets/agent/tinkrum-check.js');
    // 只有英文（创始人 2026-11-19）：Tink 的中文、法语示例句都不在里面。
    expect(guide).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/);
    expect(guide).not.toMatch(/rappelle-moi|l'accueil|"jours"/);
    // 短版（D-598）：Tink 的规则不放，动作目录另放一个文件，指南里说去哪里拿。
    expect(guide).not.toContain('## Rules');
    expect(guide).not.toContain('## Built-in tool catalog');
    expect(guide).toContain('https://tinkrum.stonetech.dev/assets/agent/tinkrum-app-actions.md');
    expect(guide.length).toBeLessThan(60_000);
    // 设计建议（D-602）：照做，除非用户要的就是这样。
    expect(guide).toContain('apply them unless the person asked for it this way');
    // 重复的日期（D-602）：订阅、账单这类用日程字段或日期偏移，不用手改的日期。
    expect(guide).toContain('A date that comes back');
    // 先从结构模式起步（D-603）。
    expect(guide).toContain('**Start from a pattern.**');
    expect(guide).toContain('https://tinkrum.stonetech.dev/assets/agent/tinkrum-app-patterns.md');
  });

  it('the action catalog is English only and lists the actions', () => {
    const catalog = buildActionCatalog(registry);
    expect(catalog).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/);
    expect(catalog).toContain('records.toExcel');
    expect(catalog).toContain('## Quick-action presets');
    // 讲快捷操作的规则（D-604）跟着动作目录。
    expect(catalog).toContain('## Rules for quick actions');
    expect(catalog).toMatch(/^20\. Building quick actions/m);
  });

  // 功能规则另放一个文件（D-604）：主指南不变短不了，资料又不能没有；指南说清楚去哪里读。
  it('keeps the feature rules in their own file, English only, and the guide points to it', () => {
    const rules = buildRulesDoc(registry);
    expect(rules).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/);
    expect(rules).not.toMatch(/rappelle-moi|l'accueil|"jours"/);
    for (const n of [32, 42, 43, 44, 46, 62]) expect(rules).toMatch(new RegExp(`^${n}\\. `, 'm'));
    // 对话、草稿和整台手机的规则不放：1 只改要改的、23 用户看到的叫法、39 手机桌面。
    for (const n of [1, 23, 39]) expect(rules).not.toMatch(new RegExp(`^${n}\\. `, 'm'));
    expect(rules).toContain('days(today, {due})');
    // 函数名后面的空括号不是删掉例子剩下的，留着。
    expect(rules).toContain('compared in if()');
    const guide = buildAgentGuide(registry, example);
    expect(guide).toContain('https://tinkrum.stonetech.dev/assets/agent/tinkrum-app-rules.md');
  });
});
