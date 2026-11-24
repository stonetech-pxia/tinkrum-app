import { currentFiles } from '@morph/core';
import type { TableDoc } from '@morph/tool-office';

import {
  dropEditDraft,
  listDesks,
  loadDesk,
  placeOnDesk,
  recoverEditDraft,
  saveDesk,
  writeEditDraft,
} from '../desk/store';
import { FakeFiles } from '../test-utils/fake-files';

// R08: Desk manifest (desk.json) and unclosed edits (editing.json) are not written directly over
// original files: first fully write to .tmp, read back and verify, rename old file to .bak, then
// replace formal file with .tmp. If interrupted halfway, the formal file or the previous valid one
// can still be read, and the desk will not disappear.

const MAIN = 'desk/d1/desk.json';
const text = (files: FakeFiles, path: string) =>
  files.disk.has(path) ? new TextDecoder().decode(files.disk.get(path)!) : null;

async function setup() {
  const files = new FakeFiles();
  files.disk.set('content://media/photo1', new Uint8Array(30).fill(7));
  const desk = await placeOnDesk(
    files,
    [{ uri: 'content://media/photo1', name: 'a.jpg', size: 30, mimeType: 'image/jpeg' }],
    1000,
    'd1',
  );
  return { files, desk };
}

describe('Desk manifest writing', () => {
  it('Normal save: formal file is new, previous one kept as .bak, no remaining .tmp', async () => {
    const { files, desk } = await setup();
    const before = text(files, MAIN)!;
    await saveDesk(files, { ...desk, touchedAt: 2000 });
    expect(JSON.parse(text(files, MAIN)!).touchedAt).toBe(2000);
    expect(text(files, `${MAIN}.bak`)).toBe(before);
    expect(files.disk.has(`${MAIN}.tmp`)).toBe(false);
    expect((await loadDesk(files, 'd1'))!.touchedAt).toBe(2000);
  });

  it('Incomplete .tmp write: save reports an error, formal file remains unchanged, .tmp is cleared', async () => {
    const { files, desk } = await setup();
    const before = text(files, MAIN)!;
    // Only wrote half when writing .tmp.
    const write = files.desk.writeBytes.bind(files.desk);
    jest
      .spyOn(files.desk, 'writeBytes')
      .mockImplementation(async (path, bytes) =>
        write(path, path.endsWith('.tmp') ? bytes.slice(0, 10) : bytes),
      );
    await expect(saveDesk(files, { ...desk, touchedAt: 2000 })).rejects.toThrow(/not written/);
    expect(text(files, MAIN)).toBe(before);
    expect(files.disk.has(`${MAIN}.tmp`)).toBe(false);
    expect((await loadDesk(files, 'd1'))!.touchedAt).toBe(desk.touchedAt);
  });

  it('Restoring an interrupted write (old renamed to .bak, .tmp not yet swapped in): new file can be read', async () => {
    const { files, desk } = await setup();
    const rename = files.desk.rename.bind(files.desk);
    let calls = 0;
    jest.spyOn(files.desk, 'rename').mockImplementation(async (from, to) => {
      if (++calls === 2) throw new Error('killed');
      return rename(from, to);
    });
    await expect(saveDesk(files, { ...desk, touchedAt: 2000 })).rejects.toThrow('killed');
    // Formal file is missing, .tmp is the written new manifest: use it when opening the desk.
    expect(files.disk.has(MAIN)).toBe(false);
    expect((await loadDesk(files, 'd1'))!.touchedAt).toBe(2000);
    expect((await listDesks(files)).map((d) => d.id)).toEqual(['d1']);
  });

  it('Formal file is truncated (unreadable): use previous valid .bak, desk remains in the list', async () => {
    const { files, desk } = await setup();
    await saveDesk(files, { ...desk, touchedAt: 2000 });
    files.disk.set(MAIN, files.disk.get(MAIN)!.slice(0, 20));
    expect((await loadDesk(files, 'd1'))!.touchedAt).toBe(desk.touchedAt);
    expect((await listDesks(files)).map((d) => d.id)).toEqual(['d1']);
  });

  it('Saving when formal file is corrupted: new file is swapped in, .bak remains the previous valid one and is not overwritten by the corrupted file', async () => {
    const { files, desk } = await setup();
    await saveDesk(files, { ...desk, touchedAt: 2000 });
    const good = text(files, `${MAIN}.bak`)!;
    files.disk.set(MAIN, files.disk.get(MAIN)!.slice(0, 20));
    await saveDesk(files, { ...desk, touchedAt: 3000 });
    expect((await loadDesk(files, 'd1'))!.touchedAt).toBe(3000);
    expect(text(files, `${MAIN}.bak`)).toBe(good);
  });

  it('Manifests from other desks placed at this desk\'s location are ignored (ID mismatch)', async () => {
    const { files, desk } = await setup();
    await saveDesk(files, { ...desk, touchedAt: 2000 });
    files.disk.set(MAIN, new TextEncoder().encode(JSON.stringify({ ...desk, id: 'other' })));
    // Formal file ID is incorrect, fall back to the previous valid one.
    expect((await loadDesk(files, 'd1'))!.id).toBe('d1');
  });

  it('All unreadable: return null', async () => {
    const files = new FakeFiles();
    expect(await loadDesk(files, 'nothere')).toBeNull();
  });
});

describe('Unclosed edits (editing.json)', () => {
  const doc = (n: number): { kind: 'table'; doc: TableDoc } => ({
    kind: 'table',
    doc: { v: 1, pages: [] } as unknown as TableDoc,
    ...({ n } as object),
  });

  it('No .tmp / .bak left after closing: deleted edits do not resurrect from backups', async () => {
    const { files, desk } = await setup();
    const file = currentFiles(desk)[0]!;
    await writeEditDraft(files, desk, file.id, doc(1));
    await writeEditDraft(files, desk, file.id, doc(2));
    expect(files.disk.has('desk/d1/editing.json.bak')).toBe(true);
    await dropEditDraft(files, desk);
    for (const suffix of ['', '.tmp', '.bak'])
      expect(files.disk.has(`desk/d1/editing.json${suffix}`)).toBe(false);
    // No edits to recover when opening the room.
    expect(await recoverEditDraft(files, desk, 5000)).toBe(desk);
  });
});
