import {
  applyOps,
  BUILTIN_TOOLS,
  createDefaultWorkspace,
  createRegistry,
  quickActionsOf,
  type RunResult,
  type Workflow,
} from '@morph/core';
import { PDFDocument, PDFName } from 'pdf-lib';
import { stampText } from '@morph/tool-pdf';

import type { PackPageId, PackRuntime } from '../packs/bridge';
import type { LocalKind, LocalUi } from '../runtime/local';
import { startRun } from '../runtime/runner';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, FakeVision, TINY_JPEG, makePdf, makePng } from '../test-utils/fake-files';

// PDF actions requiring PDF preview pack or local interface: convert to images, extract text, sign,
// fill forms. Extension pack page (WebView + pdf.js) replaced with fakes: rendering returns a real
// small JPEG, text returns page by page.

const registry = createRegistry(BUILTIN_TOOLS);

function toolWorkflow(id: string): Workflow {
  const result = applyOps(
    createDefaultWorkspace('en'),
    [{ op: 'setPackage', package: 'pdf', do: 'add' }],
    {
      registry,
      locale: 'en',
    },
  );
  if (!result.ok) throw new Error(result.error);
  return quickActionsOf(result.config).find((w) => w.id === id)!;
}

/** Fake extension pack page: records each call and the files permitted for page reading. */
class FakePacks implements PackRuntime {
  calls: { page: PackPageId; method: string; args: Record<string, unknown>; files: string[] }[] =
    [];
  pageCount = 3;
  paper: { width: number; height: number } | null = null;
  text: string[] = ['Hello', 'World', ''];
  async call<T>(
    page: PackPageId,
    method: string,
    args: Record<string, unknown>,
    files: Record<string, string> = {},
  ): Promise<T> {
    this.calls.push({ page, method, args, files: Object.values(files) });
    if (method === 'render') {
      const data = btoa(String.fromCharCode(...TINY_JPEG));
      const all = Array.from({ length: this.pageCount }, (_, index) => index);
      const wanted = (args.pages as number[] | undefined) ?? all;
      return wanted.map((index) => ({
        index,
        width: 60,
        height: 40,
        data,
        ...(this.paper ? { paper: this.paper } : {}),
      })) as T;
    }
    if (method === 'text') return { pages: this.text } as T;
    throw new Error(`unknown method ${method}`);
  }
}

let ids = 0;
function setup(
  workflow: Workflow,
  local: Partial<Record<LocalKind, unknown>> = {},
  installed = true,
) {
  const files = new FakeFiles();
  const packs = new FakePacks();
  const opened: { kind: LocalKind; input: unknown }[] = [];
  const asked: string[] = [];
  const ui: LocalUi = {
    confirm: async () => false,
    choose: async () => null,
    open: async (kind, input) => {
      opened.push({ kind, input });
      return (local[kind] ?? null) as never;
    },
  };
  const run = async (): Promise<RunResult> =>
    (
      await startRun({
        workflow,
        revisionId: 1,
        repo: new MemoryWorkspaceRepo(),
        files,
        registry,
        locale: 'en',
        now: () => new Date(2026, 9, 22),
        newId: () => `id${++ids}`,
        ui,
        packs: { runtime: packs, isInstalled: async () => installed },
        ensurePack: async (id) => {
          asked.push(id);
          return installed;
        },
        askParams: async (request) => request.params,
      })
    ).result;
  return { files, packs, run, opened, asked };
}

async function onlyPdf(files: FakeFiles, result: RunResult) {
  if (result.status !== 'succeeded' || result.value?.type !== 'pdf') {
    throw new Error(`no pdf: ${JSON.stringify(result)}`);
  }
  return PDFDocument.load(files.disk.get(result.value.items[0]!.uri)!);
}

async function makeForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('full_name').addToPage(page, { x: 20, y: 300, width: 200, height: 24 });
  form.createCheckBox('agree').addToPage(page, { x: 20, y: 250, width: 16, height: 16 });
  const dd = form.createDropdown('country');
  dd.addOptions(['France', 'Japan']);
  dd.addToPage(page, { x: 20, y: 200, width: 120, height: 24 });
  return doc.save();
}

const hasImage = (doc: PDFDocument, index: number) =>
  Boolean(doc.getPage(index).node.Resources()?.lookup(PDFName.of('XObject')));

describe('PDF actions that need the preview pack or a local screen', () => {
  it('keeps the physical PDF paper size tied to each rendered image', async () => {
    const { files, packs, run } = setup(toolWorkflow('pdf-toimages'));
    packs.paper = { width: 600, height: 255 };
    files.nextPick = [files.offer('ticket.pdf', await makePdf(3))];
    const result = await run();
    if (result.status !== 'succeeded' || result.value?.type !== 'images') throw new Error();
    for (const image of result.value.items)
      expect(image.pageSize).toEqual({ for: image.uri, width: 600, height: 255 });
  });

  it('turns every page into a JPG through the pack page, passing only the chosen file', async () => {
    const { files, packs, run, asked } = setup(toolWorkflow('pdf-toimages'));
    const picked = files.offer('report.pdf', await makePdf(3));
    files.nextPick = [picked];
    const result = await run();
    expect(asked).toEqual(['pdfview']);
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded' || result.value?.type !== 'images') throw new Error();
    expect(result.value.items.map((i) => i.name)).toEqual(['report-1', 'report-2', 'report-3']);
    expect(result.value.items[0]).toMatchObject({ ext: 'jpg', width: 60, height: 40 });
    for (const [index, image] of result.value.items.entries())
      expect(image.pdfSource).toEqual({
        for: image.uri,
        uri: packs.calls[0]!.files[0],
        page: index,
      });
    expect(files.disk.get(result.value.items[0]!.uri)).toEqual(TINY_JPEG);
    expect(packs.calls).toHaveLength(1);
    expect(packs.calls[0]).toMatchObject({ page: 'pdfview', method: 'render' });
    expect(packs.calls[0]!.args).toMatchObject({ file: 'input', maxSide: 2000 });
    // Page receives only this single file (copied into the temporary files for this run), and no others.
    expect(packs.calls[0]!.files).toHaveLength(1);
  });

  it('cancels when the user declines the pack download', async () => {
    const { files, packs, run } = setup(toolWorkflow('pdf-toimages'), {}, false);
    files.nextPick = [files.offer('report.pdf', await makePdf(1))];
    expect((await run()).status).toBe('cancelled');
    expect(packs.calls).toEqual([]);
  });

  it('extracts text that stays on the device, and says so when a scan has none', async () => {
    const ok = setup(toolWorkflow('pdf-text'));
    ok.files.nextPick = [ok.files.offer('letter.pdf', await makePdf(3))];
    expect(await ok.run()).toMatchObject({
      status: 'succeeded',
      value: { type: 'text', text: 'Hello\n\nWorld', name: 'letter' },
    });

    // Scanned documents cannot have text read when OCR is unavailable (Expo Go).
    const scan = setup(toolWorkflow('pdf-text'));
    scan.packs.text = ['', ' '];
    scan.files.nextPick = [scan.files.offer('scan.pdf', await makePdf(2))];
    expect(await scan.run()).toMatchObject({
      status: 'failed',
      error: { code: 'notFound', detail: { name: 'scan.pdf' } },
    });
  });

  it('reads the pages that have no text layer (scans) with text recognition', async () => {
    // Founder 2026-10-31: Image-based PDF text extraction was expected to use OCR, but did not.
    const { files, packs, run } = setup(toolWorkflow('pdf-text'));
    const vision = new FakeVision(files);
    files.vision = vision;
    vision.texts = ['Scanned one', 'Scanned two'];
    packs.text = ['', 'Typed', ' '];
    files.nextPick = [files.offer('mixed.pdf', await makePdf(3))];
    expect(await run()).toMatchObject({
      status: 'succeeded',
      value: { type: 'text', text: 'Scanned one\n\nTyped\n\nScanned two', name: 'mixed' },
    });
    // Only draw the pages without text.
    expect(packs.calls.find((c) => c.method === 'render')!.args).toMatchObject({ pages: [0, 2] });
    expect(vision.calls.filter((c) => c.method === 'recognizeText')).toHaveLength(2);
  });

  it('signs: shows page previews, then stamps the PNG on the chosen page', async () => {
    const { files, packs, run, opened } = setup(toolWorkflow('pdf-sign'), {
      sign: { png: makePng(30, 10), pageIndex: 1, x: 0.6, y: 0.8, width: 0.3 },
    });
    packs.pageCount = 2;
    files.nextPick = [files.offer('contract.pdf', await makePdf(2))];
    const doc = await onlyPdf(files, await run());
    expect(opened[0]!.kind).toBe('sign');
    expect((opened[0]!.input as { pages: unknown[] }).pages).toHaveLength(2);
    expect(doc.getPageCount()).toBe(2);
    expect(hasImage(doc, 1)).toBe(true);
    expect(hasImage(doc, 0)).toBe(false);
  });

  it('annotates: shows the pages, then lays a transparent layer only on pages that got marks', async () => {
    const mine: Workflow = {
      kind: 'quickAction',
      id: 'mine',
      name: 'Mine',
      steps: [
        { id: 'pick', action: 'in.files', params: { accept: 'pdf', min: 1, max: 1 } },
        { id: 'mark', action: 'pdf.annotate', params: { start: 'pen' } },
      ],
    };
    const { files, packs, run, opened } = setup(mine, {
      annotate: [
        [],
        [
          {
            kind: 'highlight',
            points: [
              { x: 5, y: 5 },
              { x: 40, y: 5 },
            ],
            width: 4,
            color: '#FACC15',
          },
        ],
      ],
    });
    packs.pageCount = 2;
    files.nextPick = [files.offer('contract.pdf', await makePdf(2))];
    const doc = await onlyPdf(files, await run());
    expect(opened[0]!.kind).toBe('annotate');
    expect((opened[0]!.input as { items: unknown[] }).items).toHaveLength(2);
    expect(doc.getPageCount()).toBe(2);
    expect(hasImage(doc, 1)).toBe(true);
    expect(hasImage(doc, 0)).toBe(false);
    // The drawn layer is the same size as the preview page, and paths are drawn as-is (highlighter translucent colors are preserved in annotations).
    expect(files.composed).toHaveLength(1);
    expect(files.composed[0]!.canvas).toMatchObject({ width: 60, height: 40 });
    expect(files.composed[0]!.ops).toEqual([expect.objectContaining({ kind: 'path' })]);
  });

  it('annotates: a page with erase or mosaic becomes a picture, so the hidden text is really gone', async () => {
    const mine: Workflow = {
      kind: 'quickAction',
      id: 'mine',
      name: 'Mine',
      steps: [
        { id: 'pick', action: 'in.files', params: { accept: 'pdf', min: 1, max: 1 } },
        { id: 'mark', action: 'pdf.annotate', params: { start: 'erase' } },
      ],
    };
    const { files, packs, run, opened } = setup(mine, {
      annotate: [
        [
          {
            kind: 'erase',
            points: [
              { x: 5, y: 5 },
              { x: 30, y: 20 },
            ],
            width: 2,
            color: '#FFFFFF',
          },
          {
            kind: 'mosaic',
            points: [
              { x: 30, y: 20 },
              { x: 55, y: 35 },
            ],
            width: 2,
            color: '#808080',
          },
        ],
        [],
      ],
    });
    packs.pageCount = 2;
    const pdf = await makePdf(2);
    const marked = await stampText(pdf, {
      text: 'SECRET',
      position: 'center',
      fontSize: 20,
      color: '#000000',
      opacity: 1,
    });
    files.nextPick = [files.offer('contract.pdf', marked)];
    const out = await run();
    const doc = await onlyPdf(files, out);
    expect(opened[0]!.input).toMatchObject({ tool: 'erase' });
    expect(doc.getPageCount()).toBe(2);
    expect(hasImage(doc, 0)).toBe(true);
    // The first page is replaced with an image; the page's original text is gone, the second page has no annotations and remains unchanged.
    const value = (out as { value?: { items: { uri: string }[] } }).value!;
    const raw = Buffer.from(files.disk.get(value.items[0]!.uri)!).toString('latin1');
    expect(raw).not.toContain('SECRET');
    // Erasure is painting white, redaction takes the average color of the original image per grid cell: drawn as several color blocks.
    const rects = files.composed.at(-1)!.ops.filter((op) => op.kind === 'rect');
    expect(rects.length).toBeGreaterThan(1);
    expect(rects[0]).toMatchObject({ color: '#FFFFFF' });
    // Larger page image re-rendered (only rendering the page with erasures or redactions).
    expect(packs.calls.filter((c) => c.method === 'render').at(-1)!.args).toMatchObject({
      pages: [0],
      maxSide: 2400,
    });
  });

  it('cancels signing when the user closes the signature screen', async () => {
    const { files, run } = setup(toolWorkflow('pdf-sign'));
    files.nextPick = [files.offer('contract.pdf', await makePdf(1))];
    expect((await run()).status).toBe('cancelled');
  });

  it('fills in form fields from the local screen and flattens them', async () => {
    const { files, run, opened } = setup(toolWorkflow('pdf-fill'), {
      fillForm: { full_name: 'Ada Lovelace', agree: true, country: 'Japan' },
    });
    files.nextPick = [files.offer('form.pdf', await makeForm())];
    const doc = await onlyPdf(files, await run());
    const fields = (opened[0]!.input as { fields: { name: string; type: string }[] }).fields;
    expect(fields.map((f) => [f.name, f.type])).toEqual([
      ['full_name', 'text'],
      ['agree', 'checkbox'],
      ['country', 'dropdown'],
    ]);
    // After flattening, form fields are gone, and content is drawn into the page.
    expect(doc.getForm().getFields()).toHaveLength(0);
  });

  it('keeps the form editable without flattening, and rejects PDFs without fields', async () => {
    const keep = setup(
      {
        kind: 'quickAction',
        id: 'mine',
        name: 'Mine',
        steps: [
          { id: 'pick', action: 'in.files', params: { accept: 'pdf', min: 1, max: 1 } },
          { id: 'fill', action: 'pdf.fillForm', params: { flatten: false } },
        ],
      },
      { fillForm: { full_name: 'Ada' } },
    );
    keep.files.nextPick = [keep.files.offer('form.pdf', await makeForm())];
    const doc = await onlyPdf(keep.files, await keep.run());
    expect(doc.getForm().getTextField('full_name').getText()).toBe('Ada');
    expect(doc.getForm().getCheckBox('agree').isChecked()).toBe(false);

    const plain = setup(toolWorkflow('pdf-fill'));
    plain.files.nextPick = [plain.files.offer('plain.pdf', await makePdf(1))];
    expect(await plain.run()).toMatchObject({
      status: 'failed',
      error: { code: 'noFormFields', detail: { name: 'plain.pdf' } },
    });

    const cjk = setup(toolWorkflow('pdf-fill'), { fillForm: { full_name: '张三' } });
    cjk.files.nextPick = [cjk.files.offer('form.pdf', await makeForm())];
    expect(await cjk.run()).toMatchObject({
      status: 'failed',
      error: { code: 'unsupportedText' },
    });
  });
});
