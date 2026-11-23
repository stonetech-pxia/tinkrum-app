import type { HandoffScope } from '@morph/core';
import { create } from 'zustand';

/** 系统引导的内存状态，不进配置或用户数据库。查看、过期只改变这个内存状态。 */
export const AI_RETURN_TTL = 24 * 60 * 60 * 1000;
export type AiReturn = { id: number; scope: HandoffScope['kind']; at: number };
let sequence = 0;
export const useAiReturn = create<{
  pending: AiReturn | null;
  start(scope: HandoffScope['kind'], now?: number): AiReturn;
  dismiss(id?: number): void;
}>((set, get) => ({
  pending: null,
  start(scope, now = Date.now()) {
    const pending = { id: ++sequence, scope, at: now };
    set({ pending });
    return pending;
  },
  dismiss(id) {
    // 先前分享的导入结束时，不关闭后来另一轮分享的卡片。
    if (id !== undefined && get().pending?.id === id) set({ pending: null });
  },
}));
export const aiReturnIsActive = (pending: AiReturn | null, now = Date.now()) =>
  pending !== null && now >= pending.at && now - pending.at < AI_RETURN_TTL;
