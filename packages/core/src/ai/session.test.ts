import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS } from '../tools';
import { createRegistry } from '../registry';
import { createDefaultWorkspace } from '../defaults';
import type { Op } from '../ops';
import { prepareOps } from '../change';
import { checkTools } from '../tool-check';
import {
  SESSION_MAX_ITEMS,
  SESSION_RECENT,
  commitDrafted,
  dropDrafted,
  emptySession,
  fixRequest,
  markSessionStart,
  markUndone,
  openItems,
  parseSession,
  planSession,
  recheckItems,
  recordTurn,
  sessionProblems,
  startBuildItems,
  toolVerdict,
  workKindOfOps,
} from './session';
import { createMockAIProvider } from './mock';

const registry = createRegistry(BUILTIN_TOOLS);
const config = createDefaultWorkspace('zh');
const ctx = { registry, locale: 'zh' as const, now: new Date(2026, 10, 3) };

const tableOp: Op = {
  op: 'addData',
  table: { id: 'books', name: '书单', fields: [{ id: 'title', name: '书名', type: 'text' }] },
} as Op;
const pageOps: Op[] = [
  {
    op: 'addContainer',
    page: 'home',
    block: {
      id: 'books-list',
      look: 'list',
      source: { table: 'books', limit: 30 },
      show: { title: 'title' },
    },
  },
  {
    op: 'addContainer',
    page: 'home',
    block: {
      id: 'books-add',
      look: 'button',
      show: { label: '添加', shape: 'filled' },
      tools: [{ do: 'create', table: 'books', ask: 'all' }],
    },
  },
] as unknown as Op[];

function apply(ops: Op[], base = config) {
  const r = prepareOps(base, ops, ctx);
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r.after;
}

describe('Tool list: store and read', () => {
  it('Missing in old app or corrupted storage both result in empty (invariant 12)', () => {
    expect(parseSession(null)).toEqual(emptySession());
    expect(parseSession('')).toEqual(emptySession());
    expect(parseSession('{oops')).toEqual(emptySession());
    expect(parseSession('{"items":"x"}')).toEqual(emptySession());
  });

  it('Read after store is identical', () => {
    const s = recordTurn(emptySession(), {
      input: '建表',
      reply: '好',
      done: true,
      kind: 'record',
    });
    expect(parseSession(JSON.stringify(s))).toEqual(s);
  });
});

describe('Tool list: who decides', () => {
  it('Considered done only when there are no related blockers', () => {
    const before = config;
    const after = apply([tableOp, pageOps[1]!]);
    const bad = toolVerdict(before, after, registry);
    expect(bad.targets).toContain('table:books');
    expect(bad.blockers.length).toBeGreaterThan(0);
    const failed = recordTurn(emptySession(), {
      input: '建书单',
      reply: '',
      done: true,
      kind: 'record',
      verdict: bad,
      reason: '还没有地方能看到',
    });
    expect(failed.items[0]).toMatchObject({ status: 'failed', reason: '还没有地方能看到' });

    const good = apply([tableOp, ...pageOps]);
    const ok = toolVerdict(before, good, registry);
    expect(ok.blockers).toEqual([]);
    expect(
      recordTurn(emptySession(), { input: 'x', reply: '', done: true, kind: 'record', verdict: ok })
        .items[0],
    ).toMatchObject({ status: 'done' });
  });

  it('Not a blocker when a page step comes later; must be counted during overall check', () => {
    const after = apply([tableOp, pageOps[1]!]);
    const later = toolVerdict(config, after, registry, { later: true });
    expect(later.blockers).toEqual([]);
    const s = recordTurn(emptySession(), {
      input: '建书单',
      reply: '',
      done: true,
      kind: 'record',
      verdict: later,
    });
    expect(s.items[0]!.status).toBe('done');
    const checked = recheckItems(s, after, registry, 'zh', { all: true });
    expect(checked.items[0]!.status).toBe('failed');
    expect(checked.items[0]!.reason).toContain('书单');
  });

  it('If something unfinished is later completed, it counts as done without the model needing to say so', () => {
    const after = apply([tableOp, pageOps[1]!]);
    const s = recordTurn(emptySession(), {
      input: '建书单',
      reply: '',
      done: true,
      kind: 'record',
      verdict: toolVerdict(config, after, registry),
      reason: 'x',
    });
    expect(openItems(s)).toHaveLength(1);
    const fixed = apply([pageOps[0]!], after);
    expect(checkTools(fixed, registry).issues.filter((i) => i.severity === 'blocker')).toEqual([]);
    const again = recheckItems(s, fixed, registry, 'zh');
    expect(again.items[0]).toMatchObject({ status: 'done' });
    expect(again.items[0]!.reason).toBeUndefined();
  });

  it('If not done, it does not enter the list, but we remember it was said', () => {
    const s = recordTurn(emptySession(), { input: '写封信', reply: '不替你写', done: false });
    expect(s.items).toEqual([]);
    expect(s.said).toEqual([{ input: '写封信', done: false, reply: '不替你写' }]);
  });

  it('Click an item in the list and talk about it again: still that same item, not an extra one', () => {
    let s = recordTurn(emptySession(), {
      input: '建表',
      reply: '',
      done: true,
      kind: 'record',
      next: '主题换成蓝色',
    });
    expect(openItems(s).map((i) => i.text)).toEqual(['主题换成蓝色']);
    s = recordTurn(s, { input: '主题换成蓝色', reply: '', done: true, kind: 'look' });
    expect(s.items).toHaveLength(2);
    expect(openItems(s)).toEqual([]);
  });
});

describe('Tool list: upper limit', () => {
  it('At most 12 items, drop completed ones first; keep unfinished ones', () => {
    let s = startBuildItems(
      emptySession(),
      '目标',
      Array.from({ length: 4 }, (_, i) => ({
        id: `s${i}`,
        kind: 'record' as const,
        request: `步骤${i}`,
      })),
    );
    for (let i = 0; i < 20; i++)
      s = recordTurn(s, { input: `句子${i}`, reply: '', done: true, kind: 'look' });
    expect(s.items).toHaveLength(SESSION_MAX_ITEMS);
    expect(openItems(s)).toHaveLength(4);
    expect(s.said).toHaveLength(SESSION_RECENT);
    expect(s.said.at(-1)!.input).toBe('句子19');
  });
});

describe('Tool list: undo and draft', () => {
  it('Draft step back: that utterance no longer counts as said, and that item no longer counts as done', () => {
    let s = recordTurn(emptySession(), { input: 'a', reply: '', done: true, kind: 'look', cr: 7 });
    s = dropDrafted(s, [7]);
    expect(s.said).toEqual([]);
    expect(s.items[0]!.status).toBe('skipped');
  });

  it('Draft applied and then undone: tell the model this utterance was undone', () => {
    let s = recordTurn(emptySession(), { input: 'a', reply: '', done: true, kind: 'look', cr: 7 });
    s = commitDrafted(s, [7], 40);
    expect(s.said[0]).toMatchObject({ rev: 40 });
    s = markUndone(s, (rev) => rev === 40);
    expect(s.said[0]).toMatchObject({ done: false, reply: 'undone by the user' });
    expect(s.items[0]!.status).toBe('skipped');
  });
});

describe('Appearance sent to the model', () => {
  it('Do not send empty ones', () => {
    expect(planSession(emptySession())).toBeUndefined();
  });

  it('Only unfinished items and recent utterances; the current utterance being processed is not listed again', () => {
    let s = startBuildItems(emptySession(), '记账 App', [
      { id: 'a', kind: 'record', request: '建表' },
      { id: 'b', kind: 'look', request: '换颜色' },
    ]);
    s = recordTurn(s, { input: '建表', reply: '建好了', done: true, kind: 'record' });
    expect(
      planSession(s, { current: '换颜色', step: { index: 2, total: 2, remaining: 0 } }),
    ).toEqual({
      goal: '记账 App',
      open: [],
      recent: [{ input: '建表', done: true, reply: '建好了' }],
      step: { index: 2, total: 2, remaining: 0 },
    });
  });
});

describe('Which tool type this utterance belongs to', () => {
  it('Determine based on operations', () => {
    expect(workKindOfOps([tableOp])).toBe('record');
    expect(workKindOfOps(pageOps)).toBe('look');
    expect(workKindOfOps([{ op: 'setPackage', package: 'image', do: 'add' } as Op])).toBe('file');
    expect(
      workKindOfOps([
        {
          op: 'addTool',
          tool: { kind: 'quickAction', id: 'a', name: 'a', steps: [] },
        } as unknown as Op,
      ]),
    ).toBe('file');
    expect(
      workKindOfOps([
        {
          op: 'addTool',
          tool: {
            kind: 'quickAction',
            id: 'a',
            name: 'a',
            steps: [{ id: 's', action: 'x', params: { out: { addRecord: {} } } }],
          },
        } as unknown as Op,
      ]),
    ).toBe('fileToRecord');
  });
});

describe('Built-in rules major engineering message (only reachable in simulator)', () => {
  it('Saying major engineering returns to plan, with steps that can be handled by built-in rules; small changes do not produce a plan', async () => {
    const mock = createMockAIProvider();
    const plan = await mock.plan('搭建一个记账 App', { config, registry, locale: 'zh' });
    expect(plan.kind).toBe('build');
    if (plan.kind !== 'build') return;
    for (const step of plan.steps) {
      const r = await mock.plan(step.request, { config, registry, locale: 'zh' });
      expect(r.kind).toBe('ops');
    }
    expect((await mock.plan('主题换成绿色', { config, registry, locale: 'zh' })).kind).toBe('ops');
  });

  it('Reachable in English and French interfaces as well; French interface title is in French', async () => {
    const mock = createMockAIProvider();
    const plan = await mock.plan('Build a budget app', { config, registry, locale: 'fr' });
    expect(plan).toMatchObject({ kind: 'build', summary: 'Une app de budget prête à servir' });
    if (plan.kind !== 'build') return;
    for (const step of plan.steps) {
      const r = await mock.plan(step.request, { config, registry, locale: 'fr' });
      expect(r.kind).toBe('ops');
    }
  });

  it('A step marked with a failure token throws an error the first time, retry fixes it', async () => {
    const mock = createMockAIProvider();
    const plan = await mock.plan('搭建一个记账 App，有一步会失败', {
      config,
      registry,
      locale: 'zh',
    });
    if (plan.kind !== 'build') throw new Error('not a plan');
    const failing = plan.steps.find((s) => s.request.includes('#fail-once'))!;
    await expect(mock.plan(failing.request, { config, registry, locale: 'zh' })).rejects.toThrow();
    expect((await mock.plan(failing.request, { config, registry, locale: 'zh' })).kind).toBe('ops');
  });
});

describe('New issues introduced in this session (patch these up)', () => {
  const addButton = pageOps[1]!;
  const listBlock = pageOps[0]!;
  // Has an add button but nowhere to view it: books cannot be used.
  const broken = apply([tableOp, addButton]);
  const fixed = apply([listBlock], broken);
  const worked = (s = markSessionStart(emptySession(), config, registry)) =>
    recordTurn(s, { input: '加书单', reply: '加了', done: true, kind: 'record' });

  it('Prerequisite: problematic config actually has blockers, fixed ones do not', () => {
    expect(checkTools(broken, registry).issues.filter((i) => i.severity === 'blocker')).not.toEqual(
      [],
    );
    expect(checkTools(fixed, registry).issues.filter((i) => i.severity === 'blocker')).toEqual([]);
  });

  it('No issues: nothing counts', () => {
    expect(sessionProblems(worked(), config, registry)).toEqual([]);
  });

  it('Issues created in this session must count, disappear once fixed', () => {
    const left = sessionProblems(worked(), broken, registry);
    expect(left.map((i) => `${i.code}|${i.target}`)).toEqual(['view-missing|table:books']);
    expect(sessionProblems(worked(), fixed, registry)).toEqual([]);
  });

  it('Pre-existing issues from the start do not count, only new ones arising after the start count', () => {
    const s = worked(markSessionStart(emptySession(), broken, registry));
    expect(sessionProblems(s, broken, registry)).toEqual([]);
    const more = apply(
      [
        {
          op: 'addData',
          table: { id: 'films', name: '片单', fields: [{ id: 'title', name: '名', type: 'text' }] },
        } as Op,
        {
          op: 'addContainer',
          page: 'home',
          block: {
            id: 'films-add',
            look: 'button',
            show: { label: '添加', shape: 'filled' },
            tools: [{ do: 'create', table: 'films', ask: 'all' }],
          },
        } as unknown as Op,
      ],
      broken,
    );
    expect(sessionProblems(s, more, registry).map((i) => i.target)).toEqual(['table:films']);
  });

  it('No entries in session, or all done ones were undone: does not count', () => {
    const start = markSessionStart(emptySession(), config, registry);
    expect(sessionProblems(start, broken, registry)).toEqual([]);
    const undone = markUndone(
      { ...worked(), items: worked().items.map((i) => ({ ...i, rev: 5 })) },
      (rev) => rev === 5,
    );
    expect(sessionProblems(undone, broken, registry)).toEqual([]);
  });

  it('later: page is in the next utterance, new table temporarily without entry point does not count', () => {
    expect(sessionProblems(worked(), broken, registry, { later: true })).toEqual([]);
  });

  it('Start point is recorded only once at session start; re-recorded after clearing; sessions stored by older apps without a start point also get it patched', () => {
    const s = worked(markSessionStart(emptySession(), config, registry));
    expect(markSessionStart(s, broken, registry)).toBe(s);
    expect(markSessionStart(emptySession(), broken, registry).startIssues).toEqual([
      'view-missing|table:books',
    ]);
    const old = recordTurn(emptySession(), { input: '旧', reply: '', done: true, kind: 'look' });
    expect(markSessionStart(old, broken, registry).startIssues).toEqual([
      'view-missing|table:books',
    ]);
  });

  it('Start point is preserved across app restarts and not sent to the model', () => {
    const s = worked(markSessionStart(emptySession(), broken, registry));
    expect(parseSession(JSON.stringify(s)).startIssues).toEqual(['view-missing|table:books']);
    expect(JSON.stringify(planSession(s))).not.toContain('view-missing');
  });

  it('What is sent to the model is an English issue list, at most 10 items at a time', () => {
    const issue = (n: number) => ({
      severity: 'blocker' as const,
      code: 'view-missing',
      target: `table:t${n}`,
      message: `problem ${n}`,
    });
    expect(fixRequest([issue(1), issue(2)])).toBe(
      'Fix these so the app can be used:\n- problem 1\n- problem 2',
    );
    const many = fixRequest(Array.from({ length: 15 }, (_, n) => issue(n)));
    expect(many.split('\n')).toHaveLength(11);
  });
});
