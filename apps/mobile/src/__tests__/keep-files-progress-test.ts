import { MemoryWorkspaceRepo } from '../storage/memory';
import { keepIncomingFiles } from '../storage/keep-files';
import { FakeFiles, TINY_JPEG } from '../test-utils/fake-files';

// 2026-11-06 simulator test: opening 23 photos at once takes several seconds to save into the document library, and the screen is grayed out with no progress indicator.
describe('keepIncomingFiles progress', () => {
  it('reports each saved file, ending at the total', async () => {
    const files = new FakeFiles();
    const picked = ['a.jpg', 'b.jpg', 'c.jpg'].map((n) => files.offer(n, TINY_JPEG, 'image/jpeg'));
    const seen: [number, number][] = [];
    const kept = await keepIncomingFiles(picked, files, new MemoryWorkspaceRepo(), (d, t) =>
      seen.push([d, t]),
    );
    expect(kept).toHaveLength(3);
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});
