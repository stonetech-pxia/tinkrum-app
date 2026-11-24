import {
  calendarOf,
  hasActiveReminders,
  loadComputedRecords,
  planNotifications,
  reminderCollections,
  reminderToolId,
  type DataRecord,
  type Locale,
  type NavTarget,
  type ReminderTarget,
  type WorkspaceConfig,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { create } from 'zustand';

import { t } from '../i18n';
import { useNavigate } from '../shell/navigation';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import type { NotificationPermission, NotificationPlatform } from './platform';
import type { ReminderActionResult } from './reminder-actions';

// Reminder (D-251): reschedule local notifications when config or records change; tapping reminder only opens page or quick action, never runs it.

/** Notification permission status (used for displaying "Notifications disabled" in Settings -> Reminders). */
export const useNotificationState = create<{ permission: NotificationPermission | null }>(() => ({
  permission: null,
}));

let syncing: Promise<unknown> = Promise.resolve();

/**
 * Reschedule reminders. When there are no active reminders, only clear scheduled ones without
 * asking for permission; pop up system permission request only the first time a reminder is
 * actually scheduled, and if user declines, do not schedule (Settings page explains how to
 * enable). Returns permission status (null when no reminders). Complete one batch before the
 * next: UI and reminder buttons (D-318) might request rescheduling simultaneously, and
 * interleaving cancellations and scheduling will leave old notifications.
 */
export function syncReminders(
  platform: NotificationPlatform,
  config: WorkspaceConfig,
  listRecords: (collectionId: string) => Promise<DataRecord[]>,
  locale: Locale,
  now: Date,
): Promise<NotificationPermission | null> {
  const run = () => sync(platform, config, listRecords, locale, now);
  const next = syncing.then(run, run);
  syncing = next.catch(() => undefined);
  return next;
}

async function sync(
  platform: NotificationPlatform,
  config: WorkspaceConfig,
  listRecords: (collectionId: string) => Promise<DataRecord[]>,
  locale: Locale,
  now: Date,
): Promise<NotificationPermission | null> {
  if (!hasActiveReminders(config)) {
    await platform.replaceAll([]);
    return null;
  }
  let permission = await platform.permission();
  if (permission === 'undetermined') permission = (await platform.request()) ? 'granted' : 'denied';
  if (permission !== 'granted') return permission;
  // Calculated records: "Last completed" for schedules might be aggregates, and unless filters might use lookup values (D-316, D-317).
  const records = new Map<string, DataRecord[]>();
  for (const id of reminderCollections(config)) {
    const collection = config.data.tables.find((c) => c.id === id);
    if (!collection) continue;
    const loaded = await loadComputedRecords(
      listRecords,
      config.data.tables,
      collection,
      now,
      calendarOf(config),
    );
    records.set(id, loaded.records);
  }
  const reserved = await platform.snoozed();
  await platform.replaceAll(planNotifications(config, records, now, locale, { reserved }));
  return permission;
}

/** Reschedule when reminders in config, referenced tables, or records change (D-251). */
export function useReminderSync(platform: NotificationPlatform | null) {
  const { repo, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config);
  const recordsVersion = useWorkspace((s) => s.recordsVersion);
  // remindersOf returns a new array each time: depends on tools (reminders reside inside).
  const tools = config?.tools;
  useEffect(() => {
    if (!platform || !config) return;
    syncReminders(platform, config, (id) => repo.listRecords(id), locale, new Date())
      .then((permission) => permission && useNotificationState.setState({ permission }))
      .catch(() => undefined);
    // Reschedule only when reminder settings, referenced tables, or records change (other parts of config changing do not trigger it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, tools, config?.data.tables, recordsVersion, repo, locale]);
}

/** Where to go when tapping a reminder: quick actions go to their reminder page (not execution page, which runs immediately upon opening), others open normally. */
export function reminderDestination(
  opens: ReminderTarget,
): { kind: 'workflow'; workflowId: string } | { kind: 'target'; target: NavTarget } {
  const workflowId = reminderToolId(opens);
  return workflowId !== null
    ? { kind: 'workflow', workflowId }
    : { kind: 'target', target: opens as NavTarget };
}

/** Tapped a reminder: quick actions open their reminder page (user taps "Start"), pages and system entry points open normally. */
export function useReminderOpen(platform: NotificationPlatform | null) {
  const router = useRouter();
  const navigate = useNavigate();
  useEffect(() => {
    if (!platform) return;
    return platform.onOpen((opens: ReminderTarget) => {
      const to = reminderDestination(opens);
      if (to.kind === 'workflow')
        router.push({ pathname: '/reminder/[workflowId]', params: { workflowId: to.workflowId } });
      else navigate(to.target);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);
}

/**
 * Tapped "Done" on a reminder while UI is active (D-318): refresh record list, show feedback on
 * which item was written. onAction is background.ts's onReminderAction in entry points.
 */
export function useReminderActionFeedback(
  onAction: (listener: (result: ReminderActionResult) => void) => () => void,
) {
  const { locale } = useWorkspaceContext();
  const bump = useWorkspace((s) => s.bumpRecords);
  const showToast = useWorkspace((s) => s.showToast);
  useEffect(() => {
    return onAction((result) => {
      if (result.kind !== 'done') return;
      bump();
      showToast({ message: t(locale, 'reminderDoneToast', { title: result.title }) });
    });
  }, [onAction, locale, bump, showToast]);
}
