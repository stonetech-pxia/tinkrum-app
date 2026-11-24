import {
  createStarterWorkspace,
  currentFiles,
  type Locale,
  type Registry,
  type Workflow,
} from '@morph/core';
import type { TableDoc } from '@morph/tool-office';
import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { commitRun, listDesks, loadDesk, placeOnDesk } from '../desk/store';
import { useIncoming } from '../share/incoming';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, TINY_JPEG } from '../test-utils/fake-files';
import { allDeskTools, deskTool } from '../test-utils/desk-toolbar';
import { renderToolsApp } from '../test-utils/render-app';

// File room R1 (file-room DESIGN §9, D-357–D-361): inbox "Place on desk" as the first item; preview
// in room, toolbar, generating new version via a tool, undo/redo, quick actions applied to desk,
// clearing desk in "Done"; layout from config. Three states: new user (blank workspace, no desk),
// with data (Excel conversion result on desk), edge case (many files, file without tools, cleared
// desk).

afterEach(() => {
  useIncoming.getState().clear();
  jest.restoreAllMocks();
});

async function openShare(files: FakeFiles, names: string[], mime = 'image/jpeg') {
  const picked = names.map((n) => files.offer(n, TINY_JPEG, mime));
  await act(async () => useIncoming.getState().receive(picked, [], 'picker'));
  await act(() => router.push('/share'));
  return picked;
}

/** Placing multiple files on desk together (inbox no longer has "Place on desk", D-457; placed directly here, then open desk). */
async function openDeskFor(files: FakeFiles, names: string[], mime = 'image/jpeg') {
  const picked = names.map((n) => files.offer(n, TINY_JPEG, mime));
  const desk = await placeOnDesk(files, picked, Date.now());
  await act(() => router.push({ pathname: '/desk/[deskId]', params: { deskId: desk.id } }));
  return picked;
}

/** The unique desk in the desk directory (wait for UI updates before reading, avoid reading files inside waitFor to prevent overlaps with other acts). */
async function onlyDesk(files: FakeFiles) {
  const list = await listDesks(files);
  expect(list).toHaveLength(1);
  return list[0]!;
}

describe('Preview page → Edit (place on desk)', () => {
  it('New user: "Edit" at the bottom of the preview page; tapping it copies an entry into the room, leaving the original untouched; going back returns to the preview page', async () => {
    const { files } = await renderToolsApp();
    const [photo] = await openShare(files, ['IMG_1.jpg']);
    expect(await screen.findByTestId('preview-bar')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('preview-edit'));
    expect(await screen.findByTestId('desk-screen')).toBeTruthy();
    expect(screen.getByTestId('desk-preview-image')).toBeTruthy();
    const placed = await onlyDesk(files);
    expect(currentFiles(placed)[0]!.path).toBe('v1-0.jpg');
    // Original is a copy from the selector: desk uses its own copy without moving it.
    expect(files.desk.moved).toEqual([]);
    expect(files.disk.get(`desk/${placed.id}/v1-0.jpg`)).toEqual(TINY_JPEG);
    // Preview page still underneath (desk was pushed): received batch not released; returning to preview page keeps the file.
    expect(files.disk.has(photo!.uri)).toBe(true);
    await act(() => router.back());
    expect(await screen.findByTestId('preview-bar')).toBeTruthy();
    expect(files.disk.has(photo!.uri)).toBe(true);
    // Desk not kept (D-462): unmodified, cleared upon leaving.
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(await listDesks(files)).toEqual([]);
  });
});

describe('Tools in the room', () => {
  it('Default toolbar grouped by file type; tools with parameters first show a panel, tapping "Apply" generates a new version, supports undo and redo', async () => {
    const { files } = await renderToolsApp();
    await openShare(files, ['IMG_1.jpg']);
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    await screen.findByTestId('desk-toolbar');
    // Group names are small tabs above the toolbar; tapping any tab scrolls to that group.
    const tabs = within(screen.getByTestId('desk-tabs'));
    for (const name of ['编辑', '处理', '转换', '快捷操作'])
      expect(tabs.getByText(name)).toBeTruthy();
    expect(screen.getByTestId('desk-tab-0')).toBeSelected();
    // Displays only the selected group below (2026-11-06: when laid out in a long strip, subsequent groups appeared on the same line, and tapping back to the first group did not jump).
    const firstOf = () =>
      String(
        within(screen.getByTestId('desk-toolbar')).getAllByTestId(/^desk-tool-/)[0]!.props.testID,
      );
    const editFirst = firstOf();
    await fireEvent.press(screen.getByTestId('desk-tab-2'));
    expect(screen.getByTestId('desk-tab-2')).toBeSelected();
    expect(screen.getByTestId('desk-tab-0')).not.toBeSelected();
    expect(screen.queryByTestId(editFirst)).toBeNull();
    await fireEvent.press(screen.getByTestId('desk-tab-0'));
    expect(screen.getByTestId('desk-tab-0')).toBeSelected();
    expect(firstOf()).toBe(editFirst);
    // Images do not have PDF tools.
    expect(screen.queryByTestId('desk-tool-pdf.compress')).toBeNull();
    expect(screen.getByTestId('desk-undo')).toBeDisabled();

    await fireEvent.press(await deskTool('desk-tool-image.rotate'));
    expect(await screen.findByText('应用')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    await waitFor(() => expect(screen.getByTestId('desk-undo')).not.toBeDisabled());
    let desk = await onlyDesk(files);
    expect(desk.versions.map((v) => v.by)).toEqual([
      { kind: 'place' },
      { kind: 'action', action: 'image.rotate' },
    ]);
    // Results in run directory moved into desk; run directory cleared.
    expect([...files.disk.keys()].filter((k) => k.startsWith('runs/'))).toEqual([]);

    await fireEvent.press(screen.getByTestId('desk-undo'));
    await waitFor(() => expect(screen.getByTestId('desk-redo')).not.toBeDisabled());
    expect((await loadDesk(files, desk.id))?.current).toBe(0);
    await fireEvent.press(screen.getByTestId('desk-redo'));
    await waitFor(() => expect(screen.getByTestId('desk-redo')).toBeDisabled());
    desk = (await loadDesk(files, desk.id))!;
    expect(desk.current).toBe(1);
    expect(desk.versions).toHaveLength(2);
  });

  it('Multiple photos: tools apply to all; convert to PDF combines multiple files into one (multi-in-one), undo returns to the individual photos', async () => {
    const { files } = await renderToolsApp();
    await openDeskFor(files, ['a.jpg', 'b.jpg', 'c.jpg']);
    expect(await screen.findByTestId('desk-targets')).toHaveTextContent('工具作用到这 3 份文件');
    expect(screen.getByTestId('desk-strip')).toBeTruthy();
    await fireEvent.press(await deskTool('desk-tool-pdf.fromImages'));
    await fireEvent.press(await screen.findByTestId('prompt-ok'));
    await waitFor(() => expect(screen.getByTestId('desk-preview-pdf')).toBeTruthy());
    const desk = await onlyDesk(files);
    expect(currentFiles(desk).map((f) => f.ext)).toEqual(['pdf']);
    // Tests have no pack: PDF page-turning preview states it needs to be downloaded, and system preview can also be used.
    expect(screen.getByTestId('desk-pdf-pack')).toBeTruthy();
    expect(screen.queryByTestId('desk-strip')).toBeNull();
    await fireEvent.press(screen.getByTestId('desk-undo'));
    await waitFor(() => expect(screen.getByTestId('desk-strip')).toBeTruthy());
    expect(screen.getByTestId('desk-preview-image')).toBeTruthy();
  });

  it('Quick action button applies the entire quick action to the files on the desk (without selecting files again), generating a version', async () => {
    const rotateTwice: Workflow = {
      kind: 'quickAction',
      id: 'rotate-twice',
      name: '转两次',
      steps: [
        { id: 's1', action: 'in.photos', params: { source: 'library', min: 1, max: 30 } },
        { id: 's2', action: 'image.rotate', params: { angle: 90, flip: 'none' } },
        { id: 's3', action: 'image.rotate', params: { angle: 90, flip: 'none' } },
      ],
    };
    const seed = (locale: Locale, registry: Registry) => {
      const base = createStarterWorkspace(locale, registry);
      return { ...base, tools: [...base.tools, rotateTwice] };
    };
    const { files } = await renderToolsApp(undefined, undefined, { seed });
    await openShare(files, ['IMG_1.jpg']);
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    // Custom quick actions are ordered first in the "quick action" group.
    await screen.findByTestId('desk-toolbar');
    const quick = (await allDeskTools()).filter((id) => !id.includes('.'));
    expect(quick[0]).toBe('desk-tool-rotate-twice');
    await fireEvent.press(await deskTool(quick[0]!));
    await waitFor(() => expect(screen.getByTestId('desk-undo')).not.toBeDisabled());
    const desk = await onlyDesk(files);
    // Combine two steps into a single version, undo the entire chain together.
    expect(desk.versions.map((v) => v.by)).toEqual([
      { kind: 'place' },
      { kind: 'workflow', workflowId: 'rotate-twice' },
    ]);
  });

  it('OCR classes (convert to Excel) do not ask for language or pop up a panel, running directly; when failed, show the reason while the desk remains unchanged (D-278, D-363)', async () => {
    const { files } = await renderToolsApp();
    await openShare(files, ['IMG_1.jpg']);
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    // Tests have no on-device OCR: converting to Excel reports "This device does not support on-device OCR".
    await fireEvent.press(await deskTool('desk-tool-ocr.toExcel'));
    expect(await screen.findByTestId('desk-error')).toBeTruthy();
    expect(screen.queryByTestId('prompt-ok')).toBeNull();
    const desk = await onlyDesk(files);
    expect(desk.versions).toHaveLength(1);
  });
});

describe('Has data: the result of converting to Excel is on the desk', () => {
  it('xlsx displayed using table view (editable from R2 onwards, see desk-edit-test), toolbar has convert to PDF and the "Files" group', async () => {
    const repo = new MemoryWorkspaceRepo();
    const files = new FakeFiles();
    files.disk.set('picker://photo.jpg', TINY_JPEG);
    let desk = await placeOnDesk(
      files,
      [
        {
          uri: 'picker://photo.jpg',
          name: 'photo.jpg',
          size: TINY_JPEG.length,
          mimeType: 'image/jpeg',
        },
      ],
      Date.now(),
      'sheetdesk',
    );
    const doc: TableDoc = {
      version: 3,
      scope: 'all',
      pages: [
        {
          name: 'Sheet1',
          source: 'runs/r1/page.jpg',
          width: 100,
          height: 100,
          lineHeight: 10,
          colWidths: [50, 50],
          blocks: [
            {
              kind: 'table',
              rows: 1,
              col: 0,
              cols: 2,
              box: { x: 0, y: 0, width: 100, height: 20 },
              cells: [
                { row: 0, col: 0, rowSpan: 1, colSpan: 1, text: '品名' },
                { row: 0, col: 1, rowSpan: 1, colSpan: 1, text: '12' },
              ],
            },
          ],
        },
      ],
    };
    files.disk.set('runs/r1/page.jpg', TINY_JPEG);
    files.disk.set('runs/r1/表格.xlsx', new Uint8Array([1, 2, 3]));
    files.disk.set('runs/r1/表格.json', new TextEncoder().encode(JSON.stringify(doc)));
    ({ desk } = await commitRun(
      files,
      desk,
      ['f1-0'],
      {
        type: 'files',
        items: [
          {
            uri: 'runs/r1/表格.xlsx',
            name: '表格',
            ext: 'xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 3,
            tableDoc: { uri: 'runs/r1/表格.json', for: 'runs/r1/表格.xlsx' },
          },
        ],
      },
      { kind: 'action', action: 'ocr.toExcel' },
      Date.now(),
    ));
    await renderToolsApp(repo, files);
    await act(() => router.push({ pathname: '/desk/[deskId]', params: { deskId: desk.id } }));
    expect(await screen.findByTestId('table-sheet')).toBeTruthy();
    expect(screen.getByText('品名')).toBeTruthy();
    expect(screen.getByTestId('desk-editor')).toBeTruthy();
    // Toolbar: convert to PDF, plus the files group (share, save, system preview), not empty.
    screen.getByTestId('desk-toolbar');
    expect(await allDeskTools()).toEqual([
      'desk-tool-pdf.fromDocument',
      'desk-tool-room-share',
      'desk-tool-room-save',
      'desk-tool-room-folder',
      'desk-tool-room-preview',
    ]);
    // Undo to return to photos.
    await fireEvent.press(screen.getByTestId('desk-undo'));
    expect(await screen.findByTestId('desk-preview-image')).toBeTruthy();
  });
});

describe('Word document on the desk', () => {
  it('docx without extension in the name (shared from other Android apps): recognized as Word, can be converted to PDF and shared', async () => {
    const { files } = await renderToolsApp();
    await openShare(
      files,
      ['合同'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    const toolbar = await screen.findByTestId('desk-toolbar');
    expect(screen.queryByTestId('desk-no-tools')).toBeNull();
    expect(within(toolbar).getByTestId('desk-tool-pdf.fromDocument')).not.toBeDisabled();
    expect(await deskTool('desk-tool-room-share')).toBeTruthy();
    const placed = await onlyDesk(files);
    expect(currentFiles(placed)[0]!.ext).toBe('docx');
    // Convert to PDF directly without asking about paper size.
    await fireEvent.press(await deskTool('desk-tool-pdf.fromDocument'));
    await waitFor(() => expect(screen.getByTestId('desk-preview-pdf')).toBeTruthy());
    expect(files.documents.converted.map((c) => c.ext)).toEqual(['docx']);
  });

  it('"Share" in the toolbar hands desk files over to system sharing', async () => {
    const { files } = await renderToolsApp();
    await openShare(files, ['IMG_1.jpg']);
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    await fireEvent.press(await deskTool('desk-tool-room-share'));
    await waitFor(() => expect(files.shared).toHaveLength(1));
  });
});

describe('Boundaries', () => {
  it('Desktop cleared: show a note, can be dismissed', async () => {
    await renderToolsApp();
    await act(() => router.push({ pathname: '/desk/[deskId]', params: { deskId: 'nope' } }));
    expect(await screen.findByTestId('desk-gone')).toHaveTextContent(/已经清空/);
  });

  it('Unrecognized files: no tools available, can be viewed using system preview; "Done" does not clear the desktop, clearing happens upon leaving, originals remain untouched (D-462)', async () => {
    const { files } = await renderToolsApp();
    const [zip] = await openShare(files, ['notes.zip'], 'application/zip');
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    expect(await screen.findByTestId('desk-no-tools')).toBeTruthy();
    expect(screen.getByTestId('desk-preview-generic')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('desk-done'));
    expect(screen.queryByTestId('desk-clear')).toBeNull();
    await fireEvent.press(await screen.findByTestId('desk-sheet-cancel'));
    await fireEvent.press(screen.getByTestId('desk-close'));
    await waitFor(() => expect(screen.queryByTestId('desk-screen')).toBeNull());
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(await listDesks(files)).toEqual([]);
    expect(zip).toBeTruthy();
  });
});

describe('Layout configuration (D-358)', () => {
  const seed = (locale: Locale, registry: Registry) => {
    const base = createStarterWorkspace(locale, registry);
    return {
      ...base,
      containers: {
        ...base.containers,
        desk: {
          toolbar: 'top' as const,
          above: [{ id: 'tip', look: 'notice' as const, show: { text: '先旋转再转 PDF' } }],
          tools: {
            image: [
              { title: '常用', items: [{ action: 'image.rotate' }, { action: 'pdf.fromImages' }] },
            ],
          },
        },
      },
    };
  };

  it('Toolbar, position, and instructions above the preview specified in the config are used; unspecified types fall back to defaults', async () => {
    const { files } = await renderToolsApp(undefined, undefined, { seed });
    await openShare(files, ['IMG_1.jpg']);
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    await screen.findByTestId('desk-toolbar');
    expect(within(screen.getByTestId('desk-tabs')).getByText('常用')).toBeTruthy();
    expect(await allDeskTools()).toEqual([
      'desk-tool-image.rotate',
      'desk-tool-pdf.fromImages',
      // The "Files" group belongs to the room itself, is not in the config, and is always at the end.
      'desk-tool-room-share',
      'desk-tool-room-save',
      'desk-tool-room-folder',
      'desk-tool-room-preview',
    ]);
    expect(screen.getByTestId('desk-above')).toHaveTextContent(/先旋转再转 PDF/);
    // Toolbar is above the preview.
    const order = screen.queryAllByTestId(/^(desk-toolbar|desk-preview-image)$/);
    expect(order.map((n) => n.props.testID)).toEqual(['desk-toolbar', 'desk-preview-image']);
  });
});

describe('Desk in storage', () => {
  it('List desks when present, show a prompt to clear those inactive for 7 days, tap "Open" to return to the room', async () => {
    const files = new FakeFiles();
    files.disk.set('picker://a.jpg', TINY_JPEG);
    const picked = [
      { uri: 'picker://a.jpg', name: 'a.jpg', size: TINY_JPEG.length, mimeType: 'image/jpeg' },
    ];
    const old = await placeOnDesk(files, picked, Date.now() - 8 * 24 * 60 * 60 * 1000, 'olddesk');
    const fresh = await placeOnDesk(files, picked, Date.now(), 'freshdesk');
    await renderToolsApp(new MemoryWorkspaceRepo(), files);
    await act(() => router.push('/storage'));
    expect(await screen.findByTestId('desk-list')).toBeTruthy();
    expect(screen.getByTestId(`desk-stale-${old.id}`)).toHaveTextContent('7 天没动了，可以清掉');
    expect(screen.queryByTestId(`desk-stale-${fresh.id}`)).toBeNull();
    await fireEvent.press(screen.getByTestId(`desk-open-${old.id}`));
    expect(await screen.findByTestId('desk-screen')).toBeTruthy();
  });

  it('New user: no desk section in storage', async () => {
    await renderToolsApp();
    await act(() => router.push('/storage'));
    expect(await screen.findByTestId('storage-screen')).toBeTruthy();
    expect(screen.queryByTestId('desk-list')).toBeNull();
  });
});

describe('Three languages', () => {
  it.each([
    ['fr', ['Modifier', 'Ajuster', 'Convertir', 'Actions rapides']],
    ['en', ['Edit', 'Adjust', 'Convert', 'Quick actions']],
  ] as const)('%s: toolbar group name', async (locale, groups) => {
    const { files } = await renderToolsApp(undefined, undefined, { locale });
    await openDeskFor(files, ['IMG_1.jpg', 'IMG_2.jpg']);
    await screen.findByTestId('desk-toolbar');
    for (const g of groups)
      expect(within(screen.getByTestId('desk-tabs')).getByText(g)).toBeTruthy();
    expect(screen.getByTestId('desk-targets')).toHaveTextContent(
      locale === 'fr' ? 'Les outils s’appliquent à ces 2 fichiers' : 'Tools apply to these 2 files',
    );
  });
});
