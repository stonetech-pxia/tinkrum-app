import {
  ReminderTargetSchema,
  t,
  type Locale,
  type NotificationButtons,
  type PlannedNotification,
  type ReminderTarget,
} from '@morph/core';
import {
  addNotificationResponseReceivedListener,
  AndroidImportance,
  cancelScheduledNotificationAsync,
  clearLastNotificationResponse,
  DEFAULT_ACTION_IDENTIFIER,
  dismissNotificationAsync,
  getAllScheduledNotificationsAsync,
  getLastNotificationResponse,
  getPermissionsAsync,
  requestPermissionsAsync,
  SchedulableTriggerInputTypes,
  scheduleNotificationAsync,
  setNotificationCategoryAsync,
  setNotificationChannelAsync,
  setNotificationHandler,
  type NotificationResponse,
  type SchedulableNotificationTriggerInput,
} from 'expo-notifications';
import { Platform } from 'react-native';

import {
  DONE_ACTION,
  OPENS_KEY,
  RECORD_KEY,
  SNOOZE_ACTION,
  type NotificationPlatform,
  type ReminderAction,
} from './platform';

// NotificationPlatform implementation: local notifications via expo-notifications (D-251). Does not fetch push tokens or connect to servers.

const CHANNEL = 'reminders';

// Displays reminders even when the App is open (banner + notification center), without intrusive ringing.
setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let channelReady: Promise<unknown> | null = null;
/** Android 8+ requires notification channels: one for "Reminders" with default importance. */
function ensureChannel(name: string) {
  if (Platform.OS !== 'android') return Promise.resolve();
  channelReady ??= setNotificationChannelAsync(CHANNEL, {
    name,
    importance: AndroidImportance.DEFAULT,
  });
  return channelReady;
}

/** ID prefix for snooze notifications (core's snoozeId): preserved during rescheduling. */
const SNOOZE_PREFIX = 'snooze-';

const categoryOf = (buttons: NotificationButtons) => `morph-${buttons}`;

/**
 * Notification buttons (D-318): complete and snooze, grouped into three categories according to
 * reminder settings. Buttons do not bring the App to the foreground: iOS launches the App in the
 * background to process, while Android handles it via background tasks (even when the App is not
 * running, see background.ts).
 */
export async function setupReminderButtons(locale: Locale) {
  const done = {
    identifier: DONE_ACTION,
    buttonTitle: t(locale, 'reminderDoneButton'),
    options: { opensAppToForeground: false },
  };
  const later = {
    identifier: SNOOZE_ACTION,
    buttonTitle: t(locale, 'reminderSnoozeButton'),
    options: { opensAppToForeground: false },
  };
  await setNotificationCategoryAsync(categoryOf('done'), [done]);
  await setNotificationCategoryAsync(categoryOf('snooze'), [later]);
  await setNotificationCategoryAsync(categoryOf('doneSnooze'), [done, later]);
}

/** Data attached to notifications (sometimes JSON text in Android background tasks). */
function dataOf(response: NotificationResponse): Record<string, unknown> {
  const data = response.notification?.request?.content?.data as
    Record<string, unknown> | null | undefined;
  if (typeof data?.dataString === 'string') {
    try {
      return JSON.parse(data.dataString) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return data ?? {};
}

const opensOf = (data: unknown): ReminderTarget | null => {
  const raw = (data as Record<string, unknown> | null | undefined)?.[OPENS_KEY];
  const parsed = ReminderTargetSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** Button click -> ReminderAction; null if not a Morph button. */
export function reminderActionOf(response: NotificationResponse): ReminderAction | null {
  const id = response.actionIdentifier;
  if (id !== DONE_ACTION && id !== SNOOZE_ACTION) return null;
  const raw = dataOf(response)[RECORD_KEY] as Record<string, unknown> | undefined;
  if (typeof raw?.reminderId !== 'string' || typeof raw.recordId !== 'string') return null;
  const notificationId = response.notification.request.identifier;
  return {
    button: id === DONE_ACTION ? 'done' : 'snooze',
    reminderId: raw.reminderId,
    recordId: raw.recordId,
    notificationId,
    key: `${notificationId}:${response.notification.date}:${id}`,
  };
}

const isTap = (response: NotificationResponse) =>
  response.actionIdentifier === DEFAULT_ACTION_IDENTIFIER;

function triggerOf(n: PlannedNotification): SchedulableNotificationTriggerInput {
  const channelId = CHANNEL;
  return n.trigger.kind === 'daily'
    ? {
        type: SchedulableTriggerInputTypes.DAILY,
        hour: n.trigger.hour,
        minute: n.trigger.minute,
        channelId,
      }
    : n.trigger.kind === 'weekly'
      ? {
          type: SchedulableTriggerInputTypes.WEEKLY,
          // In core, 1 = Monday ... 7 = Sunday; in expo-notifications, 1 = Sunday.
          weekday: (n.trigger.weekday % 7) + 1,
          hour: n.trigger.hour,
          minute: n.trigger.minute,
          channelId,
        }
      : {
          type: SchedulableTriggerInputTypes.DATE,
          date: n.trigger.at,
          channelId,
        };
}

/** All settings used when scheduling are stored in the notification: if identical during the next reschedule, it remains untouched (D-319). */
const PLAN_KEY = 'morphPlan';
const planOf = (n: PlannedNotification) =>
  JSON.stringify([n.title, n.body, n.trigger, n.opens, n.recordId ?? null, n.buttons ?? null]);

function schedule(n: PlannedNotification) {
  return scheduleNotificationAsync({
    identifier: n.id,
    content: {
      title: n.title,
      body: n.body,
      data: {
        [OPENS_KEY]: n.opens,
        [PLAN_KEY]: planOf(n),
        ...(n.recordId ? { [RECORD_KEY]: { reminderId: n.reminderId, recordId: n.recordId } } : {}),
      },
      ...(n.buttons ? { categoryIdentifier: categoryOf(n.buttons) } : {}),
    },
    trigger: triggerOf(n),
  });
}

export function expoReminders(channelName: string): NotificationPlatform {
  /** Already asked during this App session: once rejected, does not pop up on every reschedule. */
  let asked = false;
  return {
    async permission() {
      const { status, canAskAgain, granted } = await getPermissionsAsync();
      if (status === 'granted') return 'granted';
      if (status !== 'denied') return 'undetermined';
      // Android 13+ reports denied even when never asked; only canAskAgain indicates if it can
      // still be asked. granted being true means the user disabled notifications in system
      // settings, and dialogs will not appear.
      return canAskAgain && !granted && !asked ? 'undetermined' : 'denied';
    },
    async request() {
      asked = true;
      const { status } = await requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      });
      return status === 'granted';
    },
    async replaceAll(planned) {
      await ensureChannel(channelName);
      // Morph uses expo-notifications exclusively to schedule reminders (long task progress
      // notifications use morph-background and are unaffected). Diffs by notification ID (D-319):
      // only cancels unneeded ones, and schedules new or modified ones (rescheduling the same ID
      // replaces it). Each entry goes through a bridge, and the App can be suspended at any time in
      // the background; this ensures no needed reminders are lost if interrupted midway. Cancels
      // before scheduling to prevent exceeding iOS's 64-notification limit, which causes the system
      // to drop them. Pending snooze notifications were triggered by the user and are preserved
      // (D-318).
      const wanted = new Set(planned.map((n) => n.id));
      const existing = new Map<string, unknown>();
      for (const n of await getAllScheduledNotificationsAsync())
        existing.set(n.identifier, (n.content.data as Record<string, unknown> | null)?.[PLAN_KEY]);
      for (const id of existing.keys())
        if (!wanted.has(id) && !id.startsWith(SNOOZE_PREFIX))
          await cancelScheduledNotificationAsync(id);
      for (const n of planned) if (existing.get(n.id) !== planOf(n)) await schedule(n);
    },
    async snoozed() {
      return (await getAllScheduledNotificationsAsync()).filter((n) =>
        n.identifier.startsWith(SNOOZE_PREFIX),
      ).length;
    },
    async snooze(planned) {
      await ensureChannel(channelName);
      await schedule(planned);
    },
    async cancel(id) {
      await cancelScheduledNotificationAsync(id);
    },
    async dismiss(notificationId) {
      await dismissNotificationAsync(notificationId);
    },
    async alert(title, body) {
      await ensureChannel(channelName);
      await scheduleNotificationAsync({
        content: { title, body },
        trigger: { channelId: CHANNEL },
      });
    },
    onOpen(listener) {
      // Cold start from reminder: the last tapped notification (button clicks are handled by onAction).
      const last = getLastNotificationResponse();
      const lastOpens =
        last && isTap(last) ? opensOf(last.notification.request.content.data) : null;
      if (lastOpens) {
        listener(lastOpens);
        clearLastNotificationResponse();
      }
      const sub = addNotificationResponseReceivedListener((response) => {
        if (!isTap(response)) return;
        const opens = opensOf(response.notification.request.content.data);
        if (opens) listener(opens);
      });
      return () => sub.remove();
    },
    onAction(listener) {
      // When iOS launches the App in the background, clicks may arrive before listeners here: checks the last one first.
      const last = getLastNotificationResponse();
      const lastAction = last && reminderActionOf(last);
      if (lastAction) {
        listener(lastAction);
        clearLastNotificationResponse();
      }
      const sub = addNotificationResponseReceivedListener((response) => {
        const action = reminderActionOf(response);
        if (action) listener(action);
      });
      return () => sub.remove();
    },
  };
}
