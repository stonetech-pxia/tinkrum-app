import type { HandoffScope } from '@morph/core';
import { create } from 'zustand';

/**
 * 「等 AI 结果」的标记（系统引导，不进配置或用户数据库）。查看、过期不写任何东西；
 * 只有用户点分享、导入成功或关掉卡片时才写一个小文件（和启动计数一样放在数据库外面，是 App 自己的记账，
 * D-621），Android 在用户去别的 App 时把 Tinkrum 进程杀掉，回来这张卡还在。
 */
export const AI_RETURN_TTL = 24 * 60 * 60 * 1000;
export type AiReturn = { id: number; scope: HandoffScope['kind']; at: number };

/** 标记文件；读写都是同步的，读写失败一律当没有标记，绝不影响使用。 */
export interface ReturnStore {
  read(): string | null;
  write(text: string): void;
}

const SCOPES: readonly HandoffScope['kind'][] = ['new', 'app', 'setup'];
let sequence = 0;
let backing: ReturnStore | null = null;

function save(value: AiReturn | null) {
  try {
    backing?.write(JSON.stringify(value));
  } catch {
    // 写不进去：这次不记，卡片仍在内存里显示。
  }
}

function load(store: ReturnStore): AiReturn | null {
  try {
    const raw = store.read();
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AiReturn> | null;
    if (
      v &&
      typeof v.id === 'number' &&
      Number.isInteger(v.id) &&
      typeof v.at === 'number' &&
      Number.isFinite(v.at) &&
      SCOPES.includes(v.scope as HandoffScope['kind'])
    )
      return { id: v.id, scope: v.scope as HandoffScope['kind'], at: v.at };
  } catch {
    // 坏文件当没有。
  }
  return null;
}

export const useAiReturn = create<{
  pending: AiReturn | null;
  start(scope: HandoffScope['kind'], now?: number): AiReturn;
  dismiss(id?: number): void;
  /** 返回一个标记的还原：分享没成功时把上一个换回来。 */
  restore(previous: AiReturn | null): void;
}>((set, get) => ({
  pending: null,
  start(scope, now = Date.now()) {
    const pending = { id: ++sequence, scope, at: now };
    set({ pending });
    save(pending);
    return pending;
  },
  dismiss(id) {
    // 先前分享的导入结束时，不关闭后来另一轮分享的卡片。
    if (id !== undefined && get().pending?.id === id) {
      set({ pending: null });
      save(null);
    }
  },
  restore(previous) {
    set({ pending: previous });
    save(previous);
  },
}));

/** 启动时接上标记文件：读出上次留下的（只读，不写）。已经有新的标记就不覆盖。 */
export function attachReturnStore(store: ReturnStore, now = Date.now()) {
  backing = store;
  const loaded = load(store);
  if (!loaded || !aiReturnIsActive(loaded, now)) return;
  sequence = Math.max(sequence, loaded.id);
  if (!useAiReturn.getState().pending) useAiReturn.setState({ pending: loaded });
}

export const aiReturnIsActive = (pending: AiReturn | null, now = Date.now()) =>
  pending !== null && now >= pending.at && now - pending.at < AI_RETURN_TTL;
