import { createDefaultWorkspace, currentFiles, decodeUtf8, type RunItem } from '@morph/core';
import {
  parseDocDoc,
  parseTableDoc,
  type DocDoc,
  type TableBlock,
  type TableDoc,
} from '@morph/tool-office';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { strFromU8, unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { Alert, Dimensions, StyleSheet } from 'react-native';

import { placeAssetOnDesk, savedSourceBytes } from '../desk/saved-source';
import { openAsset } from '../renderer/FileList';
import { loadDesk, placeResultsOnDesk, writeEditDraft } from '../desk/store';
import { makePalette } from '../renderer/theme';
import { ResultView } from '../run/ResultView';
import { saveItems } from '../runtime/actions/io';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { deskTool } from '../test-utils/desk-toolbar';
import { renderToolsApp } from '../test-utils/render-app';

// File room R2 (file-room DESIGN §9, §11, D-366, D-367): Excel and Word files on the desk act as
// editors (tap to select, tap again to edit, toolbar switches to editing layer when selected);
// consecutive edits are merged into a single version, undoing steps backward through edits first,
// then reverting the entire block upon closing; saved as user files preserving intermediate formats
// and original images, allowing further edits when placed back on the desk from storage; result
// page's "Place on desk" replaces "View and edit".

afterEach(() => jest.restoreAllMocks());

const box = (x: number, y: number, width = 100, height = 20) => ({ x, y, width, height });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Page 1: a line of non-table text (title), followed by a cells×cells table; Page 2 contains only text. */
function tableDoc(cells = 2): TableDoc {
  const table: TableBlock = {
    kind: 'table',
    rows: cells,
    col: 0,
    cols: cells,
    box: box(0, 30, 400, 40),
    cells: Array.from({ length: cells * cells }, (_, i) => ({
      row: Math.floor(i / cells),
      col: i % cells,
      rowSpan: 1,
      colSpan: 1,
      text: cells === 2 ? 'abcd'[i]! : String(i),
      box: box((i % cells) * 200, 30 + Math.floor(i / cells) * 20, 200, 20),
    })),
  };
  return {
    version: 3,
    scope: 'all',
    pages: [
      {
        name: '第 1 页',
        source: 'runs/r1/page.jpg',
        width: 1000,
        height: 1400,
        lineHeight: 20,
        colWidths: Array(cells).fill(200),
        blocks: [{ kind: 'text', text: '标题', box: box(0, 0) }, table],
      },
      {
        name: '第 2 页',
        source: 'runs/r1/page.jpg',
        width: 1000,
        height: 1400,
        lineHeight: 20,
        colWidths: [250, 250, 250, 250],
        blocks: [{ kind: 'text', text: '只有文字', box: box(0, 0) }],
      },
    ],
  };
}

function wordDoc(src?: string): DocDoc {
  const cell = (col: number, text: string) => ({
    row: 0,
    col,
    rowSpan: 1,
    colSpan: 1,
    text,
    box: box(100 + col * 200, 300, 200, 40),
  });
  return {
    version: 1,
    pages: [
      {
        source: 'runs/r1/page.jpg',
        width: 1000,
        height: 1400,
        bodySize: 11,
        blocks: [
          { kind: 'paragraph', text: '年度报告', heading: 1, box: box(300, 40) },
          { kind: 'paragraph', text: '正文第一段。', box: box(100, 120, 800, 60) },
          {
            kind: 'list',
            ordered: true,
            format: '%1.',
            start: 1,
            items: ['甲', '乙'],
            box: box(100, 200),
          },
          {
            kind: 'table',
            colWidths: [200, 200],
            box: box(100, 300, 400, 40),
            table: {
              kind: 'table',
              rows: 1,
              col: 0,
              cols: 2,
              box: box(100, 300, 400, 40),
              cells: [cell(0, '名称'), cell(1, '金额')],
            },
          },
          { kind: 'image', box: box(100, 400, 300, 200), ...(src ? { src } : {}) },
        ],
      },
    ],
  };
}

/** An export-to-Excel or export-to-Word result inside the run directory (matching the result page). */
function runResult(files: FakeFiles, kind: 'table' | 'doc', doc: TableDoc | DocDoc): RunItem {
  files.disk.set('runs/r1/page.jpg', new Uint8Array([9, 9, 9]));
  const ext = kind === 'table' ? 'xlsx' : 'docx';
  files.disk.set(`runs/r1/明细.${ext}`, new Uint8Array([1, 2, 3]));
  files.disk.set('runs/r1/明细.json', new TextEncoder().encode(JSON.stringify(doc)));
  const ref = { uri: 'runs/r1/明细.json', for: `runs/r1/明细.${ext}` };
  return {
    uri: `runs/r1/明细.${ext}`,
    name: '明细',
    ext,
    mimeType: kind === 'table' ? XLSX : DOCX,
    size: 3,
    ...(kind === 'table' ? { tableDoc: ref } : { docDoc: ref }),
  };
}

/** Place on desk ("Place on desk" on the result page), opening the room. */
async function openOnDesk(kind: 'table' | 'doc', doc: TableDoc | DocDoc, files = new FakeFiles()) {
  const item = runResult(files, kind, doc);
  const desk = await placeResultsOnDesk(files, [item], Date.now(), 'editdesk');
  const repo = new MemoryWorkspaceRepo();
  await renderToolsApp(repo, files);
  await act(() => router.push({ pathname: '/desk/[deskId]', params: { deskId: desk.id } }));
  await screen.findByTestId('desk-editor');
  return { files, repo, item };
}

const deskNow = async (files: FakeFiles) => (await loadDesk(files, 'editdesk'))!;
const xlsxText = async (files: FakeFiles) => {
  const file = currentFiles(await deskNow(files))[0]!;
  return strFromU8(
    unzipSync(files.disk.get(`desk/editdesk/${file.path}`)!)['xl/sharedStrings.xml']!,
  );
};
const docxXml = async (files: FakeFiles) => {
  const file = currentFiles(await deskNow(files))[0]!;
  return strFromU8(unzipSync(files.disk.get(`desk/editdesk/${file.path}`)!)['word/document.xml']!);
};

async function editTo(id: string, text: string) {
  await fireEvent.press(screen.getByTestId(id));
  await fireEvent.press(screen.getByTestId(id));
  await fireEvent.changeText(screen.getByTestId('desk-edit-input'), text);
  await fireEvent.press(screen.getByTestId('desk-edit-ok'));
}

describe('Placed on desk: result page and storage (D-366)', () => {
  it('Result page Convert to Excel and Convert to Word results have "Place on desk" (replacing "View and edit"); absent when subsequent steps generate other files', async () => {
    const putOnDesk = jest.fn(async () => undefined);
    const item: RunItem = {
      uri: 'runs/r/1/a.xlsx',
      name: 'a',
      ext: 'xlsx',
      mimeType: XLSX,
      size: 2048,
      tableDoc: { uri: 'runs/r/2/a.json', for: 'runs/r/1/a.xlsx', pagesWithoutTables: [2, 3] },
    };
    const actions = {
      save: jest.fn(),
      share: jest.fn(),
      saveToFolder: jest.fn(),
      rememberedFolder: () => null,
      saveToPhotos: jest.fn(),
      print: jest.fn(),
      copy: jest.fn(),
      putOnDesk,
    };
    const palette = makePalette(createDefaultWorkspace('zh').theme, false);
    const view = await render(
      <ResultView
        value={{ type: 'files', items: [item] }}
        palette={palette}
        locale="zh"
        actions={actions}
      />,
    );
    expect(view.getByText('第 2、3 页没有找到带线的表格，已按全部内容输出。')).toBeTruthy();
    expect(view.queryByText('查看和编辑')).toBeNull();
    await fireEvent.press(view.getByTestId('result-desk'));
    expect(putOnDesk).toHaveBeenCalledWith(item);
    await view.rerender(
      <ResultView
        value={{ type: 'files', items: [{ ...item, uri: 'runs/r/3/a-renamed.xlsx' }] }}
        palette={palette}
        locale="zh"
        actions={actions}
      />,
    );
    expect(view.queryByTestId('result-desk')).toBeNull();
  });

  it('Place on desk copies only: file remains on result page; intermediate format images replaced with relative paths within desk', async () => {
    const files = new FakeFiles();
    const item = runResult(files, 'table', tableDoc());
    const desk = await placeResultsOnDesk(files, [item], 1, 'copydesk');
    expect(files.disk.has(item.uri)).toBe(true);
    expect(files.disk.has('runs/r1/page.jpg')).toBe(true);
    const file = currentFiles(desk)[0]!;
    expect(file.source?.kind).toBe('table');
    const json = parseTableDoc(decodeUtf8(files.disk.get(`desk/copydesk/${file.source!.path}`)!))!;
    expect(json.pages[0]!.source).toBe(file.source!.assets[0]!.path);
  });
});

describe('Excel on desk is a spreadsheet editor', () => {
  it('Images cropped during Excel conversion are displayed in the table, selectable on tap (showing original image), and can be deleted; after "Done", the image is absent from xlsx (D-520)', async () => {
    const files = new FakeFiles();
    files.disk.set('runs/r1/fig.jpg', new Uint8Array([5, 5, 5]));
    const doc = tableDoc();
    doc.pages[0]!.blocks.push({
      kind: 'image',
      col: 0,
      cols: 2,
      src: 'runs/r1/fig.jpg',
      box: box(0, 100, 400, 200),
    });
    await openOnDesk('table', doc, files);
    // Image placed below table: title on line 1, table on two lines, starting from line 4.
    const image = screen.getByTestId('table-cell-3-0');
    expect(image).toBeTruthy();
    expect(screen.getByTestId('table-image-3-0')).toBeTruthy();
    await fireEvent.press(image);
    expect(screen.getByTestId('desk-edit-bar')).toBeTruthy();
    expect(screen.getByTestId('table-crop')).toBeTruthy();
    // Image has no text to edit: tapping again still selects it, with no edit box; can only delete.
    await fireEvent.press(image);
    expect(screen.queryByTestId('desk-edit-input')).toBeNull();
    expect(screen.queryByTestId('desk-row-below')).toBeNull();
    await fireEvent.press(screen.getByTestId('desk-image-delete'));
    expect(screen.queryByTestId('table-image-3-0')).toBeNull();
    await fireEvent.press(screen.getByTestId('desk-done'));
    const file = currentFiles(await deskNow(files))[0]!;
    const zip = unzipSync(files.disk.get(`desk/editdesk/${file.path}`)!);
    expect(Object.keys(zip).some((n) => n.includes('media'))).toBe(false);
    // "Done" panel closed: do not leave an open panel for the next test.
    await fireEvent.press(screen.getByTestId('desk-sheet-backdrop'));
  });

  it('Tap to select (toolbar changes to edit layer, shows original image), tap again to edit; undo steps back during editing; merges into a single version on "Done"', async () => {
    const { files } = await openOnDesk('table', tableDoc());
    await fireEvent.press(screen.getByTestId('table-cell-1-0'));
    expect(screen.getByTestId('desk-edit-bar')).toBeTruthy();
    expect(screen.getByTestId('table-crop')).toBeTruthy();
    expect(screen.queryByTestId('desk-toolbar')).toBeNull();
    await fireEvent.press(screen.getByTestId('table-cell-1-0'));
    expect(screen.getByTestId('desk-edit-input').props.value).toBe('a');
    await fireEvent.changeText(screen.getByTestId('desk-edit-input'), 'A & 1');
    await fireEvent.press(screen.getByTestId('desk-edit-ok'));
    expect(screen.getByText('A & 1')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('desk-row-below'));
    expect(screen.getByTestId('table-cell-3-0')).toBeTruthy();
    // Not closed: desk still has one version, "Editing" written to desk (preventing loss).
    expect((await deskNow(files)).versions).toHaveLength(1);
    await waitFor(() => expect(files.disk.has('desk/editdesk/editing.json')).toBe(true));
    // Undo steps back edits one by one.
    await fireEvent.press(screen.getByTestId('desk-undo'));
    expect(screen.queryByTestId('table-cell-3-0')).toBeNull();
    await fireEvent.press(screen.getByTestId('desk-undo'));
    expect(screen.getByText('a')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('desk-redo'));
    expect(screen.getByText('A & 1')).toBeTruthy();
    // No longer selected after inserting a row: toolbar is back.
    expect(screen.getByTestId('desk-toolbar')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('desk-done'));
    expect(await screen.findByTestId('desk-save')).toBeTruthy();
    const desk = await deskNow(files);
    expect(desk.versions.map((v) => v.by)).toEqual([{ kind: 'place' }, { kind: 'edit' }]);
    expect(desk.versions.some((v) => v.open)).toBe(false);
    expect(await xlsxText(files)).toContain('<t>A &amp; 1</t>');
    expect(files.disk.has('desk/editdesk/editing.json')).toBe(false);
    // After closing, undo rolls back the entire section together.
    await fireEvent.press(screen.getByTestId('desk-sheet-backdrop'));
    await fireEvent.press(screen.getByTestId('desk-undo'));
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
    expect((await deskNow(files)).current).toBe(0);
  });

  it('Undo across edits and tools: converting to PDF after editing rolls back the modified table first, then rolls back the entire section to the original', async () => {
    const files = new FakeFiles();
    files.documents.extensions = ['docx', 'xlsx'];
    await openOnDesk('table', tableDoc(), files);
    await editTo('table-cell-1-1', '改过');
    await fireEvent.press(screen.getByTestId('desk-deselect'));
    // Close editing before using other tools; document-to-PDF runs directly without asking about page size (D-363).
    await fireEvent.press(await deskTool('desk-tool-pdf.fromDocument'));
    await waitFor(() => expect(screen.getByTestId('desk-preview-pdf')).toBeTruthy());
    expect((await deskNow(files)).versions.map((v) => v.by.kind)).toEqual([
      'place',
      'edit',
      'action',
    ]);
    expect(files.documents.converted).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('desk-undo'));
    expect(await screen.findByText('改过')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('desk-undo'));
    expect(await screen.findByText('b')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('desk-redo'));
    expect(await screen.findByText('改过')).toBeTruthy();
  });

  it('Insert/delete columns, delete text outside table; tap "Done" to close; leaving without saving prompts "Discard changes?"', async () => {
    const { files } = await openOnDesk('table', tableDoc());
    await fireEvent.press(screen.getByTestId('table-cell-1-0'));
    await fireEvent.press(screen.getByTestId('desk-col-delete'));
    await fireEvent.press(screen.getByTestId('table-cell-0-0'));
    // Text outside the table: no row/column insertion or deletion, only edit and delete.
    expect(screen.queryByTestId('desk-row-below')).toBeNull();
    await fireEvent.press(screen.getByTestId('desk-block-delete'));
    const ask = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await fireEvent.press(screen.getByTestId('desk-close'));
    expect(ask.mock.lastCall?.[0]).toBe('放弃修改？');
    expect(screen.getByTestId('desk-screen')).toBeTruthy();
    ask.mockRestore();
    await fireEvent.press(screen.getByTestId('desk-done'));
    await screen.findByTestId('desk-sheet-cancel');
    const desk = await deskNow(files);
    expect(desk.versions.map((v) => v.by.kind)).toEqual(['place', 'edit']);
    const file = currentFiles(desk)[0]!;
    const doc = parseTableDoc(decodeUtf8(files.disk.get(`desk/editdesk/${file.source!.path}`)!))!;
    const blocks = doc.pages[0]!.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['table']);
    expect((blocks[0] as TableBlock).cells.map((c) => c.text)).toEqual(['b', 'd']);
    // Original image is stored only once; new version still uses it.
    expect(file.source!.assets).toHaveLength(1);
  });

  it('Recognition range and tabs; pages exceeding 2000 cells are view-only', async () => {
    await openOnDesk('table', tableDoc());
    await fireEvent.press(screen.getByTestId('table-scope-tables'));
    expect(screen.queryByText('标题')).toBeNull();
    await fireEvent.press(screen.getByTestId('desk-sheet-page-1'));
    expect(screen.getByText('只有文字')).toBeTruthy();
  });

  it('Pages exceeding 2000 cells are view-only: cells cannot be tapped', async () => {
    await openOnDesk('table', tableDoc(46));
    expect(screen.getByText(/超过 2000 个格子/)).toBeTruthy();
    expect(screen.getByTestId('table-cell-1-0')).toBeDisabled();
  });

  it('Cells aligned with original image; long lines outside table wrap according to screen width', async () => {
    const doc = tableDoc(20);
    const table = doc.pages[0]!.blocks[1] as TableBlock;
    table.cells[0]!.align = 'center';
    table.cells[1]!.text = 'note';
    const long = Array.from({ length: 12 }, (_, i) => `Ligne ${i + 1} du relevé`).join(' ');
    doc.pages[0]!.blocks[0] = { kind: 'text', text: long, align: 'center', box: box(0, 0, 1000) };
    await openOnDesk('table', doc);
    const alignOf = (text: string) =>
      StyleSheet.flatten(screen.getByText(text).props.style).textAlign;
    expect(alignOf('0')).toBe('center');
    expect(alignOf('note')).toBe('left');
    expect(alignOf('388')).toBe('right');
    const cell = StyleSheet.flatten(screen.getByTestId('table-cell-0-0').props.style);
    expect(cell.width).toBeLessThanOrEqual(Dimensions.get('window').width - 40);
  });

  it('Unclosed edits when app is killed: next time room is opened, merges into a single version with undo support', async () => {
    const files = new FakeFiles();
    const item = runResult(files, 'table', tableDoc());
    const desk = await placeResultsOnDesk(files, [item], Date.now(), 'editdesk');
    const file = currentFiles(desk)[0]!;
    const edited = tableDoc();
    (edited.pages[0]!.blocks[1] as TableBlock).cells[0]!.text = '没合上的';
    await writeEditDraft(files, desk, file.id, { kind: 'table', doc: edited });
    await renderToolsApp(new MemoryWorkspaceRepo(), files);
    await act(() => router.push({ pathname: '/desk/[deskId]', params: { deskId: desk.id } }));
    expect(await screen.findByText('没合上的')).toBeTruthy();
    expect((await deskNow(files)).versions.map((v) => v.by.kind)).toEqual(['place', 'edit']);
    expect(files.disk.has('desk/editdesk/editing.json')).toBe(false);
  });
});

/** Word editing page on desk (D-465): runs real page scripts using jsdom, modifies DOM, and sends the modified page representation back to the app. */
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
    /** Browser input event: returns the full page. */
    input: () => send({ type: 'doc', pages: window.__wordPages() }),
    state: (state: object) => send({ type: 'state', ...state }),
    /** "Replace with original" on the original image floating window (D-469). */
    swap: () => send({ type: 'swap' }),
    window,
  };
}

describe('Word on desk is a full-page editor (D-465)', () => {
  it('Direct page editing: edit text, bold text, enter for new paragraphs; insert rows when cursor is in table; undo; generate new docx upon closing', async () => {
    const { files } = await openOnDesk('doc', wordDoc());
    const page = wordPage();
    // No taps selected, no text box: every block in the page can be edited directly.
    expect(screen.queryByTestId('desk-edit-input')).toBeNull();
    expect(screen.queryByTestId('word-format-bar')).toBeNull();
    // Cursor placed inside the page: room's toolbar collapses and is replaced by formatting buttons.
    await page.state({ focus: true, bold: false, align: 'left', cell: null });
    expect(screen.getByTestId('word-format-bar')).toBeTruthy();
    expect(screen.getByTestId('word-bold')).toBeTruthy();
    expect(screen.getByTestId('word-underline')).toBeTruthy();
    expect(screen.queryByTestId('desk-row-below')).toBeNull();

    page.q('[data-ref="0-1"]').innerHTML = '改过的 &lt;正文&gt; <b>&amp; 段落</b>';
    const second = page.q('[data-ref="0-1"]').cloneNode(false) as HTMLElement;
    second.textContent = '回车分出来的';
    page.q('[data-ref="0-1"]').after(second);
    page.q('[data-ref="0-3"] td[data-i="1"]').textContent = '合计';
    await page.input();
    // Mid-edit, cursor moved into the table: extra options for inserting/deleting rows and columns appear; tapping "Insert row below" preserves the edits made so far.
    await page.state({ focus: true, cell: { ref: '0-3', i: 1 } });
    await fireEvent.press(screen.getByTestId('desk-row-below'));
    const html = screen.getByTestId('word-editor-page').props.source.html as string;
    expect(html).toContain('合计');
    expect(html).toContain('回车分出来的');
    expect(html.match(/<tr>/g)).toHaveLength(2);
    // Undo rolls back the inserted row, then redo.
    await fireEvent.press(screen.getByTestId('desk-undo'));
    expect(
      (screen.getByTestId('word-editor-page').props.source.html as string).match(/<tr>/g),
    ).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('desk-redo'));

    await page.state({ focus: false });
    await fireEvent.press(screen.getByTestId('desk-done'));
    expect(await screen.findByTestId('desk-save')).toBeTruthy();
    expect((await deskNow(files)).versions.map((v) => v.by.kind)).toEqual(['place', 'edit']);
    const xml = await docxXml(files);
    expect(xml).toContain('改过的 &lt;正文&gt; ');
    expect(xml).toMatch(/<w:r><w:rPr>[^]*?<w:b\/>[^]*?&amp; 段落<\/w:t>/);
    expect(xml).toContain('回车分出来的');
    expect(xml).toContain('合计');
    const file = currentFiles(await deskNow(files))[0]!;
    const doc = parseDocDoc(decodeUtf8(files.disk.get(`desk/editdesk/${file.source!.path}`)!))!;
    const table = doc.pages[0]!.blocks.find((b) => b.kind === 'table');
    expect(table?.kind === 'table' && table.table.rows).toBe(2);
  });

  it('Tapping "Done" immediately after typing: unmerged single-character edits are also written into docx', async () => {
    const { files } = await openOnDesk('doc', wordDoc());
    const page = wordPage();
    await page.state({ focus: true });
    page.q('[data-ref="0-0"]').textContent = '刚打的标题';
    await page.input();
    await fireEvent.press(screen.getByTestId('desk-done'));
    await screen.findByTestId('desk-save');
    expect(await docxXml(files)).toContain('刚打的标题');
  });

  it('Formatting buttons delegate commands to the page', async () => {
    await openOnDesk('doc', wordDoc());
    const page = wordPage();
    const inject = jest.fn();
    screen.getByTestId('word-editor-page').props.injectJavaScript = inject;
    await page.state({ focus: true, align: 'left' });
    // Placeholder WebView does not throw errors even without injectJavaScript.
    await fireEvent.press(screen.getByTestId('word-bold'));
    await fireEvent.press(screen.getByTestId('word-bigger'));
    expect(screen.getByTestId('word-format-bar')).toBeTruthy();
  });

  it('Word to PDF on desk prints according to editing page layout, preserving edited text and styles (2026-11-06 Samsung real device: converted PDF entirely left-aligned with lost font sizes, D-466)', async () => {
    const { files } = await openOnDesk('doc', wordDoc());
    const page = wordPage();
    page.q('[data-ref="0-1"]').innerHTML = '改过的 <b>正文</b>';
    await page.input();
    await fireEvent.press(await deskTool('desk-tool-pdf.fromDocument'));
    await waitFor(() => expect(screen.getByTestId('desk-preview-pdf')).toBeTruthy());
    // Not passed to the general Word layout engine (Android mammoth).
    expect(files.documents.converted).toHaveLength(0);
    const html = files.printedHtml.at(-1)!;
    expect(html).toContain('class="paper"');
    expect(html).not.toContain('contenteditable');
    expect(html).not.toContain('<script');
    expect(html).toContain('改过的 <b>正文</b>');
    // Font size in points (A4 width 595 pt), centered title position matches the original image.
    expect(html).toMatch(/font-size:\d+(\.\d+)?pt/);
    expect(html).not.toMatch(/font-size:\d+(\.\d+)?px/);
  });

  it('"Use original here": signatures and stamps recognized as text are replaced by the cropped segment from the original image, moved into desk and embedded into docx upon closing (D-467)', async () => {
    const files = new FakeFiles();
    files.imageSizes.set('runs/r1/page.jpg', { width: 2000, height: 2800 });
    await openOnDesk('doc', wordDoc(), files);
    const page = wordPage();
    // Button is on the page's original image floating window (D-469), not in the formatting bar.
    expect(screen.getByTestId('word-editor-page').props.source.html).toContain(
      '"swap":{"one":"换成原件","lines":"换成原件（{n} 行）","primary":',
    );
    await page.state({ focus: true, cell: null, ref: '0-1', refs: ['0-1'] });
    expect(screen.queryByTestId('word-use-original')).toBeNull();
    await page.swap();
    await waitFor(() =>
      expect(
        (screen.getByTestId('word-editor-page').props.source.html as string).includes(
          'data-ref="0-1" data-kind="image"',
        ),
      ).toBe(true),
    );
    // Newly cropped image is also read into the page (simulator only draws gray blocks on first render).
    await waitFor(() =>
      expect(screen.getByTestId('word-editor-page').props.source.html as string).toMatch(
        /data-ref="0-1" data-kind="image"[^>]*><img src="data:image\/jpeg;base64,/,
      ),
    );
    const html = screen.getByTestId('word-editor-page').props.source.html as string;
    expect(html).not.toContain('正文第一段。');
    await page.state({ focus: false });
    await fireEvent.press(screen.getByTestId('desk-done'));
    await screen.findByTestId('desk-save');
    const file = currentFiles(await deskNow(files))[0]!;
    // Cropped image moved into desk and embedded into docx.
    const doc = parseDocDoc(decodeUtf8(files.disk.get(`desk/editdesk/${file.source!.path}`)!))!;
    const image = doc.pages[0]!.blocks[1]!;
    expect(image.kind).toBe('image');
    const src = image.kind === 'image' ? image.src! : '';
    expect(src).toMatch(/^assets\//);
    expect(file.source!.assets.map((a) => a.path)).toContain(src);
    expect(files.disk.has(`desk/editdesk/${src}`)).toBe(true);
    expect(Object.keys(unzipSync(files.disk.get(`desk/editdesk/${file.path}`)!))).toContain(
      'word/media/image1.jpg',
    );
    // Crop position corresponds to this segment in the original image (scaled by original size with extra padding around).
    expect(image.box.x).toBeLessThan(100);
    expect(image.box.width).toBeGreaterThan(800);
  });

  it('Tapping "Done" after replacing with original, continuing edits, and saving again: image remains on page, saved file can be edited again when placed back on desk (2026-11-06 Samsung: display failed after save and reopen)', async () => {
    const files = new FakeFiles();
    files.imageSizes.set('runs/r1/page.jpg', { width: 1000, height: 1400 });
    const { repo } = await openOnDesk('doc', wordDoc(), files);
    let page = wordPage();
    await page.state({ focus: true, cell: null, ref: '0-1', refs: ['0-1'] });
    await page.swap();
    await waitFor(() =>
      expect(screen.getByTestId('word-editor-page').props.source.html as string).toMatch(
        /data-ref="0-1" data-kind="image"[^>]*><img src="data:image/,
      ),
    );
    await page.state({ focus: false });
    await fireEvent.press(screen.getByTestId('desk-done'));
    await screen.findByTestId('desk-save');
    await fireEvent.press(screen.getByTestId('desk-sheet-cancel'));
    // Cropped image moved into desk after closing: page still shows this image, not gray blocks.
    await waitFor(() =>
      expect(screen.getByTestId('word-editor-page').props.source.html as string).toMatch(
        /data-ref="0-1" data-kind="image"[^>]*><img src="data:image/,
      ),
    );
    // Continue editing text, then save again as a user file.
    page = wordPage();
    page.q('[data-ref="0-0"]').textContent = '第二次改的标题';
    await page.input();
    await fireEvent.press(await deskTool('desk-tool-room-save'));
    expect(await screen.findByTestId('desk-saved')).toBeTruthy();
    const [asset] = await repo.listAssets();
    // Saved docx contains two images (the replaced one and the originally cropped one); placing back on desk retains intermediate format for further editing.
    const desk = await placeAssetOnDesk(files, asset!, 3, 'again');
    expect(desk).not.toBeNull();
    const file = currentFiles(desk!)[0]!;
    expect(file.source?.kind).toBe('doc');
    const doc = parseDocDoc(decodeUtf8(files.disk.get(`desk/again/${file.source!.path}`)!))!;
    expect(doc.pages[0]!.blocks.filter((b) => b.kind === 'image')).toHaveLength(2);
    expect(JSON.stringify(doc)).toContain('第二次改的标题');

    // Opened from recent files (file preview page): displays according to editing page layout; tapping "Edit" places it on desk as a Word editor (D-467 / D-470).
    await act(() => router.dismissAll());
    await act(() => openAsset(files, router, asset!));
    const preview = await screen.findByTestId('word-preview-page');
    expect(preview.props.source.html).toContain('第二次改的标题');
    expect(preview.props.source.html).not.toContain('contenteditable="true"');
    await fireEvent.press(screen.getByTestId('preview-edit'));
    const editor = await screen.findByTestId('word-editor-page');
    expect(editor.props.source.html).toContain('第二次改的标题');
  });

  it('Selecting multiple rows then tapping "Use original": replaced together as a single image (2026-11-06 Samsung real device: signature split into multiple parts, D-468)', async () => {
    const files = new FakeFiles();
    files.imageSizes.set('runs/r1/page.jpg', { width: 1000, height: 1400 });
    await openOnDesk('doc', wordDoc(), files);
    const page = wordPage();
    await page.state({ focus: true, cell: null, ref: '0-1', refs: ['0-1', '0-2'] });
    await page.swap();
    await waitFor(() =>
      expect(screen.getByTestId('word-editor-page').props.source.html as string).toContain(
        'data-ref="0-1" data-kind="image"',
      ),
    );
    const html = screen.getByTestId('word-editor-page').props.source.html as string;
    expect(html).not.toContain('正文第一段。');
    expect(html).not.toContain('甲');
    // Single image wrapping two blocks (paragraph y 120–180, list y 200–220, with extra padding around).
    await page.state({ focus: false });
    await fireEvent.press(screen.getByTestId('desk-done'));
    await screen.findByTestId('desk-save');
    const file = currentFiles(await deskNow(files))[0]!;
    const doc = parseDocDoc(decodeUtf8(files.disk.get(`desk/editdesk/${file.source!.path}`)!))!;
    const images = doc.pages[0]!.blocks.filter((b) => b.kind === 'image');
    expect(images).toHaveLength(2);
    const swapped = images.find((b) => b.box.y < 200)!;
    expect(swapped.box.y).toBeLessThan(120);
    expect(swapped.box.y + swapped.box.height).toBeGreaterThan(220);
  });

  it('Cropped images embedded into docx: image written to page; embedded again upon closing', async () => {
    const files = new FakeFiles();
    files.disk.set('runs/r1/crop.jpg', new Uint8Array([7, 7, 7, 7]));
    files.imageSizes.set('runs/r1/crop.jpg', { width: 600, height: 400 });
    await openOnDesk('doc', wordDoc('runs/r1/crop.jpg'), files);
    const page = wordPage();
    expect(page.q('[data-kind="image"] img').getAttribute('src')).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    page.q('[data-ref="0-0"]').remove();
    await page.input();
    await fireEvent.press(screen.getByTestId('desk-done'));
    await screen.findByTestId('desk-save');
    const file = currentFiles(await deskNow(files))[0]!;
    expect(Object.keys(unzipSync(files.disk.get(`desk/editdesk/${file.path}`)!))).toContain(
      'word/media/image1.jpg',
    );
    expect(await docxXml(files)).not.toContain('年度报告');
    // Both original and cropped images remain in desk assets.
    expect(file.source!.assets).toHaveLength(2);
  });
});

// 2026-11-09 user test: "Done" and "Files" on desk only saved to the app's internal document library, making them hard for users to find in the system "Files" app.
describe('Files on desk can be saved to phone (copied into selected folder in "Files" app)', () => {
  it('Available in both "Done" and "Files" tab, prompting user to select a folder every time', async () => {
    const { files } = await openOnDesk('table', tableDoc());
    await fireEvent.press(screen.getByTestId('desk-done'));
    await fireEvent.press(await screen.findByTestId('desk-folder'));
    await waitFor(() =>
      expect([...(files.folders.get('MorphOut')?.keys() ?? [])]).toEqual(['明细.xlsx']),
    );
    await fireEvent.press(screen.getByTestId('desk-sheet-backdrop'));
    files.nextFolder = 'Work';
    await fireEvent.press(await deskTool('desk-tool-room-folder'));
    await waitFor(() =>
      expect([...(files.folders.get('Work')?.keys() ?? [])]).toEqual(['明细.xlsx']),
    );
    expect(files.folderPicks).toBe(2);
  });

  // 2026-11-09 PDF user retest: after saving to phone and going back, it still asked "Discard changes?", leading to the misconception that the newly edited file would be lost.
  it('Leaving after saving to phone no longer prompts "Discard changes?"; cancelling folder selection or editing after saving still prompts', async () => {
    const { files } = await openOnDesk('table', tableDoc());
    await fireEvent.press(screen.getByTestId('table-cell-1-0'));
    await fireEvent.press(screen.getByTestId('desk-col-delete'));
    const ask = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    // Cancel folder selection: nothing saved, asks as usual.
    files.folderChoice = 'cancel';
    await fireEvent.press(screen.getByTestId('desk-done'));
    await fireEvent.press(await screen.findByTestId('desk-folder'));
    await fireEvent.press(screen.getByTestId('desk-sheet-backdrop'));
    await fireEvent.press(screen.getByTestId('desk-close'));
    expect(ask.mock.lastCall?.[0]).toBe('放弃修改？');

    // Edited again after saving: asks as usual.
    files.folderChoice = 'pick';
    await fireEvent.press(screen.getByTestId('desk-done'));
    await fireEvent.press(await screen.findByTestId('desk-folder'));
    await waitFor(() => expect(files.folders.get('MorphOut')?.size).toBe(1));
    await fireEvent.press(screen.getByTestId('desk-sheet-backdrop'));
    await fireEvent.press(screen.getByTestId('table-cell-0-0'));
    await fireEvent.press(screen.getByTestId('desk-block-delete'));
    ask.mockClear();
    await fireEvent.press(screen.getByTestId('desk-close'));
    expect(ask.mock.lastCall?.[0]).toBe('放弃修改？');

    // No further changes after saving to phone: leaves directly.
    await fireEvent.press(screen.getByTestId('desk-done'));
    await fireEvent.press(await screen.findByTestId('desk-folder'));
    await waitFor(() => expect(files.folderPicks).toBe(3));
    await fireEvent.press(screen.getByTestId('desk-sheet-backdrop'));
    ask.mockClear();
    await fireEvent.press(screen.getByTestId('desk-close'));
    expect(ask).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('desk-screen')).toBeNull());
  });
});

describe('Can be placed back on desk for editing after saving as user file (D-367)', () => {
  it('Intermediate format and original image saved along upon saving; accounted toward storage space, can be placed back on desk for editing, and deleted together with file', async () => {
    const { files, repo } = await openOnDesk('table', tableDoc());
    await editTo('table-cell-1-0', '存之前改的');
    await fireEvent.press(screen.getByTestId('desk-deselect'));
    await fireEvent.press(await deskTool('desk-tool-room-save'));
    expect(await screen.findByTestId('desk-saved')).toBeTruthy();
    const [asset] = await repo.listAssets();
    expect(asset!.name).toBe('明细.xlsx');
    const dir = [...files.disk.keys()].filter((k) => k.startsWith(`assets/${asset!.id}/`));
    expect(dir.sort()).toEqual(
      [
        `assets/${asset!.id}/明细.xlsx`,
        `assets/${asset!.id}/morph-source-0.jpg`,
        `assets/${asset!.id}/morph-source.json`,
      ].sort(),
    );
    // Editing closed before saving: saves the modified version.
    expect(strFromU8(unzipSync(files.disk.get(asset!.path)!)['xl/sharedStrings.xml']!)).toContain(
      '存之前改的',
    );

    await act(() => router.push('/storage'));
    // Size accounts for intermediate format and original image.
    const row = await screen.findByTestId(`storage-file-${asset!.id}`);
    expect(row).toHaveTextContent(/表格|其他|文件/);
    jest.spyOn(Alert, 'alert').mockImplementationOnce((_t, _m, buttons) => {
      buttons?.find((b) => b.text === '放到桌上')?.onPress?.();
    });
    await fireEvent.press(row);
    expect(await screen.findByText('存之前改的')).toBeTruthy();
    expect(screen.getByTestId('desk-editor')).toBeTruthy();
    // Placing back on desk is a copy: user file remains untouched.
    expect(files.disk.has(asset!.path)).toBe(true);

    await editTo('table-cell-1-1', '放回来再改');
    jest.spyOn(Alert, 'alert').mockImplementationOnce((_t, _m, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await fireEvent.press(screen.getByTestId('desk-close'));
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    await waitFor(() => expect(screen.queryByTestId('desk-screen')).toBeNull());
    expect(files.disk.has(asset!.path)).toBe(true);

    await files.removeAssetFile(asset!.path);
    expect([...files.disk.keys()].filter((k) => k.startsWith(`assets/${asset!.id}/`))).toEqual([]);
  });

  it('Result page "Save" and quick action save steps also include intermediate format and original image (D-400): available in storage to be placed back on desk for editing', async () => {
    const files = new FakeFiles();
    const repo = new MemoryWorkspaceRepo();
    // Result of Word conversion: one page original image and one cropped image.
    files.disk.set('runs/r1/cut.png', new Uint8Array([7, 7]));
    const word = runResult(files, 'doc', wordDoc('runs/r1/cut.png'));
    const [saved] = await saveItems({ files, repo, grantee: 'w1' }, [word], {
      now: () => new Date(1),
      newId: () => 'a1',
    });
    expect(saved!.assetId).toBe('a1');
    const [asset] = await repo.listAssets();
    expect([...files.disk.keys()].filter((k) => k.startsWith('assets/a1/')).sort()).toEqual(
      [
        'assets/a1/明细.docx',
        'assets/a1/morph-source-0.jpg',
        'assets/a1/morph-source-1.png',
        'assets/a1/morph-source.json',
      ].sort(),
    );
    // Results in run directory remain untouched (deleted only when run page is closed).
    expect(files.disk.has('runs/r1/明细.json')).toBe(true);
    // Accounted toward storage space for this file: two images + intermediate format.
    expect(await savedSourceBytes(files, asset!)).toBeGreaterThan(4);
    const desk = await placeAssetOnDesk(files, asset!, 2, 'backdesk');
    expect(desk).not.toBeNull();
    const file = currentFiles(desk!)[0]!;
    expect(file.source?.kind).toBe('doc');
    expect(file.source!.assets).toHaveLength(2);
    const doc = parseDocDoc(decodeUtf8(files.disk.get(`desk/backdesk/${file.source!.path}`)!))!;
    expect(doc.pages[0]!.blocks.map((b) => b.kind)).toContain('table');

    // Subsequent steps modified the file (intermediate format no longer matches it), ordinary file: save file only.
    const renamed = { ...runResult(files, 'table', tableDoc()), uri: 'runs/r1/明细.xlsx' };
    renamed.tableDoc = { ...renamed.tableDoc!, for: 'runs/r1/别的.xlsx' };
    await saveItems({ files, repo, grantee: 'w1' }, [renamed], {
      now: () => new Date(1),
      newId: () => 'a2',
    });
    expect([...files.disk.keys()].filter((k) => k.startsWith('assets/a2/'))).toEqual([
      'assets/a2/明细.xlsx',
    ]);
  });

  it('Ordinary files (without intermediate format) do not have "Place on desk" in storage', async () => {
    const files = new FakeFiles();
    const repo = new MemoryWorkspaceRepo();
    files.disk.set('assets/x1/a.pdf', new Uint8Array([1]));
    await repo.addAsset({
      id: 'x1',
      name: 'a.pdf',
      mimeType: 'application/pdf',
      size: 1,
      path: 'assets/x1/a.pdf',
      source: 'generated',
      createdAt: 1,
    });
    await renderToolsApp(repo, files);
    await act(() => router.push('/storage'));
    let labels: string[] = [];
    jest.spyOn(Alert, 'alert').mockImplementationOnce((_t, _m, buttons) => {
      labels = (buttons ?? []).map((b) => b.text ?? '');
    });
    await fireEvent.press(await screen.findByTestId('storage-file-x1'));
    expect(labels).not.toContain('放到桌上');
  });
});
