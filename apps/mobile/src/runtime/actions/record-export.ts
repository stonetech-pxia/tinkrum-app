import {
  REPORT_ATTACHMENT_LIMITS as LIMITS,
  RunCancelled,
  RunError,
  attachmentIds,
  reportAttachmentNotes,
  sanitizeFileName,
  uniqueFileName,
  type ActionImpl,
  type Collection,
  type DataRecord,
  type RunItem,
} from '@morph/core';
import { baseName, extOf, freshName, type RunServices } from './helpers';

type Ctx = Parameters<ActionImpl<RunServices>>[2];

/** Excel with attachments: copy only, preserving the correspondence between each record and filename; all types can be carried over without converting to images. */
export async function copyExcelAttachments(
  ctx: Ctx,
  table: Collection,
  records: readonly DataRecord[],
) {
  const items: RunItem[] = [];
  const rows: string[] = [];
  const copied = new Map<string, RunItem>();
  const taken = new Set([`${sanitizeFileName(table.name)}.xlsx`]);
  let bytes = 0;
  try {
    for (const record of records) {
      const names: string[] = [];
      const unreadable: string[] = [],
        overLimit: string[] = [];
      for (const id of new Set(
        table.fields
          .filter((f) => f.type === 'file')
          .flatMap((f) => attachmentIds(record.values[f.id])),
      )) {
        ctx.throwIfCancelled();
        const previous = copied.get(id);
        if (previous) {
          names.push(`${previous.name}.${previous.ext}`);
          continue;
        }
        let label = id;
        try {
          const asset = await ctx.services.repo.getAsset(id);
          if (!asset) throw new Error('missing');
          label = asset.name;
          if (items.length >= LIMITS.maxCount || asset.size > LIMITS.maxBytes - bytes) {
            overLimit.push(label);
            continue;
          }
          const name = uniqueFileName(
            sanitizeFileName(baseName(asset.name)),
            extOf(asset.name) || 'bin',
            taken,
          );
          const stored = await ctx.services.files.copyToRun(
            ctx.services.files.fileUri(asset.path),
            ctx.services.runId,
            freshName(baseName(name), extOf(name)),
          );
          if (stored.size > LIMITS.maxBytes - bytes) {
            await ctx.services.files.removeRunFile(stored.uri);
            overLimit.push(label);
            continue;
          }
          const item: RunItem = {
            ...stored,
            name: baseName(name),
            ext: extOf(name),
            mimeType: asset.mimeType,
          };
          items.push(item);
          copied.set(id, item);
          taken.add(name);
          bytes += stored.size;
          names.push(name);
        } catch (e) {
          if (e instanceof RunCancelled) throw e;
          unreadable.push(label);
        }
      }
      rows.push(
        [...names, ...reportAttachmentNotes({ overLimit, unreadable }, ctx.locale)].join('\n'),
      );
    }
    ctx.throwIfCancelled();
    return { items, rows };
  } catch (e) {
    for (const item of items)
      await ctx.services.files.removeRunFile(item.uri).catch(() => undefined);
    throw e;
  }
}

export function requireRecordTable(input: { collectionId: string }, tableId: unknown) {
  if (typeof tableId === 'string' && tableId !== input.collectionId)
    throw new RunError('invalidWorkflow');
}
