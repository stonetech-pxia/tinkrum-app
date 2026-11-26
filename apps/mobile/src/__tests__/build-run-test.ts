import {
  type AIProvider,
  BUILTIN_TOOLS,
  checkTools,
  createRegistry,
  openItems,
  type Plan,
  type PlanContext,
  remindersOf,
  sessionProblems,
} from '@morph/core';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { createWorkspaceStore, type WorkspaceStore } from '../workspace/store';

// Large engineering step-by-step (D-415) and tool inventory (D-414). Uses fake planner without sending real requests.

const registry = createRegistry(BUILTIN_TOOLS);

const table = (id: string): Plan => ({
  kind: 'ops',
  ops: [
    {
      op: 'addData',
      table: { id, name: id, fields: [{ id: 'title', name: '名字', type: 'text' }] },
    },
  ],
});

const page = (id: string): Plan => ({
  kind: 'ops',
  ops: [
    {
      op: 'addContainer',
      page: 'home',
      block: {
        id: `${id}-add`,
        look: 'button',
        show: { label: '添加', shape: 'filled' },
        tools: [{ do: 'create', table: id, ask: 'all' }],
      },
    },
    {
      op: 'addContainer',
      page: 'home',
      block: {
        id: `${id}-list`,
        look: 'list',
        source: { table: id, limit: 30 },
        show: { title: 'title' },
      },
    },
  ],
});

const green: Plan = { kind: 'ops', ops: [{ op: 'setTheme', primaryColor: '#2F9E44' }] };

const reminder: Plan = {
  kind: 'ops',
  ops: [
    {
      op: 'addTool',
      tool: {
        kind: 'reminder',
        id: 'read',
        title: '看书',
        enabled: true,
        when: { every: 'day', at: '09:00' },
        opens: 'page:home',
      },
    },
  ],
};

const STEPS = [
  { id: 'data', kind: 'record', title: '书单表', request: '建书单表' },
  { id: 'page', kind: 'look', title: '书单列表', request: '放书单列表' },
  { id: 'remind', kind: 'record', title: '每天提醒', request: '每天提醒看书' },
  { id: 'theme', kind: 'look', title: '绿色主题', request: '主题换成绿色' },
] as const;

const SCRIPT: Record<string, Plan> = {
  建书单表: table('books'),
  放书单列表: page('books'),
  每天提醒看书: reminder,
  主题换成绿色: green,
  '搭建读书 App': { kind: 'build', summary: '一个读书 App', steps: [...STEPS] },
};

/** planFails: these sentences throw an error on the first attempt. */
function setup(
  options: {
    repo?: MemoryWorkspaceRepo;
    fails?: string[];
    script?: Record<string, Plan>;
    /** What the request sent for "fix these" returns. */
    fixPlan?: Plan;
  } = {},
) {
  const repo = options.repo ?? new MemoryWorkspaceRepo();
  const fails = new Set(options.fails ?? []);
  const calls: { input: string; ctx: PlanContext }[] = [];
  const hooks: { before?: (input: string) => void | Promise<void> } = {};
  const provider: AIProvider = {
    plan: async (input, ctx) => {
      calls.push({ input, ctx });
      await hooks.before?.(input);
      if (fails.delete(input)) throw new Error('model down');
      if (input.startsWith('Fix these') && options.fixPlan) return options.fixPlan;
      const plan = { ...SCRIPT, ...options.script }[input];
      if (!plan) throw new Error(`no script: ${input}`);
      return plan;
    },
  };
  const store = createWorkspaceStore({
    repo,
    provider,
    registry,
    locale: 'zh',
    now: () => new Date(2026, 10, 3, 9, 0),
  });
  return { repo, store, calls, hooks };
}

async function booted(options: Parameters<typeof setup>[0] = {}) {
  const t = setup(options);
  await t.store.getState().boot();
  return t;
}

const phase = (store: WorkspaceStore) => store.getState().build?.phase;
const statuses = (store: WorkspaceStore) => store.getState().build?.steps.map((s) => s.status);
const planned = (store: WorkspaceStore) =>
  store.getState().draft?.steps.at(-1)?.config ?? store.getState().config!;

describe('Large projects generate a plan first', () => {
  it('Previous step also completed the subsequent step: this step is checked off but records "previously completed", not a failure, overall result proceeds normally', async () => {
    const { store } = await booted({
      script: {
        放书单列表: {
          kind: 'reject',
          reason: 'noChange',
          message: '已经有了',
          examples: [],
        } as Plan,
      },
    });
    await store.getState().change('搭建读书 App');
    await store.getState().startBuild();
    expect(phase(store)).toBe('finished');
    expect(statuses(store)).toEqual(['done', 'done', 'done', 'done']);
    const steps = store.getState().build!.steps;
    expect(steps.find((s) => s.id === 'page')!.already).toBe(true);
    expect(steps.filter((s) => s.already)).toHaveLength(1);
  });

  it('New user discusses large project: sees plan, nothing modified, tapping "Start" invokes the model (invariant 16)', async () => {
    const { store, calls } = await booted();
    const headId = store.getState().head!.id;
    expect(await store.getState().change('搭建读书 App')).toEqual({ kind: 'build' });
    expect(phase(store)).toBe('review');
    expect(store.getState().head!.id).toBe(headId);
    expect(calls).toHaveLength(1);
    expect(store.getState().session.items).toEqual([]);
  });

  it('Delete a step before starting: that step is not executed', async () => {
    const { store, calls } = await booted();
    await store.getState().change('搭建读书 App');
    await store.getState().removeBuildStep('remind');
    await store.getState().startBuild();
    expect(phase(store)).toBe('finished');
    expect(calls.map((c) => c.input)).toEqual([
      '搭建读书 App',
      '建书单表',
      '放书单列表',
      '主题换成绿色',
    ]);
    expect(remindersOf(store.getState().config!)).toEqual([]);
  });

  it('Steps deleted entirely: plan is gone, cannot start', async () => {
    const { store, calls } = await booted();
    await store.getState().change('搭建读书 App');
    for (const s of STEPS) await store.getState().removeBuildStep(s.id);
    expect(store.getState().build).toBeNull();
    await store.getState().startBuild();
    expect(calls).toHaveLength(1);
  });

  it('Small modifications do not generate a plan', async () => {
    const { store } = await booted();
    expect(await store.getState().change('主题换成绿色')).toMatchObject({ kind: 'drafted' });
    expect(store.getState().build).toBeNull();
  });

  it('Discussing large projects in the draft chat box also generates a plan', async () => {
    const { store } = await booted();
    await store.getState().change('主题换成绿色');
    expect(await store.getState().draftChange('搭建读书 App')).toEqual({ kind: 'build' });
    expect(phase(store)).toBe('review');
  });
});

describe('Step-by-step execution', () => {
  it('Features take effect immediately, appearance enters draft (invariant 7); one call per step, with inventory and step position', async () => {
    const { store, calls } = await booted();
    await store.getState().change('搭建读书 App');
    await store.getState().startBuild();
    expect(phase(store)).toBe('finished');
    expect(statuses(store)).toEqual(['done', 'done', 'done', 'done']);

    const { config, draft } = store.getState();
    // Feature entered the official version.
    expect(config!.data.tables.some((t) => t.id === 'books')).toBe(true);
    expect(remindersOf(config!).map((r) => r.id)).toEqual(['read']);
    // Appearance is still in draft, not opened yet, waiting for user review.
    expect(config!.theme.primaryColor).not.toBe('#2F9E44');
    expect(draft).toMatchObject({ open: false });
    expect(draft!.steps.map((s) => s.input)).toEqual(['放书单列表', '主题换成绿色']);
    expect(draft!.steps.at(-1)!.config.theme.primaryColor).toBe('#2F9E44');

    const steps = calls.slice(1);
    expect(steps.map((c) => c.ctx.session?.step)).toEqual([
      { index: 1, total: 4, remaining: 3 },
      { index: 2, total: 4, remaining: 2 },
      { index: 3, total: 4, remaining: 1 },
      { index: 4, total: 4, remaining: 0 },
    ]);
    expect(steps[0]!.ctx.session!.goal).toBe('一个读书 App');
    // Second step can see the table created in the previous step.
    expect(steps[1]!.ctx.config.data.tables.some((t) => t.id === 'books')).toBe(true);
    // Ongoing items are not listed again, subsequent ones are present.
    expect(steps[1]!.ctx.session!.open.map((i) => i.text)).toEqual([
      '每天提醒看书',
      '主题换成绿色',
    ]);
    // Do not pop up a series of "Modified · Undo".
    await store.getState().markRendered(store.getState().head!.id);
    expect(store.getState().banner).toBeNull();
  });

  it('Overall check after completion: all tools usable, inventory fully completed; app draft goes through standard confirmation', async () => {
    const { store } = await booted();
    await store.getState().change('搭建读书 App');
    await store.getState().startBuild();
    expect(openItems(store.getState().session)).toEqual([]);
    expect(
      checkTools(planned(store), registry).issues.filter((i) => i.severity === 'blocker'),
    ).toEqual([]);
    store.getState().openDraft();
    await store.getState().applyDraft();
    expect(store.getState().config!.theme.primaryColor).toBe('#2F9E44');
    await store.getState().endBuild();
    expect(store.getState().build).toBeNull();
  });

  it('Can also complete 8 steps', async () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      kind: 'record' as const,
      title: `表 ${i}`,
      request: `建表${i}`,
    }));
    const script: Record<string, Plan> = { 大的: { kind: 'build', summary: '大的', steps } };
    for (let i = 0; i < 8; i++) script[`建表${i}`] = table(`t${i}`);
    const { store } = await booted({ script });
    await store.getState().change('大的');
    await store.getState().startBuild();
    expect(phase(store)).toBe('finished');
    expect(store.getState().config!.data.tables).toHaveLength(8);
  });

  it('Feature completion in a step leaves appearance remaining (next): continue in the same step without requiring user to tap again', async () => {
    const script: Record<string, Plan> = {
      建书单表: { ...table('books'), next: '放书单列表' } as Plan,
    };
    const { store, calls } = await booted({ script });
    await store.getState().change('搭建读书 App');
    await store.getState().removeBuildStep('page');
    await store.getState().startBuild();
    expect(calls.map((c) => c.input).slice(1, 3)).toEqual(['建书单表', '放书单列表']);
    expect(store.getState().next).toBeNull();
    expect(openItems(store.getState().session)).toEqual([]);
  });
});

describe('Both feature and appearance are present in the step plan (D-419)', () => {
  const opsOf = (plan: Plan) => (plan.kind === 'ops' ? plan.ops : []);
  const both: Plan = { kind: 'ops', ops: [...opsOf(table('books')), ...opsOf(page('books'))] };

  it('Appearance enters draft without opening, without querying the model extra, completes "view appearance"', async () => {
    const { store, calls } = await booted({ script: { 建书单表: both } });
    await store.getState().change('搭建读书 App');
    await store.getState().removeBuildStep('page');
    await store.getState().removeBuildStep('remind');
    await store.getState().removeBuildStep('theme');
    await store.getState().startBuild();

    expect(calls.map((c) => c.input)).toEqual(['搭建读书 App', '建书单表']);
    expect(phase(store)).toBe('finished');
    expect(statuses(store)).toEqual(['done']);
    const { config, draft, banner } = store.getState();
    expect(config!.data.tables.some((t) => t.id === 'books')).toBe(true);
    expect(draft).toMatchObject({ open: false });
    expect(draft!.steps).toHaveLength(1);
    expect(banner).toBeNull();
    // Overall check at the end sees the draft-included state: table has an entry point, this step is successfully completed.
    expect(openItems(store.getState().session)).toEqual([]);
    expect(store.getState().session.items.find((i) => i.id === 'b-data')!.status).toBe('done');

    store.getState().openDraft();
    expect(store.getState().draft!.open).toBe(true);
    await store.getState().applyDraft();
    expect(checkTools(store.getState().config!, registry).issues).not.toContainEqual(
      expect.objectContaining({ severity: 'blocker', target: 'table:books' }),
    );
  });
});

describe('Step failure', () => {
  it('Stop when model fails, keep completed work; retry to continue', async () => {
    const { store } = await booted({ fails: ['放书单列表'] });
    await store.getState().change('搭建读书 App');
    await store.getState().startBuild();
    expect(phase(store)).toBe('failed');
    expect(statuses(store)).toEqual(['done', 'failed', 'todo', 'todo']);
    expect(store.getState().build!.steps[1]!.reason).toBe('Tink 这一步没有回答，可以重试。');
    expect(store.getState().config!.data.tables.some((t) => t.id === 'books')).toBe(true);
    expect(store.getState().session.items.find((i) => i.text === '放书单列表')!.status).toBe(
      'failed',
    );

    await store.getState().resumeBuild();
    expect(phase(store)).toBe('finished');
    expect(openItems(store.getState().session)).toEqual([]);
  });

  it('Stop when invalid; skip and continue with subsequent ones', async () => {
    const script: Record<string, Plan> = {
      每天提醒看书: {
        kind: 'ops',
        ops: [{ op: 'removeData', table: 'nothing' }],
      },
    };
    const { store } = await booted({ script });
    await store.getState().change('搭建读书 App');
    await store.getState().startBuild();
    expect(phase(store)).toBe('failed');
    expect(statuses(store)).toEqual(['done', 'done', 'failed', 'todo']);
    await store.getState().skipBuildStep();
    expect(phase(store)).toBe('finished');
    expect(statuses(store)).toEqual(['done', 'done', 'skipped', 'done']);
    expect(store.getState().session.items.find((i) => i.text === '每天提醒看书')!.status).toBe(
      'skipped',
    );
  });

  it('Stop if blockers remain, explain reasons (the last step is exempted as there are no subsequent steps)', async () => {
    const script: Record<string, Plan> = {
      只有按钮: {
        kind: 'ops',
        ops: [(page('books') as Extract<Plan, { kind: 'ops' }>).ops[0]!],
      },
      两步: {
        kind: 'build',
        summary: '两步',
        steps: [
          { id: 'a', kind: 'record', title: '表', request: '建书单表' },
          { id: 'b', kind: 'look', title: '按钮', request: '只有按钮' },
        ],
      },
    };
    const { store } = await booted({ script });
    await store.getState().change('两步');
    await store.getState().startBuild();
    expect(phase(store)).toBe('failed');
    expect(store.getState().build!.steps[1]!.reason).toContain('books');
  });

  it('Requires using pages in the draft: stalls, tapping "Apply draft and continue" confirms the draft (invariant 7)', async () => {
    const script: Record<string, Plan> = {
      放书单列表: {
        kind: 'ops',
        ops: [
          {
            op: 'addContainer',
            page: {
              id: 'shelf',
              title: '书架',
              blocks: (page('books') as never as { ops: { block: object }[] }).ops.map(
                (o) => o.block,
              ),
            },
          },
        ],
      } as never,
      每天提醒看书: {
        kind: 'ops',
        ops: [
          {
            op: 'addTool',
            tool: {
              kind: 'reminder',
              id: 'read',
              title: '看书',
              enabled: true,
              when: { every: 'day', at: '09:00' },
              opens: 'page:shelf',
            },
          },
        ],
      },
    };
    const { store } = await booted({ script });
    await store.getState().change('搭建读书 App');
    await store.getState().startBuild();
    expect(phase(store)).toBe('failed');
    const stuck = store.getState().build!.steps[2]!;
    expect(stuck).toMatchObject({ status: 'failed', needsDraft: true });
    expect(stuck.reason).toBe('这一步要用到草稿里的页面。');
    expect(store.getState().config!.containers.pages.some((p) => p.id === 'shelf')).toBe(false);

    await store.getState().applyDraftForBuild();
    expect(phase(store)).toBe('finished');
    expect(store.getState().config!.containers.pages.some((p) => p.id === 'shelf')).toBe(true);
    expect(remindersOf(store.getState().config!).map((r) => r.id)).toEqual(['read']);
  });

  it('Model returns to plan or undo within a step: counts as step failure, does not initiate a new plan consecutively', async () => {
    const script: Record<string, Plan> = {
      放书单列表: { kind: 'build', summary: '又一份', steps: [...STEPS] },
      每天提醒看书: { kind: 'restorePrevious' },
    };
    const { store } = await booted({ script });
    await store.getState().change('搭建读书 App');
    await store.getState().startBuild();
    expect(phase(store)).toBe('failed');
    expect(store.getState().build!.summary).toBe('一个读书 App');
    await store.getState().skipBuildStep();
    expect(phase(store)).toBe('failed');
    expect(store.getState().config!.data.tables.some((t) => t.id === 'books')).toBe(true);
  });
});

describe('Stop and continue', () => {
  it('Stop midway: do not apply even if model returns, keep completed work; resume from this step', async () => {
    const { store, hooks } = await booted();
    await store.getState().change('搭建读书 App');
    hooks.before = async (input) => {
      if (input === '放书单列表') await store.getState().stopBuild();
    };
    await store.getState().startBuild();
    hooks.before = undefined;
    expect(phase(store)).toBe('paused');
    expect(statuses(store)).toEqual(['done', 'todo', 'todo', 'todo']);
    expect(store.getState().draft).toBeNull();

    await store.getState().resumeBuild();
    expect(phase(store)).toBe('finished');
    expect(statuses(store)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('No automatic continuation after restart (invariant 16): zero model calls, halts at unfinished step, resumes only when user taps', async () => {
    const repo = new MemoryWorkspaceRepo();
    const first = await booted({ repo });
    await first.store.getState().change('搭建读书 App');
    first.hooks.before = async (input) => {
      // Process terminated halfway through step 2: prevent this round from ending.
      if (input === '放书单列表') await new Promise(() => {});
    };
    void first.store.getState().startBuild();
    await new Promise((r) => setTimeout(r, 20));
    expect(statuses(first.store)).toEqual(['done', 'running', 'todo', 'todo']);

    const again = await booted({ repo });
    expect(again.calls).toEqual([]);
    expect(phase(again.store)).toBe('paused');
    expect(statuses(again.store)).toEqual(['done', 'todo', 'todo', 'todo']);
    expect(again.store.getState().session.goal).toBe('一个读书 App');

    await again.store.getState().resumeBuild();
    expect(phase(again.store)).toBe('finished');
    expect(again.calls.map((c) => c.input)).toEqual(['放书单列表', '每天提醒看书', '主题换成绿色']);
  });

  it('Finish after stopping: keep completed work, leave uncompleted in the inventory', async () => {
    const { store } = await booted({ fails: ['放书单列表'] });
    await store.getState().change('搭建读书 App');
    await store.getState().startBuild();
    await store.getState().stopBuild();
    expect(phase(store)).toBe('paused');
    await store.getState().endBuild();
    expect(store.getState().build).toBeNull();
    expect(store.getState().config!.data.tables.some((t) => t.id === 'books')).toBe(true);
    expect(openItems(store.getState().session).map((i) => i.text)).toEqual([
      '放书单列表',
      '每天提醒看书',
      '主题换成绿色',
    ]);
  });

  it('Restart while viewing plan: plan remains, not started', async () => {
    const repo = new MemoryWorkspaceRepo();
    const first = await booted({ repo });
    await first.store.getState().change('搭建读书 App');
    const again = await booted({ repo });
    expect(phase(again.store)).toBe('review');
    expect(again.calls).toEqual([]);
  });
});

describe('Tool inventory (D-414)', () => {
  it('Include previously discussed utterances and remaining items even outside the draft chat box', async () => {
    const script: Record<string, Plan> = {
      建书单表: { ...table('books'), next: '放书单列表' } as Plan,
    };
    const { store, calls } = await booted({ script });
    await store.getState().change('建书单表');
    await store.getState().change('每天提醒看书');
    const session = calls.at(-1)!.ctx.session!;
    expect(session.recent[0]).toMatchObject({ input: '建书单表', done: true });
    expect(session.open).toEqual([{ kind: 'look', text: '放书单列表', status: 'todo' }]);
  });

  it('Retained across app restarts; no longer sent after clearing', async () => {
    const repo = new MemoryWorkspaceRepo();
    const first = await booted({ repo });
    await first.store.getState().change('建书单表');
    const again = await booted({ repo });
    expect(again.store.getState().session.items[0]).toMatchObject({
      text: '建书单表',
      status: 'done',
    });
    await again.store.getState().clearSession();
    await again.store.getState().change('每天提醒看书');
    expect(again.calls.at(-1)!.ctx.session).toBeUndefined();
    const third = await booted({ repo });
    expect(third.store.getState().session.said.map((s) => s.input)).toEqual(['每天提醒看书']);
  });

  it('New users, old app versions without inventory: empty, used as usual; carry over utterances from old drafts', async () => {
    const fresh = await booted();
    expect(fresh.store.getState().session).toEqual({ items: [], said: [] });

    const repo = new MemoryWorkspaceRepo();
    const first = await booted({ repo });
    await first.store.getState().change('主题换成绿色');
    await repo.setMeta('session', '');
    const again = await booted({ repo });
    expect(again.store.getState().session.said.map((s) => s.input)).toEqual(['主题换成绿色']);
    expect(again.store.getState().session.items).toEqual([]);
  });

  it('Corrupted storage treated as empty', async () => {
    const repo = new MemoryWorkspaceRepo();
    await repo.setMeta('session', '{broken');
    await repo.setMeta('build', '{broken');
    const { store } = await booted({ repo });
    expect(store.getState().status).toBe('ready');
    expect(store.getState().session).toEqual({ items: [], said: [] });
    expect(store.getState().build).toBeNull();
  });

  it('Model claiming completion is ineffective: remaining blockers mean failed, code determines completion after fix', async () => {
    const script: Record<string, Plan> = {
      只有按钮: {
        kind: 'ops',
        ops: [(page('books') as Extract<Plan, { kind: 'ops' }>).ops[0]!],
      },
      加列表: {
        kind: 'ops',
        ops: [(page('books') as Extract<Plan, { kind: 'ops' }>).ops[1]!],
      },
    };
    const { store } = await booted({ script });
    await store.getState().change('建书单表');
    await store.getState().change('只有按钮');
    const item = store.getState().session.items[1]!;
    expect(item).toMatchObject({ text: '只有按钮', status: 'failed' });
    expect(item.reason).toContain('books');
    // List entered draft: also counts as the state seen after modification.
    await store.getState().draftChange('加列表');
    expect(openItems(store.getState().session)).toEqual([]);
    expect(store.getState().session.items[1]!.reason).toBeUndefined();
  });

  it('After undo: inform model that the utterance was not executed, inventory item counts as incomplete', async () => {
    const { store, calls } = await booted();
    await store.getState().change('每天提醒看书');
    await store.getState().markRendered(store.getState().head!.id);
    await store.getState().undo();
    await store.getState().change('建书单表');
    expect(calls.at(-1)!.ctx.session!.recent[0]).toMatchObject({
      input: '每天提醒看书',
      done: false,
    });
    expect(store.getState().session.items[0]!.status).toBe('skipped');
  });

  it('Draft step back, discard draft: that utterance no longer counts as said', async () => {
    const { store } = await booted();
    await store.getState().change('主题换成绿色');
    await store.getState().deleteDraft();
    expect(store.getState().session.said).toEqual([]);
    expect(store.getState().session.items[0]!.status).toBe('skipped');
  });
});

describe('Fix these (D-418)', () => {
  /** Table with add button but nowhere to view: books cannot be used. */
  const addOnly = (id: string): Plan => ({
    kind: 'ops',
    ops: [(page(id) as Extract<Plan, { kind: 'ops' }>).ops[0]!],
  });
  const listOnly = (id: string): Plan => ({
    kind: 'ops',
    ops: [(page(id) as Extract<Plan, { kind: 'ops' }>).ops[1]!],
  });
  const FIX = 'Fix these so the app can be used:\n';
  const problems = (store: WorkspaceStore) => {
    const s = store.getState();
    return sessionProblems(s.session, planned(store), registry);
  };
  it('No issues: do not send request', async () => {
    const { store, calls } = await booted();
    await store.getState().change('主题换成绿色');
    const count = calls.length;
    expect(await store.getState().fixProblems()).toBeNull();
    expect(calls).toHaveLength(count);
  });

  it('Send request per tap: model sees English issue, user records are in their own language, inventory count does not increase', async () => {
    const t = await booted({
      fixPlan: listOnly('books'),
      script: { 建书单表: table('books'), 放添加按钮: addOnly('books') },
    });
    const { store, calls } = t;
    await store.getState().change('建书单表');
    await store.getState().change('放添加按钮');
    const items = store.getState().session.items.length;
    const count = calls.length;
    const before = problems(store)[0]!;

    expect(await store.getState().fixProblems()).toMatchObject({ kind: 'drafted' });
    expect(calls).toHaveLength(count + 1);
    expect(calls.at(-1)!.input).toBe(`${FIX}- ${before.message}`);
    expect(store.getState().session.said.at(-1)!.input).toBe('把这些补上');
    expect(store.getState().session.items).toHaveLength(items);
    expect(store.getState().draft!.steps.at(-1)!.input).toBe('把这些补上');
    // Appearance entered draft (invariant 7): official version unchanged, issue resolved in draft.
    expect(problems(store)).toEqual([]);
    expect(await store.getState().fixProblems()).toBeNull();
    expect(calls).toHaveLength(count + 1);
  });

  it('Feature modifications take effect immediately, undoable (invariant 7)', async () => {
    const { store } = await booted({
      fixPlan: table('films'),
      script: { 建书单表: table('books'), 放添加按钮: addOnly('books') },
    });
    await store.getState().change('建书单表');
    await store.getState().change('放添加按钮');
    const head = store.getState().head!.id;
    expect(await store.getState().fixProblems()).toMatchObject({ kind: 'applied' });
    expect(store.getState().head!.id).not.toBe(head);
    expect(store.getState().config!.data.tables.map((x) => x.id)).toContain('films');
  });

  it('Issues remain: can tap again; no automatic looping', async () => {
    const t = await booted({
      fixPlan: green,
      script: { 建书单表: table('books'), 放添加按钮: addOnly('books') },
    });
    const { store, calls } = t;
    await store.getState().change('建书单表');
    await store.getState().change('放添加按钮');
    const count = calls.length;
    await store.getState().fixProblems();
    expect(calls).toHaveLength(count + 1);
    expect(problems(store)).not.toEqual([]);
    await store.getState().fixProblems();
    expect(calls).toHaveLength(count + 2);
  });

  it('Model rejection: nothing changed, can tap again, inventory count does not increase', async () => {
    const { store } = await booted({
      fixPlan: { kind: 'reject', reason: 'unknown', message: '不会', examples: [] },
      script: { 建书单表: table('books'), 放添加按钮: addOnly('books') },
    });
    await store.getState().change('建书单表');
    await store.getState().change('放添加按钮');
    const items = store.getState().session.items.length;
    expect(await store.getState().fixProblems()).toMatchObject({ kind: 'rejected' });
    expect(store.getState().session.items).toHaveLength(items);
    expect(problems(store)).not.toEqual([]);
  });

  it('Issues existing before session start are ignored; other sessions are also ignored', async () => {
    const repo = new MemoryWorkspaceRepo();
    const first = await booted({
      repo,
      script: { 建书单表: table('books'), 放添加按钮: addOnly('books') },
    });
    await first.store.getState().change('建书单表');
    await first.store.getState().change('放添加按钮');
    await first.store.getState().clearSession();

    const { store, calls } = await booted({ repo });
    await store.getState().change('主题换成绿色');
    expect(store.getState().session.startIssues).toEqual(['view-missing|table:books']);
    expect(problems(store)).toEqual([]);
    const count = calls.length;
    expect(await store.getState().fixProblems()).toBeNull();
    expect(calls).toHaveLength(count);
  });

  it('Issues in draft also count: remove list from draft, official version remains intact', async () => {
    const remove: Plan = {
      kind: 'ops',
      ops: [{ op: 'removeContainer', page: 'home', block: 'books-list' }],
    };
    const { store } = await booted({
      script: {
        建书单表: table('books'),
        放页面: page('books'),
        拿掉列表: remove,
      },
    });
    await store.getState().change('建书单表');
    await store.getState().change('放页面');
    await store.getState().applyDraft();
    expect(problems(store)).toEqual([]);
    await store.getState().change('拿掉列表');
    expect(store.getState().draft).not.toBeNull();
    expect(
      checkTools(store.getState().config!, registry).issues.filter((i) => i.severity === 'blocker'),
    ).toEqual([]);
    expect(problems(store).map((i) => i.target)).toEqual(['table:books']);
  });

  it('Starting point remains after restart', async () => {
    const repo = new MemoryWorkspaceRepo();
    const a = await booted({
      repo,
      script: { 建书单表: table('books'), 放添加按钮: addOnly('books') },
    });
    await a.store.getState().change('建书单表');
    await a.store.getState().change('放添加按钮');
    const b = await booted({ repo });
    expect(problems(b.store).map((i) => i.target)).toEqual(['table:books']);
  });
});
