import {
  RunCancelled,
  RunError,
  attachmentIds,
  expandCollection,
  fieldLink,
  fillRecordTemplate,
  linkedCollectionIds,
  loadLinkResolver,
  recordTitle,
  t,
  OFFICE_MIME_BY_EXT,
  FILE_LIMITS,
  type ActionImpl,
  type DataRecord,
} from '@morph/core';
import { fillDocxTemplate, OfficeImportFailure } from '@morph/tool-office';
import { openFieldLink } from '../../renderer/open-link';
import { extOf, writeItem, type RunServices } from './helpers';
import { requireRecordTable } from './record-export';

type Impl = ActionImpl<RunServices>;

export const fillRecord: Impl = async (input, params, ctx) => {
  if (!input || input.type !== 'records') throw new RunError('needsRecord');
  requireRecordTable(input, params.collectionId);
  if (input.records.length === 0) throw new RunError('noRecords', { name: input.name });
  const source = ctx.services.collections.find((t) => t.id === params.collectionId);
  const templates = ctx.services.collections.find((t) => t.id === params.templatesTable);
  if (!source || !templates) throw new RunError('invalidWorkflow');
  const collection = expandCollection(ctx.services.collections, source);
  let record = input.records[0]!;
  // records remains the existing type; when there are multiple, the user manually selects one, without rejecting chainable actions in the config.
  if (input.records.length > 1) {
    const chosen = await ctx.services.ui.open('recordPick', {
      collection,
      records: input.records,
      select: true,
    });
    if (!chosen) throw new RunCancelled();
    const selected = input.records.find((r) => r.id === chosen.recordId);
    if (!selected) throw new RunError('invalidWorkflow');
    record = selected;
  }
  const key = (name: string) => (params[name] as string[] | undefined)?.[0] ?? '';
  const content = (r: DataRecord, name: string) => {
    const value = r.values[key(name)];
    return typeof value === 'string' ? value : '';
  };
  const kind = params.kind;
  // Determine which templates are applicable solely from attachment metadata; contents are read only after the user makes a selection.
  const candidates: DataRecord[] = [];
  const docs = new Map<string, Awaited<ReturnType<typeof ctx.services.repo.getAsset>>>();
  for (const r of await ctx.services.repo.listRecords(templates.id)) {
    ctx.throwIfCancelled();
    if (kind === 'word') {
      for (const id of attachmentIds(r.values[key('document')])) {
        const asset = await ctx.services.repo.getAsset(id);
        if (asset && extOf(asset.name).toLowerCase() === 'docx') {
          candidates.push(r);
          docs.set(r.id, asset);
          break;
        }
      }
    } else if (content(r, 'body').trim() && (kind !== 'email' || content(r, 'subject').trim()))
      candidates.push(r);
  }
  if (!candidates.length) throw new RunError('noRecords', { name: templates.name });
  let template = candidates[0]!;
  if (candidates.length > 1) {
    const chosen = await ctx.services.ui.open('recordPick', {
      collection: templates,
      records: candidates,
      select: true,
    });
    if (!chosen) throw new RunCancelled();
    const selected = candidates.find((r) => r.id === chosen.recordId);
    if (!selected) throw new RunError('invalidWorkflow');
    template = selected;
  }
  const links = await loadLinkResolver(
    (id) => ctx.services.repo.listRecords(id),
    ctx.services.collections,
    linkedCollectionIds(collection),
    ctx.locale,
  );
  const missing = new Set<string>();
  const fill = (text: string) => {
    const result = fillRecordTemplate(text, collection, record, ctx.locale, links);
    result.missing.forEach((n) => missing.add(n));
    return result.text;
  };
  const name = recordTitle(template, templates, ctx.locale, ctx.now(), ctx.services.calendar);
  let text = '',
    subject = '',
    document: Uint8Array | undefined;
  if (kind === 'word') {
    const asset = docs.get(template.id)!;
    if (asset.size > FILE_LIMITS.maxFileBytes)
      throw new RunError('tooLarge', {
        name: asset.name,
        mb: FILE_LIMITS.maxFileBytes / (1024 * 1024),
      });
    try {
      document = fillDocxTemplate(
        await ctx.services.files.readUri(ctx.services.files.fileUri(asset.path)),
        fill,
      );
    } catch (e) {
      if (e instanceof OfficeImportFailure && e.code === 'encrypted')
        throw new RunError('encrypted', { name: asset.name });
      throw new RunError('unreadable', { name: asset.name });
    }
  } else {
    text = fill(content(template, 'body'));
    if (kind === 'email') subject = fill(content(template, 'subject'));
  }
  ctx.throwIfCancelled();
  if (missing.size) {
    const chosen = await ctx.services.ui.choose(
      t(ctx.locale, 'templateMissingTitle'),
      t(ctx.locale, 'templateMissingMessage', { fields: [...missing].join(', ') }),
      [t(ctx.locale, 'resultContinue')],
    );
    if (chosen !== 0) throw new RunCancelled();
  }
  if (document)
    return {
      type: 'files',
      items: [
        await writeItem(ctx.services, document, {
          name,
          ext: 'docx',
          mimeType: OFFICE_MIME_BY_EXT.docx!,
        }),
      ],
    };
  if (kind === 'email') {
    const field = collection.fields.find((f) => f.id === key('recipient'));
    const link = field && fieldLink(field, record.values[field.id]);
    if (!link || link.kind !== 'email') throw new RunError('badLink');
    openFieldLink(
      {
        ...link,
        url: `${link.url}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`,
      },
      ctx.locale,
    );
  }
  return { type: 'text', text, name };
};
