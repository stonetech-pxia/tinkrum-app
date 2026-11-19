import { BUILTIN_TOOLS, checkAppFileText, createRegistry } from '@morph/core';
import { describe, expect, it } from 'vitest';

import { AGENT_EXAMPLE_APP } from './agent-example';
import { appFileJsonSchema, buildAgentGuide } from './agent-guide';

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
    expect(result.ok && result.summary).toEqual({
      name: 'Plants',
      pages: 2,
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
    // 自检（D-594）：先跑和导入同一套检查的脚本，说 OK 才交给用户。
    expect(guide).toContain('node tinkrum-check.js app.json');
    expect(guide).toContain('https://tinkrum.stonetech.dev/assets/agent/tinkrum-check.js');
    // 只有英文（创始人 2026-11-19）：Tink 的中文、法语示例句都不在里面。
    expect(guide).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/);
    expect(guide).not.toMatch(/rappelle-moi|l'accueil|"jours"/);
    expect(guide).toContain('"days" and decimals 0');
    // 函数名后面的空括号不是删掉例子剩下的，留着。
    expect(guide).toContain('compared in if()');
    // 规则 23（用户看到的叫法）和 57（App）留着。
    expect(guide).toMatch(/^23\. /m);
    expect(guide).toMatch(/^57\. /m);
  });
});
