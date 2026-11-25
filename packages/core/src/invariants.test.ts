import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PlanAboutSchema, PlanSchema } from './ai/types';
import { DEFAULT_CALENDAR } from './calendar';
import { createMockAIProvider } from './ai/mock';
import { prepareOps, prepareSnapshot } from './change';
import { createDefaultWorkspace } from './defaults';
import { defaultDeskTools } from './desk/tools';
import { V4_CUSTOM_ASK, V4_DEFAULT_MERGE, V4_FIXED_NAME } from './fixtures/v4';
import {
  filterRecords,
  formatValue,
  perCurrencyText,
  prepareRecordValues,
  recordValue,
  type DataRecord,
} from './data';
import { fieldLink } from './field-link';
import { listGroups } from './list-groups';
import { fieldDefinition } from './fields';
import { en, enSingular } from './messages/en';
import { fr, frSingular } from './messages/fr';
import { zh } from './messages/zh';
import { migrateWorkspace } from './migrate';
import { ruleEngine } from './prefill/engine';
import { applyOps, OpSchema, type Op } from './ops';
import { checkInput, checkOverwrites } from './record-ops';
import {
  MAX_CREATE_ALL,
  MAX_SET_ALL,
  MAX_TAP_WRITES,
  PICK_TOOLS,
  RecordToolSchema,
  ToolUseSchema,
  type RecordToolUse,
} from './record-ops-schema';
import {
  allComponents,
  CollectionSchema,
  CURRENT_SCHEMA_VERSION,
  ReminderSchema,
  WorkflowStepSchema,
  WorkspaceConfigSchema,
  type Collection,
  type Workflow,
  type WorkspaceConfig,
} from './schema';
import { planDocument } from './prefill/code-rules';
import { IMPORT_LIMITS, importLimitProblem } from './records-import';
import { sampleOps } from './samples';
import { readNumber } from './source';
import { NumberSourceSchema } from './components/number';
import { createStarterWorkspace } from './starter';
import { fromV33, registry, v33Fixture } from './test-helpers';
import { validateWorkspace } from './validate';
import { defaultParams, initialParams, typesAlong, workflowProblems } from './workflow/check';
import {
  actionAccepts,
  handedTypeOf,
  isSourceAction,
  outputTypeOf,
  type ActionDefinition,
} from './workflow/contract';
import { REDACTED_FILE, REDACTED_TEXT, redactForAI } from './workflow/redact';
import { presetById } from './workflows/presets';

// Tinkrum's 19 invariants (AGENTS.md "Invariants", provisionally set by the founder in conversation
// on 2026-10-31, items 3, 7, 11, 16 modified and 19 added on the same day). One describe block per
// invariant, testing behavior rather than implementation details. Tests requiring the app
// environment (requests sent to AI, records, files, rendering) are located in
// apps/mobile/src/__tests__/invariants-test.tsx and invariants-files-test.ts; where dedicated tests
// already exist, their location is noted here. When an actual violation is detected, do not fix the
// code: mark it with it.fails and a comment "violates invariant N, awaiting the founder's decision:
// ...".

const REPO = join(__dirname, '..', '..', '..');
const SENTINEL = 'SENTINEL-私密-7f3a';

const V33_NAMES = readdirSync(join(__dirname, 'fixtures', 'v33'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('coverage-'))
  .map((f) => f.slice(0, -'.json'.length));
const V34_NAMES = ['habits', 'calendar', 'tasks', 'todo'];

/** Stored state is v34, upgraded to the current version just like when loading configuration. */
const v34Fixture = (name: string): WorkspaceConfig => {
  const r = migrateWorkspace(
    JSON.parse(readFileSync(join(__dirname, 'fixtures', 'v34', `${name}.json`), 'utf8')),
  );
  if (!r.ok) throw new Error(`fixture ${name}: ${r.error}`);
  return r.config as WorkspaceConfig;
};

/** All test configurations: migrated versions from v34 code storage (default, new user, template, sample app, evaluation setup), plus the v34 scope template. */
const CONFIGS: [string, WorkspaceConfig][] = [
  ...V33_NAMES.map((n): [string, WorkspaceConfig] => [n, fromV33(v33Fixture(n))]),
  ...V34_NAMES.map((n): [string, WorkspaceConfig] => [`v34-${n}`, v34Fixture(n)]),
];

/** Names of the 14 modification operations (in the order defined in ops-schema.ts). */
const OP_NAMES = [
  ...readFileSync(join(__dirname, 'ops-schema.ts'), 'utf8').matchAll(/op: z\.literal\('(\w+)'\)/g),
].map((m) => m[1]!);

const ctx = { registry, locale: 'zh' as const, now: new Date(2026, 9, 31, 9, 0) };

/** Source files in the repository (excluding tests, generated files, and node_modules). */
function sourceFiles(dir: string, exts = ['.ts', '.tsx']): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path, exts));
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\.tsx?$|-test\.tsx?$/.test(name))
      out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Data and Privacy
// ---------------------------------------------------------------------------------------------

describe("Invariant 1: The user's data never leaves the phone", () => {
  // Actual requests (with keys, Tinkrum server, inbox page) are tested using sentinel strings in mobile's invariants-test.tsx.

  it('the app has no telemetry, crash-report or analytics library', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'apps', 'mobile', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const tracking =
      /sentry|bugsnag|crashlytics|firebase|analytics|amplitude|segment|mixpanel|posthog|datadog|newrelic|insights|expo-updates/i;
    expect(Object.keys(pkg.dependencies).filter((d) => tracking.test(d))).toEqual([]);
  });

  it('every network call in the app code is one of the allowed kinds (AI, downloads, the need button)', () => {
    // Adding a new network connection point will cause this test to fail: first verify that it
    // carries no data content (invariant 1) and is not essential for offline functionality
    // (invariant 13), then add it to the list below and document it in DECISIONS.
    const ALLOWED: Record<string, string> = {
      'packages/planner/src/http.ts': 'AI 修改：自带 key 调 Claude',
      'packages/planner/src/openai.ts': 'AI 修改：自带 key 调 OpenAI 兼容接口',
      'packages/planner/src/relay.ts': 'AI 修改：经 Tinkrum 服务器转发（D-193）',
      'apps/mobile/src/workspace/remote-ai.ts': '「把这个需求告诉我们」（D-189）：只发用户那句话',
      'apps/mobile/src/tool-download/expo-tool-fs.ts': '下载工具（D-177）：目录和工具文件',
      'apps/mobile/src/tool-download/store.ts':
        '下载工具：经 expo-tool-fs 取目录（每天最多一次）和工具',
      'apps/mobile/src/packs/expo-pack-fs.ts': '下载扩展包（模型、识别语言）',
    };
    const NETWORK =
      /\bfetch\(|fetchImpl\(|XMLHttpRequest|new WebSocket|downloadFileAsync|createDownloadResumable|downloadAsync\(/;
    const found = [
      ...sourceFiles(join(REPO, 'apps', 'mobile', 'src')),
      ...sourceFiles(join(REPO, 'packages', 'core', 'src')),
      ...sourceFiles(join(REPO, 'packages', 'planner', 'src')),
    ]
      .filter((f) => !f.includes(`${join('src', 'test-utils')}`))
      // The method named fetch in pack pages is used to request local bytes (BinaryDataFactory) from the app, without network access.
      .filter((f) => !f.endsWith(join('packs', 'pages', 'pdfview.ts')))
      .filter((f) => NETWORK.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO, f).split('\\').join('/'));
    expect(found.sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});

describe('Invariant 2: The AI never sees the content of the data', () => {
  // Requests sent out (including inbox page, draft chat, both AI types) are tested using sentinel
  // strings in mobile's invariants-test.tsx; here we test the two places in core that determine
  // "what to send".

  it('the inbox context sent to AI is only kinds and counts: names, sizes and contents do not fit', () => {
    expect(
      PlanAboutSchema.safeParse({ kind: 'shared', images: 1, pdfs: 0, others: 0 }).success,
    ).toBe(true);
    for (const extra of [
      { names: ['a.pdf'] },
      { size: 1000 },
      { text: SENTINEL },
      { files: [{ name: 'a.pdf' }] },
    ])
      expect(
        PlanAboutSchema.safeParse({ kind: 'shared', images: 1, pdfs: 0, others: 0, ...extra })
          .success,
      ).toBe(false);
  });

  it('the page a change was opened from is only an id or a kind of file: titles of records, names and contents do not fit (D-406)', () => {
    const places = [
      { kind: 'page', pageId: 'budget' },
      { kind: 'table', tableId: 'expenses' },
      { kind: 'screen', screen: 'tools' },
      { kind: 'desk', fileKind: 'pdf' },
    ];
    for (const place of places) {
      expect(PlanAboutSchema.safeParse(place).success).toBe(true);
      for (const extra of [
        { recordId: 'r1' },
        { title: SENTINEL },
        { name: 'a.pdf' },
        { text: SENTINEL },
      ])
        expect(PlanAboutSchema.safeParse({ ...place, ...extra }).success).toBe(false);
    }
  });

  it('text the user typed into quick-action steps (watermark, stamp …) is replaced before the config goes to AI', () => {
    const base = createDefaultWorkspace('zh');
    let hidden = 0;
    const steps = [...registry.actions.values()]
      .filter((a) => a.fields.some((f) => f.private))
      .map((a, i) => {
        const params: Record<string, unknown> = {};
        for (const f of a.fields.filter((x) => x.private)) {
          params[f.key] = `${SENTINEL}-${i}-${f.key}`;
          hidden++;
        }
        return { id: `s${i}`, action: a.id, params };
      });
    expect(hidden).toBeGreaterThan(0);
    const config = {
      ...base,
      tools: [...base.tools, { id: 'qa', kind: 'quickAction', name: 'x', steps }],
    } as WorkspaceConfig;
    const sent = JSON.stringify(redactForAI(config, registry));
    expect(sent).not.toContain(SENTINEL);
    expect(sent.split(REDACTED_TEXT).length - 1).toBe(hidden);
  });
});

describe('Invariants 1 / 2 / 14: Saved presets are not in the config (D-410)', () => {
  it('a config carrying saved presets is rejected, so they can never go to the AI with it', () => {
    const config = createDefaultWorkspace('zh');
    expect(
      WorkspaceConfigSchema.safeParse({ ...config, presets: [{ id: 'p', name: SENTINEL }] })
        .success,
    ).toBe(false);
  });
});

describe("Invariant 2: On-device model reads file text only for suggestions, and only the user's spoken sentence for this entry is filled directly (D-396, D-575)", () => {
  const fields = [
    { id: 'title', name: '事项', type: 'text' as const },
    { id: 'due', name: '截止日期', type: 'date' as const },
    { id: 'amount', name: '金额', type: 'money' as const, currency: 'CNY' },
  ];
  const page = (text: string) => ({
    width: 600,
    height: 40,
    lines: [{ text, x: 0, y: 0, width: 600, height: 24 }],
  });
  const sure = (out: Record<string, { sure?: boolean }[]>) =>
    Object.values(out)
      .flat()
      .some((s) => s.sure === true);

  it('Same sentence: none read from files are filled directly, only spoken ones are', async () => {
    const text = '明天交房租 2026-11-18 金额 3000元';
    const base = {
      fields,
      pages: [page(text)],
      locale: 'zh' as const,
      now: new Date(2026, 10, 17),
    };
    expect(sure(await ruleEngine(base))).toBe(false);
    expect(sure(await ruleEngine({ ...base, spoken: true }))).toBe(true);
  });
});

describe('Invariant 2: Scanned QR codes are not sent to the AI (D-423)', () => {
  it('the code is only for the candidates: not in the document text, and never in config', () => {
    const fields = [{ id: 'name', name: 'Name', type: 'text' as const }];
    const plan = planDocument({
      fields,
      rules: 'card',
      pages: [],
      locale: 'en',
      codes: [`BEGIN:VCARD\nFN:${SENTINEL}\nEND:VCARD`],
    });
    // Rows provided when querying the model; the AI plan contains only configuration (candidates do not fit in the config).
    expect(plan.rows).toEqual([]);
    expect(plan.fields[0]!.fromCode.map((s) => s.value)).toEqual([SENTINEL]);
    expect(plan.fields[0]!.ask).toBe(false);
    expect(
      CollectionSchema.safeParse({ id: 't', name: 'T', fields, codes: [SENTINEL] }).success,
    ).toBe(false);
  });
});

describe('Invariant 3: AI never touches files', () => {
  it('the 14 changes AI can make are all changes to the configuration; none reads, writes, moves or deletes a file', () => {
    expect(OP_NAMES).toEqual([
      'addData',
      'updateData',
      'removeData',
      'moveData',
      'addContainer',
      'updateContainer',
      'removeContainer',
      'moveContainer',
      'addTool',
      'updateTool',
      'removeTool',
      'moveTool',
      'setTheme',
      'setPackage',
    ]);
    for (const op of [
      { op: 'deleteFile', file: 'abcdef12' },
      { op: 'moveFile', file: 'abcdef12', to: 'x' },
      { op: 'writeFile', name: 'a.txt', text: 'x' },
      { op: 'readFile', file: 'abcdef12' },
    ])
      expect(OpSchema.safeParse(op).success).toBe(false);
  });

  it('applying changes is pure: the result is a new configuration and the input is untouched', () => {
    for (const [, config] of CONFIGS.slice(0, 6)) {
      const before = JSON.stringify(config);
      const first = config.data.tables[0];
      if (!first) continue;
      const result = applyOps(config, [{ op: 'removeData', table: first.id }], ctx);
      expect(JSON.stringify(config)).toBe(before);
      expect(Object.keys(result).sort()).toEqual(
        result.ok ? ['config', 'notes', 'ok'] : ['error', 'ok'],
      );
    }
  });

  it('a file slot that AI adds starts empty: the user picks the file (prompt rule; the store-level check is in mobile)', () => {
    // The structure allows {file: null} (empty file slots); pointing to a file ID can only be chosen by the user (mobile's invariants-test.tsx tests the AI path).
    const config = createDefaultWorkspace('zh');
    const ok = prepareOps(
      config,
      [
        {
          op: 'addContainer',
          page: 'home',
          block: { id: 'slot', look: 'entry', show: { title: '合同' }, opens: { file: null } },
        },
      ],
      ctx,
    );
    expect(ok.ok ? [] : ok.issues).toEqual([]);
  });

  // Founder 2026-10-31 (conversation): AI modifications are strictly prohibited from writing file references; file IDs are no longer sent to the AI.
  describe('only the user picks a file: AI changes never write a reference to one', () => {
    const A = 'useraaaa01';
    const B = 'userbbbb02';
    /** A file slot pointing to A on the home screen, an image pointing to B (with an image background), and the home screen background is also B. */
    function withFiles(): WorkspaceConfig {
      const r = applyOps(
        createDefaultWorkspace('zh'),
        [
          {
            op: 'addContainer',
            page: 'home',
            block: { id: 'slot', look: 'entry', show: { title: '合同' }, opens: { file: A } },
          },
          {
            op: 'addContainer',
            page: 'home',
            block: { id: 'pic', look: 'image', show: { asset: B, aspect: 'wide', fit: 'cover' } },
          },
          {
            op: 'updateContainer',
            page: 'home',
            changes: { backdrop: { overlay: 'medium', assetId: B } },
          },
        ],
        ctx,
      );
      if (!r.ok) throw new Error(r.error);
      return r.config;
    }
    const ai = { ...ctx, fromAI: true };

    it.each<[string, unknown[]]>([
      [
        'pointing a file slot at another file',
        [
          {
            op: 'updateContainer',
            page: 'home',
            block: 'slot',
            changes: { opens: { file: B } },
          },
        ],
      ],
      [
        'adding a file slot that already points at a file',
        [
          {
            op: 'addContainer',
            page: 'home',
            block: { id: 'slot2', look: 'entry', show: { title: 'x' }, opens: { file: A } },
          },
        ],
      ],
      [
        'adding an image of a user file',
        [
          {
            op: 'addContainer',
            page: 'home',
            block: { id: 'pic2', look: 'image', show: { asset: B, aspect: 'wide', fit: 'cover' } },
          },
        ],
      ],
      [
        'changing the photo of an image',
        [{ op: 'updateContainer', page: 'home', block: 'pic', changes: { show: { asset: A } } }],
      ],
      [
        'putting a user file behind a page',
        [
          {
            op: 'updateContainer',
            page: 'home',
            changes: { backdrop: { overlay: 'light', assetId: A } },
          },
        ],
      ],
    ])('%s is refused', (_name, ops) => {
      const r = prepareOps(withFiles(), ops, ai);
      expect(r.ok).toBe(false);
      // When the user selects files themselves in long-press edit, it goes through the same prepareOps (without fromAI) and can be saved normally.
      expect(prepareOps(withFiles(), ops, ctx).ok).toBe(true);
    });

    it('clearing a file slot and moving or restyling a block with a file still work', () => {
      const config = withFiles();
      for (const ops of [
        [
          {
            op: 'updateContainer',
            page: 'home',
            block: 'slot',
            changes: { opens: { file: null } },
          },
        ],
        [{ op: 'updateContainer', page: 'home', block: 'pic', changes: { show: { asset: null } } }],
        [{ op: 'updateContainer', page: 'home', changes: { backdrop: null } }],
        [
          {
            op: 'updateContainer',
            page: 'home',
            block: 'pic',
            changes: { show: { caption: '图' } },
          },
        ],
        [{ op: 'moveContainer', page: 'home', block: 'slot', toIndex: 0 }],
        [{ op: 'removeContainer', page: 'home', block: 'pic' }],
      ]) {
        const r = prepareOps(config, ops, ai);
        expect(r.ok ? [] : r.issues).toEqual([]);
      }
    });

    it('AI sees a placeholder instead of the file IDs, and handing the placeholder back keeps the file', () => {
      const config = withFiles();
      const sent = JSON.stringify(redactForAI(config, registry));
      expect(sent).not.toContain(A);
      expect(sent).not.toContain(B);
      expect(sent).toContain(REDACTED_FILE);
      const r = prepareOps(
        config,
        [
          {
            op: 'updateContainer',
            page: 'home',
            block: 'slot',
            changes: { opens: { file: REDACTED_FILE }, show: { title: '租房合同' } },
          },
        ],
        ai,
      );
      expect(r.ok ? [] : r.issues).toEqual([]);
      if (r.ok) expect(JSON.stringify(r.after)).toContain(A);
    });
  });
});

describe('Invariant 3: No file references in new settings (D-424)', () => {
  const page = (block: object) => ({
    op: 'addContainer' as const,
    page: { id: 'p', title: 'P', blocks: [block] },
  });
  const table = {
    op: 'addData' as const,
    table: { id: 't', name: 'T', fields: [{ id: 'a', name: 'A', type: 'text' as const }] },
  };

  it.each([
    [
      'single with a file',
      { id: 'x', look: 'single', source: { table: 't' }, show: { fields: ['a'], asset: 'f' } },
    ],
    [
      'single with opens',
      {
        id: 'x',
        look: 'single',
        source: { table: 't' },
        show: { fields: ['a'] },
        opens: { file: 'f' },
      },
    ],
    [
      'list browse with a file',
      {
        id: 'x',
        look: 'list',
        source: { table: 't' },
        show: { title: 'a', browse: { search: true, asset: 'f' } },
      },
    ],
    [
      'showIf with a file',
      { id: 'x', look: 'divider', showIf: { table: 't', has: 'some', asset: 'f' } },
    ],
  ])('%s is refused', (_name, block) => {
    expect(OpSchema.safeParse(page(block)).success).toBe(false);
    expect(prepareOps(createDefaultWorkspace('en'), [table, page(block) as never], ctx).ok).toBe(
      false,
    );
  });
});

describe('Invariants 2 / 3: Reports with attachments, AI can only toggle this parameter (D-425)', () => {
  const steps = (attachments: unknown) => [
    { id: 'a', action: 'in.records', params: { collectionId: 'notes', period: 'all' } },
    {
      id: 'b',
      action: 'print.records',
      params: { template: 'table', title: '', fields: [], pageSize: 'a4', attachments },
    },
  ];
  const params = () => registry.actions.get('print.records')!.params;

  it('the parameter is a yes or no: a file id, a path or a list cannot be written there', () => {
    expect(params().safeParse(steps(true)[1]!.params).success).toBe(true);
    for (const bad of ['asset01', 'file:///x.jpg', ['asset01'], { file: 'asset01' }, 1])
      expect(params().safeParse(steps(bad)[1]!.params).success).toBe(false);
  });

  it('what AI sees of the step is the switch, never a file', () => {
    const base = createDefaultWorkspace('en');
    const tool = { id: 'q', kind: 'quickAction', name: 'Q', steps: steps(true) };
    const config = { ...base, tools: [...base.tools, tool] } as WorkspaceConfig;
    const shown = JSON.stringify(redactForAI(config, registry).tools.find((x) => x.id === 'q'));
    expect(shown).toContain('"attachments":true');
    expect(shown).not.toMatch(/asset|file:/);
  });
});

describe('Invariant 4: Originals are never moved or deleted', () => {
  // File platform (expo-platform.ts) deletions and moves only touch the runtime directory and picker copies: tested in mobile's invariants-files-test.ts.
  it('the configuration can only point at a file by an opaque id; it has no place for a path or a content:// uri', () => {
    const config = createDefaultWorkspace('zh');
    for (const file of ['content://media/external/images/1', 'file:///DCIM/a.jpg', '/var/a.pdf']) {
      const r = prepareOps(
        config,
        [
          {
            op: 'addContainer',
            page: 'home',
            block: { id: 'slot', look: 'entry', show: { title: 'x' }, opens: { file } },
          },
        ],
        ctx,
      );
      expect(r.ok).toBe(false);
    }
  });
});

describe('Invariant 5: Changing the app never deletes data', () => {
  // Records reside in the database, not in the configuration: records remain intact after removeData and restoring old versions, see mobile's invariants-test.tsx.

  it('records have no place in the configuration: a table or a config carrying entries is rejected', () => {
    const config = createDefaultWorkspace('zh');
    expect(
      WorkspaceConfigSchema.safeParse({ ...config, records: [{ id: 'r', values: {} }] }).success,
    ).toBe(false);
    expect(
      CollectionSchema.safeParse({
        id: 't',
        name: 'T',
        fields: [{ id: 'a', name: 'A', type: 'text' }],
        records: [{ a: SENTINEL }],
      }).success,
    ).toBe(false);
  });

  it('no change AI can make deletes entries: removing a table or a field only changes the configuration', () => {
    // Records can only be deleted via permanent deletion manually triggered by the user in "Settings -> Data" and deletion on the record page (mobile).
    expect(OP_NAMES.filter((n) => /record|purge|clear|delete/i.test(n))).toEqual([]);
    const config = v34Fixture('tasks');
    const result = applyOps(config, [{ op: 'removeData', table: 'tasks' }], ctx);
    // The result of removing a table contains only the configuration (and notes for the draft), with no executions of deletion.
    if (result.ok) expect(Object.keys(result).sort()).toEqual(['config', 'notes', 'ok']);
  });
});

// ---------------------------------------------------------------------------------------------
// AI Permissions
// ---------------------------------------------------------------------------------------------

describe('Invariant 6: The AI only changes the app, not actions for the user (D-113)', () => {
  it('an AI reply is changes, "go back one version" or a refusal: there is no reply that runs a tool or answers', () => {
    for (const reply of [
      { kind: 'run', tool: 'pdf-merge' },
      { kind: 'answer', text: 'Dear …' },
      { kind: 'ops', ops: [{ op: 'runTool', tool: 'pdf-merge' }] },
      { kind: 'ops', ops: [{ op: 'addData', table: 't' }], answer: 'hi' },
    ])
      expect(PlanSchema.safeParse(reply).success).toBe(false);
  });

  it('the built-in AI turns down errands (write an email, summarize a file) and does nothing', async () => {
    const ai = createMockAIProvider();
    for (const input of ['帮我写一封请假邮件', '总结一下这个文件']) {
      const plan = await ai.plan(input, {
        config: createDefaultWorkspace('zh'),
        registry,
        locale: 'zh',
      });
      expect(plan.kind).toBe('reject');
    }
  });

  // D-422: AI can set a text field's format (configuration), but has no operations to make calls, send emails, or open links; taps are performed by the user on the record page.
  it("AI can set a text field's format, and no op dials, emails or opens a link", () => {
    const base = applyOps(
      createDefaultWorkspace('zh'),
      [
        {
          op: 'addData',
          table: { id: 'c', name: 'c', fields: [{ id: 'p', name: 'p', type: 'text' }] },
        },
      ],
      ctx,
    );
    if (!base.ok) throw new Error(base.error);
    const set: Op = { op: 'updateData', table: 'c', field: 'p', changes: { format: 'phone' } };
    expect(PlanSchema.safeParse({ kind: 'ops', ops: [set] }).success).toBe(true);
    expect(prepareOps(base.config, [set], { ...ctx, fromAI: true }).ok).toBe(true);
    for (const op of ['dial', 'call', 'openLink', 'openUrl', 'sendEmail', 'runTool'])
      expect(OpSchema.safeParse({ op, url: 'tel:123', field: 'p', table: 'c' }).success).toBe(
        false,
      );
    const ops = OpSchema.options.map((o) => o.shape.op.value as string);
    expect(ops.filter((o) => /dial|call|mail|link|url|open/i.test(o))).toEqual([]);
  });
});

describe('Invariant 7: Changes go into a draft first, take effect only when confirmed, and can be undone', () => {
  // Drafts, confirmation, undo, and change history are within the app (mobile's invariants-test.tsx, workspace-store-test.ts).
  it('an old version from the change history always opens again (every frozen config is a valid snapshot)', () => {
    for (const [name, config] of CONFIGS) {
      const r = prepareSnapshot(config, registry);
      expect({ name, issues: r.ok ? [] : r.issues }).toEqual({ name, issues: [] });
    }
  });
});

describe('Invariant 8: The AI cannot change the system layer', () => {
  it('Settings (with the AI page and the change history behind it) always stays reachable', () => {
    const config = createDefaultWorkspace('zh');
    for (const nav of [
      { bar: ['page:home', 'ai'], floating: [] },
      { bar: ['page:home'] },
      { floating: [] },
    ]) {
      const r = prepareOps(config, [{ op: 'updateContainer', nav }], ctx);
      // Either reject the change, or ensure "Settings" is placed back into the floating entry point.
      if (r.ok) expect([...r.after.nav.bar, ...r.after.nav.floating]).toContain('settings');
    }
    const without = { ...config, nav: { bar: ['page:home' as const], floating: [] } };
    expect(validateWorkspace(without, registry).ok).toBe(false);
  });

  it('there is no change that reaches the AI page, drafts, history, settings or permissions', () => {
    for (const op of [
      { op: 'updateContainer', page: 'settings', changes: { title: 'x' } },
      { op: 'removeContainer', page: 'ai' },
      { op: 'removeContainer', page: 'history' },
      { op: 'setSettings', ai: 'off' },
      { op: 'updateHistory', keep: 0 },
      { op: 'setPermission', camera: true },
      { op: 'savePreset', name: 'x' },
      { op: 'applyPreset', id: 'x' },
      { op: 'deletePreset', id: 'x' },
    ]) {
      const r = prepareOps(createDefaultWorkspace('zh'), [op], ctx);
      expect({ op, ok: r.ok }).toEqual({ op, ok: false });
    }
  });

  it('a theme that hides Settings (unreadable colors) is rejected', () => {
    const r = prepareOps(
      createDefaultWorkspace('zh'),
      [{ op: 'setTheme', colors: { background: '#ffffff', text: '#fefefe' } }],
      ctx,
    );
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

describe('Invariant 9: A tool cannot trigger a tool; no branches or loops', () => {
  // A step is a single catalog action with parameters: no conditions, jumps, loops, or chaining (relation-rules.test.ts "rule 13": reminders have no steps, done cannot reference tools, steps cannot be quick actions).
  it('a step is one catalog action with parameters: no condition, jump, loop or call', () => {
    for (const extra of [
      { if: { field: 'a', op: 'eq', value: 1 } },
      { goto: 's1' },
      { repeat: 3 },
      { forEach: 'files' },
      { then: 'other-quick-action' },
      { runs: 'pdf-merge' },
    ])
      expect(
        WorkflowStepSchema.safeParse({ id: 's', action: 'pdf.merge', params: {}, ...extra })
          .success,
      ).toBe(false);
  });

  it('a one-tap record tool is one of seven fixed kinds and cannot chain another tool', () => {
    for (const bad of [
      { do: 'run', table: 't', tool: 'x' },
      { do: 'create', table: 't', then: { do: 'set', table: 't', field: 'a', value: 1 } },
      // Deleting a punch-card cell (D-610) is also a single action and cannot be chained with anything else.
      { do: 'remove', table: 't', then: { do: 'create', table: 't' } },
      { do: 'remove', table: 't', tool: 'x' },
    ])
      expect(RecordToolSchema.safeParse(bad).success).toBe(false);
  });
});

describe("Invariant 10: Data leaves the app only by the user's own tap, every time", () => {
  // D-428 (superseding D-422's "not a step", decided by the founder in conversation on 2026-11-04):
  // making phone calls, sending SMS, sending emails, and opening websites are four steps that only
  // accept text provided by the container; block tools and reminders cannot run them, nor can
  // addresses be written in the configuration.
  it('only the four value steps open a link, and no block tool or reminder can run them', () => {
    const opening = [...registry.actions.values()].filter((a) => a.opensLink);
    expect(opening.map((a) => [a.id, a.opensLink, a.input, a.fields])).toEqual([
      ['out.call', 'phone', ['text'], []],
      ['out.message', 'message', ['text'], []],
      ['out.email', 'email', ['text'], []],
      ['out.website', 'url', ['text'], []],
    ]);
    const ids = [...registry.actions.keys()];
    expect(ids.filter((id) => /tel|mailto|dial|openurl|openlink/i.test(id))).toEqual([]);
    for (const { id: action } of opening) {
      expect(ToolUseSchema.safeParse({ as: 'button', label: 'x', action }).success).toBe(false);
      expect(
        ReminderSchema.safeParse({
          id: 'r',
          kind: 'reminder',
          title: 'x',
          enabled: true,
          when: { every: 'day', at: '09:00' },
          opens: 'page:home',
          steps: [{ id: 's', action, params: {} }],
        }).success,
      ).toBe(false);
    }
    // Action parameters also contain no addresses to open (even if present, they would not open: the next test demonstrates that only two places can invoke system opening).
    const params = [...registry.actions.values()].flatMap((a) =>
      a.fields
        .filter((f) => /^(tel|mailto|phone|email|url)$/i.test(f.key))
        .map((f) => `${a.id}.${f.key}`),
    );
    expect(params).toEqual([]);
  });

  // Only the record page, rich text, the presets page, the rescue page, and Settings link to
  // external sites.
  // The presets page (system layer, D-593) can also open a webpage: a fixed URL ("Build apps with
  // your AI" on the website), opened only upon user tap, carrying no data. The founder chose
  // "Allow, add to whitelist" in conversation on 2026-11-19 (D-596). Similarly, the "Check website
  // for new versions" on the startup fallback page (D-621) uses a fixed URL, opens only upon user
  // tap, and carries no data. So does Settings' privacy policy row (D-new-privacy-1): the founder
  // chose to add it to the whitelist in conversation on 2026-11-25.
  it('only the record page, rich text, the presets page, the rescue page and Settings can open something outside the app', () => {
    const openers = sourceFiles(join(REPO, 'apps', 'mobile', 'src'))
      .filter((path) => /\bLinking\.openURL\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO, path));
    expect(openers.sort()).toEqual([
      join('apps', 'mobile', 'src', 'app', 'presets.tsx'),
      join('apps', 'mobile', 'src', 'renderer', 'RichText.tsx'),
      join('apps', 'mobile', 'src', 'renderer', 'open-link.ts'),
      join('apps', 'mobile', 'src', 'rescue', 'actions.ts'),
      join('apps', 'mobile', 'src', 'shell', 'SettingsView.tsx'),
    ]);
  });

  // D-627: Preset and AI pages share the manual share trigger; system text sharing is used only
  // when native interfaces are absent. D-611: When handing over an app modification to another AI
  // app, the Expo Go fallback without native sharing sends text only (prompt and app files).
  // Sharing files and records uses quick action out.share and local modules, avoiding
  // react-native's Share. D-621: The startup rescue page passes error details (version number and
  // error text, visible to the user on the page first) to the system share sheet, letting the user
  // tap and choose a recipient; founder chose this approach on 2026-11-22, rejecting automatic
  // reporting.
  it('only the hand-off fallback and the rescue page hand text to the system share sheet', () => {
    const sharers = sourceFiles(join(REPO, 'apps', 'mobile', 'src'))
      .filter((path) => /\bShare\.share\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO, path));
    expect(sharers.sort()).toEqual([
      join('apps', 'mobile', 'src', 'rescue', 'actions.ts'),
      join('apps', 'mobile', 'src', 'runtime', 'expo-platform.ts'),
    ]);
  });

  // D-627: Only this shared function invokes the sharing platform, triggered exclusively by user clicks on the AI page or preset page buttons.
  it('only the explicit handoff helper hands structure to another AI app', () => {
    const callers = sourceFiles(join(REPO, 'apps', 'mobile', 'src'))
      .filter((path) => /\.shareWithAi\(|\.shareFilesWithText\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO, path));
    expect(callers.sort()).toEqual([
      join('apps', 'mobile', 'src', 'ai', 'useAiHandoff.ts'),
      join('apps', 'mobile', 'src', 'runtime', 'expo-platform.ts'),
    ]);
    const entries = sourceFiles(join(REPO, 'apps', 'mobile', 'src'))
      .filter((path) => /\buseAiHandoff\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO, path));
    expect(entries.sort()).toEqual([
      join('apps', 'mobile', 'src', 'ai', 'useAiHandoff.ts'),
      join('apps', 'mobile', 'src', 'app', 'presets.tsx'),
      join('apps', 'mobile', 'src', 'shell', 'ChangeScreen.tsx'),
    ]);
  });

  // D-423: Exporting to vCard is just a step in a quick action, producing a single file; leaving the app also requires out.share (quick actions run only upon user tap).
  it('records.toVCard is only a step: no block tool or reminder can run it', () => {
    const action = registry.actions.get('records.toVCard')!;
    expect(action.input).toEqual(['records']);
    expect(action.output).toBe('files');
    expect(ToolUseSchema.safeParse({ as: 'button', label: 'x', action: action.id }).success).toBe(
      false,
    );
    expect(
      ReminderSchema.safeParse({
        id: 'r',
        kind: 'reminder',
        title: 'x',
        enabled: true,
        when: { every: 'day', at: '09:00' },
        opens: 'page:home',
        steps: [{ id: 's', action: action.id, params: {} }],
      }).success,
    ).toBe(false);
  });

  it('in.records → records.toVCard → out.share is a straight chain the catalog accepts', () => {
    const wf: Workflow = {
      id: 'q',
      kind: 'quickAction',
      name: 'Q',
      steps: [
        { id: 'a', action: 'in.records', params: { collectionId: 't', period: 'all' } },
        { id: 'b', action: 'records.toVCard', params: {} },
        { id: 'c', action: 'out.share', params: {} },
      ],
    };
    expect(workflowProblems(wf, registry)).toEqual([]);
    expect(typesAlong(wf.steps, registry)).toEqual(['records', 'files', 'files']);
  });

  // D-427: Exporting to Excel, like vCard, is just a step, and leaving the app also requires out.share.
  it('records.toExcel is only a step: no block tool or reminder can run it', () => {
    const action = registry.actions.get('records.toExcel')!;
    expect(action.input).toEqual(['records']);
    expect(action.output).toBe('files');
    expect(ToolUseSchema.safeParse({ as: 'button', label: 'x', action: action.id }).success).toBe(
      false,
    );
    expect(
      ReminderSchema.safeParse({
        id: 'r',
        kind: 'reminder',
        title: 'x',
        enabled: true,
        when: { every: 'day', at: '09:00' },
        opens: 'page:home',
        steps: [{ id: 's', action: action.id, params: {} }],
      }).success,
    ).toBe(false);
  });

  it('in.records → records.toExcel → out.share is a straight chain the catalog accepts', () => {
    const wf: Workflow = {
      id: 'q',
      kind: 'quickAction',
      name: 'Q',
      steps: [
        { id: 'a', action: 'in.records', params: { collectionId: 't', period: 'all' } },
        { id: 'b', action: 'records.toExcel', params: {} },
        { id: 'c', action: 'out.share', params: {} },
      ],
    };
    expect(workflowProblems(wf, registry)).toEqual([]);
    expect(typesAlong(wf.steps, registry)).toEqual(['records', 'files', 'files']);
  });

  // D-428: Buttons on the record page run their tools only inside onPress, and "Share vCard" also goes through quick actions with no other path (tested by mobile upon tap).
  it('the entry page runs its tools only in the tap handler, with no way around the steps', () => {
    const text = readFileSync(
      join(REPO, 'apps', 'mobile', 'src', 'renderer', 'RecordActionRow.tsx'),
      'utf8',
    );
    expect(text).not.toMatch(/shareText|shareUris|Linking|useEffect/);
    expect(text.match(/\brun\(/g)).toHaveLength(1);
    expect(text).toMatch(/onPress=\{\(\) => void run\(/);
  });

  // Tools on containers cannot be run from anywhere else: reminders, home screen widgets, and regular buttons have no values to pass (D-428).
  describe('a quick action taking a handed value cannot be reached from a schedule or a shortcut', () => {
    const base = () => {
      const r = prepareOps(
        createDefaultWorkspace('en'),
        [
          {
            op: 'addData',
            table: { id: 'people', name: 'People', fields: [{ id: 'n', name: 'N', type: 'text' }] },
          },
          {
            op: 'addTool',
            tool: {
              id: 'send',
              kind: 'quickAction',
              name: 'Send',
              steps: [
                { id: 'a', action: 'records.toVCard', params: {} },
                { id: 'b', action: 'out.share', params: {} },
              ],
            },
          },
        ] as Op[],
        ctx,
      );
      if (!r.ok) throw new Error(r.issues.join());
      return r.after;
    };
    const refused = (ops: unknown[]) => prepareOps(base(), ops as Op[], ctx).ok;

    it('a reminder cannot open it', () => {
      expect(
        refused([
          {
            op: 'addTool',
            tool: {
              id: 'r',
              kind: 'reminder',
              title: 'x',
              enabled: true,
              when: { every: 'day', at: '09:00' },
              opens: 'tool:send',
            },
          },
        ]),
      ).toBe(false);
    });

    it('nor can a built-in one that dials', () => {
      expect(
        refused([
          {
            op: 'addTool',
            tool: {
              id: 'r',
              kind: 'reminder',
              title: 'x',
              enabled: true,
              when: { every: 'day', at: '09:00' },
              opens: 'tool:record-call',
            },
          },
        ]),
      ).toBe(false);
    });

    it('the phone home screen, an action block and a button cannot run it', () => {
      expect(refused([{ op: 'updateContainer', nav: { phoneHomeScreen: ['send'] } }])).toBe(false);
      expect(
        refused([
          {
            op: 'addContainer',
            page: 'home',
            index: 0,
            block: { id: 'x', look: 'action', tools: [{ tool: 'send' }] },
          },
        ]),
      ).toBe(false);
      expect(
        refused([
          {
            op: 'addContainer',
            page: 'home',
            index: 0,
            block: { id: 'x', look: 'button', show: { label: 'Go' }, opens: 'tool:send' },
          },
        ]),
      ).toBe(false);
    });
  });

  // relation-rules.test.ts "rule 14": Time-triggered tools only open, not run; sharing and exporting can only be quick action steps.
  it('a tool on a block cannot share, export or save to Files', () => {
    for (const action of ['out.share', 'out.saveToFolder', 'out.saveToPhotos', 'out.print'])
      expect(ToolUseSchema.safeParse({ as: 'button', label: 'x', action }).success).toBe(false);
  });

  it('a reminder cannot carry a step', () => {
    expect(
      ReminderSchema.safeParse({
        id: 'r',
        kind: 'reminder',
        title: 'x',
        enabled: true,
        when: { every: 'day', at: '09:00' },
        opens: 'page:home',
        steps: [{ id: 's', action: 'out.share', params: {} }],
      }).success,
    ).toBe(false);
  });
});

describe('Invariant 11: Every action that writes data can be taken back; an undo banner is shown only where one simple action cannot take it back (deletion, a tap that makes several changes at once, entries created in bulk, an imported batch); a bulk change must always ask first', () => {
  // Deletions pop an undo banner, and actions modifying multiple places pop an undo banner (D-566),
  // while other writes (forms, checkboxes, one-tap creation, incrementing, tapping circular blocks)
  // do not: mobile's invariants-test.tsx; setAll asks first and does not pop an undo banner after
  // completion: mobile's record-actions-test.tsx; modifying multiple places:
  // record-tap-also-test.tsx; dragging Kanban boards: tiles-board-test.tsx; home screen widgets:
  // widgets-journeys-test.tsx.
  it('asking before a bulk change does not promise an undo', () => {
    for (const text of [
      en.recordActionConfirm,
      enSingular.recordActionConfirm,
      zh.recordActionConfirm,
      fr.recordActionConfirm,
      frSingular.recordActionConfirm,
      // Bulk creation (D-567) also asks first, and does not mention undo when asking.
      en.recordCreateAllConfirm,
      enSingular.recordCreateAllConfirm,
      zh.recordCreateAllConfirm,
      fr.recordCreateAllConfirm,
      frSingular.recordCreateAllConfirm,
      // The phrase asked during check-and-create (D-616) is the picker button text.
      en.recordPickAddButton,
      enSingular.recordPickAddButton,
      zh.recordPickAddButton,
      fr.recordPickAddButton,
      frSingular.recordPickAddButton,
    ])
      expect(text).not.toMatch(/undo|撤销|annuler/i);
  });

  it('the picker’s button is the question of a pick (D-616): it says how many and into which table', () => {
    for (const text of [
      en.recordPickAddButton,
      enSingular.recordPickAddButton,
      zh.recordPickAddButton,
      fr.recordPickAddButton,
      frSingular.recordPickAddButton,
    ]) {
      expect(text).toContain('{n}');
      expect(text).toContain('{table}');
    }
  });

  it('a bulk change has no setting that skips asking first', () => {
    for (const base of [
      { do: 'setAll', table: 't', field: 'a', value: true },
      { do: 'createAll', table: 't', from: 's', values: {} },
      // Check-and-create (D-616): The picker button text "Add N items to B" is the initial prompt (founder, 2026-11-21), and there is similarly no config setting to skip it.
      { do: 'createAll', table: 't', from: 's', pick: true, values: {} },
    ]) {
      expect(RecordToolSchema.safeParse(base).success).toBe(true);
      for (const skip of [{ confirm: false }, { ask: false }, { ask: 'none' }, { silent: true }])
        expect(RecordToolSchema.safeParse({ ...base, ...skip }).success).toBe(false);
    }
  });

  it('a tap that makes several changes makes at most 3, all to this entry, and none of them asks or fans out', () => {
    const tap = {
      as: 'button',
      label: 'Ship',
      do: 'set',
      table: 't',
      field: 'a',
      value: true,
      also: [{ do: 'set', field: 'b', value: 'today' }],
    };
    expect(MAX_TAP_WRITES).toBe(3);
    expect(ToolUseSchema.safeParse(tap).success).toBe(true);
    for (const also of [
      [...tap.also, { do: 'toggle', field: 'c' }, { do: 'toggle', field: 'd' }],
      [{ do: 'setAll', field: 'b', value: true }],
      [{ do: 'set', table: 'other', field: 'b', value: true }],
      [{ do: 'create', table: 'x', values: {}, ask: 'all' }],
    ])
      expect(ToolUseSchema.safeParse({ ...tap, also }).success, JSON.stringify(also)).toBe(false);
    // The "Done" button on reminder notifications has nowhere to pop an undo banner: it modifies at most a single place.
    const { as: _as, label: _label, also, ...done } = tap;
    expect(RecordToolSchema.safeParse(done).success).toBe(true);
    expect(RecordToolSchema.safeParse({ ...done, also }).success).toBe(false);
  });

  // Checklist check with also (D-617): Checking sets one or two fields on this entry, and
  // unchecking clears them, so unchecking reverses everything done by checking and does not pop an
  // undo banner; an undo banner pops only when checking overwrites a previously existing value
  // (since unchecking cannot restore that value). Opening and undo are tested in mobile's
  // invariants-test.tsx and check-latest-empty-test.tsx.
  it('a check that also records something makes at most 3 changes, all set on this entry, and unticking clears them', () => {
    const tick = {
      as: 'check',
      do: 'toggle',
      table: 'tasks',
      field: 'done',
      also: [{ do: 'set', field: 'completed', value: 'today' }],
    };
    expect(ToolUseSchema.safeParse(tick).success).toBe(true);
    for (const also of [
      [...tick.also, { do: 'set', field: 'b', value: 1 }, { do: 'set', field: 'c', value: 2 }],
      [{ do: 'set', table: 'other', field: 'b', value: true }],
      [{ do: 'setAll', field: 'b', value: true }],
    ])
      expect(ToolUseSchema.safeParse({ ...tick, also }).success, JSON.stringify(also)).toBe(false);
    // No settings to skip anything (no prompting, no undo banner, no clearing).
    for (const skip of [{ undo: false }, { quiet: true }, { keep: true }, { clear: false }])
      expect(ToolUseSchema.safeParse({ ...tick, ...skip }).success).toBe(false);
    const config = createDefaultWorkspace('en');
    config.data.tables.push(
      {
        id: 'tasks',
        name: 'Tasks',
        fields: [
          { id: 'title', name: 'Task', type: 'text' },
          { id: 'done', name: 'Done', type: 'checkbox' },
          { id: 'completed', name: 'Completed', type: 'date' },
        ],
      },
      {
        id: 'logs',
        name: 'Logs',
        fields: [
          { id: 'task', name: 'Task', type: 'link', table: 'tasks' },
          { id: 'on', name: 'On', type: 'date' },
        ],
      },
    );
    const on = (check: object) => {
      const copy = structuredClone(config);
      copy.containers.pages[0]!.blocks.push({
        id: 'c',
        look: 'checklist',
        source: { table: 'tasks', limit: 30 },
        show: { title: 'title' },
        tools: [check],
      } as never);
      const r = validateWorkspace(copy, registry);
      return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
    };
    expect(on(tick)).toBe('');
    // Creating an entry (in another table) and checking clears it: unchecking cannot restore it, so reject.
    expect(
      on({ ...tick, also: [{ do: 'create', table: 'logs', values: { task: '$row' } }] }),
    ).not.toBe('');
    expect(on({ ...tick, also: [{ do: 'set', field: 'completed', value: null }] })).not.toBe('');
    const use = tick as unknown as RecordToolUse;
    const table = config.data.tables.find((t) => t.id === 'tasks')!;
    const now = new Date(2026, 10, 18, 9);
    const before = { title: 'A', done: false };
    const ticked = prepareRecordValues(
      table,
      checkInput(use, table, before, { now })!,
      before,
      now,
    );
    expect(ticked.ok && ticked.values).toEqual({ title: 'A', done: true, completed: '2026-11-18' });
    const after = ticked.ok ? ticked.values : {};
    expect(checkOverwrites(use, before, after)).toBe(false);
    const back = prepareRecordValues(table, checkInput(use, table, after, { now })!, after, now);
    expect(back.ok && back.values).toEqual(before);
    // Checking overwrote the original date: this time unchecking cannot restore it, so the app pops an undo banner.
    expect(checkOverwrites(use, { ...before, completed: '2026-01-05' }, after)).toBe(true);
  });

  // Importing from a table file (D-574, founder decision ⑦ on 2026-11-16): System layer, first
  // provides a summary, writes only after the user taps "Import", and pops an undo banner after
  // completion (mobile's import-records-test.tsx, invariants-test.tsx).
  it('asking before an import does not promise an undo, and the import has fixed caps it never passes in part', () => {
    for (const text of [
      en.importSummary,
      enSingular.importSummary,
      zh.importSummary,
      fr.importSummary,
      frSingular.importSummary,
      en.importConfirm,
      zh.importConfirm,
      fr.importConfirm,
    ])
      expect(text).not.toMatch(/undo|撤销|annuler/i);
    expect(IMPORT_LIMITS.maxRows).toBe(2000);
    expect(importLimitProblem(2001, 1, 0)).not.toBeNull();
    expect(importLimitProblem(10, 10, 9995)).not.toBeNull();
  });

  it('importing is not something a tool or the AI can do: no record tool imports a file', () => {
    for (const kind of ['import', 'importFile', 'importRows'])
      expect(RecordToolSchema.safeParse({ do: kind, table: 't' }).success).toBe(false);
  });

  // Check-in grid (D-610): Tapping a single-item grid cell moves it to "Recently Deleted" with an
  // undo button on the toast (mobile's grid-test.tsx, invariants-test.tsx); creating inside a cell
  // does not pop an undo banner (tapping again deletes it). This controls structure: deletes at
  // most one item per grid cell at a time, without filters, counts, or settings to skip undo;
  // restricted to taps on the check-in grid (individual item buttons, button blocks, and reminder
  // completion are excluded; grid-look.test.ts).
  it('removing from a grid is one entry, with no setting that skips the undo, and only on a grid', () => {
    expect(RecordToolSchema.safeParse({ do: 'remove', table: 't' }).success).toBe(true);
    for (const extra of [
      { filter: [] },
      { max: 10 },
      { undo: false },
      { quiet: true },
      { all: true },
    ])
      expect(
        ToolUseSchema.safeParse({ as: 'tap', do: 'remove', table: 't', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    const config = createDefaultWorkspace('en');
    config.data.tables.push({
      id: 'logs',
      name: 'Logs',
      fields: [
        { id: 'kind', name: 'Kind', type: 'choice', options: [{ id: 'a', label: 'A' }] },
        { id: 'day', name: 'Day', type: 'date' },
      ],
    });
    const on = (block: object) => {
      const copy = structuredClone(config);
      copy.containers.pages[0]!.blocks.push(block as never);
      const r = validateWorkspace(copy, registry);
      return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
    };
    const remove = { as: 'tap', do: 'remove', table: 'logs' };
    expect(
      on({
        id: 'g',
        look: 'grid',
        source: { table: 'logs', limit: 30, group: { by: 'kind' }, across: { unit: 'day' } },
        show: { title: 'kind' },
        tools: [remove],
      }),
    ).toBe('');
    expect(
      on({
        id: 'l',
        look: 'list',
        source: { table: 'logs', limit: 30 },
        show: { title: 'kind' },
        tools: [{ ...remove, as: 'button', label: 'Delete' }],
      }),
    ).toMatch(/remove/);
  });

  it('setAll is capped at 200 entries', () => {
    const set = (n: number) =>
      RecordToolSchema.safeParse({ do: 'setAll', table: 't', field: 'a', value: true, max: n });
    // The upper limit is a constant, and no other number can be written in the config. Bulk creation is the same (D-567).
    expect(MAX_SET_ALL).toBe(200);
    expect(set(1000).success).toBe(false);
    expect(MAX_CREATE_ALL).toBe(200);
    expect(
      RecordToolSchema.safeParse({ do: 'createAll', table: 't', from: 's', values: {}, max: 1000 })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------------------------

describe('Invariant 12: Old data always opens', () => {
  it('a print.records step saved before D-425 is still valid, with no attachments', () => {
    const params = { template: 'table', title: 'T', fields: [], pageSize: 'a4' };
    expect(registry.actions.get('print.records')!.params.safeParse(params).success).toBe(true);
    const old = v33Fixture('sample-expense-helper-zh') as never;
    const r = prepareSnapshot(old, registry);
    expect(r.ok ? [] : r.issues).toEqual([]);
    const opened = fromV33(old);
    expect(JSON.stringify(opened.tools)).not.toContain('"attachments"');
  });

  // Migrations lose nothing: migrate-v34.test.ts (all frozen config IDs present, M1-M8),
  // v34-equivalence.test.ts (data calculated before and after migration is identical),
  // migrate.test.ts (every step). This upgrades each frozen old config from scratch to the present.
  it.each(V33_NAMES)('frozen v33 config %s opens as a valid current config', (name) => {
    const r = prepareSnapshot(v33Fixture(name), registry);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it.each([
    ['V4_DEFAULT_MERGE', V4_DEFAULT_MERGE],
    ['V4_FIXED_NAME', V4_FIXED_NAME],
    ['V4_CUSTOM_ASK', V4_CUSTOM_ASK],
  ])('the real v4 snapshot %s opens as a valid current config', (_name, raw) => {
    const r = prepareSnapshot(raw, registry);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it('migrating a current config changes nothing', () => {
    for (const [, config] of CONFIGS) {
      const r = migrateWorkspace(structuredClone(config));
      expect(r.ok && r.config).toEqual(config);
    }
    // D-607: Single-select gains multiple, upgrading to version 40 (version bump only).
    expect(CURRENT_SCHEMA_VERSION).toBe(40);
  });

  // D-424: showIf, browse, and single are new optional values; old configs without them remain unchanged down to the letter, and schemaVersion is unchanged.
  it('old configs have no showIf or browse and load exactly as they were', () => {
    for (const [, config] of CONFIGS) {
      const text = JSON.stringify(config);
      expect(text).not.toMatch(/"showIf"|"browse"|"look":"single"/);
      const r = prepareSnapshot(structuredClone(config), registry);
      expect(r.ok && r.after).toEqual(config);
    }
  });

  // D-422: format is optional; old configs lack it, read back completely unchanged down to the letter, and text values read identically.
  it('an old config with no format loads unchanged and its text values read the same', () => {
    const table = {
      id: 'c',
      name: 'c',
      fields: [{ id: 'p', name: '电话', type: 'text', required: true }],
    };
    const base = createDefaultWorkspace('zh');
    const old = {
      ...structuredClone(base),
      schemaVersion: 36,
      data: { ...base.data, tables: [table] },
    };
    const r = prepareSnapshot(old, registry);
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (!r.ok) return;
    const loaded = r.after.data.tables[0]!;
    expect(loaded).toEqual(table);
    const f = loaded.fields[0]!;
    expect(fieldLink(f, '+33 6 12 34 56 78')).toBeNull();
    expect(fieldDefinition(f.type).read(f as never, '+33 6 12')).toBe('+33 6 12');
    expect(fieldDefinition(f.type).format(f as never, '+33 6 12', 'zh')).toBe('+33 6 12');
  });
});

describe('Invariant 13: Works without a network', () => {
  // The core and planner packages call the network exclusively to reach the AI: the checklist tests
  // for "Invariant 1" above. Offline behaviors for native modules (ML Kit, translation, speech) can
  // only be tested on real devices, see INVARIANTS_AUDIT.md.
  it('the core and planner packages call the network only to reach the AI', () => {
    const files = [
      ...sourceFiles(join(REPO, 'packages', 'core', 'src')),
      ...sourceFiles(join(REPO, 'packages', 'planner', 'src')),
    ].filter((f) => /\bfetch\(|fetchImpl\(/.test(readFileSync(f, 'utf8')));
    expect(files.map((f) => relative(REPO, f).split('\\').join('/')).sort()).toEqual([
      'packages/planner/src/http.ts',
      'packages/planner/src/openai.ts',
      'packages/planner/src/relay.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Between containers, tools, and data
// ---------------------------------------------------------------------------------------------

describe('Invariant 14: There is only one copy of the data, and it lives only in the data', () => {
  it('a computed field has no stored value', () => {
    const table = (field: object) => ({
      id: 't',
      name: 'T',
      fields: [{ id: 'n', name: 'N', type: 'number' }, field],
    });
    const formula = { id: 'f', name: 'F', type: 'formula', expression: '{n} * 2' };
    expect(CollectionSchema.safeParse(table(formula)).success).toBe(true);
    expect(CollectionSchema.safeParse(table({ ...formula, value: 4 })).success).toBe(false);
    expect(CollectionSchema.safeParse(table({ ...formula, values: [4] })).success).toBe(false);
    // Empty numbers evaluating to zero (D-619) is a fixed term with nowhere to store values; calculated values are similarly not stored.
    expect(CollectionSchema.safeParse(table({ ...formula, empty: 'zero' })).success).toBe(true);
    for (const empty of [0, 4, 'four', { value: 4 }])
      expect(CollectionSchema.safeParse(table({ ...formula, empty })).success).toBe(false);
    const t = CollectionSchema.parse(table({ ...formula, empty: 'zero' }));
    const saved = prepareRecordValues(t, { f: 8 }, null, new Date());
    expect(saved.ok && saved.values).toEqual({});
  });

  it('the latest number of a number block is read from the entries, never kept (D-618)', () => {
    const source = { table: 't', aggregate: 'latest', field: 'kg' };
    expect(NumberSourceSchema.safeParse(source).success).toBe(true);
    for (const extra of [{ value: 71.8 }, { latest: 71.8 }, { cached: 71.8 }])
      expect(NumberSourceSchema.safeParse({ ...source, ...extra }).success).toBe(false);
  });
});

describe('Invariant 14: No business card content in the config (D-423)', () => {
  const single = (show: object) => ({ id: 'x', look: 'single', source: { table: 't' }, show });

  it('a single block holds only a table and field ids; a QR code or values do not fit', () => {
    for (const extra of [
      { vcard: 'BEGIN:VCARD' },
      { qrImage: 'data:' },
      { values: { a: SENTINEL } },
    ])
      expect(
        OpSchema.safeParse({
          op: 'addContainer',
          page: 'home',
          block: single({ fields: ['a'], ...extra }),
        }).success,
      ).toBe(false);
    expect(
      OpSchema.safeParse({
        op: 'addContainer',
        page: 'home',
        block: { ...single({ fields: ['a'] }), record: 'r1' },
      }).success,
    ).toBe(false);
  });

  it('search text and the chosen sort or group have no place in browse', () => {
    for (const extra of [{ query: 'x' }, { current: 'name' }, { selected: 'name' }])
      expect(
        OpSchema.safeParse({
          op: 'addContainer',
          page: 'home',
          block: {
            id: 'x',
            look: 'list',
            source: { table: 't' },
            show: { title: 'a', browse: { search: true, ...extra } },
          },
        }).success,
      ).toBe(false);
  });

  it('the business card sample carries no entries or card text in its config', () => {
    const base = createStarterWorkspace('en', registry);
    const result = sampleOps('business-cards', base, 'en');
    if (!result.ok) throw new Error(result.message);
    const r = prepareOps(base, result.ops, ctx);
    if (!r.ok) throw new Error(r.issues.join());
    expect(JSON.stringify(r.after)).not.toMatch(/BEGIN:VCARD|data:image|"values":\{/);
  });
});

describe('Invariant 15: Looking never changes anything', () => {
  // Reading data is a pure function of configuration and entries: zero database writes when rendering templates and sample pages (mobile's invariants-test.tsx).
  it('reading data is a pure function of the configuration and the entries', () => {
    // source.ts reading does not accept write callbacks; this checks that its exported read
    // functions do not accept a repo (static check). The rows, columns, cell counts, and pagination
    // of check-in grids (D-610) work the same way (grid-view.ts).
    for (const file of ['source.ts', 'grid-view.ts']) {
      const text = readFileSync(join(__dirname, file), 'utf8');
      expect(text).not.toMatch(/insertRecord|updateRecord|deleteRecord|setMeta|commitRevision/);
    }
  });

  it('the latest number (D-618) and a formula with empty "zero" (D-619) change nothing when read', () => {
    const config = createDefaultWorkspace('en');
    const table = CollectionSchema.parse({
      id: 'w',
      name: 'W',
      fields: [
        { id: 'date', name: 'Date', type: 'date' },
        { id: 'kg', name: 'Kg', type: 'number' },
        { id: 'plus', name: 'Plus', type: 'number' },
        { id: 'f', name: 'F', type: 'formula', expression: '{kg} + {plus}', empty: 'zero' },
      ],
    });
    config.data.tables.push(table);
    const entries: DataRecord[] = [
      {
        id: 'a',
        collectionId: 'w',
        values: { date: '2026-11-01', kg: 72 },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'b',
        collectionId: 'w',
        values: { date: '2026-11-10', kg: 71 },
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    const frozen = structuredClone(entries);
    const configBefore = structuredClone(config);
    const now = new Date(2026, 10, 18);
    const read = () =>
      readNumber(
        { table: 'w', aggregate: 'latest', field: 'kg' },
        { config, records: new Map([['w', entries]]), now, locale: 'en' },
      )?.value;
    expect(read()).toBe(71);
    expect(read()).toBe(71);
    expect(entries.map((r) => recordValue(r, table, 'f', now))).toEqual([72, 71]);
    expect(entries).toEqual(frozen);
    expect(config).toEqual(configBefore);
  });
});

describe('Invariant 16: Every write comes from one user action', () => {
  // The code scheduling reminders only triggers notifications without background writes:
  // relation-rules.test.ts "rule 13" (reminders have no steps); zero writes during startup,
  // rendering, and reminder scheduling (mobile's invariants-test.tsx).
  it('the code that schedules reminders cannot write entries', () => {
    const text = readFileSync(join(__dirname, 'reminders.ts'), 'utf8');
    expect(text).not.toMatch(/insertRecord|updateRecord|deleteRecord/);
  });
});

describe('Invariant 17: Check-in grid only modifies the table it displays (D-610)', () => {
  it('a grid tap adds to or removes from the table the grid reads, never another one', () => {
    const config = createDefaultWorkspace('en');
    config.data.tables.push(
      { id: 'habits', name: 'Habits', fields: [{ id: 'name', name: 'Name', type: 'text' }] },
      {
        id: 'logs',
        name: 'Logs',
        fields: [
          { id: 'habit', name: 'Habit', type: 'link', table: 'habits' },
          { id: 'day', name: 'Day', type: 'date' },
        ],
      },
    );
    const grid = (tools: object[]) => {
      const copy = structuredClone(config);
      copy.containers.pages[0]!.blocks.push({
        id: 'g',
        look: 'grid',
        source: { table: 'logs', limit: 30, group: { by: 'habit' }, across: { unit: 'day' } },
        show: { title: 'habit' },
        tools,
      } as never);
      const r = validateWorkspace(copy, registry);
      return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
    };
    expect(
      grid([
        { as: 'tap', do: 'create', table: 'logs', values: '$here' },
        { as: 'tap', do: 'remove', table: 'logs' },
      ]),
    ).toBe('');
    expect(grid([{ as: 'tap', do: 'remove', table: 'habits' }])).toMatch(/table must be logs/);
    expect(grid([{ as: 'tap', do: 'create', table: 'habits', values: '$here' }])).not.toBe('');
  });
});

describe("Invariants 9 / 17 / 18: Checkbox creation is only below the list and writes only to the list's table (D-616)", () => {
  const config = createDefaultWorkspace('en');
  config.data.tables.push(
    { id: 'recipes', name: 'Recipes', fields: [{ id: 'name', name: 'Name', type: 'text' }] },
    { id: 'foods', name: 'Foods', fields: [{ id: 'name', name: 'Name', type: 'text' }] },
    {
      id: 'uses',
      name: 'Uses',
      fields: [
        { id: 'recipe', name: 'Recipe', type: 'link', table: 'recipes' },
        { id: 'food', name: 'Food', type: 'link', table: 'foods' },
        { id: 'amount', name: 'Amount', type: 'number' },
      ],
    },
  );
  config.containers.pages.push({ id: 'recipe', title: 'Recipe', of: 'recipes', blocks: [] });
  const pick = {
    as: 'addHere',
    do: 'createAll',
    table: 'uses',
    from: 'foods',
    pick: true,
    values: { food: '$row' },
  };
  const list = (tool: object) => ({
    id: 'l',
    look: 'list',
    source: {
      table: 'uses',
      filter: [{ field: 'recipe', op: 'is', value: '$record' }],
      limit: 30,
    },
    show: { title: 'amount' },
    tools: [tool],
  });
  const check = (block: object) => {
    const copy = structuredClone(config);
    copy.containers.pages.find((p) => p.id === 'recipe')!.blocks.push(block as never);
    const r = validateWorkspace(copy, registry);
    return r.ok ? '' : r.issues.map((i) => i.message).join('\n');
  };

  it('writes only the table of the list it sits under (invariant 17)', () => {
    expect(check(list(pick))).toBe('');
    expect(check(list({ ...pick, table: 'foods', values: {} }))).toMatch(/table must be uses/);
    expect(check(list({ ...pick, table: 'recipes', values: {} }))).toMatch(/table must be uses/);
  });

  it('is a plain key, with no steps, branches or tool to trigger (invariant 9)', () => {
    for (const extra of [{ tool: 'x' }, { steps: [] }, { then: {} }, { pick: 'all' }])
      expect(check(list({ ...pick, ...extra }))).not.toBe('');
  });

  it('deleting the picked table cleans the Add up, the list stays (invariant 18)', () => {
    const copy = structuredClone(config);
    copy.containers.pages.find((p) => p.id === 'recipe')!.blocks.push(list(pick) as never);
    const r = prepareOps(
      copy,
      [
        { op: 'removeData', table: 'uses', field: 'food' },
        { op: 'removeData', table: 'foods' },
      ] as never,
      { registry, locale: 'en', now: new Date() },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = r.after.containers.pages
      .find((p) => p.id === 'recipe')!
      .blocks.find((b) => b.id === 'l') as { tools?: unknown[] } | undefined;
    expect(block?.tools ?? []).toEqual([]);
    expect(validateWorkspace(r.after, registry).ok).toBe(true);
  });
});

describe('Invariant 17: What the user sees is what gets changed (Relation Rule 12)', () => {
  // record-ops.test.ts "relation rule 12": Tools on blocks write only to the table read by the
  // block, or to the single record reached via $row / $record relations; relation-rules.test.ts:
  // reminder done writes only to this entry. mobile's record-actions-test.tsx tests which table is
  // written during execution.
  it('every one-tap tool in every frozen config writes a table the block reads, or a table linked back to it', () => {
    for (const [name, config] of CONFIGS) {
      const r = validateWorkspace(config, registry);
      expect({ name, issues: r.ok ? [] : r.issues.map((i) => i.message) }).toEqual({
        name,
        issues: [],
      });
    }
  });
});

// ---- Used by Invariant 18: Independent reference checks not relying on validation ----

type Json = Record<string, unknown>;

/** References in the config pointing to non-existent tables, fields, tools, pages, or packs. */
function danglingRefs(config: WorkspaceConfig): string[] {
  const tables = new Map(config.data.tables.map((t) => [t.id, new Set(t.fields.map((f) => f.id))]));
  const pages = new Set(config.containers.pages.map((p) => p.id));
  const tools = new Set(config.tools.map((t) => t.id));
  // Built-in quick actions (D-236, runnable without adding) and the two pickers are also referenceable tools.
  const toolOk = (id: string) =>
    tools.has(id) || presetById(id) !== undefined || (PICK_TOOLS as readonly string[]).includes(id);
  const packages = new Set(config.packages.map((p) => p.id));
  const out: string[] = [];
  const tableOk = (id: string) => id === '$files' || tables.has(id);
  const target = (s: string, at: string) => {
    const m = /^(page|tool|package):(.+)$/.exec(s);
    if (!m) return;
    const [, kind, id] = m;
    const ok = kind === 'page' ? pages.has(id!) : kind === 'tool' ? toolOk(id!) : packages.has(id!);
    if (!ok) out.push(`${at}: ${s}`);
  };
  const walk = (v: unknown, at: string) => {
    if (typeof v === 'string') return target(v, at);
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (!v || typeof v !== 'object') return;
    const o = v as Json;
    if (typeof o.table === 'string' && !tableOk(o.table)) out.push(`${at}.table: ${o.table}`);
    if (typeof o.table === 'string' && tables.has(o.table)) {
      const fields = tables.get(o.table)!;
      for (const key of ['field', 'via'])
        if (
          typeof o[key] === 'string' &&
          !fields.has(o[key]) &&
          !/^(createdAt|updatedAt|name|size)$/.test(o[key])
        )
          out.push(`${at}.${key}: ${o.table}.${o[key]}`);
    }

    if (typeof o.look === 'string' && o.source && typeof o.source === 'object') {
      const source = o.source as Json,
        show = (o.show ?? {}) as Json;
      const fields = typeof source.table === 'string' ? tables.get(source.table) : undefined;
      const check = (id: unknown) => {
        if (
          typeof id === 'string' &&
          fields &&
          !fields.has(id) &&
          !['createdAt', 'updatedAt'].includes(id)
        )
          out.push(`${at}: ${id}`);
      };
      check((source.split as Json | undefined)?.by);
      check((source.group as Json | undefined)?.until);
      check((show.day as Json | undefined)?.field);
      for (const total of ((source.calc as Json | undefined)?.with ?? []) as Json[]) {
        const own = typeof total.table === 'string' ? tables.get(total.table) : undefined;
        for (const f of [
          total.field,
          (total.days as Json | undefined)?.date,
          ...((total.filter ?? []) as Json[]).map((c) => c.field),
        ])
          if (
            typeof f === 'string' &&
            own &&
            !own.has(f) &&
            !['createdAt', 'updatedAt'].includes(f)
          )
            out.push(`${at}.calc: ${f}`);
      }
    }
    // recordRow on tables (D-428): Fields belong to this table.
    if (Array.isArray(o.recordRow) && Array.isArray(o.fields)) {
      const own = new Set((o.fields as Json[]).map((f) => f.id));
      for (const item of o.recordRow as Json[])
        if (item.field !== undefined && !own.has(item.field))
          out.push(`${at}.recordRow: ${String(item.field)}`);
    }
    if (typeof o.of === 'string' && !tables.has(o.of)) out.push(`${at}.of: ${o.of}`);
    // A block referencing a quick action: {tool: "<id>"} (not a reminder-kind definition).
    if (typeof o.tool === 'string' && !('kind' in o) && !toolOk(o.tool))
      out.push(`${at}.tool: ${o.tool}`);
    for (const [k, x] of Object.entries(o)) walk(x, `${at}.${k}`);
  };
  walk(config.containers, 'containers');
  walk(config.nav, 'nav');
  walk(config.tools, 'tools');
  walk(config.data, 'data');
  for (const id of config.nav.phoneHomeScreen ?? [])
    if (!tools.has(id)) out.push(`nav.phoneHomeScreen: ${id}`);
  // File desk toolbar: Quick action IDs (excluding reminders) and catalog actions.
  for (const [kind, groups] of Object.entries(config.containers.desk?.tools ?? {}))
    for (const item of (groups ?? []).flatMap((g) => g.items)) {
      if (typeof item === 'string') {
        const reminder = config.tools.some((t) => t.id === item && t.kind === 'reminder');
        if (reminder || !toolOk(item)) out.push(`containers.desk.tools.${kind}: ${item}`);
      } else if (!registry.actions.has(item.action))
        out.push(`containers.desk.tools.${kind}: ${item.action}`);
    }
  // Quick action steps: tables in parameters (collectionId), and fields listed for PDF generation from records (belonging to the table read previously).
  for (const wf of config.tools) {
    if (wf.kind !== 'quickAction') continue;
    let read: string | null = null;
    for (const step of wf.steps) {
      const at = `tools.${wf.id}.${step.id}`;
      const table = step.params.collectionId;
      if (typeof table === 'string' && !tables.has(table)) out.push(`${at}.collectionId: ${table}`);
      if (step.action === 'in.records') read = typeof table === 'string' ? table : null;
      if (Array.isArray(step.params.fields) && read && tables.has(read))
        for (const f of step.params.fields as string[])
          if (!tables.get(read)!.has(f) && !/^(createdAt|updatedAt)$/.test(f))
            out.push(`${at}.fields: ${read}.${f}`);
    }
  }
  return out;
}

/** Deletion operations for each deletable item type in a config. */
function removals(config: WorkspaceConfig): Op[] {
  const ops: Op[] = [];
  for (const t of config.data.tables) {
    ops.push({ op: 'removeData', table: t.id });
    for (const f of t.fields) ops.push({ op: 'removeData', table: t.id, field: f.id });
  }
  for (const p of config.containers.pages) {
    ops.push({ op: 'removeContainer', page: p.id });
    for (const c of allComponents(p)) ops.push({ op: 'removeContainer', page: p.id, block: c.id });
  }
  for (const t of config.tools) {
    ops.push({ op: 'removeTool', tool: t.id });
    if (t.kind === 'quickAction')
      for (const s of t.steps) ops.push({ op: 'removeTool', tool: t.id, step: s.id });
  }
  for (const p of config.packages) ops.push({ op: 'setPackage', package: p.id, do: 'remove' });
  return ops;
}

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let h = seed >>> 0 || 1;
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
}

describe('Invariant 18: Delete tables and fields referenced by new settings (D-424)', () => {
  const sample = () => {
    const base = createStarterWorkspace('en', registry);
    const result = sampleOps('business-cards', base, 'en');
    if (!result.ok) throw new Error(result.message);
    const r = prepareOps(base, result.ops, ctx);
    if (!r.ok) throw new Error(r.issues.join());
    return r.after;
  };

  it('a field the list also shows as a subtitle is refused as before; the app says which', () => {
    const r = prepareOps(
      sample(),
      [{ op: 'removeData', table: 'contacts', field: 'company' }],
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/subtitleField company/);
  });

  it.each(['contacts', 'my-card'])('removing table %s leaves nothing dangling', (table) => {
    const r = prepareOps(sample(), [{ op: 'removeData', table }], ctx);
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (!r.ok) return;
    expect(danglingRefs(r.after)).toEqual([]);
    expect(JSON.stringify(r.after.containers)).not.toContain(`"table":"${table}"`);
  });

  it.each([
    ['contacts', 'note'],
    ['my-card', 'phone'],
  ])('removing field %s.%s leaves nothing dangling', (table, field) => {
    const r = prepareOps(sample(), [{ op: 'removeData', table, field }], ctx);
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (!r.ok) return;
    expect(danglingRefs(r.after)).toEqual([]);
    const blocks = r.after.containers.pages.flatMap(allComponents);
    for (const b of blocks) {
      const show = (
        b as { show?: { fields?: string[]; browse?: { sort?: string[]; group?: string[] } } }
      ).show;
      expect([
        ...(show?.fields ?? []),
        ...(show?.browse?.sort ?? []),
        ...(show?.browse?.group ?? []),
      ]).not.toContain(field);
    }
  });
});

describe('Invariant 18: The config is always self-consistent', () => {
  it('new summary references are cleaned up or their deletion is refused', () => {
    const initial = createDefaultWorkspace('en');
    const table = (id: string): Collection => ({
      id,
      name: id,
      fields: [
        { id: 'n', name: 'N', type: 'number' },
        { id: 'date', name: 'Date', type: 'date' },
        { id: 'end', name: 'End', type: 'date' },
        { id: 'cat', name: 'Cat', type: 'choice', options: [{ id: 'one', label: 'One' }] },
      ],
    });
    const blocks = [
      {
        id: 'calc',
        look: 'number',
        show: { label: 'Ratio' },
        source: {
          table: 'a',
          aggregate: 'sum',
          field: 'n',
          calc: {
            with: [
              {
                id: 'other',
                table: 'b',
                aggregate: 'latest',
                field: 'n',
                days: { date: 'date' },
                filter: [{ field: 'cat', op: 'is', value: 'one' }],
              },
            ],
            formula: '{total} / {other}',
          },
        },
      },
      {
        id: 'split',
        look: 'chart',
        show: { title: 'Split', kind: 'bar' },
        source: {
          table: 'a',
          aggregate: 'count',
          group: { unit: 'day', by: 'date' },
          split: { by: 'cat' },
        },
      },
      {
        id: 'span',
        look: 'calendar',
        show: { title: 'date', day: { aggregate: 'count' } },
        source: { table: 'a', limit: 30, group: { unit: 'day', by: 'date', until: 'end' } },
      },
      {
        id: 'sum',
        look: 'calendar',
        show: { title: 'date', day: { aggregate: 'sum', field: 'n' } },
        source: { table: 'a', limit: 30, group: { unit: 'day', by: 'date' } },
      },
    ];
    const built = prepareOps(
      initial,
      [
        { op: 'addData', table: table('a') },
        { op: 'addData', table: table('b') },
        ...blocks.map((block) => ({ op: 'addContainer', page: 'home', block })),
      ] as Op[],
      ctx,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const outcomes: Record<string, string> = {};
    for (const tableId of ['a', 'b'])
      for (const field of [undefined, 'n', 'date', 'end', 'cat']) {
        const result = prepareOps(
          built.after,
          [{ op: 'removeData', table: tableId, ...(field ? { field } : {}) }],
          ctx,
        );
        outcomes[`${tableId}${field ? `.${field}` : ''}`] = result.ok ? 'cleaned' : 'refused';
        if (result.ok) {
          expect(danglingRefs(result.after)).toEqual([]);
        } else {
          // Rejections must clearly state which block is using it, preventing arbitrary rejections from masking the true cause.
          expect(result.issues.join('\n')).toMatch(/calc|split|span|sum|block|used|uses/i);
        }
      }
    // Deterministic outcomes: table deletion cleans up entirely (along with blocks using it), deleting referenced fields is strictly rejected, and b.end not referenced by any block is cleaned up.
    expect(outcomes).toEqual({
      a: 'cleaned',
      b: 'cleaned',
      'a.n': 'refused',
      'a.date': 'refused',
      'a.end': 'refused',
      'a.cat': 'refused',
      'b.n': 'refused',
      'b.date': 'refused',
      'b.cat': 'refused',
      'b.end': 'cleaned',
    });
  });

  it('every frozen config starts without a dangling reference (the checker itself)', () => {
    for (const [name, config] of CONFIGS)
      expect({ name, refs: danglingRefs(config) }).toEqual({ name, refs: [] });
    // The checker itself correctly identifies broken references (including tables and fields within quick action steps).
    const broken = structuredClone(v34Fixture('tasks'));
    broken.nav.bar = ['page:nope', 'settings'];
    expect(danglingRefs(broken)).toEqual(['nav.bar[0]: page:nope']);
    const steps = structuredClone(fromV33(v33Fixture('sample-expense-helper-zh')));
    steps.data.tables = [];
    expect(danglingRefs(steps).filter((r) => r.startsWith('tools.')).length).toBeGreaterThan(0);
  });

  it.each(CONFIGS.map(([n]) => n))(
    '%s: removing a table or field that quick-action steps use cleans up those steps instead of being refused for them',
    (name) => {
      const config = CONFIGS.find(([n]) => n === name)![1];
      for (const op of removals(config).filter((o) => o.op === 'removeData')) {
        const r = prepareOps(config, [op], ctx);
        if (r.ok) continue;
        // Reject other reasons (referenced by other tables, fields requested by forms) as usual; do not reject due to quick action steps.
        expect({ op, issues: r.issues.filter((i) => /^[\w-]+\/[\w-]+: /.test(i)) }).toEqual({
          op,
          issues: [],
        });
      }
    },
  );

  it.each(CONFIGS.map(([n]) => n))(
    '%s: removing any one table, field, page, block, tool, step or package either cleans up or is refused',
    (name) => {
      const config = CONFIGS.find(([n]) => n === name)![1];
      for (const op of removals(config)) {
        const r = prepareOps(config, [op], ctx);
        if (r.ok) expect({ op, refs: danglingRefs(r.after) }).toEqual({ op, refs: [] });
        else expect(r.issues.length).toBeGreaterThan(0);
      }
    },
  );

  it.each(CONFIGS.map(([n]) => n))(
    '%s: random sequences of removals keep the config valid after every step',
    (name) => {
      let config = CONFIGS.find(([n]) => n === name)![1];
      const next = rng(name.length * 7919 + name.charCodeAt(0));
      for (let step = 0; step < 12; step++) {
        const ops = removals(config);
        if (ops.length === 0) break;
        const op = ops[Math.floor(next() * ops.length)]!;
        const r = prepareOps(config, [op], ctx);
        if (!r.ok) continue;
        expect({ op, refs: danglingRefs(r.after) }).toEqual({ op, refs: [] });
        const valid = validateWorkspace(r.after, registry);
        expect(valid.ok).toBe(true);
        config = r.after;
      }
    },
  );

  it('starting points (new user, default) are self-consistent', () => {
    for (const config of [createStarterWorkspace('zh', registry), createDefaultWorkspace('en')])
      expect(danglingRefs(config)).toEqual([]);
  });

  // The reference validators below were previously unchecked (Audit F3, founder instructed to fix first in conversation on 2026-11-03). Reject only upon modification: old configs must still open (Invariant 12).
  describe('a change cannot add a reference to something that does not exist', () => {
    const base = (): WorkspaceConfig => {
      const r = applyOps(
        createDefaultWorkspace('en'),
        [
          {
            op: 'addData',
            table: {
              id: 'expenses',
              name: 'Expenses',
              fields: [
                { id: 'amount', name: 'Amount', type: 'number' },
                {
                  id: 'category',
                  name: 'Category',
                  type: 'choice',
                  options: [{ id: 'food', label: 'Food' }],
                },
              ],
            },
          },
        ],
        ctx,
      );
      if (!r.ok) throw new Error(r.error);
      return r.config;
    };
    const number = (source: object) => ({
      id: 'n',
      look: 'number',
      show: { label: 'N' },
      source: { table: 'expenses', ...source },
    });
    const chart = (source: object) => ({
      id: 'c',
      look: 'chart',
      show: { kind: 'bar', title: 'C' },
      source: { table: 'expenses', group: { by: 'category' }, ...source },
    });
    const add = (block: object) => [{ op: 'addContainer', page: 'home', block }];
    const desk = (kind: string, items: unknown[]) => [
      { op: 'updateContainer', desk: { tools: { [kind]: [{ items }] } } },
    ];
    const reminder = (extra: object) => ({
      op: 'addTool',
      tool: {
        id: 'r',
        kind: 'reminder',
        title: 'T',
        enabled: true,
        when: { every: 'day', at: '09:00' },
        opens: 'page:home',
        ...extra,
      },
    });
    const quickAction = (extra: object) => ({
      op: 'addTool',
      tool: {
        id: 'q',
        kind: 'quickAction',
        name: 'Q',
        steps: [{ id: 's', action: 'in.photos', params: { source: 'files', min: 1, max: 5 } }],
        ...extra,
      },
    });

    it.each([
      ['number count', number({ aggregate: 'count', field: 'nope' })],
      ['number streak', number({ aggregate: 'streak', field: 'nope' })],
      ['chart count', chart({ aggregate: 'count', field: 'nope' })],
      ['chart distinctDays', chart({ aggregate: 'distinctDays', field: 'nope' })],
      [
        'minus count',
        number({
          aggregate: 'count',
          minus: { table: 'expenses', aggregate: 'count', field: 'nope' },
        }),
      ],
    ])('%s: field must exist even where the aggregate does not read it', (_name, block) => {
      const r = prepareOps(base(), add(block), ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join()).toContain('nope');
    });

    it('a count may leave field out, or name a real field (older configs do)', () => {
      for (const block of [
        number({ aggregate: 'count' }),
        number({ aggregate: 'count', field: 'amount' }),
        chart({ aggregate: 'count', field: 'amount' }),
      ])
        expect(prepareOps(base(), add(block), ctx).ok).toBe(true);
    });

    it('removing a field clears it from count blocks, charts and minus', () => {
      const added = prepareOps(
        base(),
        [
          ...add(number({ aggregate: 'count', field: 'amount' })),
          ...add({ ...chart({ aggregate: 'count', field: 'amount' }) }),
          ...add({
            ...number({
              aggregate: 'count',
              minus: { table: 'expenses', aggregate: 'count', field: 'amount' },
            }),
            id: 'm',
          }),
        ],
        ctx,
      );
      if (!added.ok) throw new Error(added.issues.join());
      const r = prepareOps(
        added.after,
        [{ op: 'removeData', table: 'expenses', field: 'amount' }],
        ctx,
      );
      if (!r.ok) throw new Error(r.issues.join());
      expect(danglingRefs(r.after)).toEqual([]);
      const blocks = allComponents(r.after.containers.pages.find((p) => p.id === 'home')!);
      const source = (id: string) => (blocks.find((c) => c.id === id) as Json).source as Json;
      expect(source('n').field).toBeUndefined();
      expect(source('c').field).toBeUndefined();
      expect((source('m').minus as Json).field).toBeUndefined();
    });

    it.each([
      ['a quick action that does not exist', 'pdf', 'no-such-quick-action'],
      ['an action that is not in the catalog', 'pdf', { action: 'foo.bar' }],
      ['an action for another kind of file', 'pdf', { action: 'image.rotate' }],
      ['a spec the action does not have', 'image', { action: 'image.compress', preset: 'nope' }],
    ])('desk toolbar: %s is refused', (_name, kind, item) => {
      expect(prepareOps(base(), desk(kind, [item]), ctx).ok).toBe(false);
    });

    it('desk toolbar: a reminder id is refused', () => {
      const r = prepareOps(base(), [reminder({}), ...desk('pdf', ['r'])], ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join()).toContain('reminder');
    });

    it('desk toolbar: actions that take this kind of file and quick actions are fine', () => {
      for (const [kind, items] of [
        ['pdf', [{ action: 'pdf.rotate' }, 'visa-photo']],
        ['image', [{ action: 'image.rotate' }, { action: 'pdf.fromImages' }]],
      ] as const)
        expect(prepareOps(base(), desk(kind, [...items]), ctx).ok).toBe(true);
      const own = prepareOps(base(), [quickAction({}), ...desk('image', ['q'])], ctx);
      expect(own.ok).toBe(true);
      // Actions on the default toolbar can all be written into the config.
      for (const kind of ['image', 'pdf', 'sheet', 'doc', 'video', 'audio'] as const) {
        const items = defaultDeskTools(kind, registry, [], 'en').flatMap((g) => g.items);
        const r = prepareOps(base(), desk(kind, items.slice(0, 20)), ctx);
        expect({ kind, issues: r.ok ? [] : r.issues }).toEqual({ kind, issues: [] });
      }
    });

    it('a new reminder cannot name a tool or a preset, so removeTool can always remove it', () => {
      expect(prepareOps(base(), [reminder({ package: 'nope' })], ctx).ok).toBe(false);
      expect(prepareOps(base(), [reminder({ preset: 'nope' })], ctx).ok).toBe(false);
      const ok = prepareOps(base(), [reminder({})], ctx);
      if (!ok.ok) throw new Error(ok.issues.join());
      expect(prepareOps(ok.after, [{ op: 'removeTool', tool: 'r' }], ctx).ok).toBe(true);
    });

    it('a new quick action can only name a preset that exists', () => {
      const r = prepareOps(base(), [quickAction({ preset: 'nope' })], ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join()).toContain('nope');
      expect(prepareOps(base(), [quickAction({ preset: 'visa-photo' })], ctx).ok).toBe(true);
    });

    it('a config saved with such references still opens and can still be changed (Invariant 12)', () => {
      const old = structuredClone(base());
      const home = old.containers.pages.find((p) => p.id === 'home')!;
      home.blocks.push(number({ aggregate: 'count', field: 'gone' }) as never);
      old.containers.desk = { tools: { pdf: [{ items: ['gone', { action: 'image.rotate' }] }] } };
      old.tools.push(
        {
          id: 'old-r',
          kind: 'reminder',
          package: 'gone',
          title: 'T',
          enabled: true,
          when: { every: 'day', at: '09:00' },
          opens: 'page:home',
        } as never,
        {
          id: 'old-q',
          kind: 'quickAction',
          name: 'Q',
          preset: 'gone',
          steps: [{ id: 's', action: 'in.photos', params: { source: 'files', min: 1, max: 5 } }],
        } as never,
      );
      expect(validateWorkspace(old, registry).ok).toBe(true);
      expect(prepareSnapshot(old, registry).ok).toBe(true);
      const edit = [{ op: 'updateContainer', page: 'home', changes: { title: 'Home 2' } }];
      expect(prepareOps(old, edit, ctx).ok).toBe(true);
      // Old reminder IDs on the toolbar: reminders can still be deleted.
      const withReminder = structuredClone(old);
      withReminder.containers.desk = { tools: { pdf: [{ items: ['old-r2'] }] } };
      withReminder.tools.push({
        id: 'old-r2',
        kind: 'reminder',
        title: 'T',
        enabled: true,
        when: { every: 'day', at: '09:00' },
        opens: 'page:home',
      });
      expect(prepareOps(withReminder, [{ op: 'removeTool', tool: 'old-r2' }], ctx).ok).toBe(true);
      // Newly written broken references continue to be rejected.
      expect(
        prepareOps(old, [...edit, ...add(number({ aggregate: 'count', field: 'no' }))], ctx).ok,
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// What the user wants
// ---------------------------------------------------------------------------------------------

describe('Invariant 19: What the user wants can be done', () => {
  // Founder 2026-10-31 (conversation): Quick actions process files and finally hand them over to a
  // page (new record form, record page) for the user to confirm saving; any actions with matching
  // types can be chained; the AI cannot refuse achievable combinations as "unreasonable" (the
  // prompt half is in planner's prompt-baseline.test.ts). Still a straight chain, with each step
  // taking only the output of the previous one (Invariant 9 unchanged).
  const paramsOf = (a: ActionDefinition) => {
    const p = { ...(defaultParams(a) ?? initialParams(a)) };
    if ('collectionId' in p) p.collectionId = 'notes';
    if (a.id === 'records.fill')
      Object.assign(p, {
        templatesTable: 'templates',
        body: ['body'],
        subject: ['subject'],
        document: ['document'],
        recipient: ['email'],
      });
    return p;
  };

  const variants = (a: ActionDefinition) => {
    const base = paramsOf(a);
    const out = [base];
    for (const f of a.fields)
      if (f.kind === 'choice')
        for (const o of f.options ?? []) {
          const p = { ...base, [f.key]: o.value };
          if (a.params.safeParse(p).success) out.push(p);
        }
    return out;
  };

  it('any two catalog actions whose types fit chain into a quick action that passes the checks', () => {
    const actions = [...registry.actions.values()];
    const sources = actions.filter(isSourceAction);
    const problems: string[] = [];
    let pairs = 0;
    for (const a of actions) {
      // a is preceded by an input action capable of feeding it (if a itself is an input action, it
      // is the first step). An input action's output may depend on parameters (in.files accept):
      // test every option.
      const feed = isSourceAction(a)
        ? []
        : sources
            .flatMap((s) => variants(s).map((params) => ({ s, params })))
            .filter(({ s, params }) => {
              const out = outputTypeOf(s, params, null);
              return out !== null && actionAccepts(a, out);
            })
            .slice(0, 1)
            .map(({ s, params }) => ({ id: 'in', action: s.id, params }));
      if (!isSourceAction(a) && feed.length === 0) {
        problems.push(`${a.id}: no input action gives it something it accepts`);
        continue;
      }
      const head = [...feed, { id: 'a', action: a.id, params: paramsOf(a) }];
      const out = typesAlong(head, registry).at(-1);
      expect(out, a.id).toBeTruthy();
      for (const b of actions) {
        if (isSourceAction(b) || !actionAccepts(b, out!)) continue;
        const wf = {
          id: 'qa',
          kind: 'quickAction',
          name: 'x',
          steps: [...head, { id: 'next', action: b.id, params: paramsOf(b) }],
        } as Workflow;
        problems.push(...workflowProblems(wf, registry).map((p) => p.message));
        pairs++;
      }
    }
    expect(problems).toEqual([]);
    expect(pairs).toBeGreaterThan(1000);
  });
});

// ---- Containers passing data to tools (D-428, determined by founder in conversation on 2026-11-04) ----

/** "Business Card" sample app: Both tables have record page buttons, with tools on lists and single-record blocks. */
const cardsSample = () => {
  const base = createStarterWorkspace('en', registry);
  const result = sampleOps('business-cards', base, 'en');
  if (!result.ok) throw new Error(result.message);
  const r = prepareOps(base, result.ops, ctx);
  if (!r.ok) throw new Error(r.issues.join());
  return r.after;
};
const handedSteps = (id: string, ...actions: string[]): Workflow => ({
  id,
  kind: 'quickAction',
  name: id,
  steps: actions.map((action, i) => ({
    id: `s${i}`,
    action,
    params: initialParams(registry.actions.get(action)!),
  })),
});

describe('Invariants 2 / 6: AI can configure tools on containers, but cannot run them or see values (D-428)', () => {
  it('recordRow is only structure, and the ops take it', () => {
    const r = prepareOps(
      cardsSample(),
      [
        {
          op: 'updateData',
          table: 'contacts',
          changes: {
            recordRow: [{ tool: 'record-vcard' }, { tool: 'record-call', field: 'phone' }],
          },
        },
      ],
      ctx,
    );
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (r.ok)
      expect(r.after.data.tables.find((t) => t.id === 'contacts')!.recordRow).toEqual([
        { tool: 'record-vcard' },
        { tool: 'record-call', field: 'phone' },
      ]);
  });

  it('no op runs a tool or carries the handed value', () => {
    expect(OP_NAMES.filter((n) => /run|exec|call|send|open/i.test(n))).toEqual([]);
    for (const action of ['out.call', 'out.message', 'out.email', 'out.website'])
      expect(registry.actions.get(action)!.params.safeParse({ text: '1', to: '1' }).success).toBe(
        false,
      );
  });

  it('what the AI sees of these tables has no handed values', () => {
    const shown = JSON.stringify(redactForAI(cardsSample(), registry));
    expect(shown).toContain('recordRow');
    expect(shown).not.toMatch(/tel:|mailto:|sms:/);
  });
});

describe('Invariant 9: Tools on containers are also direct chains and cannot trigger other tools (D-428)', () => {
  it('an item in the row names one tool and nothing else', () => {
    const table = { id: 't', name: 'T', fields: [{ id: 'f', name: 'F', type: 'text' }] };
    for (const extra of [{ then: 'other' }, { steps: [] }, { when: [] }, { run: true }])
      expect(
        CollectionSchema.safeParse({ ...table, recordRow: [{ tool: 'a', ...extra }] }).success,
      ).toBe(false);
  });

  it('an input step cannot come after a handed step', () => {
    const wf = handedSteps('w', 'records.toVCardText', 'in.text');
    expect(workflowProblems(wf, registry).map((p) => p.code)).toContain('source');
  });

  it('no step takes a tool as a parameter', () => {
    for (const action of registry.actions.values())
      expect(action.fields.filter((f) => /^(tool|workflow|quickAction)$/.test(f.key))).toEqual([]);
  });
});

describe('Invariant 12: Old config remains unchanged (D-428)', () => {
  it('stays on the same version: every addition is optional', () => {
    // D-607 upgrading to 40 is a separate matter (multiple select); container tools did not undergo
    // further version changes. D-617-D-619 (checklist also, latest number blocks, empty formula
    // "zero") also do not trigger version upgrades: all are optional syntaxes with unchanged stored
    // data, which older apps will reject rather than misread.
    expect(CURRENT_SCHEMA_VERSION).toBe(40);
  });

  it.each(CONFIGS)(
    '%s keeps every formula value: without empty "zero" an empty number still leaves it empty (D-619)',
    (_name, config) => {
      for (const t of config.data.tables)
        for (const f of t.fields)
          if (f.type === 'formula') expect((f as { empty?: unknown }).empty).toBeUndefined();
    },
  );

  it('an old formula reads the same: one empty number leaves it empty (D-619)', () => {
    const t = CollectionSchema.parse({
      id: 't',
      name: 'T',
      fields: [
        { id: 'a', name: 'A', type: 'number' },
        { id: 'b', name: 'B', type: 'number' },
        { id: 'f', name: 'F', type: 'formula', expression: '{a} * (1 + {b})' },
      ],
    });
    const r = (values: Record<string, unknown>): DataRecord => ({
      id: 'r',
      collectionId: 't',
      values,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(recordValue(r({ a: 1 }), t, 'f', new Date())).toBeUndefined();
    expect(recordValue(r({ a: 1, b: 2 }), t, 'f', new Date())).toBe(3);
  });

  it.each(CONFIGS)('%s loads with no row and no list tool made up', (_name, config) => {
    expect(validateWorkspace(config, registry).ok).toBe(true);
    expect(config.data.tables.some((t) => t.recordRow !== undefined)).toBe(false);
    expect(JSON.stringify(config.containers)).not.toContain('"as":"list"');
  });

  it('quick actions with an input step keep their input step', () => {
    for (const [, config] of CONFIGS)
      for (const wf of config.tools)
        if (wf.kind === 'quickAction')
          expect(isSourceAction(registry.actions.get(wf.steps[0]!.action)!)).toBe(true);
  });
});

describe('Invariant 14: Config contains only IDs, no values (D-428)', () => {
  it('an item has no place for a value, and neither does a list tool', () => {
    const table = { id: 't', name: 'T', fields: [{ id: 'f', name: 'F', type: 'text' }] };
    for (const value of [{ value: '13800000000' }, { text: 'x' }, { url: 'tel:1' }])
      expect(
        CollectionSchema.safeParse({ ...table, recordRow: [{ tool: 'a', field: 'f', ...value }] })
          .success,
      ).toBe(false);
    expect(ToolUseSchema.safeParse({ as: 'list', tool: 'a', records: [] }).success).toBe(false);
  });
});

describe('Invariant 17: Lists pass what they select (D-428)', () => {
  it('a tool on a list must take records, and a tool on each entry cannot be a quick action', () => {
    const list = (use: object) => ({
      op: 'addContainer',
      page: 'home',
      index: 0,
      block: {
        id: 'x',
        look: 'list',
        source: { table: 'contacts' },
        show: { title: 'name' },
        tools: [use],
      },
    });
    const ok = (use: object) => prepareOps(cardsSample(), [list(use)] as Op[], ctx).ok;
    expect(ok({ as: 'list', tool: 'record-vcard' })).toBe(true);
    // Quick actions that select their own input do not look at what is selected in the list; placing them on a list makes it look like they act only on the visible items.
    expect(ok({ as: 'list', tool: 'scan-card' })).toBe(false);
    expect(ok({ as: 'list', tool: 'record-call' })).toBe(false);
    expect(ok({ as: 'button', label: 'x', tool: 'record-vcard' })).toBe(false);
    expect(ok({ as: 'list', do: 'toggle', table: 'contacts', field: 'name' })).toBe(false);
  });
});

describe('Invariants 4 / 17 / 18: Containers pass attachments to tools (D-442)', () => {
  const shrink = () => handedSteps('shrink', 'pdf.compress');
  const tableOf = (config: WorkspaceConfig, id: string) =>
    config.data.tables.find((t) => t.id === id)!;
  const withShrink = (ops: unknown[]) =>
    prepareOps(cardsSample(), [{ op: 'addTool', tool: shrink() }, ...ops] as Op[], ctx);
  const list = (use: object, table = 'contacts', title = 'name') => ({
    op: 'addContainer',
    page: 'home',
    index: 0,
    block: {
      id: 'x',
      look: 'list',
      source: { table },
      show: { title },
      tools: [use],
    },
  });

  it('the row hands an attachment field to a tool that takes files, and nothing else', () => {
    const row = (recordRow: unknown) =>
      withShrink([{ op: 'updateData', table: 'contacts', changes: { recordRow } }]).ok;
    expect(row([{ tool: 'shrink', field: 'attachments' }])).toBe(true);
    // No field specified, not an attachment field, or field does not exist: cannot output files.
    expect(row([{ tool: 'shrink' }])).toBe(false);
    expect(row([{ tool: 'shrink', field: 'name' }])).toBe(false);
    expect(row([{ tool: 'shrink', field: 'nope' }])).toBe(false);
    // Conversely: a tool that receives text cannot be connected to an attachment field.
    expect(row([{ tool: 'record-copy', field: 'attachments' }])).toBe(false);
  });

  it('a number or a date can be handed over as text; a checkbox cannot', () => {
    const base = prepareOps(
      cardsSample(),
      [
        {
          op: 'addData',
          table: {
            id: 'bills',
            name: 'Bills',
            fields: [
              { id: 'title', name: 'Title', type: 'text' },
              { id: 'total', name: 'Total', type: 'number' },
              { id: 'due', name: 'Due', type: 'date' },
              { id: 'paid', name: 'Paid', type: 'checkbox' },
            ],
          },
        },
      ] as Op[],
      ctx,
    );
    if (!base.ok) throw new Error(base.issues.join());
    const row = (field: string) =>
      prepareOps(
        base.after,
        [
          {
            op: 'updateData',
            table: 'bills',
            changes: { recordRow: [{ tool: 'record-copy', field }] },
          },
        ] as Op[],
        ctx,
      ).ok;
    expect(row('total')).toBe(true);
    expect(row('due')).toBe(true);
    expect(row('paid')).toBe(false);
  });

  it('a list or a single block hands over the attachments of its own table, so the table needs an attachment field', () => {
    expect(withShrink([list({ as: 'list', tool: 'shrink' })]).ok).toBe(true);
    const plain = {
      op: 'addData',
      table: { id: 'plain', name: 'Plain', fields: [{ id: 'n', name: 'N', type: 'text' }] },
    };
    expect(withShrink([plain, list({ as: 'list', tool: 'shrink' }, 'plain', 'n')]).ok).toBe(false);
    // The same list reading a table with an attachment field: allowed (showing that the above failed because there was no attachment field).
    expect(withShrink([list({ as: 'list', tool: 'shrink' }, 'contacts', 'name')]).ok).toBe(true);
    const single = (table: string, field = 'name') => ({
      op: 'addContainer',
      page: 'home',
      index: 0,
      block: {
        id: 'one',
        look: 'single',
        source: { table },
        show: { fields: [field] },
        tools: [{ tool: 'shrink' }],
      },
    });
    expect(withShrink([single('contacts')]).ok).toBe(true);
    expect(withShrink([plain, single('plain', 'n')]).ok).toBe(false);
  });

  it('it cannot sit where nothing hands over attachments: a button, an action block, a reminder', () => {
    const at = (block: object) =>
      withShrink([{ op: 'addContainer', page: 'home', index: 0, block }]).ok;
    expect(at({ id: 'b', look: 'button', label: 'Go', opens: 'tool:shrink' })).toBe(false);
    expect(at({ id: 'a', look: 'action', tool: 'shrink' })).toBe(false);
  });

  it('removing the attachment field takes its button with it; removing the tool cleans the row', () => {
    const placed = withShrink([
      {
        op: 'updateData',
        table: 'contacts',
        changes: { recordRow: [{ tool: 'shrink', field: 'attachments' }] },
      },
    ]);
    if (!placed.ok) throw new Error(placed.issues.join());
    expect(danglingRefs(placed.after)).toEqual([]);
    const field = prepareOps(
      placed.after,
      [{ op: 'removeData', table: 'contacts', field: 'attachments' }],
      ctx,
    );
    expect(field.ok ? [] : field.issues).toEqual([]);
    if (field.ok) expect(tableOf(field.after, 'contacts').recordRow).toBeUndefined();
    const tool = prepareOps(placed.after, [{ op: 'removeTool', tool: 'shrink' }], ctx);
    expect(tool.ok ? [] : tool.issues).toEqual([]);
    if (tool.ok) {
      expect(tableOf(tool.after, 'contacts').recordRow).toBeUndefined();
      expect(danglingRefs(tool.after)).toEqual([]);
    }
  });

  it('the AI is told it can hand attachments, and that it never sees them (Invariants 2, 3)', () => {
    const rule = registry.actions.get('out.call')!.aiRules!.find((r) => r.n === 54)!.text;
    expect(rule).toMatch(/attachment/i);
    expect(rule).toMatch(/never see/i);
  });
});

describe('Invariants 3 / 5 / 14 / 18: Log an entry into an existing record (D-443)', () => {
  const addRecord = registry.actions.get('out.addRecord')!;
  const own = (params: Record<string, unknown>): Workflow => ({
    id: 'to-existing',
    kind: 'quickAction',
    name: 'To existing',
    steps: [
      { id: 'a', action: 'in.photos', params: initialParams(registry.actions.get('in.photos')!) },
      { id: 'b', action: 'out.addRecord', params },
    ],
  });

  it('the AI only says which table and that it is an existing entry: the entry and the files are chosen by the user when it runs', () => {
    // The only writable parts are tables, one file per entry, and into; cannot write to a specific record or file (and cannot see them either).
    for (const extra of [{ recordId: 'r1' }, { assetId: 'a1' }, { fileId: 'a1' }, { values: {} }])
      expect(
        addRecord.params.safeParse({ collectionId: 'contacts', into: 'existing', ...extra })
          .success,
      ).toBe(false);
    expect(addRecord.params.safeParse({ collectionId: 'contacts', into: 'existing' }).success).toBe(
      true,
    );
    expect(addRecord.params.safeParse({ collectionId: 'contacts', into: 'a1' }).success).toBe(
      false,
    );
  });

  it('a quick action that adds to an existing entry is accepted, and it is removed with its table like the others', () => {
    const wf = own({ collectionId: 'contacts', into: 'existing' });
    const added = prepareOps(cardsSample(), [{ op: 'addTool', tool: wf }] as Op[], ctx);
    expect(added.ok ? [] : added.issues).toEqual([]);
    if (!added.ok) return;
    expect(danglingRefs(added.after)).toEqual([]);
    // Remove the table it writes: cleaned up together with this step (and thus the whole quick action), leaving no references to non-existent tables.
    const gone = prepareOps(added.after, [{ op: 'removeData', table: 'contacts' }], ctx);
    expect(gone.ok ? [] : gone.issues).toEqual([]);
    if (gone.ok) expect(danglingRefs(gone.after)).toEqual([]);
  });

  it('the table needs a place for what is added, the same as for a new entry', () => {
    const noFileField = prepareOps(
      cardsSample(),
      [
        {
          op: 'addData',
          table: { id: 'plain', name: 'Plain', fields: [{ id: 'n', name: 'N', type: 'text' }] },
        },
        { op: 'addTool', tool: own({ collectionId: 'plain', into: 'existing' }) },
      ] as Op[],
      ctx,
    );
    expect(noFileField.ok).toBe(false);
  });
});

describe('Invariant 18: References to tools on containers (D-428)', () => {
  const tableOf = (config: WorkspaceConfig, id: string) =>
    config.data.tables.find((t) => t.id === id)!;

  it('the sample starts clean', () => {
    expect(danglingRefs(cardsSample())).toEqual([]);
  });

  it('removing a field takes its buttons with it and says so', () => {
    const r = prepareOps(
      cardsSample(),
      [{ op: 'removeData', table: 'my-card', field: 'email' }],
      ctx,
    );
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (!r.ok) return;
    expect(tableOf(r.after, 'my-card').recordRow!.map((i) => i.tool)).toEqual([
      'record-call',
      'record-message',
      'record-website',
      'record-vcard',
    ]);
    expect(danglingRefs(r.after)).toEqual([]);
  });

  it('removing the last field the row used removes the row', () => {
    const base = applyOps(
      createDefaultWorkspace('en'),
      [
        {
          op: 'addData',
          table: {
            id: 't',
            name: 'T',
            fields: [
              { id: 'n', name: 'N', type: 'text' },
              { id: 'p', name: 'P', type: 'text', format: 'phone' },
            ],
            recordRow: [{ tool: 'record-call', field: 'p' }],
          },
        },
      ],
      ctx,
    );
    if (!base.ok) throw new Error(base.error);
    const r = applyOps(base.config, [{ op: 'removeData', table: 't', field: 'p' }], ctx);
    if (!r.ok) throw new Error(r.error);
    expect(tableOf(r.config, 't').recordRow).toBeUndefined();
    expect(r.notes.map((n) => n.kind)).toContain('removedRecordActions');
  });

  it('removing a quick action cleans the row, the list and the single block; the blocks stay', () => {
    const base = cardsSample();
    const withOwn = prepareOps(
      base,
      [
        { op: 'addTool', tool: handedSteps('qr-own', 'records.toVCardText', 'qr.generate') },
        { op: 'updateData', table: 'my-card', changes: { recordRow: [{ tool: 'qr-own' }] } },
      ] as Op[],
      ctx,
    );
    if (!withOwn.ok) throw new Error(withOwn.issues.join());
    const r = prepareOps(withOwn.after, [{ op: 'removeTool', tool: 'qr-own' }], ctx);
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (r.ok) expect(tableOf(r.after, 'my-card').recordRow).toBeUndefined();

    const gone = prepareOps(base, [{ op: 'removeTool', tool: 'export-contacts' }], ctx);
    expect(gone.ok ? [] : gone.issues).toEqual([]);
    if (!gone.ok) return;
    expect(danglingRefs(gone.after)).toEqual([]);
    const page = gone.after.containers.pages.find((p) => p.id === 'contacts')!;
    // Export is one of the floating button items in the preset: this item is removed, others remain (decided by the founder 2026-11-04).
    const dial = allComponents(page).find((c) => c.look === 'dial') as {
      tools: { tool?: string; do?: string }[];
    };
    expect(dial.tools.map((u) => u.tool ?? u.do)).toEqual(['scan-card', 'create']);
  });

  it('a reference that does not exist, or a field that does not fit, is refused', () => {
    const row = (recordRow: unknown) =>
      prepareOps(
        cardsSample(),
        [{ op: 'updateData', table: 'contacts', changes: { recordRow } }] as Op[],
        ctx,
      ).ok;
    expect(row([{ tool: 'record-call', field: 'phone' }])).toBe(true);
    expect(row([{ tool: 'nope' }])).toBe(false);
    expect(row([{ tool: 'record-call', field: 'nope' }])).toBe(false);
    expect(row([{ tool: 'record-call' }])).toBe(false);
    expect(row([{ tool: 'record-vcard', field: 'phone' }])).toBe(false);
    expect(row([{ tool: 'scan-card' }])).toBe(false);
    expect(row([{ tool: 'record-call', field: 'attachments' }])).toBe(false);
    expect(
      row([
        { tool: 'record-call', field: 'phone' },
        { tool: 'record-call', field: 'phone' },
      ]),
    ).toBe(false);
  });

  it('records handed by a container cannot name fields: the table is not known there', () => {
    const wf = handedSteps('w', 'print.records');
    wf.steps[0]!.params = {
      template: 'table',
      title: 'x',
      fields: ['name'],
      pageSize: 'a4',
    };
    const r = prepareOps(cardsSample(), [{ op: 'addTool', tool: wf }] as Op[], ctx);
    expect(r.ok).toBe(false);
    wf.steps[0]!.params = { ...wf.steps[0]!.params, fields: [] };
    expect(prepareOps(cardsSample(), [{ op: 'addTool', tool: wf }] as Op[], ctx).ok).toBe(true);
  });

  it('removing the input step of a quick action on a removed table removes it, it does not turn into a handed one', () => {
    const r = prepareOps(
      createDefaultWorkspace('en'),
      [
        {
          op: 'addData',
          table: { id: 'x', name: 'X', fields: [{ id: 'n', name: 'N', type: 'text' }] },
        },
        {
          op: 'addTool',
          tool: {
            id: 'exp',
            kind: 'quickAction',
            name: 'Exp',
            steps: [
              { id: 'a', action: 'in.records', params: { collectionId: 'x', period: 'all' } },
              { id: 'b', action: 'records.toVCard', params: {} },
              { id: 'c', action: 'out.share', params: {} },
            ],
          },
        },
        { op: 'removeData', table: 'x' },
      ] as Op[],
      ctx,
    );
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (r.ok) expect(r.after.tools.some((t) => t.id === 'exp')).toBe(false);
  });
});

describe('Invariant 19: Tools on containers can be chained if their types match (D-428)', () => {
  it('every action taking text or records can start a chain, and what fits can follow', () => {
    for (const action of registry.actions.values()) {
      if (isSourceAction(action) || !handedTypeOf(action)) continue;
      const wf = handedSteps('w', action.id);
      expect(
        workflowProblems(wf, registry).filter((p) => p.code === 'source' || p.code === 'binding'),
      ).toEqual([]);
    }
    for (const chain of [
      ['records.toVCard', 'out.share'],
      ['records.toVCardText', 'qr.generate', 'out.share'],
      ['records.toExcel', 'out.share'],
      ['text.copy', 'qr.generate'],
      ['text.tidy', 'out.call'],
    ]) {
      const wf = handedSteps('w', ...chain);
      expect(
        workflowProblems(wf, registry).filter((p) => p.code === 'source' || p.code === 'binding'),
      ).toEqual([]);
    }
  });

  it('a value tool still chains from an input step', () => {
    const wf = handedSteps('w', 'in.text', 'out.call');
    expect(typesAlong(wf.steps, registry)).toEqual(['text', 'text']);
  });
});

// D-429: Each entry picks its own currency. Currency is the value of a single-choice field in the record; the config contains only the field ID.
describe('each entry picks its own currency (D-429)', () => {
  const ctx = { registry, locale: 'en' as const };
  const table = () => ({
    id: 'claims',
    name: 'Claims',
    fields: [
      { id: 'amount', name: 'Amount', type: 'money', currency: 'USD', currencyField: 'cur' },
      { id: 'cur', name: 'Currency', type: 'choice', options: [{ id: 'usd', label: 'USD' }] },
    ] as Record<string, unknown>[],
  });
  const withTable = (t: ReturnType<typeof table>) => {
    const c = structuredClone(createDefaultWorkspace('en'));
    c.data.tables = [t as never];
    return c;
  };
  const problems = (t: ReturnType<typeof table>) => {
    const r = validateWorkspace(withTable(t), registry);
    return r.ok ? '' : JSON.stringify(r);
  };

  it('rule 12: a money field saved before D-429 is still valid', () => {
    const t = table();
    delete t.fields[0]!.currencyField;
    expect(problems(t)).toBe('');
  });

  it('rule 18: currencyField must be a choice field of this table holding currency codes', () => {
    expect(problems(table())).toBe('');
    const missing = table();
    missing.fields = [missing.fields[0]!];
    expect(problems(missing)).toContain('currencyField');
    const bad = table();
    bad.fields[1]!.options = [{ id: 'other', label: 'Other' }];
    expect(problems(bad)).toContain('other');
  });

  it('rule 18: removing the currency field is refused until the money field lets go', () => {
    const c = withTable(table());
    const remove = { op: 'removeData', table: 'claims', field: 'cur' } as const;
    expect(JSON.stringify(applyOps(c, [remove], ctx))).toContain('currencyField');
    const freed = applyOps(
      c,
      [
        { op: 'updateData', table: 'claims', field: 'amount', changes: { currencyField: null } },
        remove,
      ],
      ctx,
    );
    expect(freed.ok).toBe(true);
  });

  it('rule 14: the config holds a field id only; the code comes from the record', () => {
    expect(JSON.stringify(table().fields[0])).not.toContain('eur');
    const record = { id: 'a', createdAt: 1, updatedAt: 1, values: { amount: 2, cur: 'usd' } };
    expect(perCurrencyText([record as never], table() as never, 'sum', 'amount', 'en')).toContain(
      '2.00',
    );
  });
});

describe('Invariants 2 / 14: Tags exist only in records; neither config nor payloads sent to AI contain tag names (decided by the founder 2026-11-04)', () => {
  const list = (browse: object) => ({
    id: 'x',
    look: 'list',
    source: { table: 'contacts' },
    show: { title: 'name', browse },
  });
  const addTo = (block: object) =>
    prepareOps(cardsSample(), [{ op: 'addContainer', page: 'my-card', block } as Op], ctx);

  it('a tags field has no options, default or list of values: tag names do not fit in the config', () => {
    const table = cardsSample().data.tables.find((t) => t.id === 'contacts')!;
    expect(table.fields.find((f) => f.type === 'tags')).toEqual({
      id: 'tags',
      name: 'Tags',
      type: 'tags',
    });
    for (const extra of [{ options: [SENTINEL] }, { default: [SENTINEL] }, { values: [SENTINEL] }])
      expect(
        CollectionSchema.safeParse({
          id: 't',
          name: 'T',
          fields: [{ id: 'g', name: 'G', type: 'tags', ...extra }],
        }).success,
      ).toBe(false);
  });

  it('a saved filter can only ask whether there are tags: is / isNot would store a tag name', () => {
    const filter = (op: string, value?: string) =>
      addTo({
        ...list({ search: true }),
        source: { table: 'contacts', filter: [{ field: 'tags', op, value }] },
      });
    for (const op of ['is', 'isNot', 'contains']) {
      const r = filter(op, SENTINEL);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join()).toMatch(/isEmpty or isNotEmpty/);
    }
    expect(filter('isNotEmpty').ok).toBe(true);
  });

  it('a record tool can not preset a tag either', () => {
    const r = addTo({
      id: 'x',
      look: 'button',
      show: { label: 'A', variant: 'filled' },
      tools: [{ do: 'create', table: 'contacts', values: { tags: [SENTINEL] } }],
    });
    expect(r.ok).toBe(false);
  });

  it('the picked filter value, the search text and the sort have no place in browse', () => {
    for (const extra of [{ picked: SENTINEL }, { value: SENTINEL }, { query: SENTINEL }])
      expect(
        OpSchema.safeParse({
          op: 'addContainer',
          page: 'home',
          block: list({ filter: ['tags'], ...extra }),
        }).success,
      ).toBe(false);
    expect(
      OpSchema.safeParse({
        op: 'addContainer',
        page: 'home',
        block: list({ filter: [SENTINEL + ' a tag'] }),
      }).success,
    ).toBe(false);
  });

  it('the sample and the contacts preset hold no tag name', () => {
    const text = JSON.stringify(cardsSample());
    for (const old of ['"client"', '"colleague"', '"friend"']) expect(text).not.toContain(old);
  });
});

describe('Invariant 12: Check-in grid has a new look, while old configs and old versions in change history still open normally (D-610)', () => {
  it('a new look and keys used only by it: no version bump, old configs load unchanged', () => {
    // Check-in grid did not increment its own version; 40 was bumped for multi-choice (D-607).
    expect(CURRENT_SCHEMA_VERSION).toBe(40);
    for (const [, config] of CONFIGS) {
      const text = JSON.stringify(config);
      expect(text).not.toMatch(/"look":"grid"|"across"|"do":"remove"/);
      const r = prepareSnapshot(structuredClone(config), registry);
      expect(r.ok && r.after).toEqual(config);
    }
  });

  it('a version saved with a grid opens again from the change history, unchanged', () => {
    const config = createDefaultWorkspace('en');
    config.data.tables.push({
      id: 'logs',
      name: 'Logs',
      fields: [
        { id: 'kind', name: 'Kind', type: 'choice', options: [{ id: 'a', label: 'A' }] },
        { id: 'day', name: 'Day', type: 'date' },
      ],
    });
    config.containers.pages[0]!.blocks.push({
      id: 'g',
      look: 'grid',
      source: { table: 'logs', limit: 30, group: { by: 'kind' }, across: { unit: 'week' } },
      show: { title: 'kind' },
      tools: [
        { as: 'tap', do: 'create', table: 'logs', values: '$here' },
        { as: 'tap', do: 'remove', table: 'logs' },
      ],
    } as never);
    const frozen = JSON.parse(JSON.stringify(config));
    const r = prepareSnapshot(frozen, registry);
    expect(r.ok ? [] : r.issues).toEqual([]);
    expect(r.ok && r.after).toEqual(frozen);
  });
});

describe('Invariant 12: Old configs open successfully without fixed areas, tags, or floating buttons (decided by the founder 2026-11-04)', () => {
  it('schemaVersion stays 40 and a config without the new keys is valid and unchanged', () => {
    // 39 -> 40 is D-607 (multi-choice), which only bumps the version number.
    expect(CURRENT_SCHEMA_VERSION).toBe(40);
    const old = fromV33(v33Fixture('sample-expense-helper-zh') as never);
    const text = JSON.stringify(old);
    for (const key of ['"pin"', '"dial"', '"tags"']) expect(text).not.toContain(key);
    expect(validateWorkspace(old, registry).ok).toBe(true);
  });
});

describe('Invariant 18: References to fixed areas, tag filters, and floating buttons (decided by the founder 2026-11-04)', () => {
  const dialOf = (config: WorkspaceConfig) =>
    allComponents(config.containers.pages.find((p) => p.id === 'contacts')!).find(
      (c) => c.look === 'dial',
    ) as { tools: { as?: string; tool?: string; do?: string }[] } | undefined;

  it('removing the list takes the item that hands its records off the dial; the others stay', () => {
    const r = prepareOps(
      cardsSample(),
      [{ op: 'removeContainer', page: 'contacts', block: 'contacts' }],
      ctx,
    );
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (!r.ok) return;
    expect(danglingRefs(r.after)).toEqual([]);
    expect(dialOf(r.after)!.tools.map((u) => u.tool ?? u.do)).toEqual(['scan-card', 'create']);
  });

  it('removing the table takes the dial items that used it; the scan stays while it can', () => {
    const r = prepareOps(cardsSample(), [{ op: 'removeData', table: 'contacts' }], ctx);
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (!r.ok) return;
    expect(danglingRefs(r.after)).toEqual([]);
    expect(JSON.stringify(dialOf(r.after) ?? {})).not.toContain('"contacts"');
    expect(dialOf(r.after)?.tools.some((u) => u.as === 'list') ?? false).toBe(false);
  });

  it('a dial with nothing left is removed', () => {
    const base = cardsSample();
    const r = prepareOps(
      base,
      [
        { op: 'removeTool', tool: 'scan-card' },
        { op: 'removeTool', tool: 'export-contacts' },
        { op: 'removeData', table: 'contacts' },
      ],
      ctx,
    );
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (r.ok) expect(dialOf(r.after)).toBeUndefined();
  });

  it('removing a page a dial opens takes that item off', () => {
    const base = cardsSample();
    const added = prepareOps(
      base,
      [
        {
          op: 'updateContainer',
          page: 'contacts',
          block: 'actions',
          changes: {
            tools: [
              { tool: 'scan-card', label: 'Scan' },
              { opens: 'my-card', label: 'Mine' },
            ],
          },
        },
      ] as Op[],
      ctx,
    );
    expect(added.ok ? [] : added.issues).toEqual([]);
    if (!added.ok) return;
    const r = prepareOps(added.after, [{ op: 'removeContainer', page: 'my-card' }], ctx);
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (r.ok) expect(dialOf(r.after)!.tools.map((u) => u.tool)).toEqual(['scan-card']);
  });

  it('removing a filter field takes it out of browse; browse goes when nothing is left', () => {
    const base = cardsSample();
    const prepared = prepareOps(
      base,
      [
        {
          op: 'addData',
          table: {
            id: 'kinds',
            name: 'Kinds',
            fields: [
              { id: 'name', name: 'Name', type: 'text' },
              { id: 'labels', name: 'Labels', type: 'tags' },
            ],
          },
        },
        {
          op: 'addContainer',
          page: 'my-card',
          block: {
            id: 'k',
            look: 'list',
            source: { table: 'kinds' },
            show: { title: 'name', browse: { filter: ['labels'] } },
          },
        },
      ] as Op[],
      ctx,
    );
    expect(prepared.ok ? [] : prepared.issues).toEqual([]);
    if (!prepared.ok) return;
    const r = prepareOps(
      prepared.after,
      [{ op: 'removeData', table: 'kinds', field: 'labels' }],
      ctx,
    );
    expect(r.ok ? [] : r.issues).toEqual([]);
    if (!r.ok) return;
    const block = allComponents(r.after.containers.pages.find((p) => p.id === 'my-card')!).find(
      (c) => c.id === 'k',
    ) as { show: { browse?: unknown } };
    expect(block.show.browse).toBeUndefined();
  });

  it('a block in a group can not be pinned, and moving a pinned block into a group is refused', () => {
    const r = prepareOps(
      cardsSample(),
      [
        {
          op: 'addContainer',
          page: 'my-card',
          block: {
            id: 'g',
            look: 'group',
            show: { layout: 'stack' },
            children: [{ id: 'h', look: 'divider', pin: 'top' }],
          },
        },
      ] as Op[],
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/can't have pin/);
  });

  it('every dial item is checked: a handed quick action, a list that is not there, a record page', () => {
    const dial = (tools: object[]) => ({ id: 'd', look: 'dial', pin: 'bottom', tools });
    const add = (block: object, page = 'my-card') =>
      prepareOps(cardsSample(), [{ op: 'addContainer', page, block } as Op], ctx);
    const refused = (block: object, pattern: RegExp) => {
      const r = add(block);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join()).toMatch(pattern);
    };
    // A tool that takes records cannot be used as a regular item (has no value to pass), nor on a page without a list.
    refused(dial([{ tool: 'export-contacts' }]), /takes a record, a value or attachments/);
    refused(dial([{ as: 'list', tool: 'export-contacts' }]), /exactly one top-level list/);
    // Only tools requiring container records can use as: "list"; self-selecting files is not allowed.
    refused(dial([{ as: 'list', tool: 'scan-card' }]), /must start with a step that takes records/);
    refused(dial([{ tool: 'no-such' }]), /missing quick action/);
    refused(dial([{ opens: 'no-such', label: 'x' }]), /is not a page/);
    refused(dial([{ do: 'create', table: 'contacts', ask: 'all' }]), /needs a label/);
    refused({ id: 'd', look: 'dial', tools: [{ tool: 'scan-card' }] }, /set pin "bottom"/);
    expect(add(dial([{ tool: 'scan-card' }])).ok).toBe(true);
    // One per page.
    const two = prepareOps(
      cardsSample(),
      [
        {
          op: 'addContainer',
          page: 'contacts',
          block: dial([{ tool: 'scan-card' }]),
        },
      ] as Op[],
      ctx,
    );
    expect(two.ok).toBe(false);
  });

  it('a list with show.browse can not be pinned, and only one list on a page pins its search', () => {
    const list = (id: string, extra: object) => ({
      id,
      look: 'list',
      source: { table: 'contacts' },
      show: { title: 'name', browse: { search: true, ...extra } },
    });
    const add = (block: object) =>
      prepareOps(cardsSample(), [{ op: 'addContainer', page: 'contacts', block } as Op], ctx);
    const second = add(list('b', { pin: true }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.issues.join()).toMatch(/only one list/);
    const pinned = add({ ...list('c', {}), pin: 'top' });
    expect(pinned.ok).toBe(false);
    if (!pinned.ok) expect(pinned.issues.join()).toMatch(/scrolls in the middle/);
    const wrongType = add({
      ...list('d', {}),
      show: { title: 'name', browse: { filter: ['name'] } },
    });
    expect(wrongType.ok).toBe(false);
  });
});

describe('Invariants 2 / 5 / 12 / 15: Single choice can select multiple values (D-607)', () => {
  const days = {
    id: 'days',
    name: 'Days',
    type: 'choice' as const,
    multiple: true as const,
    options: [
      { id: 'mon', label: 'Monday' },
      { id: 'thu', label: 'Thursday' },
    ],
  };
  const meals = {
    id: 'meals',
    name: 'Meals',
    fields: [{ id: 'name', name: 'Name', type: 'text' as const }, days],
  };
  const withMeals = () => {
    const r = applyOps(createDefaultWorkspace('en'), [{ op: 'addData', table: meals }], ctx);
    if (!r.ok) throw new Error(r.error);
    return r.config;
  };

  it('5: going back to one option is refused, so no entry loses an option it has', () => {
    const r = applyOps(
      withMeals(),
      [{ op: 'updateData', table: 'meals', field: 'days', changes: { multiple: null } }],
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('5: after an undo to one option, saving another field keeps the stored list', () => {
    const single = { ...meals, fields: [meals.fields[0]!, { ...days, multiple: undefined }] };
    const r = prepareRecordValues(
      single as never,
      { name: 'b' },
      { name: 'a', days: ['mon', 'thu'] },
      ctx.now,
    );
    expect(r).toEqual({ ok: true, values: { name: 'b', days: ['mon', 'thu'] } });
  });

  it('12: a v39 config and a v39 snapshot open; the migration only raises the version', () => {
    const v39 = { ...createDefaultWorkspace('en'), schemaVersion: 39 };
    const r = migrateWorkspace(structuredClone(v39));
    expect(r.ok && r.config).toEqual({ ...v39, schemaVersion: CURRENT_SCHEMA_VERSION });
    const snap = prepareSnapshot({ ...withMeals(), schemaVersion: 39 }, registry);
    expect(snap.ok ? [] : snap.issues).toEqual([]);
  });

  it('12: an entry saved before the field took several options reads as one of them', () => {
    expect(formatValue(days, 'thu', 'en')).toBe('Thursday');
  });

  it('15: filtering, grouping and showing leave the entries as they were', () => {
    const records: DataRecord[] = [
      {
        id: 'a',
        collectionId: 'meals',
        values: { name: 'a', days: ['thu', 'mon'] },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'b',
        collectionId: 'meals',
        values: { name: 'b', days: 'mon' },
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    const before = structuredClone(records);
    filterRecords(records, meals, [{ field: 'days', op: 'is', value: ['mon'] }], ctx.now);
    listGroups(
      records,
      meals,
      { by: 'days' },
      { locale: 'en', now: ctx.now, cal: DEFAULT_CALENDAR },
    );
    for (const r of records) formatValue(days, r.values.days, 'en');
    expect(records).toEqual(before);
  });

  it('2: the configuration holds only the options; on-device suggestions never fill a multiple field', async () => {
    const text = JSON.stringify(withMeals());
    expect(text).toContain('"multiple":true');
    const found = await ruleEngine({
      fields: meals.fields,
      pages: [
        {
          width: 1000,
          height: 40,
          lines: [{ text: 'Monday and Thursday', x: 0, y: 0, width: 1000, height: 24 }],
        },
      ],
      spoken: true,
      locale: 'en',
      now: ctx.now,
    });
    expect(found.days).toBeUndefined();
  });
});
