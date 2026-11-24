import { describe, expect, it } from 'vitest';

import { assetUsage, configAssetUses, isUnused } from './asset-usage';
import type { DataRecord } from './data';
import { applyOps, type Op } from './ops';
import type { Collection, WorkspaceConfig } from './schema';
import { registry, workspace } from './test-helpers';

// "Settings -> Storage" (D-264): where each user file is used, and which ones are currently not in use anywhere.

const receipts: Collection = {
  id: 'expenses',
  name: '账目',
  fields: [
    { id: 'item', name: '项目', type: 'text' },
    { id: 'receipt', name: '收据', type: 'file' },
  ],
};

function config(ops: Op[]): WorkspaceConfig {
  const result = applyOps(workspace('zh'), [{ op: 'addData', table: receipts }, ...ops], {
    registry,
    locale: 'zh',
  });
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

const record = (
  id: string,
  values: Record<string, unknown>,
  deletedAt: number | null = null,
  collectionId = 'expenses',
): DataRecord & { deletedAt: number | null } => ({
  id,
  collectionId,
  values,
  createdAt: 1,
  updatedAt: 1,
  deletedAt,
});

const now = new Date(2026, 9, 27);
const day = 24 * 3600 * 1000;

describe('asset usage', () => {
  // Four places in the config pointing to user files (D-377): opens.file for file slots, show.asset
  // for image blocks, style.backdrop.assetId for cards, and backdrop.assetId for pages.
  const withSlotAndImage = config([
    {
      op: 'addContainer',
      page: 'home',
      block: {
        id: 'lease',
        look: 'entry',
        show: { title: '合同' },
        opens: { file: 'slotfile1' },
      },
    },
    {
      op: 'addContainer',
      page: 'home',
      block: {
        id: 'row',
        look: 'group',
        show: { layout: 'row' },
        children: [
          {
            id: 'pic',
            look: 'image',
            show: { asset: 'photo1', aspect: 'wide', fit: 'cover' },
          },
          {
            id: 'tip',
            look: 'notice',
            show: { text: '看这里' },
            style: { backdrop: { overlay: 'medium', assetId: 'cardpic1' } },
          },
        ],
      },
    },
    { op: 'updateContainer', page: 'home', changes: { backdrop: { assetId: 'pagepic1' } } },
  ]);

  it('finds the four places that point at a file, including inside groups', () => {
    expect(Object.fromEntries(configAssetUses(withSlotAndImage))).toEqual({
      pagepic1: [{ kind: 'page', pageId: 'home' }],
      slotfile1: [{ kind: 'component', pageId: 'home', componentId: 'lease' }],
      photo1: [{ kind: 'component', pageId: 'home', componentId: 'pic' }],
      cardpic1: [{ kind: 'component', pageId: 'home', componentId: 'tip' }],
    });
  });

  it('an empty file slot uses nothing', () => {
    const empty = config([
      {
        op: 'addContainer',
        page: 'home',
        block: { id: 'lease', look: 'entry', show: { title: '合同' }, opens: { file: null } },
      },
    ]);
    expect(configAssetUses(empty).size).toBe(0);
  });

  it('finds records, old single ids, recently deleted records; old versions only count as old', () => {
    const usage = assetUsage({
      assetIds: ['a1', 'a2', 'a3', 'a4', 'slotfile1', 'oldpic', 'oldpic2', 'oldslot', 'none'],
      config: withSlotAndImage,
      collections: [],
      records: [
        record('r1', { receipt: ['a1', 'a2'] }),
        record('r2', { receipt: 'a3' }),
        // Recently deleted: items within 30 days are still considered in use, older ones are not.
        record('r3', { receipt: ['a4'] }, now.getTime() - 3 * day),
        record('r4', { receipt: ['none'] }, now.getTime() - 31 * day),
        // Coincidentally matching words in text fields do not count.
        record('r5', { item: 'a1x' }),
      ],
      // Historical versions might still use v33 config (assetId) or v34 config (show.asset, opens.file).
      revisions: [
        { pages: [{ components: [{ props: { assetId: 'oldpic' } }] }] },
        { containers: { pages: [{ blocks: [{ show: { asset: 'oldpic2' } }] }] } },
        { containers: { pages: [{ blocks: [{ opens: { file: 'oldslot' } }] }] } },
      ],
      now,
    });
    expect(usage.get('a1')!.uses).toEqual([
      { kind: 'record', collectionId: 'expenses', recordId: 'r1', deleted: false },
    ]);
    expect(usage.get('a3')!.uses).toHaveLength(1);
    expect(usage.get('a4')!.uses).toEqual([
      { kind: 'record', collectionId: 'expenses', recordId: 'r3', deleted: true },
    ]);
    expect(usage.get('slotfile1')!.uses).toHaveLength(1);
    expect(usage.get('oldpic')).toEqual({ uses: [], inOldVersions: true });
    expect(usage.get('oldpic2')).toEqual({ uses: [], inOldVersions: true });
    expect(usage.get('oldslot')).toEqual({ uses: [], inOldVersions: true });
    expect(usage.get('none')).toEqual({ uses: [], inOldVersions: false });
    expect(['a1', 'a4', 'slotfile1'].some((id) => isUnused(usage.get(id)))).toBe(false);
    expect(isUnused(usage.get('oldpic'))).toBe(true);
    expect(isUnused(usage.get('none'))).toBe(true);
  });

  it('uses the structure of tables that are only in old versions', () => {
    const trips: Collection = {
      id: 'trips',
      name: '旅行',
      fields: [{ id: 'tickets', name: '车票', type: 'file' }],
    };
    const usage = assetUsage({
      assetIds: ['t1'],
      config: withSlotAndImage,
      collections: [trips],
      records: [record('x', { tickets: ['t1'] }, null, 'trips')],
      revisions: [],
      now,
    });
    expect(usage.get('t1')!.uses).toHaveLength(1);
  });

  it('a new user has nothing in use', () => {
    const usage = assetUsage({
      assetIds: [],
      config: workspace('zh'),
      collections: [],
      records: [],
      revisions: [],
      now,
    });
    expect(usage.size).toBe(0);
  });
});
