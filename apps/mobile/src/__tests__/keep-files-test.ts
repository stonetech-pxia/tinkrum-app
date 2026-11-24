import { MemoryWorkspaceRepo } from '../storage/memory';
import { keepIncomingFiles } from '../storage/keep-files';
import { FakeFiles } from '../test-utils/fake-files';

// R01: Files opened or shared in are saved to the document library (D-455); opening the exact same
// content again does not duplicate it; files with the same name and size but different content are
// treated as distinct files and cannot be linked to the old one.

const bytes = (text: string) => new TextEncoder().encode(text);

async function setup() {
  const repo = new MemoryWorkspaceRepo();
  const files = new FakeFiles();
  const keep = async (name: string, content: string, mimeType = 'text/plain') => {
    const picked = files.offer(name, bytes(content), mimeType);
    const [kept] = await keepIncomingFiles([picked], files, repo);
    return { picked, kept: kept! };
  };
  return { repo, files, keep };
}

describe('Recognize content when saved opened files into the document library', () => {
  it('Same name, same size, different content: treated as two files, saved separately, and their own content is used when saving as a record', async () => {
    const { repo, files, keep } = await setup();
    const a = await keep('report.txt', 'AAAA');
    const b = await keep('report.txt', 'BBBB');
    expect(b.kept.assetId).toBeDefined();
    expect(b.kept.assetId).not.toBe(a.kept.assetId);
    const asset = await repo.getAsset(b.kept.assetId!);
    expect(await files.readBytes(asset!.path)).toEqual(bytes('BBBB'));
    expect(await repo.listAssets()).toHaveLength(2);
  });

  it('Same name, same size, identical content (re-opening the same file): not duplicated, uses the existing one', async () => {
    const { repo, keep } = await setup();
    const a = await keep('report.txt', 'AAAA');
    const again = await keep('report.txt', 'AAAA');
    expect(again.kept.assetId).toBe(a.kept.assetId);
    expect(await repo.listAssets()).toHaveLength(1);
  });

  it('Different size, different name: directly save the new one without reading file content', async () => {
    const { files, keep } = await setup();
    await keep('report.txt', 'AAAA');
    const digest = jest.spyOn(files, 'contentDigest');
    const longer = await keep('report.txt', 'AAAAA');
    const renamed = await keep('other.txt', 'AAAA');
    expect(longer.kept.assetId).toBeDefined();
    expect(renamed.kept.assetId).toBeDefined();
    expect(digest).not.toHaveBeenCalled();
  });

  it('Content of selected file cannot be read: save as a new file without linking to the old one', async () => {
    const { repo, files, keep } = await setup();
    const a = await keep('report.txt', 'AAAA');
    jest.spyOn(files, 'contentDigest').mockRejectedValue(new Error('unreadable'));
    const b = await keep('report.txt', 'AAAA');
    expect(b.kept.assetId).not.toBe(a.kept.assetId);
    expect(await repo.listAssets()).toHaveLength(2);
  });

  it('Use existing document library copy (assetId) directly; treat files without size as new files', async () => {
    const { repo, files, keep } = await setup();
    const a = await keep('report.txt', 'AAAA');
    const [again] = await keepIncomingFiles(
      [{ ...a.picked, assetId: a.kept.assetId! }],
      files,
      repo,
    );
    expect(again!.assetId).toBe(a.kept.assetId);
    const unknownSize = { ...files.offer('report.txt', bytes('AAAA'), 'text/plain'), size: null };
    const [kept] = await keepIncomingFiles([unknownSize], files, repo);
    expect(kept!.assetId).not.toBe(a.kept.assetId);
  });
});
