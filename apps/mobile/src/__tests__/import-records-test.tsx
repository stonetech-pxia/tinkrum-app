import { applyOps, createDefaultWorkspace, type Locale, type Registry } from '@morph/core';
import { writeXlsx, type TableCell, type TablePage } from '@morph/tool-office';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { spreadsheetKind } from '../data/import-file';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles } from '../test-utils/fake-files';
import { renderToolsApp } from '../test-utils/render-app';

// Import rows from a spreadsheet file into an existing table (D-574, founder's decision on
// 2026-11-16 item 7): "Settings -> Data" -> select a table -> "Import records from file". Columns
// are mapped locally by name to fields, subject to user confirmation; asks before importing
// (summary + "Import"); the toast notification after import allows undoing (moves to "Recently
// Deleted"); each import is logged as a batch, and batches can be deleted as a whole in "Settings
// -> Data". Originals are untouched, and the copy from the file picker is deleted immediately after
// reading (Invariant 4).

const seed = (locale: Locale, registry: Registry) => {
  const r = applyOps(
    createDefaultWorkspace(locale),
    [
      {
        op: 'addData',
        table: {
          id: 'orders',
          name: '订单',
          fields: [
            { id: 'customer', name: 'Customer', type: 'text', required: true },
            { id: 'amount', name: 'Amount', type: 'money', currency: 'EUR' },
            { id: 'on', name: 'Date', type: 'date' },
            {
              id: 'status',
              name: 'Status',
              type: 'choice',
              options: [
                { id: 'open', label: 'Open' },
                { id: 'shipped', label: 'Shipped' },
              ],
            },
            { id: 'paid', name: 'Paid', type: 'checkbox' },
          ],
        },
      },
    ],
    { registry, locale },
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

const CSV =
  'Customer;Amount;Date;Status;Paid;Comment\n' +
  'Ana;"1 234,50";25/12/2026;Shipped;oui;first\n' +
  'Bo;12;03/01/2027;open;non;\n' +
  ';;;;;\n' +
  'Cy;ten;;;;\n' +
  ';5;;;;\n';

const encode = (s: string) => new TextEncoder().encode(s);

type XCell = string | { value: number; format: string; text: string };

/** Multi-sheet xlsx (written using tool-office's writeXlsx, with formatted numbers and shared strings just like real Excel files). */
function workbook(sheets: [string, XCell[][]][]): Uint8Array {
  const pages: TablePage[] = sheets.map(([name, rows]) => {
    const cols = Math.max(...rows.map((r) => r.length));
    const cells: TableCell[] = rows.flatMap((row, r) =>
      row.map((v, c) => ({
        row: r,
        col: c,
        rowSpan: 1,
        colSpan: 1,
        text: typeof v === 'string' ? v : v.text,
        write:
          typeof v === 'string'
            ? { kind: 'text' as const }
            : { kind: 'number' as const, value: v.value, format: v.format },
      })),
    );
    return {
      name,
      source: '',
      width: 110,
      height: rows.length,
      lineHeight: 1,
      colWidths: Array.from({ length: cols }, () => 12),
      blocks: [
        {
          kind: 'table',
          rows: rows.length,
          col: 0,
          cols,
          cells,
          box: { x: 0, y: 0, width: 110, height: rows.length },
        },
      ],
    };
  });
  return writeXlsx({ version: 3, scope: 'tables', pages });
}

/** Android's "Files" app provides a content:// URI without an extension, but the file name has one. */
function offerContent(files: FakeFiles, name: string, bytes: Uint8Array, mimeType: string | null) {
  const uri = `content://com.android.providers.downloads.documents/document/${name.length}`;
  files.disk.set(uri, bytes);
  files.nextPick = [{ uri, name, size: bytes.length, mimeType }];
  return uri;
}

/** The copy created in app cache by iOS / file picker (picker://). */
function offerCopy(files: FakeFiles, name: string, bytes: Uint8Array, mimeType = 'text/csv') {
  const picked = files.offer(name, bytes, mimeType);
  files.nextPick = [picked];
  return picked.uri;
}

async function start(
  files = new FakeFiles(),
  repo = new MemoryWorkspaceRepo(),
  locale: Locale = 'zh',
) {
  const app = await renderToolsApp(repo, files, { seed, locale });
  await screen.findByTestId('nav-settings');
  await act(() => router.push('/data'));
  // One page per table (D-614): import is located within the table's page.
  await fireEvent.press(await screen.findByTestId('table-orders'));
  await screen.findByTestId('data-table-screen');
  return { ...app, repo, files };
}

async function openImport() {
  await fireEvent.press(await screen.findByTestId('import-orders'));
  await screen.findByTestId('import-choose');
}

async function choose() {
  await fireEvent.press(screen.getByTestId('import-choose'));
  await flush();
}

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => {});
}

function answerNext(label: string) {
  const asked: { title?: string | null; message?: string | null } = {};
  jest.spyOn(Alert, 'alert').mockImplementationOnce((title, message, buttons?: AlertButton[]) => {
    asked.title = title;
    asked.message = message;
    void buttons?.find((b) => b.text === label)?.onPress?.();
  });
  return asked;
}

const customers = async (repo: MemoryWorkspaceRepo) =>
  (await repo.listRecords('orders')).map((r) => r.values.customer).sort();

afterEach(() => jest.restoreAllMocks());

it('a new user with an empty table: map, review, nothing is written until Import; then undo moves the batch to Recently deleted', async () => {
  const { repo, files } = await start();
  await openImport();
  const original = offerContent(files, 'Orders 2026.csv', encode(CSV), null);
  await choose();
  // Columns with matching names are already mapped; Comment has no corresponding field and is skipped.
  for (const [col, id] of [
    [0, 'customer'],
    [1, 'amount'],
    [2, 'on'],
    [3, 'status'],
    [4, 'paid'],
    [5, 'skip'],
  ] as const)
    expect(screen.getByTestId(`import-map-${col}-${id}`)).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ selected: true, checked: true }),
    );
  // Sample display parsing result: dates follow the order of this column (25 is greater than 12, so day comes first).
  expect(screen.getAllByTestId('import-sample-2')[0]).toHaveTextContent('25/12/2026 → 2026-12-25');
  expect(screen.getAllByTestId('import-sample-1')[2]).toHaveTextContent('「ten」读不出来');
  await fireEvent.press(screen.getByTestId('import-continue'));
  await flush();
  const summary = screen.getByTestId('import-summary');
  expect(summary).toHaveTextContent(/将在「订单」加入 2 条记录。/);
  expect(summary).toHaveTextContent(/有 2 行不会导入：/);
  expect(summary).toHaveTextContent(/1 行的「Amount」读不出来（第 5 行）/);
  expect(summary).toHaveTextContent(/1 行的「Customer」是空的，但必须填写（第 6 行）/);
  // Ask first: neither mapping nor summary has been written.
  expect(await repo.listRecords('orders')).toEqual([]);
  await fireEvent.press(screen.getByTestId('import-confirm'));
  await flush();
  expect(
    (await repo.listRecords('orders'))
      .map((r) => r.values)
      .sort((a, b) => String(a.customer).localeCompare(String(b.customer))),
  ).toEqual([
    { customer: 'Ana', amount: 1234.5, on: '2026-12-25', status: 'shipped', paid: true },
    { customer: 'Bo', amount: 12, on: '2027-01-03', status: 'open', paid: false },
  ]);
  expect(screen.getByTestId('toast')).toHaveTextContent(/已在「订单」导入 2 条记录/);
  // Original file (content://) remains untouched.
  expect(files.disk.has(original)).toBe(true);
  const [batch] = await repo.listImports('orders');
  expect(batch).toMatchObject({ fileName: 'Orders 2026.csv', count: 2, present: 2 });
  await fireEvent.press(screen.getByTestId('toast-undo'));
  await flush();
  expect(await repo.listRecords('orders')).toEqual([]);
  expect((await repo.listDeletedRecords()).map((r) => r.values.customer).sort()).toEqual([
    'Ana',
    'Bo',
  ]);
  // After undoing, the page accurately reflects the state and no longer displays "Imported".
  await flush();
  expect(screen.getByTestId('import-done')).toHaveTextContent(/已放进「最近删除」/);
  expect(screen.getByTestId('import-done')).not.toHaveTextContent(/已在「订单」导入/);
});

it('with data: undo removes exactly the batch; the data screen lists it, deleting it asks first and takes edited entries too; restore brings one back', async () => {
  const repo = new MemoryWorkspaceRepo();
  await repo.insertRecord({
    id: 'old1',
    collectionId: 'orders',
    values: { customer: 'Old' },
    createdAt: 1,
    updatedAt: 1,
  });
  const { files } = await start(undefined, repo);
  await openImport();
  const copy = offerCopy(files, 'orders.csv', encode(CSV));
  await choose();
  // The file picker's cache copy is deleted after reading.
  expect(files.disk.has(copy)).toBe(false);
  await fireEvent.press(screen.getByTestId('import-continue'));
  await flush();
  await fireEvent.press(screen.getByTestId('import-confirm'));
  await flush();
  expect(await customers(repo)).toEqual(['Ana', 'Bo', 'Old']);
  // Without undoing, return to "Settings -> Data": this import is now listed under the table.
  await act(() => router.back());
  const [batch] = await repo.listImports('orders');
  const row = await screen.findByTestId(`import-batch-${batch!.id}`);
  expect(row).toHaveTextContent(/orders\.csv · 2 条记录/);
  // An entry modified subsequently is also deleted when deleting this import (as stated during the prompt).
  const ana = (await repo.listRecords('orders')).find((r) => r.values.customer === 'Ana')!;
  await repo.updateRecord(ana.id, { ...ana.values, amount: 1 }, Date.now());
  const cancelled = answerNext('取消');
  await fireEvent.press(screen.getByTestId(`import-delete-${batch!.id}`));
  expect(cancelled.message).toBe(
    '「orders.csv」导入的 2 条记录（包括后来改过的）会进「最近删除」，保留 30 天。',
  );
  expect(await customers(repo)).toEqual(['Ana', 'Bo', 'Old']);
  answerNext('删除');
  await fireEvent.press(screen.getByTestId(`import-delete-${batch!.id}`));
  await flush();
  expect(await customers(repo)).toEqual(['Old']);
  await waitFor(() => expect(screen.queryByTestId(`import-batch-${batch!.id}`)).toBeNull());
  // Entries in "Recently Deleted" can be restored one by one; a restored entry is counted back into this import batch.
  await act(() => router.push('/data-deleted'));
  await fireEvent.press(await screen.findByTestId(`restore-record-${ana.id}`));
  await flush();
  expect(await customers(repo)).toEqual(['Ana', 'Old']);
  await act(() => router.back());
  expect(await screen.findByTestId(`import-batch-${batch!.id}`)).toHaveTextContent(/1 条记录/);
});

it('an xlsx with two sheets: pick the second, real Excel dates and numbers; an ambiguous date column can be switched to month first', async () => {
  const { repo, files } = await start();
  const serial = (Date.UTC(2026, 9, 1) - Date.UTC(1899, 11, 30)) / 86400000;
  const bytes = workbook([
    ['Summary', [['nothing to import here']]],
    [
      'Orders',
      [
        ['Customer', 'Amount', 'Date'],
        [
          'Ana',
          { value: 1234.5, format: '#,##0.00', text: '1,234.50' },
          { value: serial, format: 'yyyy-mm-dd', text: '2026-10-01' },
        ],
        ['Bo', { value: 3, format: 'General', text: '3' }, '03/04/2026'],
      ],
    ],
  ]);
  await openImport();
  offerContent(
    files,
    'orders.xlsx',
    bytes,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  await choose();
  // The first sheet has only a single cell: select the second sheet.
  await fireEvent.press(screen.getByTestId('import-sheet-1'));
  expect(screen.getAllByTestId('import-sample-2')[1]).toHaveTextContent('03/04/2026 → 2026-04-03');
  await fireEvent.press(screen.getByTestId('import-order-2-mdy'));
  expect(screen.getAllByTestId('import-sample-2')[1]).toHaveTextContent('03/04/2026 → 2026-03-04');
  await fireEvent.press(screen.getByTestId('import-continue'));
  await flush();
  await fireEvent.press(screen.getByTestId('import-confirm'));
  await flush();
  expect(
    (await repo.listRecords('orders'))
      .map((r) => r.values)
      .sort((a, b) => String(a.customer).localeCompare(String(b.customer))),
  ).toEqual([
    { customer: 'Ana', amount: 1234.5, on: '2026-10-01', paid: false },
    { customer: 'Bo', amount: 3, on: '2026-03-04', paid: false },
  ]);
});

it('without a header row every row is data and nothing is matched until the user picks fields', async () => {
  const { repo, files } = await start();
  await openImport();
  offerCopy(files, 'names.csv', encode('Ana,1\nBo,2\n'));
  await choose();
  expect(screen.getByTestId('import-map-0-customer')).toHaveProp(
    'accessibilityState',
    expect.objectContaining({ selected: false, checked: false }),
  );
  await fireEvent(screen.getByTestId('import-header'), 'valueChange', false);
  expect(screen.getByTestId('import-continue')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('import-map-0-customer'));
  await fireEvent.press(screen.getByTestId('import-map-1-amount'));
  await fireEvent.press(screen.getByTestId('import-continue'));
  await flush();
  await fireEvent.press(screen.getByTestId('import-confirm'));
  await flush();
  expect(await customers(repo)).toEqual(['Ana', 'Bo']);
});

it('edge cases are refused with a sentence and write nothing: not a spreadsheet, another encoding, an old .xls, too many rows', async () => {
  const repo = new MemoryWorkspaceRepo();
  const { files } = await start(undefined, repo);
  await openImport();
  // File extension is xlsx, content is CSV.
  let copy = offerCopy(files, 'orders.xlsx', encode(CSV));
  await choose();
  expect(screen.getByTestId('import-error')).toHaveTextContent(
    '这个文件读不成表格。它可能坏了，或者是别的文件。',
  );
  expect(files.disk.has(copy)).toBe(false);
  // Latin-1 encoded CSV.
  copy = offerCopy(
    files,
    'clients.csv',
    new Uint8Array([0x4e, 0x6f, 0x6d, 0x0a, 0x52, 0xe9, 0x6d, 0x69]),
  );
  await choose();
  expect(screen.getByTestId('import-error')).toHaveTextContent(/不是 UTF-8 编码/);
  expect(files.disk.has(copy)).toBe(false);
  copy = offerCopy(
    files,
    'old.xls',
    new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
    'application/vnd.ms-excel',
  );
  await choose();
  expect(screen.getByTestId('import-error')).toHaveTextContent(
    '只能导入 .xlsx 和 .csv 文件。请先把文件存成其中一种格式。',
  );
  expect(files.disk.has(copy)).toBe(false);
  // 2,001 rows: rather than partial import, the entire import is rejected.
  offerCopy(
    files,
    'big.csv',
    encode(['Customer', ...Array.from({ length: 2001 }, (_, i) => `c${i}`)].join('\n')),
  );
  await choose();
  await fireEvent.press(screen.getByTestId('import-continue'));
  await flush();
  expect(screen.getByTestId('import-refused')).toHaveTextContent(
    '这个文件有 2001 行，一次最多导入 2000 行。请把文件分开，一份一份导入。',
  );
  expect(screen.queryByTestId('import-confirm')).toBeNull();
  expect(await repo.listRecords('orders')).toEqual([]);
});

it('a full table is refused before anything is written', async () => {
  const repo = new MemoryWorkspaceRepo();
  for (let i = 0; i < 9999; i++)
    await repo.insertRecord({
      id: `r${i}`,
      collectionId: 'orders',
      values: { customer: `x${i}` },
      createdAt: 1,
      updatedAt: 1,
    });
  const { files } = await start(undefined, repo);
  await openImport();
  offerCopy(files, 'orders.csv', encode(CSV));
  await choose();
  await fireEvent.press(screen.getByTestId('import-continue'));
  await flush();
  expect(screen.getByTestId('import-refused')).toHaveTextContent(
    '这次会在「订单」加 2 条记录，但它只能再放 1 条。什么都没有导入。',
  );
  expect(await repo.listImports('orders')).toEqual([]);
});

it('French, and one entry, use the singular', async () => {
  const { repo, files } = await start(undefined, undefined, 'fr');
  await fireEvent.press(await screen.findByTestId('import-orders'));
  await screen.findByTestId('import-choose');
  offerCopy(files, 'un.csv', encode('Customer\nAna\n'));
  await choose();
  await fireEvent.press(screen.getByTestId('import-continue'));
  await flush();
  expect(screen.getByTestId('import-summary')).toHaveTextContent(
    /1 entrée sera ajoutée à « 订单 »\./,
  );
  expect(screen.getByTestId('import-confirm')).toHaveTextContent('Importer 1 entrée');
  await fireEvent.press(screen.getByTestId('import-confirm'));
  await flush();
  expect(screen.getByTestId('toast')).toHaveTextContent(/1 entrée importée dans « 订单 »/);
  expect(await customers(repo)).toEqual(['Ana']);
});

it('the kind of file comes from its name, and only when the name has no extension from its MIME type', () => {
  expect(spreadsheetKind('Orders 2026.CSV', null)).toBe('csv');
  expect(spreadsheetKind('orders.xlsx', 'application/octet-stream')).toBe('xlsx');
  // Name says .xls, but MIME type is ignored (treated as invalid spreadsheet).
  expect(spreadsheetKind('orders.xls', 'text/csv')).toBeNull();
  expect(spreadsheetKind('orders.numbers', null)).toBeNull();
  expect(spreadsheetKind('document', 'text/comma-separated-values')).toBe('csv');
  expect(
    spreadsheetKind(
      'document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ),
  ).toBe('xlsx');
  expect(spreadsheetKind('document', 'application/pdf')).toBeNull();
});
