import type { PlannedNotification, ReminderTarget } from '@morph/core';

// Local notifications used for reminders (D-251). Implemented via expo-notifications in the App
// (expo-reminders.ts), mocked in tests. Schedules local notifications only, registers no push
// tokens, requires no server.

export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

/** User clicked a button on a record-scheduled reminder (D-318). */
export interface ReminderAction {
  button: 'done' | 'snooze';
  reminderId: string;
  recordId: string;
  /** ID of this notification (Android requires dismissing notifications manually). */
  notificationId: string;
  /** Identifier for the same click: a single click might be delivered through two paths (listener and Android background task), processed only once. */
  key: string;
}

export interface NotificationPlatform {
  permission(): Promise<NotificationPermission>;
  /** Show system notification permission request; called only the first time an alert is actually scheduled. */
  request(): Promise<boolean>;
  /** Replace with this batch: first cancel Morph-scheduled reminders (retaining pending snoozed reminders), then schedule these. */
  replaceAll(planned: readonly PlannedNotification[]): Promise<void>;
  /** Number of pending snoozed reminders (deducted from the system's pending notification limit, D-319). */
  snoozed(): Promise<number>;
  /** Schedule a snoozed reminder (ID uses snoozeId, keeping only one per record). */
  snooze(planned: PlannedNotification): Promise<void>;
  /** Cancel an un-fired notification. */
  cancel(id: string): Promise<void>;
  /** Dismiss an already appeared notification from the notification center. */
  dismiss(notificationId: string): Promise<void>;
  /** Immediately display a text-only notification (notify the user when notification buttons are not implemented, Health Check 2.5). */
  alert(title: string, body: string): Promise<void>;
  /** User tapped a reminder (App running or cold-started from reminder); returns unsubscription function. */
  onOpen(listener: (opens: ReminderTarget) => void): () => void;
  /** User tapped a button on a reminder (App running, or awakened in the background by the system); returns unsubscription function. */
  onAction(listener: (action: ReminderAction) => void): () => void;
}

/** Notifications only carry "where to open" and nothing beyond record contents; verify the format again upon reading. */
export const OPENS_KEY = 'morphOpens';
/** Reminders scheduled per record: which reminder, which record (ID only). */
export const RECORD_KEY = 'morphRecord';
/** Notification buttons (D-318): expo-notifications category ID and button ID. */
export const DONE_ACTION = 'morph-done';
export const SNOOZE_ACTION = 'morph-snooze';
