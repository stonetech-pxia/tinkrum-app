import { AI_RETURN_TTL, aiReturnIsActive, attachReturnStore, useAiReturn } from '@/ai/return';
import { MemoryAttemptStore } from '@/test-utils/memory-attempts';

// 「等 AI 结果」的标记在 Android 杀掉进程后还在（体检后补：D-638）。
// 「重启」= 清掉内存里的标记，再接上同一个文件。

const restart = (store: MemoryAttemptStore, now?: number) => {
  useAiReturn.setState({ pending: null });
  attachReturnStore(store, now);
};

it('keeps the mark across a process restart, and a dismissal across it too', () => {
  const file = new MemoryAttemptStore();
  restart(file);
  const started = useAiReturn.getState().start('setup', Date.now());
  restart(file);
  expect(useAiReturn.getState().pending).toEqual(started);
  // 之后的新标记 ID 不会和读回来的重复，旧导入结束时不会关掉新卡片。
  const later = useAiReturn.getState().start('new', Date.now());
  expect(later.id).toBeGreaterThan(started.id);
  useAiReturn.getState().dismiss(started.id);
  expect(useAiReturn.getState().pending).toEqual(later);
  useAiReturn.getState().dismiss(later.id);
  restart(file);
  expect(useAiReturn.getState().pending).toBeNull();
});

it('does not bring back an expired, corrupt or wrong mark, and never lets a broken disk matter', () => {
  const file = new MemoryAttemptStore();
  restart(file);
  const old = useAiReturn.getState().start('app', 1_000);
  restart(file, 1_000 + AI_RETURN_TTL);
  expect(useAiReturn.getState().pending).toBeNull();
  expect(aiReturnIsActive(old, 1_000 + AI_RETURN_TTL)).toBe(false);
  for (const text of ['not json', '{"id":1}', '{"id":1,"at":5,"scope":"nope"}', 'null']) {
    file.text = text;
    restart(file, 10);
    expect(useAiReturn.getState().pending).toBeNull();
  }
  file.broken = true;
  restart(file);
  expect(() => useAiReturn.getState().start('new')).not.toThrow();
  expect(useAiReturn.getState().pending?.scope).toBe('new');
});

it('writes only when the user hands over, imports or closes the card, not when it is read', () => {
  const file = new MemoryAttemptStore();
  restart(file);
  expect(file.text).toBeNull();
  const m = useAiReturn.getState().start('app');
  expect(JSON.parse(file.text!)).toMatchObject({ id: m.id, scope: 'app' });
  const written = file.text;
  restart(file);
  expect(file.text).toBe(written);
});
