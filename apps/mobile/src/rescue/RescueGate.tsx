import type { Locale } from '@morph/core';
import { Component, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { AppState } from 'react-native';

import {
  RESCUE_AFTER,
  errorText,
  recordFatal,
  startAttempt,
  type AttemptStore,
  type Attempts,
} from './attempts';
import { RescueScreen, type RescueActions } from './RescueScreen';

// 入口（index.ts）先挂这一层：连续 RESCUE_AFTER 次没能正常打开，先显示兜底页，主流程（app/ 下的路由和
// 它们引用的一切）等用户点「照常打开」才加载。走到正常时由 _layout 调 markHealthy 清零。

/** 让 App 停下来的 JS 错误记进计数文件（兜底页显示，用户自己决定要不要分享）。 */
export function recordFatalErrors(store: AttemptStore) {
  const utils = (
    globalThis as {
      ErrorUtils?: {
        getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
        setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
      };
    }
  ).ErrorUtils;
  if (!utils) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    if (isFatal) recordFatal(store, error);
    previous(error, isFatal);
  });
}

/** 一个 JS 进程里的这次启动（index.ts 建一个）：React 重试渲染、开发版的 StrictMode 都不会把一次启动算成两次。 */
export interface StartSession {
  start?: { counted: boolean } & Attempts;
}

/**
 * 渲染主流程时崩了（正式包里会直接闪退，开发版只显示红屏）：记下错误，当场换成兜底页。
 * 「照常打开」再渲染一次。
 */
class CrashBoundary extends Component<
  {
    store: AttemptStore;
    fallback: (error: string, retry: () => void) => ReactNode;
    children: ReactNode;
  },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: errorText(error) };
  }
  componentDidCatch(error: unknown) {
    recordFatal(this.props.store, error);
  }
  render() {
    return this.state.error !== null
      ? this.props.fallback(this.state.error, () => this.setState({ error: null }))
      : this.props.children;
  }
}

export function RescueGate({
  App,
  store,
  session,
  locale,
  actions,
  version,
}: {
  App: ComponentType;
  store: AttemptStore;
  session: StartSession;
  locale: Locale;
  actions: RescueActions;
  version?: string | null;
}) {
  // 被提醒按钮在后台拉起时不算一次启动（没有界面，也不会走到「正常」）；之后切到前台再算。
  session.start ??=
    AppState.currentState === 'active'
      ? { counted: true, ...startAttempt(store) }
      : { counted: false, failures: 0 };
  const start = session.start;
  const [rescue, setRescue] = useState(start.failures >= RESCUE_AFTER);
  useEffect(() => {
    if (start.counted) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || start.counted) return;
      start.counted = true;
      sub.remove();
      startAttempt(store);
    });
    return () => sub.remove();
  }, [start, store]);

  const screen = (error: string | undefined, onContinue: () => void) => (
    <RescueScreen
      locale={locale}
      {...(error ? { error } : {})}
      {...(version !== undefined ? { version } : {})}
      actions={actions}
      onContinue={onContinue}
    />
  );
  if (rescue) return screen(start.lastError, () => setRescue(false));
  return (
    <CrashBoundary store={store} fallback={screen}>
      <App />
    </CrashBoundary>
  );
}
