import {
  applyOps,
  createDefaultWorkspace,
  type Collection,
  type Locale,
  type Registry,
} from '@morph/core';
import { fireEvent } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { renderToolsApp } from '../test-utils/render-app';

// Filling and display of time, datetime, and duration fields (D-279), and working hours formulas (D-280, D-281).

const shifts: Collection = {
  id: 'shifts',
  name: '工时',
  fields: [
    { id: 'start', name: '上班', type: 'time' },
    { id: 'end', name: '下班', type: 'time' },
    { id: 'in', name: '打卡', type: 'datetime', default: 'now' },
    { id: 'break', name: '休息', type: 'duration' },
    {
      id: 'worked',
      name: '工时',
      type: 'formula',
      expression: 'hours({start}, {end}) - {break} / 60',
      unit: 'h',
    },
  ],
};

const seed = (locale: Locale, registry: Registry) => {
  const result = applyOps(
    createDefaultWorkspace(locale),
    [
      { op: 'addData', table: shifts },
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
              table: 'shifts',
              ask: ['start', 'end', 'in', 'break'],
            },
          ],
        },
      },
      {
        op: 'addContainer',
        page: 'home',
        block: {
          id: 'list',
          look: 'list',
          source: { table: 'shifts', limit: 10 },
          show: { title: 'in', subtitles: ['break'], trailing: 'worked' },
        },
      },
    ],
    { registry, locale },
  );
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

it('a new user logs a night shift with a break and sees the worked hours', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed });
  await fireEvent.changeText(await screen.findByTestId('form-log-start'), '22:00');
  await fireEvent.changeText(screen.getByTestId('form-log-end'), '6:00');
  await fireEvent.changeText(screen.getByTestId('form-log-break-minutes'), '30');
  await fireEvent.press(screen.getByTestId('form-log-submit'));
  const saved = await repo.listRecords('shifts');
  expect(saved).toHaveLength(1);
  // Check-in left blank defaults to the current time.
  expect(saved[0]!.values).toEqual({
    start: '22:00',
    end: '06:00',
    break: 30,
    in: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  });
  // 8 hours across midnight minus 30 minutes.
  expect(await screen.findByText('7.5 h')).toBeTruthy();
  expect(screen.getByText('0:30')).toBeTruthy();
});

it('the inline form says which field each box is for', async () => {
  await renderToolsApp(new MemoryWorkspaceRepo(), undefined, { seed });
  expect(await screen.findByPlaceholderText('上班 (HH:MM)')).toBeTruthy();
  expect(screen.getByPlaceholderText('下班 (HH:MM)')).toBeTruthy();
  expect(screen.getByPlaceholderText('打卡 (YYYY-MM-DD HH:MM)')).toBeTruthy();
  expect(screen.getByText('休息')).toBeTruthy();
});

it('the Now button fills in the current time', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed, locale: 'en' });
  await fireEvent.press(await screen.findByTestId('form-log-start-now'));
  expect(screen.getByTestId('form-log-start').props.value).toMatch(/^\d{2}:\d{2}$/);
  await fireEvent.press(screen.getByTestId('form-log-in-now'));
  expect(screen.getByTestId('form-log-in').props.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(screen.getAllByText('Now')).toHaveLength(3);
});

it('refuses 75 minutes and a time like 25:00 without saving anything', async () => {
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, undefined, { seed });
  await fireEvent.changeText(await screen.findByTestId('form-log-start'), '25:00');
  await fireEvent.changeText(screen.getByTestId('form-log-break-hours'), '1');
  await fireEvent.changeText(screen.getByTestId('form-log-break-minutes'), '75');
  await fireEvent.press(screen.getByTestId('form-log-submit'));
  expect(await screen.findAllByText('格式不对')).toHaveLength(2);
  expect(await repo.listRecords('shifts')).toEqual([]);
});

it('shows stored entries in French, and nothing for values that no longer fit', async () => {
  const repo = new MemoryWorkspaceRepo();
  await repo.insertRecord({
    id: 'r1',
    collectionId: 'shifts',
    values: { start: '09:00', end: '17:00', in: '2026-10-21T08:55', break: 90 },
    createdAt: 1,
    updatedAt: 1,
  });
  // Values with mismatched types after restoring an old version: not displayed, nor allowed to break formulas.
  await repo.insertRecord({
    id: 'r2',
    collectionId: 'shifts',
    values: { start: 900, end: '17:00', in: '2026-10-20', break: '1:30' },
    createdAt: 2,
    updatedAt: 2,
  });
  await renderToolsApp(repo, undefined, { seed, locale: 'fr' });
  expect(await screen.findByText('21/10/2026 08:55')).toBeTruthy();
  expect(screen.getByText('1:30')).toBeTruthy();
  expect(screen.getByText('6,5 h')).toBeTruthy();
  expect(screen.queryByText('2026-10-20')).toBeNull();
  expect(screen.getAllByText(/ h$/)).toHaveLength(1);
});
