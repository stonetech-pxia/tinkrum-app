import {
  BUILTIN_TOOLS,
  createRegistry,
  decodeUtf8,
  type RunItem,
  type RunResult,
  type Workflow,
} from '@morph/core';
import { getLocales } from 'expo-localization';
import { parseTableDoc, type TableBlock } from '@morph/tool-office';
import { gridRects, renderPage } from '@morph/tool-office/src/test-helpers';
import { strFromU8, unzipSync } from 'fflate';

import type { RecognizedLine } from '../runtime/platform';
import { startRun } from '../runtime/runner';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, FakeVision } from '../test-utils/fake-files';

// Execution of scan-to-Excel (D-272): decode pixels used for line finding only once (shared during
// PP-OCRv6 recognition on the same image); when a pre-enhancement image is available, perform
// recognition on it and map coordinates back (D-267); result is an xlsx with a TableDoc stored
// alongside.

jest.mock('expo-localization', () => ({ getLocales: jest.fn(() => []) }));

const registry = createRegistry(BUILTIN_TOOLS);
const XS = [100, 300, 500, 700, 900];
const YS = [100, 160, 220, 280];

/** A single line of text in the middle of each cell, coordinates scaled by k (the recognition image is larger than the line-finding image). */
function cellLines(k = 1): RecognizedLine[] {
  const out: RecognizedLine[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      out.push({
        text: r === 0 ? `列${c + 1}` : String(r * 100 + c),
        x: ((XS[c]! + XS[c + 1]!) / 2 - 60) * k,
        y: ((YS[r]! + YS[r + 1]!) / 2 - 12) * k,
        width: 120 * k,
        height: 24 * k,
      });
    }
  }
  return out;
}

let ids = 0;
function setup(steps: Workflow['steps'], visionOn = true) {
  const files = new FakeFiles();
  const vision = new FakeVision(files);
  if (visionOn) files.vision = vision;
  const workflow: Workflow = { kind: 'quickAction', id: 'excel', name: 'excel', steps };
  const run = async (): Promise<RunResult> =>
    (
      await startRun({
        workflow,
        revisionId: 1,
        repo: new MemoryWorkspaceRepo(),
        files,
        registry,
        locale: 'zh',
        now: () => new Date(2026, 9, 28),
        newId: () => `id${++ids}`,
        ui: { confirm: async () => false, choose: async () => null, open: async () => null },
        packs: null,
        askParams: async (request) => request.params,
      })
    ).result;
  return { files, vision, run };
}

const pick = { id: 'pick', action: 'in.photos', params: { source: 'library', min: 1, max: 5 } };
const excel = (scope: 'all' | 'tables' = 'all', lang = 'chi_sim') => ({
  id: 'excel',
  action: 'ocr.toExcel',
  params: { lang, scope },
});

function resultItem(result: RunResult): RunItem {
  if (result.status !== 'succeeded' || !result.value || !('items' in result.value)) {
    throw new Error(`run did not succeed: ${JSON.stringify(result)}`);
  }
  return result.value.items[0]!;
}

async function unpack(files: FakeFiles, item: RunItem) {
  const zip = unzipSync(await files.readUri(item.uri));
  return (name: string) => strFromU8(zip[name]!);
}

describe('ocr.toExcel (D-272)', () => {
  it('makes one xlsx from a ruled table, decoding the picture only once', async () => {
    const { files, vision, run } = setup([pick, excel()]);
    files.nextPhotos = [files.offerImage('发票明细.jpg', 2000, 1400)];
    const page = renderPage(1000, 700, gridRects(XS, YS));
    vision.tableImages = [page];
    // The recognition image is 2x the size of the line-finding image: coordinates are scaled back proportionally.
    vision.layers = [{ width: 2000, height: 1400, lines: cellLines(2) }];
    const item = resultItem(await run());
    expect(item).toMatchObject({
      name: '发票明细',
      ext: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(vision.calls.filter((c) => c.method === 'tablePixels')).toHaveLength(1);
    // Text recognition uses the exact same pixel data decoded during line finding.
    expect(vision.linePixels).toEqual([page]);
    const read = await unpack(files, item);
    expect(read('xl/workbook.xml')).toContain('<sheet name="第 1 页"');
    expect(read('xl/sharedStrings.xml')).toContain('<t>列1</t>');
    // Write numbers as numeric type.
    expect(read('xl/worksheets/sheet1.xml')).toMatch(/<c r="D3" s="\d+"><v>203<\/v><\/c>/);
    // TableDoc resides in the run directory and is valid only for this xlsx.
    expect(item.tableDoc?.for).toBe(item.uri);
    expect(item.tableDoc?.uri.startsWith('runs/')).toBe(true);
    expect(item.tableDoc?.pagesWithoutTables).toBeUndefined();
    const doc = parseTableDoc(decodeUtf8(await files.readUri(item.tableDoc!.uri)))!;
    const table = doc.pages[0]!.blocks[0] as TableBlock;
    expect([table.rows, table.cols]).toEqual([3, 4]);
    // Cropping the original image uses the line-finding image.
    expect(doc.pages[0]!.source).toBe(vision.calls.find((c) => c.method === 'tablePixels')!.uri);
  });

  it('recognizes on the picture from before the cleanup and maps the boxes back (D-267)', async () => {
    const { files, vision, run } = setup([
      pick,
      { id: 'look', action: 'scan.enhance', params: { mode: 'auto' } },
      excel(),
    ]);
    const photo = files.offerImage('table.jpg', 1000, 700);
    files.nextPhotos = [photo];
    vision.tableImages = [renderPage(1000, 700, gridRects(XS, YS))];
    vision.layers = [{ width: 1000, height: 700, lines: cellLines() }];
    const item = resultItem(await run());
    const lineCalls = vision.calls.filter((c) => c.method === 'recognizeLines');
    // Line finding uses the enhanced image, while text recognition uses the pre-enhanced image (copied into the run directory).
    const tableCall = vision.calls.find((c) => c.method === 'tablePixels')!;
    expect(lineCalls).toHaveLength(1);
    expect(lineCalls[0]!.uri).not.toBe(tableCall.uri);
    expect(vision.linePixels).toEqual([undefined]);
    const doc = parseTableDoc(decodeUtf8(await files.readUri(item.tableDoc!.uri)))!;
    const table = doc.pages[0]!.blocks[0] as TableBlock;
    expect(table.cells.find((c) => c.row === 2 && c.col === 3)!.text).toBe('203');
    expect(doc.pages[0]!.source).toBe(tableCall.uri);
  });

  it('writes everything on a page without a ruled table when “tables only” is chosen, and says so', async () => {
    const { files, vision, run } = setup([pick, excel('tables')]);
    files.nextPhotos = [files.offerImage('a.jpg', 1000, 700), files.offerImage('b.jpg', 1000, 700)];
    vision.tableImages = [renderPage(1000, 700, gridRects(XS, YS)), renderPage(1000, 700, [])];
    vision.layers = [
      {
        width: 1000,
        height: 700,
        lines: [...cellLines(), { text: '表格上面的标题', x: 100, y: 40, width: 300, height: 24 }],
      },
      {
        width: 1000,
        height: 700,
        lines: [{ text: '只有一段文字', x: 100, y: 100, width: 400, height: 24 }],
      },
    ];
    const item = resultItem(await run());
    expect(item.tableDoc?.pagesWithoutTables).toEqual([2]);
    const read = await unpack(files, item);
    const strings = read('xl/sharedStrings.xml');
    expect(strings).not.toContain('表格上面的标题');
    expect(strings).toContain('只有一段文字');
    expect(read('xl/workbook.xml')).toContain('<sheet name="第 2 页"');
  });

  it('names the workbook by date when the photo name is a machine id or there are several pages', async () => {
    // 2026-10-29 real device test: shared photo names are a string of numbers, so the table is named b02fdc9e-9ebd-...-1_all_3391.xlsx.
    const one = setup([pick, excel()]);
    one.files.nextPhotos = [
      one.files.offerImage('b02fdc9e-9ebd-4c1a-8e0f-3a9d2b7c6e51-1_all_3391.jpg', 1000, 700),
    ];
    one.vision.tableImages = [renderPage(1000, 700, gridRects(XS, YS))];
    one.vision.layers = [{ width: 1000, height: 700, lines: cellLines() }];
    expect(resultItem(await one.run())).toMatchObject({ name: '表格-2026-10-28', ext: 'xlsx' });

    // Multiple pages combined into a single file: do not use the first page's name (which looks as if only that page exists).
    const two = setup([pick, excel()]);
    two.files.nextPhotos = [
      two.files.offerImage('账单1.jpg', 1000, 700),
      two.files.offerImage('账单2.jpg', 1000, 700),
    ];
    const page = renderPage(1000, 700, gridRects(XS, YS));
    two.vision.tableImages = [page, page];
    two.vision.layers = [
      { width: 1000, height: 700, lines: cellLines() },
      { width: 1000, height: 700, lines: cellLines() },
    ];
    expect(resultItem(await two.run())).toMatchObject({ name: '表格-2026-10-28', ext: 'xlsx' });
  });

  it('says so when the device can’t read tables in that language', async () => {
    const { files, vision, run } = setup([pick, excel('all', 'rus')]);
    vision.unsupported.add('ru');
    files.nextPhotos = [files.offerImage('a.jpg', 1000, 700)];
    expect(await run()).toMatchObject({ status: 'failed', error: { code: 'tableUnsupported' } });
    const noVision = setup([pick, excel()], false);
    noVision.files.nextPhotos = [noVision.files.offerImage('a.jpg', 1000, 700)];
    expect(await noVision.run()).toMatchObject({
      status: 'failed',
      error: { code: 'tableUnsupported' },
    });
  });

  it('picks the language by the phone’s languages when lang is auto (D-278)', async () => {
    const phone = (languageTag: string) =>
      jest
        .mocked(getLocales)
        .mockReturnValue([{ languageTag } as ReturnType<typeof getLocales>[number]]);
    try {
      phone('ja-JP');
      const ja = setup([pick, excel('all', 'auto')]);
      ja.files.nextPhotos = [ja.files.offerImage('a.jpg', 1000, 700)];
      ja.vision.tableImages = [renderPage(1000, 700, gridRects(XS, YS))];
      ja.vision.layers = [{ width: 1000, height: 700, lines: cellLines() }];
      resultItem(await ja.run());
      expect(ja.vision.calls.find((c) => c.method === 'recognizeLines')?.args).toEqual([
        'ja-JP',
        'en-US',
      ]);
      // Phone language is Russian and system cannot recognize it either: state clearly that it is not supported, and do not download the text recognition package (which does not provide line coordinates).
      phone('ru-RU');
      const ru = setup([pick, excel('all', 'auto')]);
      ru.vision.unsupported.add('ru');
      ru.files.nextPhotos = [ru.files.offerImage('a.jpg', 1000, 700)];
      expect(await ru.run()).toMatchObject({
        status: 'failed',
        error: { code: 'tableUnsupported' },
      });
    } finally {
      jest.mocked(getLocales).mockReturnValue([] as unknown as ReturnType<typeof getLocales>);
    }
  });

  describe('figures from the layout model (D-520)', () => {
    // There is a chart area below the table (the original image is 2x the size of the line-finding image).
    const figure = {
      kind: 'image' as const,
      label: 'chart',
      score: 0.8,
      box: { x: 100, y: 350, width: 400, height: 200 },
    };
    const onePage = (vision: FakeVision) => {
      vision.tableImages = [renderPage(1000, 700, gridRects(XS, YS))];
      vision.layers = [{ width: 2000, height: 1400, lines: cellLines(2) }];
    };

    it('crops the figure from the picture, puts it in the xlsx and remembers it in the TableDoc', async () => {
      const { files, vision, run } = setup([pick, excel()]);
      vision.enableLayout();
      vision.layoutRegions = [[figure]];
      files.nextPhotos = [files.offerImage('报告.jpg', 2000, 1400)];
      onePage(vision);
      const item = resultItem(await run());
      expect(vision.calls.filter((c) => c.method === 'detectLayout')).toHaveLength(1);
      const zip = unzipSync(await files.readUri(item.uri));
      expect(Object.keys(zip)).toEqual(
        expect.arrayContaining(['xl/drawings/drawing1.xml', 'xl/media/image1.jpg']),
      );
      // The crop region is on the original image (at 2x scale), with a little extra margin around the edges.
      const encoded = files.encodes.at(-1)!;
      expect(encoded.format).toBe('jpeg');
      const crop = (
        encoded.ops as { crop: { x: number; y: number; width: number; height: number } }
      ).crop;
      expect(crop.x).toBeLessThanOrEqual(200);
      expect(crop.y).toBeLessThanOrEqual(700);
      expect(crop.x + crop.width).toBeGreaterThanOrEqual(1000);
      expect(crop.y + crop.height).toBeGreaterThanOrEqual(1100);
      const doc = parseTableDoc(decodeUtf8(await files.readUri(item.tableDoc!.uri)))!;
      const image = doc.pages[0]!.blocks.find((b) => b.kind === 'image')!;
      expect(image.kind === 'image' && image.src?.startsWith('runs/')).toBe(true);
      expect(doc.version).toBe(3);
    });

    it('still converts without the layout model or when it fails: no pictures', async () => {
      for (const mode of ['missing', 'not installed', 'fails'] as const) {
        const { files, vision, run } = setup([pick, excel()]);
        if (mode !== 'missing') vision.enableLayout();
        if (mode === 'fails') vision.layoutFails = true;
        files.nextPhotos = [files.offerImage('a.jpg', 2000, 1400)];
        onePage(vision);
        const item = resultItem(await run());
        const zip = unzipSync(await files.readUri(item.uri));
        expect(Object.keys(zip).some((n) => n.includes('media') || n.includes('drawing'))).toBe(
          false,
        );
        expect(strFromU8(zip['xl/sharedStrings.xml']!)).toContain('<t>列1</t>');
      }
    });

    it('keeps the picture block but writes no picture when the crop fails', async () => {
      const { files, vision, run } = setup([pick, excel()]);
      vision.enableLayout();
      vision.layoutRegions = [[figure]];
      files.nextPhotos = [files.offerImage('a.jpg', 2000, 1400)];
      onePage(vision);
      jest.spyOn(files, 'transformImage').mockRejectedValue(new Error('no memory'));
      const item = resultItem(await run());
      const zip = unzipSync(await files.readUri(item.uri));
      expect(Object.keys(zip).some((n) => n.includes('media'))).toBe(false);
      const doc = parseTableDoc(decodeUtf8(await files.readUri(item.tableDoc!.uri)))!;
      expect(doc.pages[0]!.blocks.some((b) => b.kind === 'image')).toBe(true);
    });
  });

  it('fails with “nothing found” when no page has any text', async () => {
    const { files, run } = setup([pick, excel()]);
    files.nextPhotos = [files.offerImage('blank.jpg', 1000, 700)];
    expect(await run()).toMatchObject({ status: 'failed', error: { code: 'notFound' } });
  });
});
