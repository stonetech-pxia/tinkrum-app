import type { RunItem } from '@morph/core';
import type { TableDoc } from '@morph/tool-office';
import { act, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { DeviceEventEmitter, Platform, StyleSheet } from 'react-native';

import { placeResultsOnDesk } from '../desk/store';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp } from '../test-utils/render-app';

// File room R2 layout issue on Samsung SM-S948B (bottom gesture navigation bar) (2026-10-30): the
// two recognition range buttons are stretched into large vertical bars; the edit layer and input
// box buttons after selecting cells are rendered below the navigation bar; the keyboard blocks the
// input box.

/** Bottom navigation bar height: content at the bottom of the room must leave this much inset. */
const BOTTOM = 34;
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  const insets = { top: 20, bottom: 34, left: 0, right: 0 };
  return { ...actual, useSafeAreaInsets: () => insets };
});

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const box = (x: number, y: number, width = 100, height = 20) => ({ x, y, width, height });

/** One page: a line of text outside the table (hence recognition range switching), followed by a 2x2 table. */
const tableDoc = (): TableDoc => ({
  version: 3,
  scope: 'all',
  pages: [
    {
      name: '第 1 页',
      source: 'runs/r1/page.jpg',
      width: 1000,
      height: 1400,
      lineHeight: 20,
      colWidths: [200, 200],
      blocks: [
        { kind: 'text', text: '标题', box: box(0, 0) },
        {
          kind: 'table',
          rows: 2,
          col: 0,
          cols: 2,
          box: box(0, 30, 400, 40),
          cells: [0, 1, 2, 3].map((i) => ({
            row: Math.floor(i / 2),
            col: i % 2,
            rowSpan: 1,
            colSpan: 1,
            text: 'abcd'[i]!,
            box: box((i % 2) * 200, 30 + Math.floor(i / 2) * 20, 200, 20),
          })),
        },
      ],
    },
  ],
});

function xlsxResult(files: FakeFiles, name: string): RunItem {
  files.disk.set('runs/r1/page.jpg', new Uint8Array([9, 9, 9]));
  files.disk.set(`runs/r1/${name}.xlsx`, new Uint8Array([1, 2, 3]));
  files.disk.set(`runs/r1/${name}.json`, new TextEncoder().encode(JSON.stringify(tableDoc())));
  return {
    uri: `runs/r1/${name}.xlsx`,
    name,
    ext: 'xlsx',
    mimeType: XLSX,
    size: 3,
    tableDoc: { uri: `runs/r1/${name}.json`, for: `runs/r1/${name}.xlsx` },
  };
}

async function openXlsx(names = ['明细']) {
  const files = new FakeFiles();
  const items = names.map((n) => xlsxResult(files, n));
  const desk = await placeResultsOnDesk(files, items, Date.now(), 'layoutdesk');
  await renderToolsApp(new MemoryWorkspaceRepo(), files);
  await act(() => router.push({ pathname: '/desk/[deskId]', params: { deskId: desk.id } }));
  await screen.findByTestId('desk-editor');
}

const styleOf = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) ?? {};

describe('Room layout (Samsung physical device, 2026-10-30)', () => {
  it('Recognition range switcher and file bar form a single normal-height horizontal bar without being stretched (horizontal ScrollView defaults to flexGrow: 1)', async () => {
    await openXlsx(['明细', '汇总']);
    expect(screen.getByTestId('table-scope-tables')).toBeTruthy();
    expect(styleOf('desk-strip').flexGrow).toBe(0);
    expect(styleOf('desk-scope-bar').flexGrow).toBe(0);
  });

  it('Toolbar collapses when selecting cells or editing: bottom insets by navigation bar height', async () => {
    await openXlsx();
    // Not selected: toolbar makes space for itself.
    expect(screen.queryByTestId('desk-bottom-inset')).toBeNull();
    await fireEvent.press(screen.getByTestId('table-cell-1-0'));
    expect(screen.getByTestId('desk-edit-bar')).toBeTruthy();
    expect(styleOf('desk-bottom-inset').height).toBe(BOTTOM);
    await fireEvent.press(screen.getByTestId('table-cell-1-0'));
    expect(screen.getByTestId('desk-edit-panel')).toBeTruthy();
    expect(styleOf('desk-bottom-inset').height).toBe(BOTTOM);
    // When keyboard pops up, navigation bar stays below the keyboard: no additional inset.
    await act(() => {
      DeviceEventEmitter.emit('keyboardDidShow', {
        endCoordinates: { screenX: 0, screenY: 500, width: 400, height: 300 },
      });
    });
    expect(screen.queryByTestId('desk-bottom-inset')).toBeNull();
    await act(() => {
      DeviceEventEmitter.emit('keyboardDidHide', {
        endCoordinates: { screenX: 0, screenY: 800, width: 400, height: 0 },
      });
    });
    expect(styleOf('desk-bottom-inset').height).toBe(BOTTOM);
  });

  describe('Android', () => {
    const os = Platform.OS;
    beforeEach(() =>
      Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true }),
    );
    afterEach(() => Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true }));

    it('When keyboard pops up, bottom of the room leaves space for the keyboard height, placing the input box above the keyboard (full-screen page window does not shrink with the keyboard)', async () => {
      await openXlsx();
      await fireEvent.press(screen.getByTestId('table-cell-1-0'));
      await fireEvent.press(screen.getByTestId('table-cell-1-0'));
      expect(screen.getByTestId('desk-edit-input')).toBeTruthy();
      await fireEvent(screen.getByTestId('desk-screen'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } },
        persist: () => {},
      });
      await act(() => {
        DeviceEventEmitter.emit('keyboardDidShow', {
          endCoordinates: { screenX: 0, screenY: 500, width: 400, height: 300 },
        });
      });
      expect(styleOf('desk-screen').paddingBottom).toBe(300);
    });
  });
});
