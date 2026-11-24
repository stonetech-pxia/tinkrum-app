import {
  calendarOf,
  type DataRecord,
  type Locale,
  type Registry,
  type WorkspaceConfig,
} from '@morph/core';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { serial } from '../data/record-actions';
import { t } from '../i18n';
import { newAssetId } from '../runtime/ids';
import type { WorkspaceRepo } from '../storage/types';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { applyInMemory, planWidgetOp } from './ops';
import { useWidgetPlacement } from './placed';
import { buildWidgetSnapshot } from './snapshot';
import type { PlacedWidget, QueueEntry, QueuedWidgetOp, WidgetPlatform } from './types';

// Desktop widgets and app (D-322, D-323):
// - Handle operations tapped on the widget: app startup, return to foreground, widget tapped while
// app is open on Android (onQueue). First read them out (without deleting), execute them in
// chronological order of tap time ("today" is the tap date, record creation time is also tap time),
// queue them together with in-app quick actions so both sides never write simultaneously. After
// execution, show a banner saying how many times it was recorded (without undo, invariant 11).
// Modified pages and changed operations are not executed, which is explained in the banner.
// - View: recalculated when official version config, records, desktop widgets, or language changes
// (wait half a second, consecutive changes calculate only once), and also recalculated when the app
// is open across days.

type Repo = Pick<WorkspaceRepo, 'listRecords' | 'applyRecordWrites' | 'getMeta' | 'setMeta'>;

async function allRecords(repo: Repo, config: WorkspaceConfig) {
  const map = new Map<string, DataRecord[]>();
  for (const c of config.data.tables) map.set(c.id, await repo.listRecords(c.id));
  return map;
}

function parseQueuedOp(text: string): QueuedWidgetOp | null {
  try {
    const e = JSON.parse(text) as Partial<QueuedWidgetOp>;
    if (
      typeof e.op === 'string' &&
      typeof e.component === 'string' &&
      typeof e.hash === 'string' &&
      typeof e.at === 'number' &&
      Number.isFinite(e.at)
    )
      return {
        op: e.op,
        component: e.component,
        hash: e.hash,
        at: e.at,
        ...(typeof e.record === 'string' ? { record: e.record } : {}),
      };
  } catch {
    // Skip corrupted entries.
  }
  return null;
}

export interface DrainResult {
  done: number;
  skipped: number;
  /** Number of taps that failed and remain in the queue for the next attempt (omitted when none). */
  pending?: number;
}

/** Processed taps (IDs in queue); stored on device along with records: if execution succeeded but deletion failed, reading it next time will not re-run it. */
const HANDLED_KEY = 'widgetOpsHandled';
const HANDLED_KEEP = 300;

async function loadHandled(repo: Repo): Promise<string[]> {
  try {
    const raw = await repo.getMeta(HANDLED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Execute read taps (R07): run them one by one by tap time, writing "this was done" and record
 * writes in the same transaction as each is completed; only allow remove to confirm deletion of
 * these taps from the queue after all are processed. Stop on mid-way errors (write failure):
 * completed ones are confirmed deleted as usual, uncompleted ones remain in the queue for the
 * next run. Returns null: nothing to process (queue is empty, or all read ones are already done).
 */
export async function runQueuedWidgetOps(
  entries: readonly QueueEntry[],
  repo: Repo,
  config: WorkspaceConfig,
  now: Date,
  remove: (ids: readonly string[]) => Promise<void>,
): Promise<DrainResult | null> {
  if (entries.length === 0) return null;
  const cal = calendarOf(config);
  const handled = await loadHandled(repo);
  const seen = new Set(handled);
  const ordered = entries
    .map((e) => ({ id: e.id, op: parseQueuedOp(e.text) }))
    .sort((a, b) => (a.op?.at ?? 0) - (b.op?.at ?? 0) || (a.id < b.id ? -1 : 1));
  let records: Map<string, DataRecord[]> = await allRecords(repo, config);
  let done = 0;
  let skipped = 0;
  let pending = 0;
  let stopped = false;
  let marksPending = false;
  /** Processed and ready to be confirmed and deleted. */
  const finished: string[] = [];
  const markValue = (extra: string) => JSON.stringify([...handled, extra].slice(-HANDLED_KEEP));

  for (const { id, op } of ordered) {
    if (seen.has(id)) {
      finished.push(id);
      continue;
    }
    if (stopped) {
      pending++;
      continue;
    }
    if (!op) {
      skipped++;
      finished.push(id);
      continue;
    }
    let outcome: 'done' | 'skipped' | 'stop' = 'stop';
    // If records are modified elsewhere between read and write (forms, reminder buttons), re-read and recalculate, up to three times.
    for (let attempt = 0; attempt < 3 && outcome === 'stop'; attempt++) {
      // Clock adjusted backwards, tap time in the future: calculated based on current time.
      const at = new Date(Math.min(op.at, now.getTime()));
      const write = planWidgetOp(config, op, records, at, cal);
      if (!write) {
        outcome = 'skipped';
        break;
      }
      const time = at.getTime();
      const recordId = write.kind === 'insert' ? newAssetId() : write.id;
      const before =
        write.kind === 'update'
          ? records.get(write.collection.id)?.find((r) => r.id === write.id)
          : undefined;
      let result: 'applied' | 'conflict';
      try {
        result = await repo.applyRecordWrites(
          [
            write.kind === 'insert'
              ? {
                  kind: 'insert',
                  record: {
                    id: recordId,
                    collectionId: write.collection.id,
                    values: write.values,
                    createdAt: time,
                    updatedAt: time,
                  },
                }
              : {
                  kind: 'update',
                  id: write.id,
                  values: write.values,
                  updatedAt: time,
                  ...(before ? { expected: before.values } : {}),
                },
          ],
          { key: HANDLED_KEY, value: markValue(id) },
        );
      } catch {
        break;
      }
      if (result === 'applied') {
        handled.push(id);
        records = applyInMemory(records, write, at, recordId);
        outcome = 'done';
      } else {
        records = await allRecords(repo, config);
      }
    }
    if (outcome === 'done') {
      done++;
      finished.push(id);
    } else if (outcome === 'skipped') {
      skipped++;
      handled.push(id);
      marksPending = true;
      finished.push(id);
    } else {
      stopped = true;
      pending++;
    }
  }
  if (marksPending)
    await repo
      .setMeta(HANDLED_KEY, JSON.stringify(handled.slice(-HANDLED_KEEP)))
      .catch(() => undefined);
  if (finished.length > 0) await remove(finished).catch(() => undefined);
  if (done === 0 && skipped === 0) return null;
  return { done, skipped, ...(pending > 0 ? { pending } : {}) };
}

/** Banner text: number of times recorded; if there are unexecuted ones, mention them next. */
export function drainMessage(result: DrainResult, locale: Locale): string {
  const parts: string[] = [];
  if (result.done > 0) parts.push(t(locale, 'widgetDone', { n: result.done }));
  if (result.skipped > 0) parts.push(t(locale, 'widgetSkipped', { n: result.skipped }));
  return parts.join(t(locale, 'separatorList'));
}

/** JSON of the full view (read by widgets). */
export async function widgetSnapshotJson(
  repo: Repo,
  config: WorkspaceConfig,
  placed: readonly PlacedWidget[],
  locale: Locale,
  registry: Registry,
  now: Date,
): Promise<string> {
  const records = await allRecords(repo, config);
  return JSON.stringify(
    await buildWidgetSnapshot({ config, placed, locale, registry, now, records }),
  );
}

const msToNextDay = (now: Date) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 1000;

/** Placed in root layout. */
export function WidgetBridge({ platform }: { platform: WidgetPlatform | null }) {
  const { repo, locale, registry, store } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config);
  const recordsVersion = useWorkspace((s) => s.recordsVersion);
  const placed = useWidgetPlacement((s) => s.placed);
  const last = useRef<string | null>(null);
  // Incremented when app is open across days, view recalculated (tomorrow's becomes today's, then calculate day after).
  const [day, setDay] = useState(0);

  useEffect(() => {
    if (platform) void useWidgetPlacement.getState().load(repo);
  }, [platform, repo]);

  // Fetch taps.
  useEffect(() => {
    if (!platform) return;
    const drain = () =>
      serial(async () => {
        const current = store.getState().config;
        if (!current) return;
        const entries = await platform.readQueue().catch(() => [] as QueueEntry[]);
        const result = await runQueuedWidgetOps(entries, repo, current, new Date(), (ids) =>
          platform.removeQueue([...ids]),
        );
        if (!result) return;
        store.getState().bumpRecords();
        store.getState().showToast({ message: drainMessage(result, locale) });
      }).catch(() => undefined);
    void drain();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void drain();
    });
    const off = platform.onQueue(() => void drain());
    return () => {
      sub.remove();
      off();
    };
  }, [platform, repo, store, locale]);

  useEffect(() => {
    if (!platform) return;
    const timer = setTimeout(() => setDay((d) => d + 1), msToNextDay(new Date()));
    return () => clearTimeout(timer);
  }, [platform, day]);

  // View: write only when content changes (writing triggers system widget redraw).
  useEffect(() => {
    if (!platform || !config || placed === null) return;
    let alive = true;
    const timer = setTimeout(() => {
      void widgetSnapshotJson(repo, config, placed, locale, registry, new Date())
        .then(async (json) => {
          if (!alive || json === last.current) return;
          last.current = json;
          await platform.setSnapshot(json);
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [platform, repo, config, recordsVersion, placed, locale, registry, day]);
  return null;
}
