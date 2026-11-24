import { describe, expect, it } from 'vitest';

import { clearFileRefs, countFileRefs, keepChosenFiles, newFileRefs } from './file-refs';
import { createDefaultWorkspace } from './defaults';
import type { WorkspaceConfig } from './schema';

// Full setup handed over to another AI and brought back: file references were cleared upon export
// (invariant 3), and upon return, user-selected images are restored to their original places
// without adding any new file references.

function withPictures(): WorkspaceConfig {
  const config = createDefaultWorkspace('en');
  const page = config.containers.pages[0]!;
  page.backdrop = { kind: 'image', assetId: 'file-bg' } as never;
  page.blocks.push(
    {
      id: 'photo',
      look: 'image',
      show: { asset: 'file-1', aspect: 'wide', fit: 'cover' },
    } as never,
    {
      id: 'photo-2',
      look: 'image',
      show: { asset: 'file-2', aspect: 'wide', fit: 'cover' },
    } as never,
  );
  return config;
}

describe('keepChosenFiles', () => {
  it('puts the user’s own pictures back into the same places and adds no new reference', () => {
    const before = withPictures();
    const returned = clearFileRefs(before);
    expect(countFileRefs(returned)).toBe(0);
    const kept = keepChosenFiles(before, returned);
    expect(countFileRefs(kept)).toBe(3);
    expect(newFileRefs(before, kept)).toEqual([]);
    const blocks = kept.containers.pages[0]!.blocks as unknown as {
      id: string;
      show: { asset?: string };
    }[];
    expect(blocks.find((b) => b.id === 'photo')!.show.asset).toBe('file-1');
    expect(blocks.find((b) => b.id === 'photo-2')!.show.asset).toBe('file-2');
    expect((kept.containers.pages[0]!.backdrop as { assetId?: string }).assetId).toBe('file-bg');
  });

  it('does not bring back a picture for a block the AI removed, or put one where there was none', () => {
    const before = withPictures();
    const returned = clearFileRefs(before);
    returned.containers.pages[0]!.blocks = returned.containers.pages[0]!.blocks.filter(
      (b) => b.id !== 'photo-2',
    );
    returned.containers.pages[0]!.blocks.push({
      id: 'new-photo',
      look: 'image',
      show: { aspect: 'wide', fit: 'cover' },
    } as never);
    const kept = keepChosenFiles(before, returned);
    expect(newFileRefs(before, kept)).toEqual([]);
    expect(countFileRefs(kept)).toBe(2);
  });

  it('never replaces a file the returned setup already names', () => {
    const before = withPictures();
    const returned = clearFileRefs(before);
    const photo = returned.containers.pages[0]!.blocks.find((b) => b.id === 'photo') as unknown as {
      show: { asset: string | null };
    };
    photo.show.asset = 'file-other';
    const kept = keepChosenFiles(before, returned);
    expect(
      (
        kept.containers.pages[0]!.blocks.find((b) => b.id === 'photo') as unknown as {
          show: { asset: string };
        }
      ).show.asset,
    ).toBe('file-other');
  });

  it('leaves a setup without pictures untouched', () => {
    const plain = createDefaultWorkspace('en');
    expect(keepChosenFiles(plain, clearFileRefs(plain))).toEqual(clearFileRefs(plain));
  });
});
