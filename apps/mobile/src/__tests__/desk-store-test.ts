import { DESK_MAX_VERSIONS, currentFiles, type RunValue } from '@morph/core';
import type { DocDoc, TableDoc } from '@morph/tool-office';
import { strFromU8, unzipSync } from 'fflate';

import {
  clearDesk,
  commitEdit,
  commitRun,
  deskPicked,
  listDesks,
  loadDesk,
  loadDeskSource,
  placeOnDesk,
  redo,
  undo,
} from '../desk/store';
import { FakeFiles } from '../test-utils/fake-files';

// Desk storage (file-room DESIGN §3, §11.1, D-357): originals are only copied; run directory
// outputs are moved in; intermediate format images are moved into assets/, JSON uses relative
// paths; undo/redo states are stored; old version files exceeding limits are deleted.

const bytes = (n: number) => new Uint8Array(n).fill(7);
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const files = new FakeFiles();
  // Album originals (content://) and cache selector copies: neither belongs to the desk.
  files.disk.set('content://media/photo1', bytes(300));
  files.disk.set('picker://ImagePicker/scan.pdf', bytes(500));
  return files;
}

const original = [
  {
    uri: 'content://media/photo1',
    name: 'IMG_0001.HEIC.jpg',
    size: 300,
    mimeType: 'image/jpeg',
    width: 40,
    height: 30,
  },
  {
    uri: 'picker://ImagePicker/scan.pdf',
    name: '报告.pdf',
    size: 500,
    mimeType: 'application/pdf',
  },
];

/** Files produced in the run directory during a run. */
function runFile(files: FakeFiles, runId: string, name: string, n = 100) {
  const uri = `runs/${runId}/${name}`;
  files.disk.set(uri, bytes(n));
  return uri;
}

describe('Place on desk', () => {
  it('Make a working copy for each, originals remain untouched; desk written as desk.json', async () => {
    const files = setup();
    const desk = await placeOnDesk(files, original, 1000, 'd1');
    expect(files.disk.has('content://media/photo1')).toBe(true);
    expect(files.disk.has('picker://ImagePicker/scan.pdf')).toBe(true);
    expect(files.desk.moved).toEqual([]);
    expect(currentFiles(desk).map((f) => [f.name, f.ext, f.path, f.size])).toEqual([
      ['IMG_0001.HEIC', 'jpg', 'v1-0.jpg', 300],
      ['报告', 'pdf', 'v1-1.pdf', 500],
    ]);
    expect(files.disk.get('desk/d1/v1-0.jpg')).toEqual(bytes(300));
    expect(await loadDesk(files, 'd1')).toEqual(desk);
    // Hand over to runtime: use desk copies, not originals.
    expect(deskPicked(files, desk, currentFiles(desk)).map((p) => p.uri)).toEqual([
      'desk/d1/v1-0.jpg',
      'desk/d1/v1-1.pdf',
    ]);
  });

  it('Do not copy or leave half a desk when storage space is insufficient', async () => {
    const files = setup();
    files.freeBytes = 200;
    await expect(placeOnDesk(files, original, 1000, 'd1')).rejects.toMatchObject({
      code: 'notEnoughSpace',
    });
    expect(await files.desk.list()).toEqual([]);
  });
});

describe('Return tool results to the desk', () => {
  it('Move run directory results into the desk, generate a new version; save undo and redo states', async () => {
    const files = setup();
    let desk = await placeOnDesk(files, original.slice(0, 1), 1000, 'd1');
    const out = runFile(files, 'r1', 'IMG_0001-small.jpg', 80);
    const value: RunValue = {
      type: 'images',
      items: [{ uri: out, name: 'IMG_0001-small', ext: 'jpg', mimeType: 'image/jpeg', size: 80 }],
    };
    ({ desk } = await commitRun(
      files,
      desk,
      ['f1-0'],
      value,
      { kind: 'action', action: 'image.compress' },
      2000,
    ));
    expect(files.desk.moved).toEqual([out]);
    expect(files.disk.has(out)).toBe(false);
    expect(currentFiles(desk).map((f) => [f.id, f.path, f.size])).toEqual([
      ['f2-0', 'v2-0.jpg', 80],
    ]);
    // Version 1 file is still present (can be undone).
    expect(files.disk.has('desk/d1/v1-0.jpg')).toBe(true);

    desk = await undo(files, desk, 3000);
    expect((await loadDesk(files, 'd1'))?.current).toBe(0);
    desk = await redo(files, desk, 4000);
    expect((await loadDesk(files, 'd1'))?.current).toBe(1);
    expect((await loadDesk(files, 'd1'))?.touchedAt).toBe(4000);
  });

  it('Text results (recognized text) do not generate versions, only return text', async () => {
    const files = setup();
    const desk = await placeOnDesk(files, original.slice(0, 1), 1000, 'd1');
    const result = await commitRun(
      files,
      desk,
      ['f1-0'],
      { type: 'text', text: '识别出的字', name: 'x' },
      { kind: 'action', action: 'ocr.recognize' },
      2000,
    );
    expect(result.text).toBe('识别出的字');
    expect(result.desk).toBe(desk);
    expect((await loadDesk(files, 'd1'))?.versions).toHaveLength(1);
  });

  it('Quick actions hand desk files back as-is (last step is sharing): do not generate a new version', async () => {
    const files = setup();
    const desk = await placeOnDesk(files, original.slice(0, 1), 1000, 'd1');
    const item = {
      uri: 'desk/d1/v1-0.jpg',
      name: 'IMG_0001.HEIC',
      ext: 'jpg',
      mimeType: 'image/jpeg',
      size: 300,
    };
    const result = await commitRun(
      files,
      desk,
      ['f1-0'],
      { type: 'images', items: [item] },
      { kind: 'workflow', workflowId: 'w' },
      2000,
    );
    expect(result.desk).toBe(desk);
  });

  it('Delete oldest version files from disk when exceeding 20 versions', async () => {
    const files = setup();
    let desk = await placeOnDesk(files, original.slice(0, 1), 1000, 'd1');
    for (let i = 0; i < DESK_MAX_VERSIONS; i++) {
      const out = runFile(files, `r${i}`, `p${i}.jpg`);
      ({ desk } = await commitRun(
        files,
        desk,
        currentFiles(desk).map((f) => f.id),
        {
          type: 'images',
          items: [{ uri: out, name: `p${i}`, ext: 'jpg', mimeType: 'image/jpeg', size: 100 }],
        },
        { kind: 'action', action: 'image.rotate' },
        2000 + i,
      ));
    }
    expect(desk.versions).toHaveLength(DESK_MAX_VERSIONS);
    expect(desk.versions[0]!.n).toBe(2);
    expect(files.disk.has('desk/d1/v1-0.jpg')).toBe(false);
    expect(files.disk.has('desk/d1/v2-0.jpg')).toBe(true);
  });
});

describe('Intermediate formats in versions (§11.1)', () => {
  const tableDoc = (source: string): TableDoc => ({
    version: 3,
    scope: 'all',
    pages: [
      {
        name: 'Sheet1',
        source,
        width: 100,
        height: 100,
        lineHeight: 10,
        colWidths: [50, 50],
        blocks: [{ kind: 'text', text: '标题', box: { x: 0, y: 0, width: 10, height: 10 } }],
      },
    ],
  });

  it('Convert to Excel: xlsx, TableDoc, and original image all enter the desk; JSON uses relative paths, replaced with current addresses upon reading', async () => {
    const files = setup();
    let desk = await placeOnDesk(files, original.slice(0, 1), 1000, 'd1');
    const page = runFile(files, 'r1', 'input-0.jpg', 300);
    const xlsx = runFile(files, 'r1', '表格.xlsx', 50);
    const json = `runs/r1/表格.json`;
    files.disk.set(json, new TextEncoder().encode(JSON.stringify(tableDoc(page))));
    ({ desk } = await commitRun(
      files,
      desk,
      ['f1-0'],
      {
        type: 'files',
        items: [
          {
            uri: xlsx,
            name: '表格',
            ext: 'xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 50,
            tableDoc: { uri: json, for: xlsx, pagesWithoutTables: [1] },
          },
        ],
      },
      { kind: 'action', action: 'ocr.toExcel' },
      2000,
    ));
    const [sheet] = currentFiles(desk);
    expect(sheet!.source).toMatchObject({
      kind: 'table',
      path: 'v2-0.json',
      pagesWithoutTables: [1],
      assets: [{ path: 'assets/v2-0-0.jpg', size: 300 }],
    });
    const stored = JSON.parse((await files.desk.readText('d1/v2-0.json'))!) as TableDoc;
    expect(stored.pages[0]!.source).toBe('assets/v2-0-0.jpg');
    expect(files.disk.has(page)).toBe(false);
    const loaded = await loadDeskSource(files, desk, sheet!);
    expect(loaded?.kind === 'table' && loaded.doc.pages[0]!.source).toBe(
      'desk/d1/assets/v2-0-0.jpg',
    );
    // Revert to photo version, intermediate format is still present (still viewable after redo).
    desk = await undo(files, desk, 3000);
    expect(currentFiles(desk)[0]!.ext).toBe('jpg');
    desk = await redo(files, desk, 4000);
    expect(currentFiles(desk)[0]!.source?.path).toBe('v2-0.json');
  });

  it('Convert to Word: clipped images also enter assets/; store only one copy of duplicate images', async () => {
    const files = setup();
    let desk = await placeOnDesk(files, original.slice(0, 1), 1000, 'd1');
    const page = runFile(files, 'r1', 'input-0.jpg', 300);
    const crop = runFile(files, 'r1', 'word/1-1.jpg', 40);
    const docx = runFile(files, 'r1', '文档.docx', 60);
    const doc: DocDoc = {
      version: 1,
      pages: [
        {
          source: page,
          width: 100,
          height: 100,
          bodySize: 11,
          blocks: [
            { kind: 'image', box: { x: 0, y: 0, width: 10, height: 10 }, src: crop },
            { kind: 'image', box: { x: 0, y: 20, width: 10, height: 10 }, src: crop },
          ],
        },
      ],
    };
    files.disk.set('runs/r1/文档.json', new TextEncoder().encode(JSON.stringify(doc)));
    ({ desk } = await commitRun(
      files,
      desk,
      ['f1-0'],
      {
        type: 'files',
        items: [
          {
            uri: docx,
            name: '文档',
            ext: 'docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: 60,
            docDoc: { uri: 'runs/r1/文档.json', for: docx },
          },
        ],
      },
      { kind: 'action', action: 'ocr.toWord' },
      2000,
    ));
    const [word] = currentFiles(desk);
    expect(word!.source?.assets.map((a) => a.path)).toEqual([
      'assets/v2-0-0.jpg',
      'assets/v2-0-1.jpg',
    ]);
    const loaded = await loadDeskSource(files, desk, word!);
    const blocks = loaded?.kind === 'doc' ? loaded.doc.pages[0]!.blocks : [];
    expect(blocks.map((b) => (b.kind === 'image' ? b.src : null))).toEqual([
      'desk/d1/assets/v2-0-1.jpg',
      'desk/d1/assets/v2-0-1.jpg',
    ]);
  });

  it('Convert to Excel: clipped images also enter assets/, rewritten into xlsx when edit is closed (D-520)', async () => {
    const files = setup();
    let desk = await placeOnDesk(files, original.slice(0, 1), 1000, 'd1');
    const page = runFile(files, 'r1', 'input-0.jpg', 300);
    const crop = runFile(files, 'r1', 'excel/1-1.jpg', 40);
    const xlsx = runFile(files, 'r1', '表格.xlsx', 50);
    const doc: TableDoc = {
      ...tableDoc(page),
      pages: [
        {
          ...tableDoc(page).pages[0]!,
          blocks: [
            { kind: 'text', text: '标题', box: { x: 0, y: 0, width: 10, height: 10 } },
            {
              kind: 'image',
              col: 0,
              cols: 2,
              src: crop,
              box: { x: 0, y: 20, width: 40, height: 20 },
            },
          ],
        },
      ],
    };
    files.disk.set('runs/r1/表格.json', new TextEncoder().encode(JSON.stringify(doc)));
    ({ desk } = await commitRun(
      files,
      desk,
      ['f1-0'],
      {
        type: 'files',
        items: [
          {
            uri: xlsx,
            name: '表格',
            ext: 'xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 50,
            tableDoc: { uri: 'runs/r1/表格.json', for: xlsx },
          },
        ],
      },
      { kind: 'action', action: 'ocr.toExcel' },
      2000,
    ));
    const [sheet] = currentFiles(desk);
    expect(sheet!.source?.assets.map((a) => a.path)).toEqual([
      'assets/v2-0-0.jpg',
      'assets/v2-0-1.jpg',
    ]);
    expect(files.disk.has(crop)).toBe(false);
    const stored = JSON.parse((await files.desk.readText('d1/v2-0.json'))!) as TableDoc;
    const storedImage = stored.pages[0]!.blocks.find((b) => b.kind === 'image');
    expect(storedImage?.kind === 'image' && storedImage.src).toBe('assets/v2-0-1.jpg');
    const loaded = await loadDeskSource(files, desk, sheet!);
    const shown = loaded?.kind === 'table' ? loaded.doc.pages[0]!.blocks : [];
    expect(shown.map((b) => (b.kind === 'image' ? b.src : null))).toEqual([
      null,
      'desk/d1/assets/v2-0-1.jpg',
    ]);
    // Edit closed: regenerated xlsx contains this image, path in intermediate format remains relative.
    const edited = await commitEdit(
      files,
      desk,
      sheet!.id,
      { kind: 'table', doc: loaded!.doc as TableDoc },
      3000,
    );
    const next = currentFiles(edited.desk)[0]!;
    const zip = unzipSync(files.disk.get(`desk/d1/${next.path}`)!);
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['xl/media/image1.jpg']));
    expect(strFromU8(zip['xl/drawings/drawing1.xml']!)).toContain('<xdr:pic>');
    const again = JSON.parse((await files.desk.readText(`d1/${next.source!.path}`))!) as TableDoc;
    const againImage = again.pages[0]!.blocks.find((b) => b.kind === 'image');
    expect(againImage?.kind === 'image' && againImage.src).toBe('assets/v2-0-1.jpg');
  });

  it('Subsequent steps generated new files (intermediate format not stored for it): this version has no intermediate format', async () => {
    const files = setup();
    let desk = await placeOnDesk(files, original.slice(0, 1), 1000, 'd1');
    const xlsx = runFile(files, 'r1', 'b.xlsx');
    ({ desk } = await commitRun(
      files,
      desk,
      ['f1-0'],
      {
        type: 'files',
        items: [
          {
            uri: xlsx,
            name: 'b',
            ext: 'xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 100,
            tableDoc: { uri: 'runs/r1/a.json', for: 'runs/r1/a.xlsx' },
          },
        ],
      },
      { kind: 'workflow', workflowId: 'w' },
      2000,
    ));
    expect(currentFiles(desk)[0]!.source).toBeUndefined();
  });
});

describe('Cleanup', () => {
  it('List all desks, flag those inactive for 7 days; clearing the desk deletes the entire directory, originals untouched', async () => {
    const files = setup();
    await placeOnDesk(files, original.slice(0, 1), 1000, 'old');
    await placeOnDesk(files, original.slice(1), 9 * DAY, 'new');
    const desks = await listDesks(files);
    expect(desks.map((d) => d.id)).toEqual(['new', 'old']);
    await clearDesk(files, 'old');
    expect(await loadDesk(files, 'old')).toBeNull();
    expect([...files.disk.keys()].filter((k) => k.startsWith('desk/old/'))).toEqual([]);
    expect(files.disk.has('content://media/photo1')).toBe(true);
  });
});
