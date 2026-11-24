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

// Entry point (index.ts) hooks this layer first: if it fails to open normally for RESCUE_AFTER
// consecutive times, it displays the rescue page first, and the main flow (routes under app/ and
// everything they reference) is only loaded after the user taps "Open normally". When normal
// operation is reached, _layout calls markHealthy to reset the counter.

/** Record JS errors that cause the app to halt into a counter file (displayed on the rescue page; user decides whether to share). */
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

/** This startup session within a JS process (created by index.ts): React retry renders and development StrictMode do not count a single startup as two. */
export interface StartSession {
  start?: { counted: boolean } & Attempts;
}

/**
 * Crashed while rendering the main flow (directly crashes in production builds, shows red screen
 * in development): record the error, immediately replace with the rescue page. "Open normally"
 * renders it again.
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
  // Being awakened by a notification button in the background does not count as a startup (no UI, does not reach "normal"); counted only after switching to the foreground later.
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
