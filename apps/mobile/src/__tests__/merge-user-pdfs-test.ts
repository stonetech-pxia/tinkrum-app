import { RunError } from '@morph/core';

import { MemoryWorkspaceRepo } from '../storage/memory';
import type { AssetRecord } from '../storage/types';
import { mergeUserPdfs } from '../storage/user-files';
import { FakeFiles, makePdf } from '../test-utils/fake-files';

// R04: "Merge" on all files page must read selected PDFs entirely into memory (pdf-lib), checking
// single 50 MB and total 100 MB limits first just like quick actions (P-006), rejecting before
// reading files if limits are exceeded; original files and saved copies remain untouched.

const MB = 1024 * 1024;

async function setup(sizes: number[]) {
  const repo = new MemoryWorkspaceRepo();
  const files = new FakeFiles();
  const bytes = await makePdf(1);
  const assets: AssetRecord[] = [];
  for (const [i, size] of sizes.entries()) {
    const id = `a${i}aaaa`;
    const asset: AssetRecord = {
      id,
      name: `${id}.pdf`,
      mimeType: 'application/pdf',
      size,
      path: `assets/${id}/${id}.pdf`,
      source: 'picked',
      createdAt: 0,
    };
    await repo.addAsset(asset);
    files.disk.set(asset.path, bytes);
    assets.push(asset);
  }
  const read = jest.spyOn(files, 'readBytes');
  const merge = (list: readonly AssetRecord[] = assets) =>
    mergeUserPdfs(list, 'merged', repo, files, { now: () => new Date(), newId: () => 'cccccc' });
  return { repo, files, assets, read, merge };
}

describe('Size check for merging PDFs in document library', () => {
  it('Two normal PDFs merged into a new file, originals remain', async () => {
    const { repo, assets, merge } = await setup([100_000, 120_000]);
    const out = await merge();
    expect(out.name).toBe('merged.pdf');
    const names = (await repo.listAssets()).map((a) => a.name).sort();
    expect(names).toEqual([...assets.map((a) => a.name), 'merged.pdf'].sort());
  });

  it('Single file exceeds 100 MB (PDF, D-601): rejected before reading file, nothing written', async () => {
    const { repo, read, merge } = await setup([100_000, 101 * MB]);
    await expect(merge()).rejects.toMatchObject({ code: 'tooLarge' });
    await expect(merge()).rejects.toBeInstanceOf(RunError);
    expect(read).not.toHaveBeenCalled();
    expect(await repo.listAssets()).toHaveLength(2);
  });

  it('Each under 100 MB, total exceeds 200 MB: rejected before reading files', async () => {
    const { repo, read, merge } = await setup([70 * MB, 70 * MB, 70 * MB]);
    await expect(merge()).rejects.toMatchObject({ code: 'tooLargeTotal' });
    expect(read).not.toHaveBeenCalled();
    expect(await repo.listAssets()).toHaveLength(3);
  });

  it('Exactly 50 MB each, total not exceeding 100 MB not blocked', async () => {
    const { read, merge } = await setup([50 * MB, 50 * MB]);
    await merge();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
