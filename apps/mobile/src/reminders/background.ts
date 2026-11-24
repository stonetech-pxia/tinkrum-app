import { registerTaskAsync, type NotificationResponse } from 'expo-notifications';
import { defineTask } from 'expo-task-manager';
import { Platform } from 'react-native';

import MorphBackground from '../../modules/morph-background';
import { getDeviceLocale, t } from '../i18n';
import { openRepo } from '../storage/open';
import { expoReminders, reminderActionOf, setupReminderButtons } from './expo-reminders';
import type { ReminderAction } from './platform';
import { runReminderAction, type ReminderActionResult } from './reminder-actions';

// Reminder notification buttons (D-318) must work even when the App is not open. This file is
// loaded first at the entry point (index.ts) to start listening for button clicks before the UI
// mounts:
// - iOS: buttons do not open the App; the system launches or wakes up the App in the background,
// routing clicks to this listener; morph-background requests background time upon receiving a
// button, processes it, and releases it (releaseActionTime), otherwise the App might be suspended
// before writes complete.
// - Android: when the App is in the background or not running, expo-notifications runs the
// background task below via expo-task-manager (running in headless JS when stopped); when the App
// is open, it goes through the event listener. Both paths may deliver events; handleReminderAction
// deduplicates by click.

const locale = getDeviceLocale();

/** Local notifications for reminders (D-251). Channel name follows the interface language. */
export const reminders = expoReminders(t(locale, 'remindersTitle'));

const TASK = 'morph-reminder-buttons';

type Listener = (result: ReminderActionResult) => void;
const listeners = new Set<Listener>();

/** When the UI is open: button actions write records to be refreshed and show a toast (_layout subscribes). */
export function onReminderAction(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Clicks currently being processed: background time is released only after all are finished. */
let busy = 0;
const release = () => {
  if (busy === 0) MorphBackground?.releaseActionTime();
};

async function run(action: ReminderAction) {
  busy++;
  try {
    const repo = await openRepo();
    // If action fails, runReminderAction pops up a notification to inform the user rather than failing silently (Health Check 2.5).
    const result = await runReminderAction(action, {
      repo,
      platform: reminders,
      locale,
      now: () => new Date(),
    });
    if (result) for (const l of listeners) l(result);
  } finally {
    busy--;
    release();
  }
}

defineTask<NotificationResponse>(TASK, async ({ data }) => {
  const action = data && 'actionIdentifier' in data ? reminderActionOf(data) : null;
  if (action) await run(action).catch(() => undefined);
});

if (Platform.OS === 'android') registerTaskAsync(TASK).catch(() => undefined);
setupReminderButtons(locale).catch(() => undefined);
// App started in the background not due to a button (or clicks already processed): morph-background releases requested background time after a few seconds.
setTimeout(release, 8000);
// When building release bundles, Expo runs routes on web first; web lacks notification buttons, causing listeners to throw and builds to fail.
if (Platform.OS !== 'web') reminders.onAction((action) => void run(action).catch(() => undefined));
