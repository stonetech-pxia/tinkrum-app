import { MemoryWorkspaceRepo } from '../storage/memory';
import type { AssetRecord } from '../storage/types';
import { mergeUserPdfs } from '../storage/user-files';
import { copyUserFiles } from '../storage/copy-files';
import { FakeFiles, makePdf } from '../test-utils/fake-files';

// R10: when a file is already copied into the app but fails to register in the database, this new
// copy must be deleted (otherwise storage space page won't show or delete it). Only compensates
// this newly created copy: original, previously registered items, and inbox batch remain untouched.

const diskAssets = (files: FakeFiles) =>
  [...files.disk.keys()].filter((k) => k.startsWith('assets/'));

describe('Copy into document library: delete new copy on registration failure', () => {
  it('2nd fails to register: 1st remains in document library, 2nd copy is deleted, returns copyFailed', async () => {
    const repo = new MemoryWorkspaceRepo();
    const files = new FakeFiles();
    const a = files.offer('one.txt', new Uint8Array([1, 2, 3]), 'text/plain');
    const b = files.offer('two.txt', new Uint8Array([4, 5, 6]), 'text/plain');
    const add = repo.addAsset.bind(repo);
    let calls = 0;
    jest.spyOn(repo, 'addAsset').mockImplementation(async (asset: AssetRecord) => {
      if (++calls === 2) throw new Error('database is locked');
      return add(asset);
    });
    const result = await copyUserFiles([a, b], files, repo);
    expect(result.problem).toBe('copyFailed');
    expect(result.created).toHaveLength(1);
    const kept = await repo.listAssets();
    expect(kept.map((x) => x.name)).toEqual(['one.txt']);
    // Only the registered one remains on disk; original is untouched.
    expect(diskAssets(files)).toEqual([kept[0]!.path]);
    expect(files.disk.has(a.uri)).toBe(true);
    expect(files.disk.has(b.uri)).toBe(true);
  });
});

describe('Merge PDF: delete synthesized new file on registration failure, originals untouched', () => {
  it('addAsset failure: throws error, no synthesized copy left on disk', async () => {
    const repo = new MemoryWorkspaceRepo();
    const files = new FakeFiles();
    const bytes = await makePdf(1);
    const assets: AssetRecord[] = [];
    for (const id of ['aaaaaa', 'bbbbbb']) {
      const asset: AssetRecord = {
        id,
        name: `${id}.pdf`,
        mimeType: 'application/pdf',
        size: bytes.length,
        path: `assets/${id}/${id}.pdf`,
        source: 'picked',
        createdAt: 0,
      };
      await repo.addAsset(asset);
      files.disk.set(asset.path, bytes);
      assets.push(asset);
    }
    jest.spyOn(repo, 'addAsset').mockRejectedValueOnce(new Error('database is locked'));
    await expect(
      mergeUserPdfs(assets, 'merged', repo, files, {
        now: () => new Date(),
        newId: () => 'cccccc',
      }),
    ).rejects.toThrow('database is locked');
    expect(diskAssets(files).sort()).toEqual(assets.map((a) => a.path).sort());
    expect((await repo.listAssets()).map((a) => a.id).sort()).toEqual(['aaaaaa', 'bbbbbb']);
  });
});
