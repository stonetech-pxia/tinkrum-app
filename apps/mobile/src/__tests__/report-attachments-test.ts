import {
  BUILTIN_TOOLS,
  createRegistry,
  REPORT_ATTACHMENT_LIMITS,
  type Collection,
  type RunResult,
  type Workflow,
} from '@morph/core';
import { strFromU8, unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';

import type { LocalUi } from '../runtime/local';
import { startRun } from '../runtime/runner';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, makePdf, TINY_JPEG } from '../test-utils/fake-files';

// Report attachments (D-425) and record-to-Excel (D-427): actually run `startRun`, mock the layout,
// and use the real library for merging and writing `.xlsx`. Three states: new user (records lack
// attachments), with data, and edge cases (missing file, HEIC, 200 attachments, very large image,
// missing title, corrupted PDF).

const registry = createRegistry(BUILTIN_TOOLS);

const claims: Collection = {
  id: 'claims',
  name: '报销',
  fields: [
    { id: 'note', name: '备注', type: 'text' },
    { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
    { id: 'receipt', name: '收据', type: 'file' },
  ],
};

const workflow = (attachments?: boolean): Workflow => ({
  kind: 'quickAction',
  id: 'mine',
  name: '我的',
  steps: [
    { id: 'read', action: 'in.records', params: { collectionId: 'claims', period: 'all' } },
    {
      id: 'pdf',
      action: 'print.records',
      params: {
        template: 'receipt',
        title: '报销单',
        fields: ['note', 'amount'],
        pageSize: 'a4',
        ...(attachments === undefined ? {} : { attachments }),
      },
    },
  ],
});

function setup(wf: Workflow = workflow(true)) {
  const files = new FakeFiles();
  const repo = new MemoryWorkspaceRepo();
  const ui: LocalUi = {
    confirm: async () => false,
    choose: async () => null,
    open: async () => null,
  };
  let n = 0;
  const run = async (): Promise<RunResult> =>
    (
      await startRun({
        workflow: wf,
        revisionId: 1,
        repo,
        files,
        registry,
        locale: 'zh',
        now: () => new Date(2026, 10, 4),
        newId: () => `id${++n}`,
        ui,
        collections: [claims],
        askParams: async (r) => r.params,
      })
    ).result;
  let time = 0;
  const addRecord = (id: string, values: Record<string, unknown>) =>
    repo.insertRecord({
      id,
      collectionId: 'claims',
      values,
      createdAt: ++time,
      updatedAt: time,
    });
  const addFile = async (id: string, name: string, mimeType: string, bytes: Uint8Array) => {
    const path = `assets/${id}/${name}`;
    files.disk.set(path, bytes);
    await repo.addAsset({
      id,
      name,
      mimeType,
      size: bytes.length,
      path,
      source: 'picked',
      createdAt: 1,
    });
  };
  const addPhoto = (id: string, name = `${id}.jpg`, mime = 'image/jpeg') =>
    addFile(id, name, mime, TINY_JPEG);
  return { files, repo, run, addRecord, addFile, addPhoto };
}

type Run = ReturnType<typeof setup>;

const output = async ({ files }: Run, result: RunResult) => {
  if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
  const value = result.value as { items: { uri: string; pageCount?: number }[] };
  expect(value.items).toHaveLength(1);
  const item = value.items[0]!;
  const doc = await PDFDocument.load(files.disk.get(item.uri)!);
  return { item, pages: doc.getPageCount() };
};

const report = (s: Run) => s.files.printedHtml.at(-1)!;

describe('print.records with attachments (D-425)', () => {
  it('an old quick action without the parameter reads no attachment and prints one report', async () => {
    const s = setup(workflow());
    await s.addPhoto('a');
    await s.addRecord('r', { note: '午饭', amount: 30, receipt: ['a'] });
    const { pages } = await output(s, await s.run());
    expect(pages).toBe(1);
    expect(s.files.reduced).toEqual([]);
    expect(s.files.printedHtml).toHaveLength(1);
    expect(s.files.printedHtml[0]).not.toContain('<img');
  });

  it('new user: records without attachments make a plain report with no note', async () => {
    const s = setup();
    await s.addRecord('r', { note: '午饭', amount: 30 });
    const { pages } = await output(s, await s.run());
    expect(pages).toBe(1);
    expect(s.files.printedHtml).toHaveLength(1);
    expect(report(s)).not.toContain('class="note"');
  });

  it('attachments follow the report in record order, each with its record’s title', async () => {
    const s = setup();
    await s.addPhoto('a');
    await s.addPhoto('b');
    await s.addPhoto('c');
    await s.addRecord('r1', { note: '午饭', amount: 30, receipt: ['a', 'b'] });
    await s.addRecord('r2', { note: '<出租车>', amount: 50, receipt: ['c'] });
    const { pages, item } = await output(s, await s.run());
    // Mock layout: one HTML page per report page. 1 report page + 1 attachment.
    expect(pages).toBe(2);
    expect(item.pageCount).toBe(2);
    expect(s.files.printedHtml).toHaveLength(2);
    const [attachments, main] = s.files.printedHtml as [string, string];
    expect(main).not.toContain('class="note"');
    expect(attachments.match(/<img /g)).toHaveLength(3);
    const lunch = attachments.indexOf('<h2>午饭</h2>');
    const taxi = attachments.indexOf('<h2>&lt;出租车&gt;</h2>');
    expect(lunch).toBeGreaterThan(-1);
    expect(taxi).toBeGreaterThan(lunch);
    expect(attachments).toContain('第 2 个附件，共 2 个');
    // File names and file IDs are not written on the report.
    expect(attachments).not.toContain('a.jpg');
  });

  it('originals stay exactly where they were, and intermediate files are gone', async () => {
    const s = setup();
    await s.addPhoto('a');
    await s.addFile('p', 'p.pdf', 'application/pdf', await makePdf(2));
    await s.addRecord('r1', { note: '午饭', receipt: ['a', 'p'] });
    const before = new Map(s.files.disk);
    const { item } = await output(s, await s.run());
    for (const key of before.keys())
      if (key.startsWith('assets/')) expect(s.files.disk.get(key)).toBe(before.get(key));
    const leftovers = [...s.files.disk.keys()].filter((k) => k.startsWith('runs/'));
    expect(leftovers).toEqual([item.uri]);
  });

  it('a PDF attachment’s pages are appended, after a page saying which record it is', async () => {
    const s = setup();
    await s.addPhoto('a');
    await s.addFile('p', 'p.pdf', 'application/pdf', await makePdf(3));
    await s.addPhoto('b');
    await s.addRecord('r1', { note: '合同', receipt: ['a', 'p', 'b'] });
    const { pages } = await output(s, await s.run());
    // Report 1 + photos and captions 1 + PDFs 3 + subsequent photos 1.
    expect(pages).toBe(6);
    expect(s.files.printedHtml[0]).toContain('PDF 附件：接下来的 3 页');
    expect(s.files.printedHtml[0]).toContain('<h2>合同</h2>');
  });

  it('a missing or unreadable attachment is skipped and said on the report', async () => {
    const s = setup();
    await s.addPhoto('good');
    // Present in database but missing on disk; missing from database; corrupted PDF; neither photo nor PDF.
    await s.addPhoto('gone');
    s.files.disk.delete('assets/gone/gone.jpg');
    await s.addFile('bad', 'bad.pdf', 'application/pdf', new Uint8Array([1, 2, 3]));
    await s.addFile('doc', 'x.docx', 'application/msword', new Uint8Array([1]));
    await s.addRecord('r1', { note: '好的', receipt: ['good'] });
    await s.addRecord('r2', { note: '坏的', receipt: ['gone', 'nothing1', 'bad', 'doc'] });
    const { pages } = await output(s, await s.run());
    expect(pages).toBe(2);
    expect(report(s)).toContain('有 4 个附件读不了，没有放进来。来自：坏的。');
  });

  it('a HEIC-named image goes through the same path as any photo', async () => {
    const s = setup();
    await s.addPhoto('h', 'IMG_1.heic', 'image/heic');
    await s.addPhoto('o', 'IMG_2.HEIC', 'application/octet-stream');
    await s.addRecord('r', { note: '午饭', receipt: ['h', 'o'] });
    await output(s, await s.run());
    expect(s.files.reduced).toHaveLength(2);
    expect(report(s)).not.toContain('class="note"');
  });

  it('a very large image is decoded reduced to the target size, never in full', async () => {
    const s = setup();
    await s.addPhoto('big');
    s.files.imageSizes.set('file:///fake/assets/big/big.jpg', { width: 12000, height: 16000 });
    await s.addRecord('r', { note: '大图', receipt: ['big'] });
    await output(s, await s.run());
    expect(s.files.reduced).toEqual([
      { uri: 'file:///fake/assets/big/big.jpg', maxSide: REPORT_ATTACHMENT_LIMITS.maxSide },
    ]);
    expect(s.files.encodes[0]).toMatchObject({ width: 1050, height: 1400 });
  });

  it('200 attachments: the limit goes in, in small batches, and the rest is said on the report', async () => {
    const s = setup();
    for (let r = 0; r < 10; r++) {
      const ids = Array.from({ length: 20 }, (_, i) => `f${r}x${i}`);
      for (const id of ids) await s.addPhoto(id);
      await s.addRecord(`r${r}`, { note: `第${r}条`, receipt: ids });
    }
    await output(s, await s.run());
    const max = REPORT_ATTACHMENT_LIMITS.maxCount;
    expect(s.files.reduced).toHaveLength(max);
    const htmls = s.files.printedHtml.slice(0, -1);
    for (const html of htmls)
      expect(html.match(/<img /g)!.length).toBeLessThanOrEqual(
        REPORT_ATTACHMENT_LIMITS.batchImages,
      );
    expect(htmls.join('').match(/<img /g)).toHaveLength(max);
    expect(report(s)).toContain(`有 ${200 - max} 个附件没有放进来`);
    expect(report(s)).toContain('第3条');
  });

  it('files over the byte budget are left out and said, the rest still goes in', async () => {
    const s = setup();
    s.files.disk.set('assets/huge/huge.pdf', new Uint8Array(1));
    await s.repo.addAsset({
      id: 'huge',
      name: 'huge.pdf',
      mimeType: 'application/pdf',
      size: REPORT_ATTACHMENT_LIMITS.maxBytes + 1,
      path: 'assets/huge/huge.pdf',
      source: 'picked',
      createdAt: 1,
    });
    await s.addPhoto('a');
    await s.addRecord('r', { note: '合同', receipt: ['huge', 'a'] });
    const { pages } = await output(s, await s.run());
    expect(pages).toBe(2);
    expect(report(s)).toContain('有 1 个附件没有放进来');
  });

  it('a record with no title is captioned like the list shows it', async () => {
    const s = setup();
    await s.addPhoto('a');
    await s.addRecord('r', { amount: 12, receipt: ['a'] });
    await output(s, await s.run());
    expect(s.files.printedHtml[0]).toMatch(/<h2>报销 · [^<]+<\/h2>/);
    expect(s.files.printedHtml[0]).toContain('12.00');
  });

  it('when laying out a batch fails, the report still comes out and says so', async () => {
    const s = setup();
    await s.addPhoto('a');
    await s.addRecord('r', { note: '午饭', receipt: ['a'] });
    const print = s.files.htmlToPdf.bind(s.files);
    jest.spyOn(s.files, 'htmlToPdf').mockImplementation(async (html, page, runId, relPath) => {
      if (html.includes('<img')) throw new Error('out of memory');
      return print(html, page, runId, relPath);
    });
    const { pages } = await output(s, await s.run());
    expect(pages).toBe(1);
    expect(report(s)).toContain('有 1 个附件读不了');
  });

  it('when the report itself fails, the run fails and no intermediate file stays', async () => {
    const s = setup();
    await s.addPhoto('a');
    await s.addRecord('r', { note: '午饭', receipt: ['a'] });
    const print = s.files.htmlToPdf.bind(s.files);
    jest.spyOn(s.files, 'htmlToPdf').mockImplementation(async (html, page, runId, relPath) => {
      if (!html.includes('<img')) throw new Error('printer');
      return print(html, page, runId, relPath);
    });
    const result = await s.run();
    expect(result.status).toBe('failed');
    expect([...s.files.disk.keys()].filter((k) => k.startsWith('runs/'))).toEqual([]);
    expect(s.files.disk.has('assets/a/a.jpg')).toBe(true);
  });
});

describe('records.toExcel (D-427)', () => {
  const excel: Workflow = {
    kind: 'quickAction',
    id: 'x',
    name: 'X',
    steps: [
      { id: 'read', action: 'in.records', params: { collectionId: 'claims', period: 'all' } },
      { id: 'xlsx', action: 'records.toExcel', params: {} },
    ],
  };

  it('makes one .xlsx named after the table; OCR text stays text when read back', async () => {
    const s = setup(excel);
    await s.addPhoto('a');
    await s.addRecord('r1', { note: '=HYPERLINK("http://x")', amount: 12.5, receipt: ['a'] });
    await s.addRecord('r2', { note: '+33 1 23 45', amount: 3 });
    const result = await s.run();
    if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
    const [file] = (result.value as { items: { uri: string; name: string; ext: string }[] }).items;
    expect(file).toMatchObject({ name: '报销', ext: 'xlsx' });
    const zip = unzipSync(s.files.disk.get(file!.uri)!);
    const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']!);
    const strings = strFromU8(zip['xl/sharedStrings.xml']!);
    expect(sheet).not.toMatch(/<f[ >]/);
    expect(strings).toContain('=HYPERLINK(&quot;http://x&quot;)');
    expect(strings).toContain('+33 1 23 45');
    expect(strings).toContain('1 个附件');
    expect(strings).toContain('金额');
    expect(sheet).toContain('<v>12.5</v>');
    expect(strFromU8(zip['xl/workbook.xml']!)).toContain('name="报销"');
  });

  it('selects columns in order and exports uniquely named copies with skipped files noted on their row', async () => {
    const wf = structuredClone(excel);
    wf.steps[1]!.params = { fields: ['amount', 'note'], attachments: true };
    const s = setup(wf);
    await s.addPhoto('a', 'receipt.jpg');
    await s.addPhoto('b', 'receipt.jpg');
    await s.addRecord('r1', { note: 'First', amount: 12, receipt: ['a', 'missing'] });
    await s.addRecord('r2', { note: 'Second', amount: 3, receipt: ['b', 'a'] });
    const result = await s.run();
    if (result.status !== 'succeeded' || !result.value || !('items' in result.value))
      throw new Error(JSON.stringify(result));
    expect(result.value.items.map((i) => `${i.name}.${i.ext}`)).toEqual([
      '报销.xlsx',
      'receipt.jpg',
      'receipt-2.jpg',
    ]);
    const parts = unzipSync(s.files.disk.get(result.value.items[0]!.uri)!);
    const strings = strFromU8(parts['xl/sharedStrings.xml']!);
    expect(strings.indexOf('金额')).toBeLessThan(strings.indexOf('备注'));
    expect(strings).toContain('receipt-2.jpg');
    expect(strings).toContain('missing');
    expect(await s.repo.getAsset('a')).toBeTruthy();
  });

  it('stops copying at the shared attachment count limit', async () => {
    const wf = structuredClone(excel);
    wf.steps[1]!.params = { attachments: true };
    const s = setup(wf);
    for (let i = 0; i < REPORT_ATTACHMENT_LIMITS.maxCount + 1; i++) {
      await s.addFile(`a${i}`, `a${i}.txt`, 'text/plain', new Uint8Array([1]));
      await s.addRecord(`r${i}`, { note: `Row ${i}`, receipt: [`a${i}`] });
    }
    const result = await s.run();
    if (result.status !== 'succeeded' || !result.value || !('items' in result.value))
      throw new Error(JSON.stringify(result));
    expect(result.value.items).toHaveLength(REPORT_ATTACHMENT_LIMITS.maxCount + 1);
    const strings = strFromU8(
      unzipSync(s.files.disk.get(result.value.items[0]!.uri)!)['xl/sharedStrings.xml']!,
    );
    expect(strings).toContain(`a${REPORT_ATTACHMENT_LIMITS.maxCount}.txt`);
    expect(strings).toContain('40');
  });

  it('says so when the table has no records', async () => {
    const s = setup(excel);
    const result = await s.run();
    expect(result.status).toBe('failed');
  });
});
