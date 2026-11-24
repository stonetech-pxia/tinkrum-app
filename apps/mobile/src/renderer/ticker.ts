import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

// Running timers (elapsed from D-306) refresh every second. All running rows share a single timer:
// it doesn't run when there are no running rows, and stops when the app goes to the background
// (refreshing immediately upon returning to the foreground) to save power. Only visible rows
// without an end time subscribe.

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let active = AppState.currentState !== 'background';

function sync() {
  const want = active && listeners.size > 0;
  if (want && !timer) timer = setInterval(() => listeners.forEach((l) => l()), 1000);
  if (!want && timer) {
    clearInterval(timer);
    timer = null;
  }
}

AppState.addEventListener?.('change', (state) => {
  active = state === 'active';
  if (active) listeners.forEach((l) => l());
  sync();
});

/** When running is true, returns the new current time every second; when false, does not subscribe. */
export function useTicker(running: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(new Date());
    listeners.add(tick);
    sync();
    return () => {
      listeners.delete(tick);
      sync();
    };
  }, [running]);
  return now;
}
