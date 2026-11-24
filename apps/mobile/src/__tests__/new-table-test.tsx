import {
  applyOps,
  createDefaultWorkspace,
  packById,
  type Locale,
  type Registry,
  type WorkspaceConfig,
} from '@morph/core';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
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

// Create new form after importing file (D-444): field names in file are tappable, rules provide
// preset sorting, on-device model shows only one recommendation line. Three states: no model (rules
// only), has model (recommendations), edge cases (cannot read text, recommended table already
// exists, tapped value).

const mockAnswer = { current: 'insurance' };
const mockGenerate = jest.fn(async () => mockAnswer.current);
const mockRelease = jest.fn(async () => undefined);
jest.mock('../runtime/local-model', () => ({
  deviceFitsLocalModel: () => true,
  openLocalModel: () => async () => ({ generate: mockGenerate, release: mockRelease }),
}));

afterEach(() => {
  useIncoming.getState().clear();
  useGuide.setState({ stage: null, repo: null, introOpen: false });
  mockGenerate.mockClear();
  mockRelease.mockClear();
  mockAnswer.current = 'insurance';
});

const POLICY: RecognizedLayer = {
  width: 600,
  height: 400,
  lines: [
    { text: 'Policy schedule', x: 20, y: 20, width: 150, height: 20 },
    { text: 'Insurer: Bluecrest Mutual', x: 20, y: 80, width: 250, height: 20 },
    { text: 'Policy number: PL-22817', x: 20, y: 130, width: 230, height: 20 },
    { text: 'Date of', x: 20, y: 180, width: 70, height: 20 },
    { text: 'expiry', x: 20, y: 202, width: 60, height: 20 },
    { text: '02/03/2026', x: 300, y: 202, width: 100, height: 20 },
    { text: 'PL-22817', x: 20, y: 260, width: 80, height: 20 },
  ],
};

const NO_PAGES: string[] = [];

async function setup(
  installed: string[],
  seed?: (locale: Locale, registry: Registry) => WorkspaceConfig,
  layers: RecognizedLayer[] = [POLICY],
) {
  const repo = new MemoryWorkspaceRepo();
  await repo.setMeta('guide', 'done');
  await act(() => useGuide.getState().load(repo));
  const files = new FakeFiles();
  const vision = new FakeVision(files);
  vision.ocrModel = { pack: 'ppocr', languages: ['zh', 'ja', 'en', 'fr', 'de', 'es', 'pt', 'it'] };
  vision.layers = layers;
  files.vision = vision;
  const fs = new MemoryPackFs();
  const store = new PackStore(fs, sha256);
  for (const id of installed)
    await fs.writeText(`${id}/${packById(id)!.version}/ready.json`, '{"bytes":1,"installedAt":1}');
  const bridge = {
    subscribe: () => () => undefined,
    activePages: () => NO_PAGES,
    close: () => undefined,
  } as unknown as PackBridge;
  const app = await renderToolsApp(repo, files, {
    packs: { store, bridge } as Packs,
    locale: 'en',
    ...(seed ? { seed } : {}),
  });
  const picked = files.offer('policy.jpg', TINY_JPEG, 'image/jpeg');
  await act(async () => useIncoming.getState().receive([picked], [], 'picker'));
  await act(() => router.push('/share'));
  await fireEvent.press(await screen.findByTestId(/^(preview-record|share-record-choose)$/));
  await fireEvent.press(await screen.findByTestId('share-record-new'));
  return { ...app, vision };
}

describe('New Form Page', () => {
  it('No model: Field names in the file are clickable, wrapped lines are merged; clicking Add Field populates only when a candidate is clicked', async () => {
    await setup(['ppocr']);
    expect(await screen.findByTestId('new-table-in-file')).toBeTruthy();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('new-table-working')).toBeNull();
    expect(screen.getByText('+ Insurer')).toBeTruthy();
    expect(screen.getByText('+ Policy number')).toBeTruthy();
    expect(screen.getByText('+ Date of expiry')).toBeTruthy();
    expect(screen.queryByText('+ Date of')).toBeNull();
    await fireEvent.press(screen.getByText('+ Policy number'));
    expect(await screen.findByTestId('draft-field-3')).toBeTruthy();
    // Added ones are no longer listed.
    expect(screen.queryByText('+ Policy number')).toBeNull();
    // Do not auto-fill (D-394).
    expect(screen.getByTestId('draft-field-3').props.value).toBe('');
  });

  it('With model: Display only one recommendation row, click to cycle; zero AI requests (invariants 1, 2)', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { store } = await setup(['ppocr', 'prefill-model']);
    expect(await screen.findByTestId('new-table-recommend')).toBeTruthy();
    expect(screen.getByText('This looks like “Insurance policies”')).toBeTruthy();
    expect(mockRelease).toHaveBeenCalled();
    // Not changed yet.
    expect(screen.getByTestId('new-table-name').props.value).toBe('My entries');
    await fireEvent.press(screen.getByTestId('new-table-use'));
    expect(screen.getByTestId('new-table-name').props.value).toBe('Insurance policies');
    expect(screen.queryByTestId('new-table-recommend')).toBeNull();
    expect(store.getState().config!.data.tables).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // R16: Recommendations are derived values of recognized text; if the user selects the type manually while the local model is still thinking, the recommendation must not pop back up when the answer returns.
  it('User selects type while model is still thinking: Recommendation does not appear again after the answer returns', async () => {
    let answer!: (text: string) => void;
    mockGenerate.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    await setup(['ppocr', 'prefill-model']);
    expect(await screen.findByTestId('new-table-working')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('new-table-change-type'));
    await fireEvent.press(screen.getByTestId('new-table-type-blank'));
    await act(async () => answer('insurance'));
    await waitFor(() => expect(screen.queryByTestId('new-table-working')).toBeNull());
    expect(screen.queryByTestId('new-table-recommend')).toBeNull();
    expect(screen.getByTestId('new-table-name').props.value).toBe('My entries');
  });

  // 2026-11-09 user testing: The rule already said "This looks like "Receipts""; after tapping "Use
  // this", it popped up "Download local model to determine what file this is". Once the type is
  // set, this sentence should no longer appear.
  describe('Model not downloaded, available for download', () => {
    beforeEach(() => {
      process.env.EXPO_PUBLIC_MORPH_PACKS_URL = 'https://packs.test';
    });
    afterEach(() => {
      delete process.env.EXPO_PUBLIC_MORPH_PACKS_URL;
    });
    const receipt = () => [
      {
        width: 600,
        height: 300,
        lines: ['Maple Corner', 'Subtotal 165.03', 'Tax 13.20', 'Total 178.23'].map((text, i) => ({
          text,
          x: 20,
          y: 20 + i * 40,
          width: 200,
          height: 20,
        })),
      },
    ];

    it('Propose downloading the model when there is no recommendation', async () => {
      await setup(['ppocr']);
      expect(await screen.findByTestId('new-table-model-need')).toBeTruthy();
    });

    it('Tapped rule-recommended type: Stop proposing model download', async () => {
      await setup(['ppocr'], undefined, receipt());
      expect(await screen.findByTestId('new-table-recommend')).toBeTruthy();
      expect(screen.queryByTestId('new-table-model-need')).toBeNull();
      await fireEvent.press(screen.getByTestId('new-table-use'));
      expect(screen.queryByTestId('new-table-recommend')).toBeNull();
      expect(screen.queryByTestId('new-table-model-need')).toBeNull();
    });

    it('Selected type manually: Stop proposing model download', async () => {
      await setup(['ppocr']);
      expect(await screen.findByTestId('new-table-model-need')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('new-table-change-type'));
      await fireEvent.press(screen.getByTestId('new-table-type-insurance'));
      expect(screen.queryByTestId('new-table-model-need')).toBeNull();
    });
  });

  it('Many field names in the file: Show first four initially, click "Expand" to view all, "Collapse" to return', async () => {
    const labels = ['Insurer', 'Policy number', 'Holder', 'Premium', 'Agent', 'Broker'];
    const lines = labels.map((name, i) => ({
      text: `${name}: value ${i}`,
      x: 20,
      y: 20 + i * 50,
      width: 250,
      height: 20,
    }));
    await setup(['ppocr'], undefined, [{ width: 600, height: 400, lines }]);
    expect(await screen.findByTestId('new-table-in-file')).toBeTruthy();
    expect(screen.queryAllByTestId(/^new-table-chip-\d+$/)).toHaveLength(4);
    expect(screen.getByTestId('new-table-in-file-toggle')).toHaveTextContent('Show all');
    await fireEvent.press(screen.getByTestId('new-table-in-file-toggle'));
    expect(screen.queryAllByTestId(/^new-table-chip-\d+$/)).toHaveLength(6);
    expect(screen.getByTestId('new-table-in-file-toggle')).toHaveTextContent('Show fewer');
    await fireEvent.press(screen.getByTestId('new-table-in-file-toggle'));
    expect(screen.queryAllByTestId(/^new-table-chip-\d+$/)).toHaveLength(4);
  });

  it('File field names do not exceed four: No expand link', async () => {
    await setup(['ppocr']);
    expect(await screen.findByTestId('new-table-in-file')).toBeTruthy();
    expect(screen.queryByTestId('new-table-in-file-toggle')).toBeNull();
  });

  it('Table with receipt rules already exists (sample "Receipt"): Recommend placing files with total amounts into it instead of creating a second table (D-477)', async () => {
    const withReceipts = (locale: Locale, registry: Registry) => {
      const r = applyOps(
        createDefaultWorkspace(locale),
        [
          {
            op: 'addData',
            table: {
              id: 'receipts',
              name: 'Receipts sample',
              prefillRules: 'receipt',
              fields: [
                { id: 'merchant', name: 'Merchant', type: 'text' },
                { id: 'photo', name: 'Photo', type: 'file' },
              ],
            },
          },
        ],
        { registry, locale },
      );
      if (!r.ok) throw new Error(r.error);
      return r.config;
    };
    const lines = ['Maple Corner', 'Subtotal 165.03', 'Tax 13.20', 'Total 178.23'].map(
      (text, i) => ({
        text,
        x: 20,
        y: 20 + i * 40,
        width: 200,
        height: 20,
      }),
    );
    // No local model: The rule recognizes it as a receipt.
    await setup(['ppocr'], withReceipts, [{ width: 600, height: 300, lines }]);
    expect(await screen.findByTestId('new-table-use-existing')).toBeTruthy();
    expect(screen.getByText('You already have “Receipts sample”. Put it there')).toBeTruthy();
    expect(screen.queryByTestId('new-table-recommend')).toBeNull();
  });

  // 2026-11-09, 11-10 user testing: Selecting "Receipt" for a Malaysian Ringgit receipt stored it as USD (D-548).
  it('Malaysian Ringgit receipt selected as "Receipt": Amount field is MYR; receipts without symbols continue to use interface locale', async () => {
    const receipt = (texts: string[]): RecognizedLayer => ({
      width: 600,
      height: 300,
      lines: texts.map((text, i) => ({ text, x: 20, y: 20 + i * 40, width: 240, height: 20 })),
    });
    const money = (store: Awaited<ReturnType<typeof setup>>['store']) =>
      store
        .getState()
        .config!.data.tables.flatMap((c) => c.fields)
        .filter((f) => f.type === 'money')
        .map((f) => (f.type === 'money' ? f.currency : ''));
    const { store } = await setup(['ppocr'], undefined, [
      receipt(['KEDAI PAPAN YEW CHUAN', 'Subtotal RM 115.00', 'Tax RM 6.90', 'TOTAL RM 121.90']),
    ]);
    await fireEvent.press(await screen.findByTestId('new-table-use'));
    await fireEvent.press(screen.getByTestId('new-table-save'));
    await waitFor(() => expect(money(store)).toEqual(['MYR']));
  });

  it('Receipts without currency symbols: Amount field follows interface locale (English defaults to USD)', async () => {
    const { store } = await setup(['ppocr'], undefined, [
      {
        width: 600,
        height: 300,
        lines: ['Maple Corner', 'Subtotal 165.03', 'Tax 13.20', 'Total 178.23'].map((text, i) => ({
          text,
          x: 20,
          y: 20 + i * 40,
          width: 200,
          height: 20,
        })),
      },
    ]);
    await fireEvent.press(await screen.findByTestId('new-table-use'));
    await fireEvent.press(screen.getByTestId('new-table-save'));
    await waitFor(() =>
      expect(
        store
          .getState()
          .config!.data.tables.flatMap((c) => c.fields)
          .filter((f) => f.type === 'money')
          .map((f) => (f.type === 'money' ? f.currency : '')),
      ).toEqual(['USD']),
    );
  });

  it('Model says neither: No recommendations, field names remain clickable', async () => {
    mockAnswer.current = 'none';
    await setup(['ppocr', 'prefill-model']);
    expect(await screen.findByTestId('new-table-in-file')).toBeTruthy();
    await waitFor(() => expect(mockRelease).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('new-table-working')).toBeNull());
    expect(screen.queryByTestId('new-table-recommend')).toBeNull();
  });

  it('Rule sorting: Files without amounts place receipts under "Other"', async () => {
    await setup(['ppocr']);
    await screen.findByTestId('new-table-in-file');
    await fireEvent.press(screen.getByTestId('new-table-change-type'));
    expect(screen.getByText('Others (no amount seen in this file)')).toBeTruthy();
    expect(screen.getByTestId('new-table-type-insurance')).toBeTruthy();
    expect(screen.getByTestId('new-table-type-purchase')).toBeTruthy();
    expect(screen.getByTestId('new-table-type-blank')).toBeTruthy();
  });

  it('Select from original view: Merge two lines into one field; require user naming when clicking a value, do not write values into config (invariant 14)', async () => {
    await setup(['ppocr']);
    await screen.findByTestId('new-table-in-file');
    await fireEvent.press(screen.getByTestId('new-table-original'));
    await fireEvent.press(screen.getByText('Date of'));
    await fireEvent.press(screen.getByText('expiry'));
    await fireEvent.press(screen.getByTestId('new-table-row-add'));
    expect(await screen.findByTestId('draft-field-3')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('new-table-edit'));
    expect(screen.getByTestId('new-table-field-name-field-3').props.defaultValue).toBe(
      'Date of expiry',
    );
    await fireEvent.press(screen.getByTestId('new-table-edit'));
    await fireEvent.press(screen.getByText('02/03/2026'));
    await fireEvent.press(screen.getByTestId('new-table-row-add'));
    expect(await screen.findByTestId('new-table-value-hint')).toBeTruthy();
    expect(screen.queryByTestId('draft-field-4')).toBeNull();
  });
});
