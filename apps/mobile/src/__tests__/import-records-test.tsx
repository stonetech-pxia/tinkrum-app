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

// 表格文件的行导进已有的表（D-574，创始人 2026-11-16 决定 ⑦）：「设置 → 数据」→ 一张表 →「从文件导入记录」。
// 列在本机按名字对到字段、用户确认；导之前先问（汇总 + 「导入」）；导完提示条能撤销（进「最近删除」）；
// 每次导入记成一批，「设置 → 数据」里能整批删。原件不动，选择器的副本读完就删（底线 4）。

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

/** 几张工作表的 xlsx（用 tool-office 的 writeXlsx 写，和真的 Excel 文件一样是数字带格式、文字是共享字符串）。 */
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

/** Android 的「文件」给的是 content://，地址里没有扩展名；名字里有。 */
function offerContent(files: FakeFiles, name: string, bytes: Uint8Array, mimeType: string | null) {
  const uri = `content://com.android.providers.downloads.documents/document/${name.length}`;
  files.disk.set(uri, bytes);
  files.nextPick = [{ uri, name, size: bytes.length, mimeType }];
  return uri;
}

/** iOS / 选择器复制到 App 缓存里的那份（picker://）。 */
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
  await screen.findByTestId('table-orders');
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
  // 名字相同的列已经对上；Comment 没有对应的字段，跳过。
  for (const [col, id] of [
    [0, 'customer'],
    [1, 'amount'],
    [2, 'on'],
    [3, 'status'],
    [4, 'paid'],
    [5, 'skip'],
  ] as const)
    expect(screen.getByTestId(`import-map-${col}-${id}`)).toHaveProp('accessibilityState', {
      selected: true,
    });
  // 样例显示读成什么：日期按这一列的顺序（25 大于 12，日在前）。
  expect(screen.getAllByTestId('import-sample-2')[0]).toHaveTextContent('25/12/2026 → 2026-12-25');
  expect(screen.getAllByTestId('import-sample-1')[2]).toHaveTextContent('「ten」读不出来');
  await fireEvent.press(screen.getByTestId('import-continue'));
  await flush();
  const summary = screen.getByTestId('import-summary');
  expect(summary).toHaveTextContent(/将在「订单」加入 2 条记录。/);
  expect(summary).toHaveTextContent(/有 2 行不会导入：/);
  expect(summary).toHaveTextContent(/1 行的「Amount」读不出来（第 5 行）/);
  expect(summary).toHaveTextContent(/1 行的「Customer」是空的，但必须填写（第 6 行）/);
  // 先问：看了对应和汇总都没写。
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
  // 原件（content://）不动。
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
  // 选择器放在缓存里的副本读完就删。
  expect(files.disk.has(copy)).toBe(false);
  await fireEvent.press(screen.getByTestId('import-continue'));
  await flush();
  await fireEvent.press(screen.getByTestId('import-confirm'));
  await flush();
  expect(await customers(repo)).toEqual(['Ana', 'Bo', 'Old']);
  // 不撤销，回到「设置 → 数据」：这次导入列在表下面。
  await act(() => router.back());
  const [batch] = await repo.listImports('orders');
  const row = await screen.findByTestId(`import-batch-${batch!.id}`);
  expect(row).toHaveTextContent(/orders\.csv · 2 条记录/);
  // 之后改过一条，删除这次导入时也一起删（问的时候说了）。
  const ana = (await repo.listRecords('orders')).find((r) => r.values.customer === 'Ana')!;
  await repo.updateRecord(ana.id, { ...ana.values, amount: 1 }, Date.now());
  const cancelled = answerNext('取消');
  await fireEvent.press(screen.getByTestId(`import-delete-${batch!.id}`));
  expect(cancelled.message).toBe(
    '「orders.csv」导入的 2 条记录会放进「最近删除」，保留 30 天；之后改过的也一样。',
  );
  expect(await customers(repo)).toEqual(['Ana', 'Bo', 'Old']);
  answerNext('删除');
  await fireEvent.press(screen.getByTestId(`import-delete-${batch!.id}`));
  await flush();
  expect(await customers(repo)).toEqual(['Old']);
  await waitFor(() => expect(screen.queryByTestId(`import-batch-${batch!.id}`)).toBeNull());
  // 「最近删除」里一条条能放回来；放回来的那条又算进这次导入。
  await fireEvent.press(await screen.findByTestId(`restore-record-${ana.id}`));
  await flush();
  expect(await customers(repo)).toEqual(['Ana', 'Old']);
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
  // 第一张表只有一格：选第二张。
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
  expect(screen.getByTestId('import-map-0-customer')).toHaveProp('accessibilityState', {
    selected: false,
  });
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
  // 扩展名是 xlsx，内容是 CSV。
  let copy = offerCopy(files, 'orders.xlsx', encode(CSV));
  await choose();
  expect(screen.getByTestId('import-error')).toHaveTextContent(
    '这个文件读不成表格。它可能坏了，或者是别的文件。',
  );
  expect(files.disk.has(copy)).toBe(false);
  // Latin-1 的 CSV。
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
  // 2,001 行：不导一部分，整个不导。
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
  // 名字说是 .xls，MIME 说什么都不算。
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
