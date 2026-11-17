import {
  applyOps,
  BUILTIN_TOOLS,
  createDefaultWorkspace,
  createMockAIProvider,
  createRegistry,
  quickActionsOf,
  sampleOps,
  createStarterWorkspace,
  type Collection,
  type Workflow,
} from '@morph/core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { makePalette } from '../renderer/theme';
import { RecordEntryScreen } from '../run/local/RecordEntryScreen';
import type { LocalSteps, LocalUi } from '../runtime/local';
import { startRun } from '../runtime/runner';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, FakeSpeech } from '../test-utils/fake-files';
import { WorkspaceProvider } from '../workspace/context';
import { createWorkspaceStore } from '../workspace/store';

// 语音记一笔（D-575）：录音转出来的一句话交给「记一笔」，表单按它直接填有把握的字段（任何一张表），
// 写「按你说的填的」；存不存还是用户点「保存」。

const registry = createRegistry(BUILTIN_TOOLS);
type Entry = LocalSteps['recordEntry'];

const todo: Collection = {
  id: 'todo',
  name: '待办',
  fields: [
    { id: 'title', name: '事项', type: 'text' },
    { id: 'done', name: '完成', type: 'checkbox' },
    { id: 'due', name: '截止日期', type: 'date' },
  ],
};
const expenses: Collection = {
  id: 'expenses',
  name: '账目',
  fields: [
    { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
    { id: 'date', name: '日期', type: 'date', default: 'today' },
    { id: 'note', name: '备注', type: 'note' },
  ],
};

/** 音频工具的「转文字」后面接「记一笔」。 */
function voiceWorkflow(collectionId: string): Workflow {
  const result = applyOps(
    createDefaultWorkspace('zh'),
    [{ op: 'setPackage', package: 'audio', do: 'add' }],
    { registry, locale: 'zh' },
  );
  if (!result.ok) throw new Error(result.error);
  const base = quickActionsOf(result.config).find((w) => w.id === 'audio-transcribe')!;
  const upToText = base.steps.slice(
    0,
    base.steps.findIndex((s) => s.action === 'audio.transcribe') + 1,
  );
  return {
    ...base,
    id: 'voice',
    steps: [...upToText, { id: 'add', action: 'out.addRecord', params: { collectionId } }],
  };
}

async function runVoice(texts: string[], recordings: number) {
  const files = new FakeFiles();
  const speech = new FakeSpeech();
  speech.texts = texts;
  files.speech = speech;
  files.nextPick = Array.from({ length: recordings }, (_, i) =>
    files.offerAudio(`录音${i}.m4a`, { size: 1000 }),
  );
  const opened: Entry['in'][] = [];
  const ui: LocalUi = {
    confirm: async () => true,
    choose: async () => null,
    open: async (kind, input) => {
      if (kind !== 'recordEntry') return null;
      opened.push(input as Entry['in']);
      return { values: {} } as never;
    },
  };
  let n = 0;
  const { result } = await startRun({
    workflow: voiceWorkflow('expenses'),
    revisionId: 1,
    repo: new MemoryWorkspaceRepo(),
    files,
    registry,
    locale: 'zh',
    now: () => new Date(2026, 10, 17, 10),
    newId: () => `id${++n}`,
    ui,
    collections: [expenses],
    askParams: async (r) => r.params,
    ensurePack: async () => true,
  });
  return { result, opened };
}

describe('收据样板的「语音添加」（D-576）', () => {
  it('录一段音、转成文字、打开收据表单，表单拿到这句话', async () => {
    const base = createStarterWorkspace('zh', registry);
    const sample = sampleOps('receipts', base, 'zh');
    if (!sample.ok) throw new Error(sample.message);
    const applied = applyOps(base, sample.ops, { registry, locale: 'zh' });
    if (!applied.ok) throw new Error(applied.error);
    const workflow = quickActionsOf(applied.config).find((w) => w.id === 'voice-receipt')!;
    expect(workflow.steps.map((st) => st.action)).toEqual([
      'in.audio',
      'audio.transcribe',
      'out.addRecord',
    ]);
    const files = new FakeFiles();
    const speech = new FakeSpeech();
    speech.texts = ['昨天在超市买了二十三块五'];
    files.speech = speech;
    const recorded = files.offerAudio('录音.m4a', { size: 1000 });
    const opened: Entry['in'][] = [];
    const kinds: string[] = [];
    const ui: LocalUi = {
      confirm: async () => true,
      choose: async () => null,
      open: async (kind, input) => {
        kinds.push(kind);
        if (kind === 'record') return recorded as never;
        if (kind !== 'recordEntry') return null;
        opened.push(input as Entry['in']);
        return { values: {} } as never;
      },
    };
    let n = 0;
    const { result } = await startRun({
      workflow,
      revisionId: 1,
      repo: new MemoryWorkspaceRepo(),
      files,
      registry,
      locale: 'zh',
      now: () => new Date(2026, 10, 17, 10),
      newId: () => `id${++n}`,
      ui,
      collections: applied.config.data.tables,
      askParams: async (r) => r.params,
      ensurePack: async () => true,
    });
    expect(result.status).toBe('succeeded');
    expect(kinds).toEqual(['record', 'recordEntry']);
    expect(speech.calls[0]).toMatchObject({ language: 'zh' });
    expect(opened[0]).toMatchObject({ heard: '昨天在超市买了二十三块五' });
    // 原话放进备注，不放进第一个文字字段「商家」。
    expect(opened[0]!.prefill).toEqual({ note: '昨天在超市买了二十三块五' });
  });
});

describe('录音 → 转文字 → 记一笔（D-575）', () => {
  it('一段录音：表单拿到用户说的话，原话照旧放进长文本字段', async () => {
    const { result, opened } = await runVoice(['打车花了三十五块'], 1);
    expect(result.status).toBe('succeeded');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      heard: '打车花了三十五块',
      prefill: { note: '打车花了三十五块' },
    });
  });

  it('几段录音拼起来的文字不算一句话：不直接填', async () => {
    const { opened } = await runVoice(['打车花了三十五块', '午饭二十'], 2);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.heard).toBeUndefined();
  });
});

const day = (shift: number) => {
  const d = new Date();
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + shift);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

async function openForm(
  collection: Collection,
  heard?: string,
  prefill: Record<string, unknown> = {},
) {
  const repo = new MemoryWorkspaceRepo();
  const files = new FakeFiles();
  const store = createWorkspaceStore({
    repo,
    provider: createMockAIProvider(),
    registry,
    locale: 'zh',
    now: () => new Date(),
  });
  await store.getState().boot();
  const onDone = jest.fn();
  await render(
    <WorkspaceProvider value={{ store, repo, files, registry, locale: 'zh' }}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 400, height: 800 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}>
        <RecordEntryScreen
          input={{
            collection,
            prefill,
            index: 0,
            total: 1,
            ...(heard !== undefined ? { heard } : {}),
          }}
          palette={makePalette(createDefaultWorkspace('zh').theme, false)}
          locale="zh"
          onDone={onDone}
          onCancel={jest.fn()}
        />
      </SafeAreaProvider>
    </WorkspaceProvider>,
  );
  // 候选是异步算的。
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { onDone };
}

describe('表单按说的话直接填（D-575）', () => {
  it('待办：「明天」直接填进截止日期，下面写「按你说的填的」；没说的字段不动', async () => {
    await openForm(todo, '明天给妈妈打电话');
    expect(screen.getByTestId('entry-due').props.value).toBe(day(1));
    expect(screen.getByText('按你说的填的')).toBeTruthy();
    expect(screen.getByTestId('entry-due-heard')).toBeTruthy();
    expect(screen.queryByTestId('entry-title-heard')).toBeNull();
  });

  it('账目：金额直接填（数量和钱分得开），默认的今天被说的「昨天」换掉；用户一改，提示就不写了', async () => {
    await openForm(expenses, '昨天买了3瓶水花了6块');
    expect(screen.getByTestId('entry-amount').props.value).toBe('6');
    expect(screen.getByTestId('entry-date').props.value).toBe(day(-1));
    expect(screen.getByTestId('entry-amount-heard')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('entry-amount'), '7');
    expect(screen.getByTestId('entry-amount').props.value).toBe('7');
    expect(screen.queryByTestId('entry-amount-heard')).toBeNull();
    expect(screen.getByTestId('entry-date-heard')).toBeTruthy();
  });

  it('拿不准的（两个金额）不直接填，给候选，点了才填', async () => {
    await openForm(expenses, '一个30块一个50块');
    expect(screen.getByTestId('entry-amount').props.value ?? '').toBe('');
    expect(screen.getByTestId('entry-amount-suggestion-0')).toBeTruthy();
    expect(screen.queryByText('按你说的填的')).toBeNull();
  });

  it('不是说的话（没有 heard）：什么都不直接填', async () => {
    await openForm(todo, undefined, { title: '明天给妈妈打电话' });
    expect(screen.getByTestId('entry-due').props.value ?? '').toBe('');
    expect(screen.queryByText('按你说的填的')).toBeNull();
  });

  it('存的时候交的是填好的值（保存还是用户点）', async () => {
    const { onDone } = await openForm(expenses, '午饭花了二十三块五');
    expect(onDone).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('local-done'));
    expect(onDone).toHaveBeenCalledWith({
      values: expect.objectContaining({ amount: '23.5' }),
    });
  });
});
