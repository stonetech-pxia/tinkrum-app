import { describe, expect, it } from 'vitest';

import {
  DESK_LIMITS,
  DESK_STALE_DAYS,
  blobsOf,
  canRedo,
  canUndo,
  commitVersion,
  currentFiles,
  currentVersion,
  deskBytes,
  deskKindOf,
  isStaleDesk,
  moveTo,
  newDesk,
  parseDesk,
  placeOutputs,
  redoDesk,
  sealEdit,
  undoDesk,
  type Desk,
  type DeskFile,
} from './model';

// Working files and version stacks on the desk (file-room DESIGN §3, §11.1, D-357).

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

function file(id: string, ext = 'jpg', size = 1 * MB, extra: Partial<DeskFile> = {}): DeskFile {
  const mime: Record<string, string> = {
    jpg: 'image/jpeg',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return {
    id,
    name: id,
    ext,
    mimeType: mime[ext] ?? 'application/octet-stream',
    size,
    path: `${id}.${ext}`,
    ...extra,
  };
}

/** Place one file, then apply a tool n times, replacing it with a new file each time. */
function deskWith(n: number, size = 1 * MB): Desk {
  let desk = newDesk('d1', [file('f0', 'jpg', size)], 0);
  for (let i = 1; i <= n; i++) {
    desk = commitVersion(
      desk,
      [file(`f${i}`, 'jpg', size)],
      { kind: 'action', action: 'image.compress' },
      i,
    ).desk;
  }
  return desk;
}

describe('version stack', () => {
  it('Placing on desk creates version 1; each tool usage adds a version, and the new one is displayed', () => {
    const desk = newDesk('d1', [file('a')], 100);
    expect(desk.versions.map((v) => v.n)).toEqual([1]);
    expect(currentVersion(desk).by).toEqual({ kind: 'place' });
    const { desk: next, drop } = commitVersion(
      desk,
      [file('b')],
      { kind: 'action', action: 'image.rotate' },
      200,
    );
    expect(next.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(currentFiles(next).map((f) => f.id)).toEqual(['b']);
    expect(next.touchedAt).toBe(200);
    // Version 1 is still present (undoable), so its files cannot be deleted.
    expect(drop).toEqual([]);
  });

  it('Undo and redo move between versions without deleting any version', () => {
    const desk = deskWith(2);
    expect(canUndo(desk)).toBe(true);
    expect(canRedo(desk)).toBe(false);
    const back = undoDesk(desk, 10);
    expect(currentFiles(back).map((f) => f.id)).toEqual(['f1']);
    expect(back.versions).toHaveLength(3);
    expect(canRedo(back)).toBe(true);
    const twice = undoDesk(back, 11);
    expect(canUndo(twice)).toBe(false);
    expect(undoDesk(twice, 12)).toBe(twice);
    expect(currentFiles(redoDesk(twice, 13)).map((f) => f.id)).toEqual(['f1']);
    // Revert to any arbitrary step.
    expect(currentFiles(moveTo(desk, 0, 14)).map((f) => f.id)).toEqual(['f0']);
  });

  it('Using tools after undo: subsequent versions are discarded, and only files used by them can be deleted', () => {
    const desk = undoDesk(deskWith(2), 10);
    const { desk: next, drop } = commitVersion(
      desk,
      [file('g')],
      { kind: 'action', action: 'image.resize' },
      20,
    );
    expect(next.versions.map((v) => v.n)).toEqual([1, 2, 4]);
    expect(currentFiles(next).map((f) => f.id)).toEqual(['g']);
    expect(canRedo(next)).toBe(false);
    expect(drop).toEqual(['f2.jpg']);
  });

  it('Keep at most 20 versions: deleted starting from the oldest; files belonging to deleted versions can be removed', () => {
    let desk = deskWith(DESK_LIMITS.maxVersions - 1);
    expect(desk.versions).toHaveLength(20);
    const { desk: next, drop } = commitVersion(
      desk,
      [file('new')],
      { kind: 'action', action: 'image.compress' },
      99,
    );
    desk = next;
    expect(desk.versions).toHaveLength(20);
    expect(desk.versions[0]!.n).toBe(2);
    expect(currentFiles(desk).map((f) => f.id)).toEqual(['new']);
    expect(drop).toEqual(['f0.jpg']);
  });

  it('When total size of all versions exceeds 500 MB, also delete starting from the oldest (whichever limit is hit first)', () => {
    // Four 150 MB versions exceed capacity: only the 3 most recent are retained.
    expect(deskBytes(deskWith(3, 150 * MB))).toBe(450 * MB);
    const limited = commitVersion(
      deskWith(2, 150 * MB),
      [file('f3', 'jpg', 150 * MB)],
      { kind: 'action', action: 'image.compress' },
      9,
    );
    expect(limited.desk.versions.map((v) => v.n)).toEqual([2, 3, 4]);
    expect(limited.drop).toEqual(['f0.jpg']);
  });

  it('When even a single version exceeds the limit (e.g., a very large video), the current version is still kept', () => {
    const big = commitVersion(
      newDesk('d', [file('a', 'jpg', 10 * MB)], 0),
      [file('b', 'jpg', 600 * MB)],
      { kind: 'action', action: 'image.compress' },
      1,
    );
    expect(big.desk.versions.map((v) => v.n)).toEqual([2]);
    expect(currentFiles(big.desk).map((f) => f.id)).toEqual(['b']);
    expect(big.drop).toEqual(['a.jpg']);
  });

  it('Unchanged files shared across multiple versions count toward size only once and are not deleted when old versions are removed', () => {
    const a = file('a', 'jpg', 5 * MB);
    const b = file('b', 'jpg', 5 * MB);
    let desk = newDesk('d', [a, b], 0);
    desk = commitVersion(
      desk,
      [file('a2', 'jpg', 2 * MB), b],
      { kind: 'action', action: 'image.compress' },
      1,
    ).desk;
    expect(deskBytes(desk)).toBe(12 * MB);
    const { drop } = commitVersion(
      desk,
      [file('c', 'pdf', 1 * MB)],
      { kind: 'action', action: 'pdf.fromImages' },
      2,
      {
        maxVersions: 2,
        maxBytes: DESK_LIMITS.maxBytes,
      },
    );
    // Version 1 is deleted: file 'a' is only used there, whereas file 'b' is still used in version 2.
    expect(drop).toEqual(['a.jpg']);
  });
});

describe('Merge consecutive edits into a single version (§10 question 4)', () => {
  const edit = { kind: 'edit' } as const;
  const table = (id: string, json: string) =>
    file(id, 'xlsx', 10_000, {
      source: {
        kind: 'table',
        path: json,
        size: 2_000,
        assets: [{ path: 'assets/p1.jpg', size: MB }],
      },
    });

  it('The first edit generates an unsealed version; subsequent edits replace it without generating a new version', () => {
    let desk = newDesk('d', [table('t1', 't1.json')], 0);
    let change = commitVersion(desk, [table('t2', 't2.json')], edit, 1);
    desk = change.desk;
    expect(desk.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(currentVersion(desk).open).toBe(true);
    change = commitVersion(desk, [table('t3', 't3.json')], edit, 2);
    desk = change.desk;
    expect(desk.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(currentFiles(desk).map((f) => f.id)).toEqual(['t3']);
    // The replaced file can be deleted; the original image (shared across versions) is kept.
    expect(change.drop).toEqual(['t2.xlsx', 't2.json']);
  });

  it('Editing after sealing (via other tools, undo, or leaving the room) creates a new version; undo reverts the entire segment together', () => {
    let desk = commitVersion(
      newDesk('d', [table('t1', 't1.json')], 0),
      [table('t2', 't2.json')],
      edit,
      1,
    ).desk;
    desk = sealEdit(desk);
    expect(currentVersion(desk).open).toBeUndefined();
    desk = commitVersion(desk, [table('t3', 't3.json')], edit, 2).desk;
    expect(desk.versions.map((v) => v.n)).toEqual([1, 2, 3]);
    // Close the edited version when switching to other tools.
    desk = commitVersion(
      desk,
      [file('p', 'pdf')],
      { kind: 'action', action: 'pdf.fromDocument' },
      3,
    ).desk;
    expect(desk.versions[2]!.open).toBeUndefined();
    // Undo: first return to the edited table (entire segment), then revert to the previous segment.
    desk = undoDesk(desk, 4);
    expect(currentFiles(desk).map((f) => f.id)).toEqual(['t3']);
    expect(currentVersion(desk).open).toBeUndefined();
  });

  it('Seal edits upon undo: subsequent edits after undo will not overwrite the version reverted to', () => {
    let desk = commitVersion(
      newDesk('d', [table('t1', 't1.json')], 0),
      [table('t2', 't2.json')],
      edit,
      1,
    ).desk;
    desk = undoDesk(desk, 2);
    expect(desk.versions[1]!.open).toBeUndefined();
    const { desk: next } = commitVersion(desk, [table('t3', 't3.json')], edit, 3);
    expect(next.versions.map((v) => v.n)).toEqual([1, 3]);
    expect(currentFiles(next).map((f) => f.id)).toEqual(['t3']);
  });
});

describe('Intermediate formats in versions (§11.1)', () => {
  it('Files utilized by a version: itself, intermediate formats, and images referenced by intermediate formats', () => {
    const f = file('t', 'xlsx', 10, {
      source: {
        kind: 'table',
        path: 't.json',
        size: 20,
        assets: [
          { path: 'assets/p1.jpg', size: 30 },
          { path: 'assets/p2.jpg', size: 40 },
        ],
      },
    });
    expect(blobsOf(f)).toEqual([
      { path: 't.xlsx', size: 10 },
      { path: 't.json', size: 20 },
      { path: 'assets/p1.jpg', size: 30 },
      { path: 'assets/p2.jpg', size: 40 },
    ]);
  });

  it('Type changed (image to Excel, then to PDF): step back to the version with intermediate formats; images are deleted only when the final version referencing them is removed', () => {
    const photo = file('photo', 'jpg', 3 * MB);
    const sheet = file('sheet', 'xlsx', 20_000, {
      source: {
        kind: 'table',
        path: 'sheet.json',
        size: 4_000,
        assets: [{ path: 'assets/page.jpg', size: 2 * MB }],
      },
    });
    let desk = newDesk('d', [photo], 0);
    desk = commitVersion(desk, [sheet], { kind: 'action', action: 'ocr.toExcel' }, 1).desk;
    desk = commitVersion(
      desk,
      [file('out', 'pdf', MB)],
      { kind: 'action', action: 'pdf.fromDocument' },
      2,
    ).desk;
    // The version converted to PDF has no intermediate format.
    expect(currentFiles(desk)[0]!.source).toBeUndefined();
    const back = undoDesk(desk, 3);
    expect(currentFiles(back)[0]!.source?.path).toBe('sheet.json');
    expect(deskKindOf(currentFiles(back)[0]!)).toBe('sheet');
    // When only 1 version remains, delete both the table version and its images.
    const { drop } = commitVersion(
      desk,
      [file('z', 'pdf')],
      { kind: 'action', action: 'pdf.compress' },
      4,
      {
        maxVersions: 1,
        maxBytes: DESK_LIMITS.maxBytes,
      },
    );
    expect(drop.sort()).toEqual([
      'assets/page.jpg',
      'out.pdf',
      'photo.jpg',
      'sheet.json',
      'sheet.xlsx',
    ]);
  });
});

describe('Place tool results back onto the desk (§3.1)', () => {
  const desk = [file('a'), file('b'), file('c')];
  const ids = (files: DeskFile[] | null) => files?.map((f) => f.id) ?? null;

  it('One-to-one: replace the utilized file while keeping its position unchanged', () => {
    expect(ids(placeOutputs(desk, ['b'], [file('b2')]))).toEqual(['a', 'b2', 'c']);
  });
  it('Many-to-one: multiple utilized files merge into one, placed at the position of the first file', () => {
    expect(ids(placeOutputs(desk, ['b', 'c'], [file('pdf', 'pdf')]))).toEqual(['a', 'pdf']);
    expect(ids(placeOutputs(desk, ['a', 'c'], [file('pdf', 'pdf')]))).toEqual(['pdf', 'b']);
  });
  it('One-to-many: original file remains, new files are placed right after it', () => {
    expect(ids(placeOutputs(desk, ['a'], [file('a1'), file('a2')]))).toEqual([
      'a',
      'a1',
      'a2',
      'b',
      'c',
    ]);
  });
  it('Individual processing of multiple files (compressing three images): one-to-one replacement per file', () => {
    expect(ids(placeOutputs(desk, ['a', 'b', 'c'], [file('x'), file('y'), file('z')]))).toEqual([
      'x',
      'y',
      'z',
    ]);
  });
  it('No file output (text recognition): desk remains unchanged', () => {
    expect(placeOutputs(desk, ['a'], [])).toBeNull();
  });
});

describe('Cleanup prompt and readback', () => {
  it('Prompt for cleanup only after 7 days of inactivity (prompt only, no automatic deletion)', () => {
    const now = 100 * DAY;
    expect(isStaleDesk({ touchedAt: now - (DESK_STALE_DAYS * DAY - 1) }, now)).toBe(false);
    expect(isStaleDesk({ touchedAt: now - DESK_STALE_DAYS * DAY }, now)).toBe(true);
  });

  it('Desk JSON reads back identically; invalid formats are treated as empty', () => {
    const desk = deskWith(2);
    expect(parseDesk(JSON.stringify(desk))).toEqual(desk);
    expect(parseDesk('not json')).toBeNull();
    expect(parseDesk(JSON.stringify({ ...desk, version: 2 }))).toBeNull();
    expect(parseDesk(JSON.stringify({ ...desk, current: 5 }))).toBeNull();
    expect(parseDesk(JSON.stringify({ ...desk, versions: [] }))).toBeNull();
  });

  it('Desk JSON records only tool IDs, not parameters', () => {
    const desk = commitVersion(
      newDesk('d', [file('a')], 0),
      [file('b')],
      { kind: 'action', action: 'image.watermark' },
      1,
    ).desk;
    expect(JSON.stringify(desk)).not.toContain('params');
  });

  it('File types: Excel, other office documents, images, PDFs, audio/video', () => {
    expect(deskKindOf(file('a', 'xlsx'))).toBe('sheet');
    expect(deskKindOf(file('a', 'docx'))).toBe('doc');
    expect(deskKindOf({ ext: 'pptx', mimeType: 'application/octet-stream' })).toBe('doc');
    expect(deskKindOf(file('a', 'jpg'))).toBe('image');
    expect(deskKindOf(file('a', 'pdf'))).toBe('pdf');
    expect(deskKindOf({ ext: 'mov', mimeType: 'video/quicktime' })).toBe('video');
    expect(deskKindOf({ ext: 'm4a', mimeType: 'audio/mp4' })).toBe('audio');
    expect(deskKindOf({ ext: 'zip', mimeType: 'application/zip' })).toBe('other');
  });

  it('Office documents without filename extensions (common when shared from other Android apps): recognized as Excel or Word via MIME type', () => {
    expect(
      deskKindOf({
        ext: 'bin',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toBe('sheet');
    expect(
      deskKindOf({
        ext: 'bin',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe('doc');
    expect(deskKindOf({ ext: 'bin', mimeType: 'application/octet-stream' })).toBe('other');
  });
});
