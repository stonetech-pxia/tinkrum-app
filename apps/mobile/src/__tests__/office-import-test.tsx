import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { currentFiles, type Locale } from '@morph/core';
import { writeRowsXlsx } from '@morph/tool-office';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { strFromU8, unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { Alert, type AlertButton } from 'react-native';

import { listDesks } from '../desk/store';
import { useIncoming } from '../share/incoming';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { deskTool } from '../test-utils/desk-toolbar';
import { renderToolsApp } from '../test-utils/render-app';

// Opening and editing external docx / xlsx (D-509): Preview page renders using the decoded
// intermediate format (no longer "cannot view here"); "Edit" copies a file to the desk, acting as a
// Word / spreadsheet editor (bypassing PDF conversion); before the first save or share after
// editing, display a notice about which formats are not retained; original file remains untouched.
// Three states: save unedited (saves a copy of the original without prompting), save after editing,
// and unopenable files (password-protected).

afterEach(() => {
  useIncoming.getState().clear();
  jest.restoreAllMocks();
});

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const OFFICE_FIXTURES = join(__dirname, '../../../../packages/tool-office/src/fixtures/office');
/** macOS textutil UTF-8 web-converted docx (£, €, é, Chinese, bold, lists). */
const LEASE = new Uint8Array(readFileSync(join(OFFICE_FIXTURES, 'lease-textutil.docx')));
/** Password-protected docx saved by Pages. */
const LOCKED = new Uint8Array(readFileSync(join(OFFICE_FIXTURES, 'password-pages.docx')));
/** Word-saved docx containing tables (mammoth test file). */
const TABLES = new Uint8Array(
  readFileSync(
    join(dirname(require.resolve('mammoth/package.json')), 'test/test-data/tables.docx'),
  ),
);
/** Record export xlsx (D-427): Previously only viewable via system preview. */
const EXPENSES = writeRowsXlsx('Expenses', [
  [
    { kind: 'text', text: 'Item' },
    { kind: 'text', text: 'Amount' },
  ],
  [
    { kind: 'text', text: 'Coffee' },
    { kind: 'number', value: 4.5, format: '0.00', text: '4.50' },
  ],
]);

async function openPreview(name: string, bytes: Uint8Array, mime: string, locale: Locale = 'en') {
  const files = new FakeFiles();
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, files, { locale });
  const picked = files.offer(name, bytes, mime);
  await act(async () => useIncoming.getState().receive([picked], [], 'picker'));
  await act(() => router.push('/share'));
  return { files, repo, picked };
}

async function onlyDesk(files: FakeFiles) {
  const list = await listDesks(files);
  expect(list).toHaveLength(1);
  return list[0]!;
}

/** Editing text in the edit page (web): Page script returns the entire page (same as desk-edit-test). */
function wordPage() {
  const view = screen.getByTestId('word-editor-page');
  const dom = new JSDOM(view.props.source.html, { runScripts: 'dangerously' });
  const window = dom.window as unknown as Window & { __wordPages: () => unknown };
  const send = (msg: object) =>
    fireEvent(screen.getByTestId('word-editor-page'), 'message', {
      nativeEvent: { data: JSON.stringify(msg) },
    });
  return {
    q: (sel: string) => window.document.querySelector(sel) as HTMLElement,
    input: () => send({ type: 'doc', pages: window.__wordPages() }),
    state: (state: object) => send({ type: 'state', ...state }),
  };
}

/** Pop-up alert: Record title and content, tap the button with the given label. */
function answerAlert(label: string) {
  const seen: { title: string; message?: string }[] = [];
  jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons?: AlertButton[]) => {
    seen.push({ title: String(title), ...(message ? { message: String(message) } : {}) });
    buttons?.find((b) => b.text === label)?.onPress?.();
  });
  return seen;
}

const docxText = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['word/document.xml']!);

describe('outside Word files (docx)', () => {
  it('the preview page shows the document itself; Edit puts a copy on the desk in the Word editor', async () => {
    const { files, picked } = await openPreview('Lease.docx', LEASE, DOCX);
    const preview = await screen.findByTestId('word-preview-page');
    const html = preview.props.source.html as string;
    expect(html).toContain('The rent is £1,250 per month');
    expect(html).toContain('Pay the rent');
    expect(html).toContain('中文测试');
    // Read-only.
    expect(html).not.toContain('contenteditable="true"');
    expect(screen.queryByTestId('desk-preview-generic')).toBeNull();

    await fireEvent.press(screen.getByTestId('preview-edit'));
    const editor = await screen.findByTestId('word-editor-page');
    expect(editor.props.source.html).toContain('contenteditable="true"');
    expect(editor.props.source.html).toContain('Café deposit: €300');
    const desk = await onlyDesk(files);
    const [file] = currentFiles(desk);
    expect(file!.source).toMatchObject({ kind: 'doc', imported: 'original' });
    // Original file is only copied: Desk contains identical bytes, original file remains intact and unchanged.
    expect(files.disk.get(`desk/${desk.id}/${file!.path}`)).toEqual(LEASE);
    expect(files.disk.get(picked.uri)).toEqual(LEASE);
    expect(files.desk.moved).toEqual([]);
    // Not converted to PDF.
    expect(files.documents.converted).toEqual([]);
  });

  it('saving without editing saves the original copy: no notice, nothing stored next to it', async () => {
    const { files, repo } = await openPreview('Lease.docx', LEASE, DOCX);
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    await screen.findByTestId('word-editor-page');
    const alerts = answerAlert('Continue');
    await fireEvent.press(await deskTool('desk-tool-room-save'));
    expect(await screen.findByTestId('desk-saved')).toBeTruthy();
    expect(alerts).toEqual([]);
    const [asset] = await repo.listAssets();
    expect(files.disk.get(asset!.path)).toEqual(LEASE);
    expect([...files.disk.keys()].filter((k) => k.startsWith(`assets/${asset!.id}/`))).toEqual([
      asset!.path,
    ]);
  });

  it('after editing, the first save says once which formatting is not kept; Cancel saves nothing', async () => {
    const { files, repo, picked } = await openPreview('Report.docx', TABLES, DOCX);
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    await screen.findByTestId('word-editor-page');
    const page = wordPage();
    await page.state({ focus: true });
    page.q('[data-ref="0-0"]').textContent = 'Above, edited on the phone';
    page.q('[data-ref="0-1"] td[data-i="3"]').textContent = 'Bottom right, edited';
    await page.input();
    await page.state({ focus: false });

    // First tap on "Cancel": Saves nothing, prompts again next time.
    let alerts = answerAlert('Cancel');
    await fireEvent.press(await deskTool('desk-tool-room-save'));
    await waitFor(() => expect(alerts).toHaveLength(1));
    expect(alerts[0]!.title).toBe('Some formatting won’t be kept');
    expect(alerts[0]!.message).toMatch(/new Word file.*Headers and footers.*not changed/s);
    expect(await repo.listAssets()).toEqual([]);

    jest.restoreAllMocks();
    alerts = answerAlert('Continue');
    await fireEvent.press(await deskTool('desk-tool-room-save'));
    expect(await screen.findByTestId('desk-saved')).toBeTruthy();
    expect(alerts).toHaveLength(1);
    const [asset] = await repo.listAssets();
    const xml = docxText(files.disk.get(asset!.path)!);
    expect(xml).toContain('Above, edited on the phone');
    expect(xml).toContain('Bottom right, edited');
    expect(xml).toContain('Below');
    // Intermediate formats read from external files are not persisted alongside (re-read on next open).
    expect([...files.disk.keys()].filter((k) => k.startsWith(`assets/${asset!.id}/`))).toEqual([
      asset!.path,
    ]);
    // Original file untouched.
    expect(files.disk.get(picked.uri)).toEqual(TABLES);

    // Prompt only once: subsequent shares do not prompt again.
    await fireEvent.press(await deskTool('desk-tool-room-share'));
    await waitFor(() => expect(files.shared).toHaveLength(1));
    expect(alerts).toHaveLength(1);
  });

  // Combining D-507 and D-509 (2026-11-09): "Save to phone" also exports the regenerated file and similarly shows a notice first.
  it('after editing, Save to phone also says it first; Cancel copies nothing', async () => {
    const { files } = await openPreview('Report.docx', TABLES, DOCX);
    await fireEvent.press(await screen.findByTestId('preview-edit'));
    await screen.findByTestId('word-editor-page');
    const page = wordPage();
    await page.state({ focus: true });
    page.q('[data-ref="0-0"]').textContent = 'Edited before saving to the phone';
    await page.input();
    await page.state({ focus: false });

    let alerts = answerAlert('Cancel');
    await fireEvent.press(await deskTool('desk-tool-room-folder'));
    await waitFor(() => expect(alerts).toHaveLength(1));
    expect(alerts[0]!.title).toBe('Some formatting won’t be kept');
    expect(files.folderPicks).toBe(0);

    jest.restoreAllMocks();
    alerts = answerAlert('Continue');
    await fireEvent.press(await deskTool('desk-tool-room-folder'));
    await waitFor(() => expect(files.folders.get('MorphOut')?.size).toBe(1));
    const [saved] = [...files.folders.get('MorphOut')!.values()];
    expect(docxText(saved!)).toContain('Edited before saving to the phone');
  });

  it('a password-protected file says it cannot be opened, also when tapping Edit (French)', async () => {
    const { files } = await openPreview('Contrat.docx', LOCKED, DOCX, 'fr');
    expect(await screen.findByTestId('desk-preview-generic')).toHaveTextContent(
      /protégé par un mot de passe/,
    );
    await fireEvent.press(screen.getByTestId('preview-edit'));
    expect(await screen.findByTestId('share-preview-error')).toHaveTextContent(
      'Ce fichier est protégé par un mot de passe : Tinkrum ne peut pas l’ouvrir. Vous pouvez l’ouvrir dans l’aperçu du système.',
    );
    expect(await listDesks(files)).toEqual([]);
  });
});

describe('outside Excel files (xlsx)', () => {
  it('the preview shows the sheet; Edit opens the table editor; the edited number is saved after the notice', async () => {
    const { files, repo, picked } = await openPreview('Expenses.xlsx', EXPENSES, XLSX, 'zh');
    expect(await screen.findByTestId('table-preview-sheet')).toBeTruthy();
    expect(screen.getByTestId('table-cell-1-0')).toHaveTextContent('Coffee');
    expect(screen.getByTestId('table-cell-1-1')).toHaveTextContent('4.50');

    await fireEvent.press(screen.getByTestId('preview-edit'));
    expect(await screen.findByTestId('desk-editor')).toBeTruthy();
    // No out-of-table text: The two recognition scope buttons are useless and hidden.
    expect(screen.queryByTestId('table-scope-all')).toBeNull();
    await fireEvent.press(screen.getByTestId('table-cell-1-1'));
    // External tables lack original images: Below the selected cell, do not display "Original image" or "This cell was added here".
    expect(screen.getByTestId('desk-edit-bar')).not.toHaveTextContent(/原图/);
    await fireEvent.press(screen.getByTestId('table-cell-1-1'));
    await fireEvent.changeText(screen.getByTestId('desk-edit-input'), '5.25');
    await fireEvent.press(screen.getByTestId('desk-edit-ok'));
    await fireEvent.press(screen.getByTestId('desk-deselect'));

    const alerts = answerAlert('继续');
    await fireEvent.press(screen.getByTestId('desk-done'));
    await fireEvent.press(await screen.findByTestId('desk-save'));
    await waitFor(async () => expect(await repo.listAssets()).toHaveLength(1));
    expect(alerts).toEqual([
      {
        title: '有些格式不会保留',
        message:
          'Tinkrum 会把改好的存成一份新的 Excel 文件：数值、合并的格子和列宽都在；公式只留下最后算出的结果，颜色、边框和图表不会保留。原来的文件不会改动。',
      },
    ]);
    const [asset] = await repo.listAssets();
    const sheet = strFromU8(unzipSync(files.disk.get(asset!.path)!)['xl/worksheets/sheet1.xml']!);
    expect(sheet).toMatch(/<c r="B2" s="\d+"><v>5.25<\/v><\/c>/);
    expect(files.disk.get(picked.uri)).toEqual(EXPENSES);
  });
});
