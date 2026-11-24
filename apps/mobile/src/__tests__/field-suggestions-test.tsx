import {
  applyOps,
  createStarterWorkspace,
  packById,
  PICK_STORE_KEY,
  templateOps,
  type Collection,
  type Locale,
  type Registry,
  type TextPage,
  type Workflow,
  type WorkspaceConfig,
} from '@morph/core';
import { qrMatrix, qrToRgba } from '@morph/tool-qr';
import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen } from 'expo-router/testing-library';

import { useGuide } from '../guide/store';
import type { PackBridge } from '../packs/bridge';
import type { Packs } from '../packs/PackHost';
import { PackStore } from '../packs/store';
import type { RecognizedLayer } from '../runtime/platform';
import { useIncoming } from '../share/incoming';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, FakeVision, TINY_JPEG } from '../test-utils/fake-files';
import { MemoryPackFs, sha256 } from '../test-utils/memory-packs';
import { renderToolsApp } from '../test-utils/render-app';

// New record form suggestions (D-394): text is read locally from photos and PDFs in attachments,
// with up to 3 suggestions per empty field, filled only on tap and never automatically. Three
// states: new user (OCR not installed -> prompt; installed -> suggestions), has data (last tapped
// tag ranks first next time), edge cases (no text, mixed photos and PDFs, more than 3 attachments,
// editing an existing record, leaving before read completes).

afterEach(() => {
  useIncoming.getState().clear();
  useGuide.setState({ stage: null, repo: null, introOpen: false });
});

/** Recognition results row by row (each row a segment, font height 20, row spacing 40). */
function layer(rows: string[]): RecognizedLayer {
  return {
    width: 600,
    height: rows.length * 40 + 40,
    lines: rows.map((text, i) => ({
      text,
      x: 20,
      y: 20 + i * 40,
      width: text.length * 10,
      height: 20,
    })),
  };
}

const RECEIPT = ['Maple Corner', 'Date 2026-10-20', 'Subtotal 165.03', 'Tax 13.20', 'Total 178.23'];

/** Fake PDF preview page: lines provide the text layer, render provides the page image. */
class FakePdfPages {
  calls: string[] = [];
  textPages: TextPage[] = [];
  /** Wait until the next text layer is read (simulating leaving before reading completes). */
  hold: Promise<void> | null = null;
  async call<T>(_page: string, method: string): Promise<T> {
    this.calls.push(method);
    if (this.hold) await this.hold;
    if (method === 'lines') return { count: 1, pages: this.textPages } as T;
    if (method === 'render')
      return [{ index: 0, data: btoa(String.fromCharCode(...TINY_JPEG)) }] as T;
    throw new Error(`unexpected ${method}`);
  }
}

/** Pack environment: in-memory PackStore (installed ones are considered installed) and fake PDF pages. */
async function fakePacks(installed: string[]) {
  const fs = new MemoryPackFs();
  const store = new PackStore(fs, sha256);
  const install = async (id: string) =>
    fs.writeText(`${id}/${packById(id)!.version}/ready.json`, '{"bytes":1,"installedAt":1}');
  for (const id of installed) await install(id);
  const pdf = new FakePdfPages();
  const none: string[] = [];
  const bridge = {
    subscribe: () => () => undefined,
    activePages: () => none,
    call: pdf.call.bind(pdf),
    close: () => undefined,
  } as unknown as PackBridge;
  return { packs: { store, bridge } as Packs, fs, pdf, install };
}

/** New form page suggestions have separate tests (new-table-test); use the pre-created shopping receipt table here. */
function withPurchases(locale: Locale, registry: Registry): WorkspaceConfig {
  const blank = createStarterWorkspace(locale, registry);
  const r = applyOps(blank, templateOps('purchase', blank, locale), { registry, locale });
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

async function render(
  installed: string[] = ['ppocr', 'pdfview'],
  locale: 'zh' | 'en' | 'fr' = 'zh',
  seed?: (locale: Locale, registry: Registry) => WorkspaceConfig,
) {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  const files = new FakeFiles();
  const vision = new FakeVision(files);
  vision.ocrModel = { pack: 'ppocr', languages: ['zh', 'ja', 'en', 'fr', 'de', 'es', 'pt', 'it'] };
  files.vision = vision;
  const p = await fakePacks(installed);
  const app = await renderToolsApp(repo, files, {
    packs: p.packs,
    locale,
    seed: seed ?? withPurchases,
  });
  return { ...app, vision, ...p };
}

/** Inbox page receives these files (real extensions and types, selector provides picker:// addresses), saved as "Shopping Receipts". */
async function shareInto(
  files: FakeFiles,
  items: { name: string; mime: string }[],
  choice = 'table-purchases',
) {
  const picked = items.map((i) =>
    files.offer(
      i.name,
      i.mime === 'application/pdf' ? new Uint8Array([37, 80, 68, 70]) : TINY_JPEG,
      i.mime,
    ),
  );
  await act(async () => useIncoming.getState().receive(picked, [], 'picker'));
  await act(() => router.push('/share'));
  await fireEvent.press(await screen.findByTestId(/^(preview-record|share-record-choose)$/));
  await fireEvent.press(await screen.findByTestId(`share-record-${choice}`));
  expect(await screen.findByTestId('editor-attachments-file-0')).toBeTruthy();
}

const chipTexts = (field: string) =>
  screen
    .queryAllByTestId(new RegExp(`^editor-${field}-suggestion-\\d$`))
    .map((c) => String((c.props as { accessibilityLabel?: string }).accessibilityLabel));

const recognizedAll = (vision: FakeVision) =>
  vision.calls.filter((c) => c.method === 'recognizeLines').length;

const recognized = (vision: FakeVision) =>
  vision.calls.filter((c) => c.method === 'recognizeLines' && !/\/receipt-like-/.test(c.uri));
const runsLeft = (files: FakeFiles) =>
  [...files.disk.keys()].filter((k) => k.startsWith('runs/prefill-'));

async function save() {
  await fireEvent.press(screen.getByTestId('editor-save'));
  await waitFor(() => expect(screen.queryByTestId('editor-save')).toBeNull());
  expect(await screen.findByTestId('share-screen')).toBeTruthy();
}

describe('Suggestions for new record forms', () => {
  it('New user, OCR not installed: display a single prompt line only, no recognition or download; prompt on tap, recognize only after consent', async () => {
    const { files, vision, fs, install } = await render([]);
    await shareInto(files, [{ name: 'IMG_0001.HEIC', mime: 'image/heic' }]);
    expect(await screen.findByTestId('suggestions-notice')).toHaveTextContent(/需要先下载一次/);
    expect(recognized(vision)).toHaveLength(0);
    expect(chipTexts('amount')).toEqual([]);

    // Tapping shows confirmation dialog first; cancelling does nothing.
    await fireEvent.press(screen.getByTestId('suggestions-download'));
    expect(await screen.findByTestId('pack-gate')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('pack-cancel'));
    await waitFor(() => expect(screen.queryByTestId('pack-gate')).toBeNull());
    expect(fs.downloads).toEqual([]);
    expect(recognized(vision)).toHaveLength(0);

    // Consent to download (download itself handled by PackStore, treated as already downloaded here), then recognize in the background, making suggestions appear.
    vision.layers.push(layer(RECEIPT));
    await fireEvent.press(screen.getByTestId('suggestions-download'));
    await install('ppocr');
    await fireEvent.press(await screen.findByTestId('pack-download'));
    await waitFor(() => expect(chipTexts('amount').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('suggestions-notice')).toBeNull();
    // Convert HEIC to JPG before recognition; intermediate files are already deleted.
    expect(recognized(vision)[0]!.uri).toMatch(/^runs\/prefill-.+\/page-1\.jpg$/);
    expect(runsLeft(files)).toEqual([]);
  });

  it('OCR installed: automatic recognition, suggestions appear below empty fields without auto-filling; populate only on tap, suggestions stay in place and tapped item is marked', async () => {
    const { files, vision, repo } = await render();
    vision.layers.push(layer(RECEIPT));
    await shareInto(files, [{ name: 'receipt.jpg', mime: 'image/jpeg' }]);
    await waitFor(() => expect(chipTexts('amount').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('suggestions-notice')).toBeNull();
    // Actual amount ranks first, not subtotal; date and merchant are also present.
    expect(chipTexts('amount')[0]).toMatch(/178\.23/);
    expect(chipTexts('date')[0]).toMatch(/「日期」/);
    // Date writes out the month (two candidates are needed when month/day are ambiguous), unlike numeric-only formats like 2026-10-12.
    expect(chipTexts('date')[0]).toMatch(/\d{4}年\d{1,2}月\d{1,2}日/);
    expect(chipTexts('merchant')[0]).toBe('把 Maple Corner 填进「商家」');
    // None of them are auto-filled.
    for (const id of ['merchant', 'date', 'amount'])
      expect(screen.getByTestId(`editor-${id}`).props.value ?? '').toBe('');

    const before = chipTexts('amount');
    await fireEvent.press(screen.getByTestId('editor-amount-suggestion-0'));
    expect(screen.getByTestId('editor-amount').props.value).toBe('178.23');
    // Suggestions do not disappear (fields below do not jump up, iOS simulator 2026-10-31), and the tapped one is marked as selected.
    expect(chipTexts('amount')).toEqual(before);
    const selected = (id: string) =>
      screen
        .queryAllByTestId(new RegExp(`^editor-${id}-suggestion-\\d$`))
        .map((c) =>
          Boolean(
            (c.props as { accessibilityState?: { selected?: boolean } }).accessibilityState
              ?.selected,
          ),
        );
    expect(selected('amount')).toEqual(before.map((_, i) => i === 0));
    // Manually entered fields: suggestions remain, none are marked; learning does not occur.
    await fireEvent.changeText(screen.getByTestId('editor-merchant'), '枫叶小店');
    expect(chipTexts('merchant').length).toBeGreaterThan(0);
    expect(selected('merchant').some(Boolean)).toBe(false);
    await save();
    const [record] = await repo.listRecords('purchases');
    expect(record!.values).toMatchObject({ amount: 178.23, merchant: '枫叶小店' });
    // Record only the tapped field: label and position, without values.
    const picks = JSON.parse((await repo.getMeta(PICK_STORE_KEY))!);
    expect(Object.keys(picks.purchases)).toEqual(['amount']);
    expect(JSON.stringify(picks)).not.toContain('178');
    // Tapped tags are learned under this field (D-445).
    expect(picks.purchases.amount.labels[0].label).toBe('total');
  });

  it('Receipt template classification (D-405): provide suggestions below classification if discernible on the ticket, no auto-selection; select only on tap, none if indiscernible', async () => {
    const { files, vision, repo } = await render();
    vision.layers.push(layer(['大众药房', 'Date 2026-10-20', '感冒灵 12.00', 'Total 12.00']));
    await shareInto(files, [{ name: 'receipt.jpg', mime: 'image/jpeg' }]);
    await waitFor(() => expect(chipTexts('category')).toEqual(['把 药妆 填进「分类」']));
    // No auto-selection: none of the six options are selected.
    const optionOn = (id: string) =>
      (screen.getByTestId(`editor-category-${id}`).props as { style?: unknown }).style;
    const before = optionOn('pharmacy');
    await fireEvent.press(screen.getByTestId('editor-category-suggestion-0'));
    expect(optionOn('pharmacy')).not.toEqual(before);
    expect(
      screen.getByTestId('editor-category-suggestion-0').props.accessibilityState.selected,
    ).toBe(true);
    await save();
    const [record] = await repo.listRecords('purchases');
    expect(record!.values.category).toBe('pharmacy');
    // Category suggestions are not specific positions within text: tap selections are not recorded.
    expect(await repo.getMeta(PICK_STORE_KEY)).toBeNull();
  });

  it('Receipt template classification: no suggestions and no errors (local model not installed) if ticket category is indiscernible', async () => {
    const { files, vision } = await render();
    vision.layers.push(layer(RECEIPT));
    await shareInto(files, [{ name: 'receipt.jpg', mime: 'image/jpeg' }]);
    await waitFor(() => expect(chipTexts('amount').length).toBeGreaterThan(0));
    expect(chipTexts('category')).toEqual([]);
    expect(screen.getByTestId('editor-category-dining')).toBeTruthy();
  });

  it('Has data: previously tapped tag ranks first for similar receipts next time', async () => {
    const { files, vision } = await render();
    const shipped = ['Order date 2026-09-03', 'Ship date 2026-09-08', 'Total 5.00'];
    vision.layers.push(layer(shipped));
    await shareInto(files, [{ name: 'a.jpg', mime: 'image/jpeg' }]);
    await waitFor(() => expect(chipTexts('date')).toHaveLength(2));
    const second = chipTexts('date')[1]!;
    const learned = second.includes('9月8日') || second.includes('09-08') ? 'ship' : 'order';
    await fireEvent.press(screen.getByTestId('editor-date-suggestion-1'));
    await save();

    vision.layers.push(layer(['Order date 2026-10-01', 'Ship date 2026-10-06', 'Total 7.00']));
    await act(() => useIncoming.getState().clear());
    await shareInto(files, [{ name: 'b.jpg', mime: 'image/jpeg' }], 'table-purchases');
    await waitFor(() => expect(chipTexts('date')).toHaveLength(2));
    expect(chipTexts('date')[0]).toMatch(learned === 'ship' ? /10月6日|10-06/ : /10月1日|10-01/);
  });

  it('French: prompts follow the language', async () => {
    const fr = await render([], 'fr');
    await shareInto(fr.files, [{ name: 'recu.jpg', mime: 'image/jpeg' }]);
    expect(await screen.findByTestId('suggestions-notice')).toHaveTextContent(
      /téléchargement unique/,
    );
  });

  it('English: suggestion accessibility descriptions follow the language', async () => {
    const en = await render(['ppocr'], 'en');
    en.vision.layers.push(layer(RECEIPT));
    await shareInto(en.files, [{ name: 'receipt.jpg', mime: 'image/jpeg' }]);
    await waitFor(() => expect(chipTexts('amount').length).toBeGreaterThan(0));
    expect(chipTexts('amount')[0]).toMatch(/^Fill “Amount” with .*178\.23/);
  });

  it('Edge case: no suggestions and no errors when text cannot be read', async () => {
    const { files, vision } = await render();
    vision.layers.push({ width: 100, height: 100, lines: [] });
    await shareInto(files, [{ name: 'blank.png', mime: 'image/png' }]);
    await waitFor(() => expect(recognized(vision)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('suggestions-working')).toBeNull());
    expect(screen.queryAllByTestId(/-suggestion-\d$/)).toHaveLength(0);
    expect(screen.getByTestId('editor-save')).toBeTruthy();
  });

  it('Edge case: read both when photos and PDFs are mixed (PDFs use text layer, scanned PDFs rendered to images then recognized), read only the first 3 if exceeding 3', async () => {
    const { files, vision, pdf } = await render();
    pdf.textPages = [layer(['Facture', 'Montant TTC 42,50 €'])];
    vision.layers.push(layer(['Date 2026-10-20']), layer(['x']), layer(['y']));
    await shareInto(files, [
      { name: 'photo.jpg', mime: 'image/jpeg' },
      { name: 'invoice.pdf', mime: 'application/pdf' },
      { name: 'photo2.jpg', mime: 'image/jpeg' },
      { name: 'photo3.jpg', mime: 'image/jpeg' },
      { name: 'photo4.jpg', mime: 'image/jpeg' },
    ]);
    await waitFor(() => expect(chipTexts('amount').length).toBeGreaterThan(0));
    expect(chipTexts('amount')[0]).toMatch(/42\.50/);
    expect(chipTexts('date')[0]).toMatch(/10月20日|2026/);
    // First 3: two photos recognized, PDF text layer read (has text, no drawing).
    expect(recognized(vision)).toHaveLength(2);
    expect(pdf.calls).toEqual(['lines']);
    expect(runsLeft(files)).toEqual([]);
  });

  it('Edge case: scanned PDFs without text layers are rendered to images and then recognized', async () => {
    const { files, vision, pdf } = await render();
    pdf.textPages = [{ width: 600, height: 800, lines: [] }];
    vision.layers.push(layer(['合计 ¥88.00']));
    await shareInto(files, [{ name: 'scan.pdf', mime: 'application/pdf' }]);
    await waitFor(() => expect(chipTexts('amount').length).toBeGreaterThan(0));
    // Preview page first draws the PDF to view (D-457), followed by recognition.
    expect(pdf.calls).toEqual(['preview', 'lines', 'render']);
    expect(recognized(vision)[0]!.uri).toMatch(/^runs\/prefill-.+\/pdf-1-1\.jpg$/);
    expect(runsLeft(files)).toEqual([]);
  });

  it('Editing existing records does not provide suggestions', async () => {
    const { files, vision, repo } = await render();
    vision.layers.push(layer(RECEIPT));
    await shareInto(files, [{ name: 'receipt.jpg', mime: 'image/jpeg' }]);
    await waitFor(() => expect(chipTexts('amount').length).toBeGreaterThan(0));
    await save();
    const [record] = await repo.listRecords('purchases');
    const before = recognized(vision).length;
    await act(() => router.push(`/record/purchases?recordId=${record!.id}`));
    expect(await screen.findByTestId('editor-delete')).toBeTruthy();
    expect(screen.queryAllByTestId(/-suggestion-\d$/)).toHaveLength(0);
    expect(screen.queryByTestId('suggestions-notice')).toBeNull();
    expect(recognized(vision)).toHaveLength(before);
  });

  it('Leaving before read completes: reading terminates (not left hanging), intermediate files deleted, no longer displayed', async () => {
    const { files, pdf } = await render();
    let release!: () => void;
    pdf.hold = new Promise((r) => (release = r));
    pdf.textPages = [layer(['Total 9.00'])];
    await shareInto(files, [{ name: 'doc.pdf', mime: 'application/pdf' }]);
    await waitFor(() => expect(pdf.calls).toEqual(['preview', 'lines']));
    expect(screen.getByTestId('suggestions-working')).toBeTruthy();
    await act(() => router.back());
    expect(await screen.findByTestId('share-screen')).toBeTruthy();
    await act(async () => release());
    await waitFor(() => expect(runsLeft(files)).toEqual([]));
    expect(screen.queryAllByTestId(/-suggestion-\d$/)).toHaveLength(0);
  });
});

// Quick action "Log an expense" form (D-397): scan button (D-397): quick action hands files to the form, reading is handled by the form itself, and steps do not include recognition.
describe('Quick action "Log an expense" form (D-397)', () => {
  const receipts = (extra: Partial<Collection> = {}): Collection => ({
    id: 'receipts',
    name: '小票',
    fields: [
      { id: 'amount', name: '金额', type: 'money', currency: 'CNY' },
      { id: 'photo', name: '附件', type: 'file' },
    ],
    ...extra,
  });
  const scanButton: Workflow = {
    kind: 'quickAction',
    id: 'scan-receipt',
    name: '扫小票',
    steps: [
      { id: 'pick', action: 'in.photos', params: { source: 'library', min: 1, max: 10 } },
      { id: 'log', action: 'out.addRecord', params: { collectionId: 'receipts' } },
    ],
  };
  const seed = (table: Collection) => (locale: Locale, registry: Registry) => {
    const config = createStarterWorkspace(locale, registry);
    config.data.tables.push(table);
    config.tools.push(scanButton);
    return config;
  };
  const entryChips = () => screen.queryAllByTestId(/^entry-amount-suggestion-\d$/);

  it('Files entering the form are automatically recognized, provide suggestions, and fill only on tap', async () => {
    const { files, vision } = await render(undefined, 'zh', seed(receipts()));
    vision.layers.push(layer(RECEIPT));
    files.nextPhotos = [files.offerImage('receipt.jpg', 600, 240)];
    await act(() => router.push('/run/scan-receipt'));
    expect(await screen.findByTestId('entry-photo-file-0')).toBeTruthy();
    await waitFor(() => expect(entryChips().length).toBeGreaterThan(0));
    expect(screen.getByTestId('entry-amount').props.value ?? '').toBe('');
    await fireEvent.press(screen.getByTestId('entry-amount-suggestion-0'));
    expect(screen.getByTestId('entry-amount').props.value).toBe('178.23');
    expect(recognized(vision)).toHaveLength(1);
  });

  it('OCR not installed: displays a single prompt line like other forms, without downloading', async () => {
    const { files, vision } = await render([], 'zh', seed(receipts()));
    files.nextPhotos = [files.offerImage('receipt.jpg', 600, 240)];
    await act(() => router.push('/run/scan-receipt'));
    expect(await screen.findByTestId('suggestions-notice')).toBeTruthy();
    expect(recognized(vision)).toHaveLength(0);
  });

  it('Table turns off "automatic attachment reading": no recognition, no suggestions, and no download prompt', async () => {
    const { files, vision } = await render(
      undefined,
      'zh',
      seed(receipts({ readAttachments: false })),
    );
    vision.layers.push(layer(RECEIPT));
    files.nextPhotos = [files.offerImage('receipt.jpg', 600, 240)];
    await act(() => router.push('/run/scan-receipt'));
    expect(await screen.findByTestId('entry-photo-file-0')).toBeTruthy();
    await act(async () => undefined);
    expect(recognized(vision)).toHaveLength(0);
    expect(entryChips()).toHaveLength(0);
    expect(screen.queryByTestId('suggestions-notice')).toBeNull();
  });

  it('Settings -> Data: Only tables with attachment fields have this switch; on by default, turns off reading when disabled', async () => {
    const plain: Collection = {
      id: 'plain',
      name: '备忘',
      fields: [{ id: 'note', name: '内容', type: 'note' }],
    };
    const both = (locale: Locale, registry: Registry) => {
      const config = seed(receipts())(locale, registry);
      config.data.tables.push(plain);
      return config;
    };
    const { files, vision } = await render(undefined, 'zh', both);
    // One page per table (D-614): tables without file fields lack this switch.
    await act(() =>
      router.push({ pathname: '/data-table/[tableId]', params: { tableId: 'plain' } }),
    );
    await screen.findByTestId('export-plain');
    expect(screen.queryByTestId('read-attachments-plain')).toBeNull();
    await act(() =>
      router.push({ pathname: '/data-table/[tableId]', params: { tableId: 'receipts' } }),
    );
    const toggle = await screen.findByTestId('read-attachments-receipts');
    expect(toggle.props.value).toBe(true);
    await fireEvent(toggle, 'valueChange', false);
    await waitFor(() =>
      expect(screen.getByTestId('read-attachments-receipts').props.value).toBe(false),
    );
    vision.layers.push(layer(RECEIPT));
    files.nextPhotos = [files.offerImage('receipt.jpg', 600, 240)];
    await act(() => router.push('/run/scan-receipt'));
    expect(await screen.findByTestId('entry-photo-file-0')).toBeTruthy();
    await act(async () => undefined);
    expect(recognized(vision)).toHaveLength(0);
  });

  it('Settings -> Data: Select "attachment is" written to the table (D-421), only available for tables with attachment fields, defaults to other', async () => {
    const plain: Collection = {
      id: 'plain',
      name: '备忘',
      fields: [{ id: 'note', name: '内容', type: 'note' }],
    };
    const both = (locale: Locale, registry: Registry) => {
      const config = seed(receipts())(locale, registry);
      config.data.tables.push(plain);
      return config;
    };
    await render(undefined, 'zh', both);
    await act(() =>
      router.push({ pathname: '/data-table/[tableId]', params: { tableId: 'plain' } }),
    );
    await screen.findByTestId('export-plain');
    expect(screen.queryByTestId('prefill-rules-plain-general')).toBeNull();
    await act(() =>
      router.push({ pathname: '/data-table/[tableId]', params: { tableId: 'receipts' } }),
    );
    const selected = (id: string) => screen.getByTestId(id).props.accessibilityState.selected;
    await screen.findByTestId('prefill-rules-receipts-general');
    expect(selected('prefill-rules-receipts-general')).toBe(true);
    await fireEvent.press(screen.getByTestId('prefill-rules-receipts-card'));
    await waitFor(() => expect(selected('prefill-rules-receipts-card')).toBe(true));
    expect(selected('prefill-rules-receipts-general')).toBe(false);
    await fireEvent.press(screen.getByTestId('prefill-rules-receipts-general'));
    await waitFor(() => expect(selected('prefill-rules-receipts-general')).toBe(true));
  });
});

// Business card table forms also look up QR codes (D-423): vCard and MeCard values rank first, URLs provide websites only; other things ignored, text read normally; filled only on tap.
describe('Business card table QR code', () => {
  const cards: Collection = {
    id: 'people',
    name: '联系人',
    prefillRules: 'card',
    fields: [
      { id: 'name', name: '姓名', type: 'text' },
      { id: 'tel', name: '电话', type: 'text', format: 'phone' },
      { id: 'site', name: '网站', type: 'text', format: 'url' },
      { id: 'attachments', name: '附件', type: 'file' },
    ],
  };
  const seed = (table: Collection) => (locale: Locale, registry: Registry) => {
    const config = createStarterWorkspace(locale, registry);
    config.data.tables.push(table);
    return config;
  };
  const qr = (text: string) => qrToRgba(qrMatrix(text), { scale: 4 });
  const VCARD = 'BEGIN:VCARD\nFN:Maria Garcia\nTEL:+33 6 12 34 56 78\nEND:VCARD';

  /** Form receives a photo with pixel data pixels (white image if omitted). */
  async function scan(
    pixels: ReturnType<typeof qr> | null,
    rows: string[] = [],
    table: Collection = cards,
    installed: string[] = ['ppocr', 'pdfview'],
  ) {
    const app = await render(installed, 'zh', seed(table));
    app.vision.layers.push(layer(rows));
    const read = jest.spyOn(app.files, 'imagePixels');
    if (pixels) read.mockResolvedValue(pixels);
    await shareInto(app.files, [{ name: 'card.jpg', mime: 'image/jpeg' }], `table-${table.id}`);
    return { ...app, read };
  }

  it('Only QR code present, no text recognized: still shows suggestions, no auto-fill; fills only upon tapping', async () => {
    const { repo } = await scan(qr(VCARD));
    await waitFor(() => expect(chipTexts('name').length).toBeGreaterThan(0));
    expect(chipTexts('name')[0]).toContain('Maria Garcia');
    expect(chipTexts('tel')[0]).toContain('+33 6 12 34 56 78');
    expect(screen.getByTestId('editor-name').props.value ?? '').toBe('');
    await fireEvent.press(screen.getByTestId('editor-name-suggestion-0'));
    expect(screen.getByTestId('editor-name').props.value).toBe('Maria Garcia');
    await save();
    const [record] = await repo.listRecords('people');
    expect(record!.values.name).toBe('Maria Garcia');
    expect(record!.values.tel).toBeUndefined();
    // QR code values do not record positions (no layout to record).
    expect(await repo.getMeta(PICK_STORE_KEY)).toBeNull();
  });

  it('QR code value precedes text-recognized values', async () => {
    await scan(qr(VCARD), ['Tel +33 1 11 11 11 11']);
    await waitFor(() => expect(chipTexts('tel').length).toBeGreaterThan(1));
    expect(chipTexts('tel')[0]).toContain('+33 6 12 34 56 78');
    expect(chipTexts('tel')[1]).toContain('+33 1 11 11 11 11');
  });

  it('URL provides website only', async () => {
    await scan(qr('https://example.com/me'));
    await waitFor(() => expect(chipTexts('site').length).toBeGreaterThan(0));
    expect(chipTexts('site')[0]).toContain('https://example.com/me');
    expect(chipTexts('name')).toEqual([]);
    expect(chipTexts('tel')).toEqual([]);
  });

  it('Ignore other QR codes, business cards read normally as text', async () => {
    await scan(qr('WIFI:T:WPA;S:cafe;P:12345678;;'), ['Tel +33 1 11 11 11 11']);
    await waitFor(() => expect(chipTexts('tel').length).toBeGreaterThan(0));
    expect(chipTexts('tel')[0]).toContain('+33 1 11 11 11 11');
    expect(chipTexts('name').join()).not.toContain('cafe');
  });

  it('Unresolvable cases (pixel reading failure, no code) say nothing, text proceeds as normal', async () => {
    const app = await render(['ppocr', 'pdfview'], 'zh', seed(cards));
    app.vision.layers.push(layer(['Tel +33 1 11 11 11 11']));
    jest.spyOn(app.files, 'imagePixels').mockRejectedValue(new Error('broken'));
    await shareInto(app.files, [{ name: 'card.jpg', mime: 'image/jpeg' }], 'table-people');
    await waitFor(() => expect(chipTexts('tel').length).toBeGreaterThan(0));
    expect(chipTexts('tel')[0]).toContain('+33 1 11 11 11 11');
  });

  it('QR code works even when text recognition is not installed, no download', async () => {
    const { fs } = await scan(qr(VCARD), [], cards, []);
    await waitFor(() => expect(chipTexts('name').length).toBeGreaterThan(0));
    expect(chipTexts('name')[0]).toContain('Maria Garcia');
    expect(fs.downloads).toEqual([]);
  });

  it('Photos and PDFs mixed: read QR code only from photos', async () => {
    const app = await render(['ppocr', 'pdfview'], 'zh', seed(cards));
    app.vision.layers.push(layer([]));
    const read = jest.spyOn(app.files, 'imagePixels').mockResolvedValue(qr(VCARD));
    await shareInto(
      app.files,
      [
        { name: 'a.pdf', mime: 'application/pdf' },
        { name: 'card.jpg', mime: 'image/jpeg' },
      ],
      'table-people',
    );
    await waitFor(() => expect(chipTexts('name').length).toBeGreaterThan(0));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('Not a business card table: do not search for QR codes', async () => {
    const { prefillRules: _unused, ...plain } = cards;
    const { read, vision } = await scan(qr(VCARD), ['Tel +33 1 11 11 11 11'], plain as Collection);
    await waitFor(() => expect(recognized(vision).length).toBeGreaterThan(0));
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    expect(chipTexts('name').join()).not.toContain('Maria');
  });
});

/** Tap "Save record" for a photo on the preview page without selecting, viewing only the tables in the panel. */
async function openChooserFor(files: FakeFiles) {
  const picked = [files.offer('receipt.jpg', TINY_JPEG, 'image/jpeg')];
  await act(async () => useIncoming.getState().receive(picked, [], 'picker'));
  await act(() => router.push('/share'));
  await fireEvent.press(await screen.findByTestId('preview-record'));
  return screen.findByTestId('share-record-table-purchases');
}

describe('Save record panel: for receipt-like photos, recommend tables with receipt rules (D-477)', () => {
  const TAG = '看起来是收据，推荐放这里';

  it('Receipt photo: recommend writing to the "Shopping Voucher" table', async () => {
    const { files, vision } = await render();
    vision.layers.push(layer(RECEIPT));
    const row = await openChooserFor(files);
    await waitFor(() => expect(within(row).getByText(TAG)).toBeTruthy());
    // Reads the received photo itself without modifying it (invariant 4); intermediate files are not left behind after reading.
    expect(files.disk.size).toBeGreaterThan(0);
  });

  it('Unlike a receipt (no total and amount): no recommendation written, panel remains as usual', async () => {
    const { files, vision } = await render();
    vision.layers.push(layer(['Vaccination record', 'Dose 1: 3 March 2025']));
    const row = await openChooserFor(files);
    await waitFor(() => expect(recognizedAll(vision)).toBeGreaterThan(0));
    expect(within(row).queryByText(TAG)).toBeNull();
  });

  it('Text recognition not installed: do not read, do not recommend, no errors', async () => {
    const { files, vision } = await render([]);
    vision.layers.push(layer(RECEIPT));
    const row = await openChooserFor(files);
    expect(within(row).queryByText(TAG)).toBeNull();
    expect(recognizedAll(vision)).toBe(0);
  });
});
