// 启动兜底（体检 6.6，D-new-vibe-checkup-full-test-145368-1）：连续几次没能正常打开（闪退、启动出错）
// 就先显示兜底页。计数存在数据库外面的一个小文件里，是 App 自己的记账，不是用户数据（创始人 2026-11-22：
// 不算违反底线 16）。读写失败一律当没有计数，绝不挡启动。

/** 计数文件；读写都是同步的：紧接着闪退时，这次启动也已经记上。 */
export interface AttemptStore {
  read(): string | null;
  write(text: string): void;
}

export interface Attempts {
  /** 连续几次启动没走到「正常」。 */
  failures: number;
  /** 最后一次让 App 停下来的错误（给兜底页显示、由用户自己分享）。 */
  lastError?: string;
}

/** 连续失败这么多次，下一次打开先进兜底页。 */
export const RESCUE_AFTER = 2;
/** 主页正常显示这么久才算这次启动成功。 */
export const HEALTHY_AFTER_MS = 5000;
const MAX_ERROR = 2000;

export function readAttempts(store: AttemptStore): Attempts {
  try {
    const raw = store.read();
    if (!raw) return { failures: 0 };
    const value = JSON.parse(raw) as { failures?: unknown; lastError?: unknown };
    const failures =
      typeof value.failures === 'number' && Number.isInteger(value.failures) && value.failures > 0
        ? value.failures
        : 0;
    return {
      failures,
      ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
    };
  } catch {
    return { failures: 0 };
  }
}

function save(store: AttemptStore, attempts: Attempts) {
  try {
    store.write(JSON.stringify(attempts));
  } catch {
    // 写不进去：这次不计数，照常启动。
  }
}

/** 一次前台启动开始：返回这次之前的情况，并先把这一次记成失败（走到正常时再清掉）。 */
export function startAttempt(store: AttemptStore): Attempts {
  const before = readAttempts(store);
  save(store, { ...before, failures: before.failures + 1 });
  return before;
}

/** 这次启动走到了正常的主页：从零数起。 */
export function markHealthy(store: AttemptStore) {
  save(store, { failures: 0 });
}

/** 给人看、给用户分享的错误文字：消息和调用栈，限长。 */
export const errorText = (error: unknown) =>
  (error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.trim() : String(error)).slice(
    0,
    MAX_ERROR,
  );

/** 记下让 App 停下来的错误（全局错误处理和兜底门的错误边界里调用）。 */
export function recordFatal(store: AttemptStore, error: unknown) {
  save(store, { ...readAttempts(store), lastError: errorText(error) });
}
