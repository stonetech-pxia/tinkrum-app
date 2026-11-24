// When building a release package, Expo preruns routes on the web platform (exporting server
// manifests), executing `reminders/background.ts` loaded at the entry point first. On web,
// `expo-notifications` lacks `getLastNotificationResponse`, throwing an error on call and failing
// the entire build. Do not listen to notification buttons on web.

jest.mock('expo-notifications', () => ({
  registerTaskAsync: jest.fn(async () => undefined),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => {
    throw new Error('ExpoNotifications.getLastNotificationResponse is not available on web');
  }),
  clearLastNotificationResponse: jest.fn(),
  setNotificationCategoryAsync: jest.fn(async () => null),
}));
jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));
jest.mock('../../modules/morph-background', () => ({ __esModule: true, default: null }));
jest.mock('../storage/open', () => ({ openRepo: jest.fn() }));
jest.mock('../reminders/reminder-actions', () => ({ handleReminderAction: jest.fn() }));
jest.mock('../i18n', () => ({ getDeviceLocale: () => 'zh', t: () => '提醒' }));
jest.mock('../reminders/expo-reminders', () => {
  const notifications = jest.requireMock('expo-notifications');
  return {
    expoReminders: () => ({
      onAction: () => {
        notifications.getLastNotificationResponse();
        return () => undefined;
      },
    }),
    reminderActionOf: () => null,
    setupReminderButtons: jest.fn(async () => undefined),
  };
});

it('loads on web without listening to notification buttons', () => {
  jest.useFakeTimers();
  const load = () =>
    jest.isolateModules(() => {
      // Switching to web requires using the same isolated module; `background.ts` reads this exact copy.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Platform } = require('react-native');
      Object.defineProperty(Platform, 'OS', { get: () => 'web', configurable: true });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../reminders/background');
    });
  expect(load).not.toThrow();
  jest.useRealTimers();
});
