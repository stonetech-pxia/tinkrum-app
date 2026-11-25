import { describe, expect, it } from 'vitest';

import { prepareOps } from '../change';
import type { Op } from '../ops';
import { fromV33, registry, v33Fixture } from '../test-helpers';
import { EVAL_CASES, buildSetup, runEvalCase, type EvalSetup } from './eval-cases';
import { createMockAIProvider } from './mock';
import type { AIProvider, Plan, WorkKind } from './types';

// Evaluation setup rewritten using v34 operations (v34 phase 3): identical after migration to config saved by v33 code.
describe('eval setups are the same as the v33 ones', () => {
  const setups: EvalSetup[] = [
    'default',
    'pdf',
    'pdfBelowFiles',
    'budget',
    'visa',
    'visaHomeScreen',
    'habits',
    'linked',
    'oneTap',
    'views',
    'boards',
    'scheduled',
    'envelopes',
    'todos',
  ];
  it.each(setups)('%s', (setup) => {
    const name = setup === 'default' ? `${setup}-zh` : `setup-${setup}-zh`;
    expect(buildSetup(setup, 'zh', registry)).toStrictEqual(fromV33(v33Fixture(name)));
  });
});

// Mock AI must pass all evaluation cases marked as mock; rewriting test cases (`P*`) is reserved for real models.
describe('eval cases on the mock AI', () => {
  const ai = createMockAIProvider();
  const now = new Date(2026, 9, 22, 9, 0);

  it.each(EVAL_CASES.filter((c) => c.mock).map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    expect((await runEvalCase(c, ai, registry, now)).outcome).toEqual({ pass: true });
  });

  it('the mock does not pretend to understand paraphrases', async () => {
    for (const c of EVAL_CASES.filter((x) => !x.mock)) {
      const config = buildSetup(c.setup, c.locale, registry);
      const plan = await ai.plan(c.input, {
        config,
        registry,
        locale: c.locale,
        ...(c.about ? { about: c.about } : {}),
      });
      // Does not require passing, but must not produce invalid modifications.
      if (plan.kind === 'ops') {
        expect(prepareOps(config, plan.ops, { registry, locale: c.locale, now }).ok).toBe(true);
      }
    }
  });
});

// Two interpretations of W10 (D-083 supplement, confirmed in local session by founder on 2026-10-27): compress images, or straighten and convert to PDF.
describe('W10 accepts both readings', () => {
  const w10 = EVAL_CASES.find((c) => c.id === 'W10')!;
  const check = (steps: [string, Record<string, unknown>][]) => {
    const config = buildSetup('default', 'zh', registry);
    const after = {
      ...config,
      tools: [
        ...config.tools,
        {
          id: 'scan-300',
          kind: 'quickAction' as const,
          name: 'Scan',
          steps: steps.map(([action, params], i) => ({ id: `s${i}`, action, params })),
        },
      ],
    };
    if (w10.expect.kind !== 'ops') throw new Error('W10 should expect ops');
    return w10.expect.check(after);
  };
  const scanner: [string, Record<string, unknown>] = ['in.photos', { source: 'scanner' }];

  it('compresses the scanned images to 300KB', () => {
    expect(check([scanner, ['image.compress', { maxKB: 300 }], ['file.save', {}]])).toBeNull();
  });

  it('straightens the pages and makes a PDF of at most 0.3 MB', () => {
    expect(
      check([
        scanner,
        ['scan.detect', {}],
        ['scan.enhance', {}],
        ['pdf.fromImages', { maxMB: 0.3 }],
        ['file.save', {}],
      ]),
    ).toBeNull();
    expect(
      check([scanner, ['scan.detect', {}], ['pdf.fromImages', { maxMB: 0.25 }], ['file.save', {}]]),
    ).toBeNull();
  });

  it('rejects a PDF that is too big, a missing save or a camera instead of the scanner', () => {
    expect(
      check([scanner, ['scan.detect', {}], ['pdf.fromImages', { maxMB: 0.5 }], ['file.save', {}]]),
    ).not.toBeNull();
    expect(
      check([scanner, ['scan.detect', {}], ['pdf.fromImages', {}], ['file.save', {}]]),
    ).not.toBeNull();
    expect(
      check([scanner, ['pdf.fromImages', { maxMB: 0.3 }], ['file.save', {}], ['out.share', {}]]),
    ).not.toBeNull();
    expect(
      check([
        ['in.photos', { source: 'camera' }],
        ['pdf.fromImages', { maxMB: 0.3 }],
        ['file.save', {}],
      ]),
    ).not.toBeNull();
  });
});

// Align new workflow (D-415, D-407) with evaluations: multiple tools in a single sentence returning a build plan is also considered correct, and non-existent named items are created.
describe('allowBuild', () => {
  const now = new Date(2026, 10, 3);
  const caseOf = (id: string) => EVAL_CASES.find((c) => c.id === id)!;
  const replies = (plan: Plan): AIProvider => ({ plan: async () => plan });
  const step = (id: string, kind: WorkKind) => ({ id, kind, title: id, request: `do ${id}` });
  const build = (steps: ReturnType<typeof step>[]): Plan => ({
    kind: 'build',
    summary: 'an app',
    steps,
  });
  const judge = async (id: string, plan: Plan) =>
    (await runEvalCase(caseOf(id), replies(plan), registry, now)).outcome;

  it.each(['TD17', 'TD17-en', 'FX6'])('%s: valid build plan counts as passing', async (id) => {
    const plan = build([step('data', 'record'), step('look', 'look')]);
    expect(await judge(id, plan)).toEqual({ pass: true });
  });

  it('Cases without `allowBuild` returning build still fail', async () => {
    const plan = build([step('data', 'record'), step('look', 'look')]);
    expect(await judge('RE1', plan)).toMatchObject({ pass: false });
  });

  it.each([
    ['步数不够', build([step('data', 'record')])],
    ['步骤 ID 重复', build([step('data', 'record'), step('data', 'look')])],
    ['request 是空的', build([{ ...step('data', 'record'), request: '  ' }, step('look', 'look')])],
    ['没有做数据的那一步', build([step('a', 'look'), step('b', 'look')])],
    ['外观排在数据前面', build([step('look', 'look'), step('data', 'record')])],
  ])('Invalid plans do not count: %s', async (_why, plan) => {
    expect(await judge('TD17', plan)).toMatchObject({ pass: false });
  });

  it('Cases with `allowBuild` returning ops maintain existing assertions', async () => {
    expect(await judge('FX6', { kind: 'ops', ops: [] })).toMatchObject({ pass: false });
  });

  it('Rejections still fail', async () => {
    const plan: Plan = { kind: 'reject', reason: 'unknown', message: 'no', examples: [] };
    expect(await judge('FX6', plan)).toMatchObject({ pass: false });
  });
});

describe('RE3: Photo logging to a non-existent table (create if named item does not exist and purpose is clear, D-407)', () => {
  const now = new Date(2026, 10, 3);
  const c = EVAL_CASES.find((x) => x.id === 'RE3')!;
  const judge = async (plan: Plan) =>
    (await runEvalCase(c, { plan: async () => plan }, registry, now)).outcome;
  const newTable: Op = {
    op: 'addData',
    table: {
      id: 'photos',
      name: '照片记录',
      fields: [
        { id: 'photo', name: '照片', type: 'file' },
        { id: 'note', name: '备注', type: 'text' },
      ],
    },
  } as Op;
  const quickAction = (table: string): Op =>
    ({
      op: 'addTool',
      tool: {
        kind: 'quickAction',
        id: 'snap',
        name: '拍照记录',
        icon: '📷',
        steps: [
          { id: 's1', action: 'in.photos', params: { source: 'camera', min: 1, max: 1 } },
          { id: 's2', action: 'out.addRecord', params: { collectionId: table } },
        ],
      },
    }) as Op;

  it('Created new table and quick action logging to it: passed', async () => {
    const outcome = await judge({ kind: 'ops', ops: [newTable, quickAction('photos')] });
    expect(outcome).toEqual({ pass: true });
  });

  it('Rejections no longer count as correct', async () => {
    const plan: Plan = { kind: 'reject', reason: 'unknown', message: '没有', examples: [] };
    expect(await judge(plan)).toMatchObject({ pass: false });
  });

  it('Table creation only without quick action: does not count', async () => {
    expect(await judge({ kind: 'ops', ops: [newTable] })).toMatchObject({ pass: false });
  });

  it('Logging to existing expenses: does not count, user referred to another table', async () => {
    const outcome = await judge({ kind: 'ops', ops: [newTable, quickAction('expenses')] });
    expect(outcome).toMatchObject({ pass: false });
  });

  it('Built-in rules do not guess, reject as before', async () => {
    const config = buildSetup(c.setup, c.locale, registry);
    const plan = await createMockAIProvider().plan(c.input, {
      config,
      registry,
      locale: c.locale,
    });
    expect(plan.kind).toBe('reject');
    expect(c.mock).toBe(false);
  });
});

describe('Mixed plans (D-419): check after applying both features and appearance', () => {
  const now = new Date(2026, 10, 3);
  const c = EVAL_CASES.find((x) => x.id === 'FL1')!;
  const judge = async (plan: Plan) =>
    (await runEvalCase(c, { plan: async () => plan }, registry, now)).outcome;
  const visaAction: Op = {
    op: 'addTool',
    tool: {
      kind: 'quickAction',
      id: 'visa',
      name: '签证照片',
      steps: [
        { id: 'in', action: 'in.photos', params: { source: 'library', min: 1, max: 1 } },
        { id: 'photo', action: 'image.idPhoto', params: { spec: 'cn-visa', maxKB: 500 } },
      ],
    },
  };

  it('Mixed plans do not count as failure: pass if both are done correctly (cases requiring `next` do not need `next`)', async () => {
    const green: Op = { op: 'setTheme', primaryColor: '#2F9E44' };
    expect(await judge({ kind: 'ops', ops: [visaAction, green] })).toEqual({ pass: true });
  });

  it('Mixed plans with incorrect appearance still fail', async () => {
    const red: Op = { op: 'setTheme', primaryColor: '#E03131' };
    expect(await judge({ kind: 'ops', ops: [visaAction, red] })).toMatchObject({ pass: false });
  });

  it('Features only without `next`: appearance was not done, still fails', async () => {
    expect(await judge({ kind: 'ops', ops: [visaAction] })).toEqual({
      pass: false,
      reason: 'expected next with the look part',
    });
  });

  it('Appearance cannot be applied standalone: failure (user cannot actually obtain it)', async () => {
    const clash: Op = {
      op: 'addContainer',
      page: 'nowhere',
      block: { id: 'x', look: 'header', show: { title: 'x' } },
    };
    expect(await judge({ kind: 'ops', ops: [visaAction, clash] })).toMatchObject({ pass: false });
  });
});
