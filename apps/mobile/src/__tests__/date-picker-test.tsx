import {
  applyOps,
  createDefaultWorkspace,
  dateOfDayNumber,
  monthTitle,
  shiftMonth,
  todayNumber,
  DEFAULT_CALENDAR,
  type Collection,
  type Locale,
  type Registry,
} from '@morph/core';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Date and time pickers (D-543): JS-implemented calendar grid and time selectors without native components; "Today" and "Now" work as usual.

const events: Collection = {
  id: 'events',
  name: 'Events',
  fields: [
    { id: 'day', name: 'Day', type: 'date' },
    { id: 'due', name: 'Due', type: 'date', default: 'today' },
    { id: 'at', name: 'At', type: 'datetime' },
    { id: 'clock', name: 'Clock', type: 'time' },
  ],
};

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: events },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'log',
          look: 'form',
          show: { mode: 'inline' },
          tools: [
            {
              as: 'submit',
              label: 'Log',
              do: 'create',
              table: 'events',
              ask: ['day', 'due', 'at', 'clock'],
            },
          ],
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

const today = () => dateOfDayNumber(todayNumber(new Date(), DEFAULT_CALENDAR));

it('picks a date from a month grid, in the user language, and moves between months', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed, locale: 'fr' });
  await fireEvent.press(await screen.findByTestId('form-log-day-pick'));
  const month = today().slice(0, 7);
  expect(screen.getByText(monthTitle(month, 'fr'))).toBeTruthy();
  // Monday start (default in Settings -> Date).
  expect(screen.getByTestId('form-log-day-weekdays')).toHaveTextContent('LMMJVSD');
  await fireEvent.press(screen.getByTestId('form-log-day-next'));
  const next = shiftMonth(month, 1);
  expect(screen.getByText(monthTitle(next, 'fr'))).toBeTruthy();
  await fireEvent.press(screen.getByTestId(`form-log-day-day-${next}-15`));
  expect(screen.getByTestId('form-log-day').props.value).toBe(`${next}-15`);
});

it('a date field starts as today and has the input and the calendar, no day buttons', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed, locale: 'en' });
  expect((await screen.findByTestId('form-log-due')).props.value).toBe(today());
  expect(screen.getByTestId('form-log-due-pick')).toBeTruthy();
  for (const label of ['Today', 'Tomorrow', 'Yesterday'])
    expect(screen.queryByText(label)).toBeNull();
});

it('the new-entry page and the inline form start a date field as today, again after saving', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed, locale: 'en' });
  await fireEvent.press(await screen.findByTestId('form-log-submit'));
  expect((await screen.findByTestId('form-log-due')).props.value).toBe(today());
  await act(() => router.push('/record/events'));
  expect((await screen.findByTestId('editor-due')).props.value).toBe(today());
});

it('picks a date and a time for a date-and-time field, and a time alone', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed, locale: 'en' });
  await fireEvent.press(await screen.findByTestId('form-log-at-pick'));
  await fireEvent.press(screen.getByTestId(`form-log-at-day-${today()}`));
  await fireEvent.press(screen.getByTestId('form-log-at-hour-14'));
  await fireEvent.press(screen.getByTestId('form-log-at-minute-30'));
  expect(screen.getByTestId('form-log-at').props.value).toBe(`${today()} 14:30`);
  await fireEvent.press(screen.getByTestId('form-log-clock-pick'));
  await fireEvent.press(screen.getByTestId('form-log-clock-hour-7'));
  await fireEvent.press(screen.getByTestId('form-log-clock-minute-5'));
  expect(screen.getByTestId('form-log-clock').props.value).toBe('07:05');
  await fireEvent.press(screen.getByTestId('form-log-submit'));
  const [saved] = await repo.listRecords('events');
  expect(saved!.values).toEqual({ due: today(), at: `${today()}T14:30`, clock: '07:05' });
});

it('the week starts on the day set in Settings → Date', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, {
    seed: (locale, registry) => {
      const config = seed(locale, registry);
      return { ...config, data: { ...config.data, calendar: { weekStart: 'sunday' } } };
    },
    locale: 'en',
  });
  await fireEvent.press(await screen.findByTestId('form-log-day-pick'));
  expect(screen.getByTestId('form-log-day-weekdays')).toHaveTextContent(/^S/);
});
