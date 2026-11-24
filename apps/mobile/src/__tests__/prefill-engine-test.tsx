import {
  parsePickStore,
  PICK_STORE_KEY,
  putPick,
  serializePickStore,
  type Collection,
  type FieldSuggestions,
  type PrefillEngine,
} from '@morph/core';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useFieldSuggestions } from '../data/field-suggestions';
import { MemoryWorkspaceRepo } from '../storage/memory';
import { FakeFiles, FakeVision, TINY_JPEG } from '../test-utils/fake-files';

// The form only accepts the prefill engine interface (D-398): the engine is asynchronous (the
// on-device model takes a moment to run), retrieves text with positions, and yields results
// directly as candidates; errors result in no candidates; informs it to cancel upon leaving the
// form, and late-arriving results are ignored.

const mockContext: { repo?: MemoryWorkspaceRepo; files?: FakeFiles } = {};
jest.mock('../workspace/context', () => ({ useWorkspaceContext: () => mockContext }));

const collection: Collection = {
  id: 'c',
  name: 'Receipts',
  fields: [
    { id: 'total', name: 'Amount', type: 'money', currency: 'USD' },
    { id: 'files', name: 'Attachments', type: 'file' },
  ],
};
const values = { files: ['a1'] };
const LINE = { text: 'Total 9.00', x: 20, y: 40, width: 100, height: 20 };
const FOUND: FieldSuggestions = {
  total: [{ value: '42', score: 5, pick: { label: 'Total', relY: 0.5 } }],
};

async function setup() {
  const repo = new MemoryWorkspaceRepo();
  const files = new FakeFiles();
  const vision = new FakeVision(files);
  vision.layers.push({ width: 600, height: 400, lines: [LINE] });
  files.vision = vision;
  files.disk.set('assets/a1.jpg', TINY_JPEG);
  await repo.addAsset({
    id: 'a1',
    name: 'a1.jpg',
    mimeType: 'image/jpeg',
    size: TINY_JPEG.length,
    path: 'assets/a1.jpg',
    source: 'picked',
    createdAt: 1,
  });
  mockContext.repo = repo;
  mockContext.files = files;
}

const open = (engine: PrefillEngine) =>
  renderHook(() =>
    useFieldSuggestions({ enabled: true, collection, values, locale: 'en', engine }),
  );

describe('Prefill engine (D-398)', () => {
  beforeEach(setup);

  it('The engine receives fields and position-annotated text, and directly provides the resulting candidates', async () => {
    const engine = jest.fn<ReturnType<PrefillEngine>, Parameters<PrefillEngine>>(async () => FOUND);
    const { result } = await open(engine);
    await waitFor(() => expect(result.current.suggestions).toEqual(FOUND));
    expect(result.current.working).toBe(false);
    const input = engine.mock.calls[0]![0];
    expect(input.fields).toBe(collection.fields);
    expect(input.pages).toEqual([{ width: 600, height: 400, lines: [LINE] }]);
  });

  it('The engine receives prefillRules on the table (D-421)', async () => {
    const cards: Collection = { ...collection, prefillRules: 'card' };
    const engine = jest.fn<ReturnType<PrefillEngine>, Parameters<PrefillEngine>>(async () => ({}));
    await renderHook(() =>
      useFieldSuggestions({ enabled: true, collection: cards, values, locale: 'en', engine }),
    );
    await waitFor(() => expect(engine).toHaveBeenCalled());
    expect(engine.mock.calls[0]![0].rules).toBe('card');
  });

  it('Engine error: no candidates, no longer displays reading status', async () => {
    const { result } = await open(async () => {
      throw new Error('model failed');
    });
    await waitFor(() => expect(result.current.working).toBe(false));
    expect(result.current.suggestions).toEqual({});
  });

  it('Engine in two steps (D-398): initial results appear immediately and stop displaying reading status, subsequent results fill in later', async () => {
    let finish: ((s: FieldSuggestions) => void) | undefined;
    const { result } = await open(
      (_input, _signal, onPartial) =>
        new Promise((resolve) => {
          onPartial?.(FOUND);
          finish = resolve;
        }),
    );
    await waitFor(() => expect(result.current.suggestions).toEqual(FOUND));
    // The engine has not finished, but the "Reading" line has already collapsed: if it collapsed late, fields below would jump upward after the user taps (D-388).
    expect(result.current.working).toBe(false);
    const later: FieldSuggestions = {
      total: [{ value: '7', score: 0, pick: { label: '', relY: 0 } }, ...FOUND.total!],
    };
    await act(async () => finish!(later));
    expect(result.current.suggestions).toEqual(later);
  });

  it('Candidates whose positions cannot be found in the text: tapping them does nothing, and the field\'s original memory remains', async () => {
    const good = { label: 'Total', relY: 0.5 };
    await mockContext.repo!.setMeta(
      PICK_STORE_KEY,
      serializePickStore(putPick(parsePickStore(null), 'c', 'total', good)),
    );
    const found: FieldSuggestions = { total: [{ value: '7', score: 0 }] };
    const { result } = await open(async () => found);
    await waitFor(() => expect(result.current.suggestions).toEqual(found));
    await act(async () => result.current.remember('total', found.total![0]!));
    await act(async () => undefined);
    const stored = parsePickStore(await mockContext.repo!.getMeta(PICK_STORE_KEY));
    expect(stored.c?.total).toEqual(good);
  });

  it('Fields with selected candidates (D-388): subsequent results do not update their candidates, while other fields are filled as usual', async () => {
    const one = (id: string, value: string): FieldSuggestions[string] => [
      { value, score: 1, pick: { label: id, relY: 0.5 } },
    ];
    let push: ((s: FieldSuggestions) => void) | undefined;
    const first: FieldSuggestions = { total: one('t', '42') };
    const { result } = await open(
      (_input, _signal, onPartial) =>
        new Promise(() => {
          push = onPartial;
          onPartial?.(first);
        }),
    );
    await waitFor(() => expect(result.current.suggestions).toEqual(first));
    await act(async () => result.current.remember('total', first.total![0]!));
    const later: FieldSuggestions = { total: one('t', '99'), other: one('o', 'x') };
    await act(async () => push!(later));
    expect(result.current.suggestions).toEqual({ total: first.total, other: later.other });
  });

  it('The engine retrieves stored store names for this table (checked on the fly, read-only)', async () => {
    const merchant: Collection = {
      id: 'c',
      name: 'Receipts',
      fields: [
        { id: 'shop', name: 'Merchant', type: 'text' },
        { id: 'files', name: 'Attachments', type: 'file' },
      ],
    };
    await mockContext.repo!.insertRecord({
      id: 'r1',
      collectionId: 'c',
      values: { shop: 'Acme Coffee' },
      createdAt: 1,
      updatedAt: 1,
    });
    const before = JSON.stringify(await mockContext.repo!.listRecords('c'));
    const engine = jest.fn<ReturnType<PrefillEngine>, Parameters<PrefillEngine>>(async () => ({}));
    await renderHook(() =>
      useFieldSuggestions({ enabled: true, collection: merchant, values, locale: 'en', engine }),
    );
    await waitFor(() => expect(engine).toHaveBeenCalled());
    expect(engine.mock.calls[0]![0].known).toEqual({ shop: ['Acme Coffee'] });
    expect(JSON.stringify(await mockContext.repo!.listRecords('c'))).toBe(before);
  });

  it('Leaving the form: notify the engine to cancel', async () => {
    let signal: AbortSignal | undefined;
    const { unmount } = await open((_input, s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    await waitFor(() => expect(signal?.aborted).toBe(false));
    await unmount();
    expect(signal?.aborted).toBe(true);
  });
});
