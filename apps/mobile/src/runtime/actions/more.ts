import {
  t,
  FILE_LIMITS,
  PAGE_POINTS,
  RunError,
  actionLink,
  type LinkKind,
  extractText,
  groupItems,
  expandCollection,
  linkedCollectionIds,
  loadComputedRecords,
  loadLinkResolver,
  replaceText,
  splitOrJoinLines,
  tidyText,
  dayOf,
  periodRange,
  recordsToHtml,
  sortRecords,
  textToHtml,
  type ActionImpl,
  type BlankLines,
  type ExtractKind,
  type GroupRule,
  type LineSeparator,
  type PageSize,
  type Period,
  type RecordTemplate,
  type RunItem,
  type RunValue,
  recordsToVCard,
  recordsToSheet,
  OFFICE_MIME_BY_EXT,
} from '@morph/core';

import { ArchiveError, createZip, extractZip, mimeTypeOfName } from '@morph/tool-archive';
import {
  QrError,
  decodeQr,
  downscaleRgba,
  encodePng,
  qrMatrix,
  qrToRgba,
  wifiProblem,
  wifiText,
  MAX_TEXT_LENGTH,
} from '@morph/tool-qr';
import { textToDocDoc, writeDocx, writeRowsXlsx } from '@morph/tool-office';

import { copyExcelAttachments, requireRecordTable } from './record-export';
import { fillRecord } from './record-fill';

import { openFieldLink } from '../../renderer/open-link';
import { collectAttachments, mergeReport, type CollectedAttachments } from './report-attachments';
import {
  MB,
  baseName,
  displayName,
  extOf,
  fileItems,
  freshName,
  readItem,
  writeItem,
  type RunServices,
} from './helpers';

// Other T6 actions: input text, read records, ZIP, QR code, text to PDF, generate PDF from records.
// Text and records are processed locally only (D-036, D-042).

type Impl = ActionImpl<RunServices>;

const openLinkAction =
  (opens: LinkKind): Impl =>
  async (input, _params, ctx) => {
    const value = textOf(input);
    const link = actionLink(opens, value.text);
    if (!link) throw new RunError('badLink');
    openFieldLink(link, ctx.locale);
    return value;
  };

const textOf = (input: RunValue | null) => {
  if (!input || input.type !== 'text') throw new RunError('unexpected', { detail: 'no text' });
  return input;
};

export const MORE_IMPLS: Record<string, Impl> = {
  async 'in.text'(_input, params, ctx) {
    const text = String(params.text ?? '').trim();
    if (!text) throw new RunError('emptyText');
    return {
      type: 'text',
      text,
      name: t(ctx.locale, 'more_Text_6ebbd'),
    };
  },

  async 'in.wifi'(_input, params, ctx) {
    // Password asked on every run, only for this run (D-199, D-194).
    const network = {
      name: String(params.network ?? ''),
      security: params.security as 'WPA' | 'WEP' | 'none',
      password: ctx.secrets.password ?? '',
      hidden: params.hidden === true,
    };

    switch (wifiProblem(network)) {
      case 'name':
        throw new RunError('badField', { name: t(ctx.locale, 'more_Network_name_1c98e') });
      case 'passwordMissing':
        throw new RunError('passwordMissing');
      case 'password':
        throw new RunError('badField', {
          name: t(ctx.locale, 'more_Password_8_63_characters_1c4be'),
        });
    }
    return { type: 'text', text: wifiText(network), name: network.name };
  },

  async 'in.records'(_input, params, ctx) {
    const collection = ctx.services.collections.find((c) => c.id === params.collectionId);
    if (!collection) throw new RunError('notFound', { name: String(params.collectionId) });
    const period = params.period as 'all' | Period;
    // Find, aggregate, previous record (D-291) include computed values so they can be printed in reports.
    let { records } = await loadComputedRecords(
      (id) => ctx.services.repo.listRecords(id),
      ctx.services.collections,
      collection,
      ctx.now(),
      ctx.services.calendar,
    );
    if (period !== 'all') {
      const cal = ctx.services.calendar;
      const [start, end] = periodRange(period, ctx.now(), cal);
      // According to the first date field in the table; if no date field exists, use the creation time (date determination follows D-286).
      const dateField = collection.fields.find((f) => f.type === 'date');
      records = records.filter((r) => {
        const raw = dateField ? r.values[dateField.id] : dayOf(new Date(r.createdAt), cal);
        return typeof raw === 'string' && raw >= start && raw <= end;
      });
    }
    if (records.length === 0) throw new RunError('noRecords', { name: collection.name });
    const dateField = collection.fields.find((f) => f.type === 'date');
    const sorted = sortRecords(records, collection, {
      field: dateField?.id ?? 'createdAt',
      direction: 'asc',
    });
    return { type: 'records', collectionId: collection.id, records: sorted, name: collection.name };
  },

  async 'print.records'(input, params, ctx) {
    if (!input || input.type !== 'records') {
      throw new RunError('unexpected', { detail: 'no records' });
    }
    const table = ctx.services.collections.find((c) => c.id === input.collectionId);
    if (!table) throw new RunError('notFound', { name: input.name });
    // Find, aggregate, and previous record print using the type of field they display (D-291; values are computed in in.records).
    const collection = expandCollection(ctx.services.collections, table);
    const pageSize = params.pageSize as PageSize;
    // Reference fields print the title of the referenced record (D-250).
    const links = await loadLinkResolver(
      (id) => ctx.services.repo.listRecords(id),
      ctx.services.collections,
      linkedCollectionIds(collection),
      ctx.locale,
    );
    const fields = (params.fields as string[] | undefined) ?? [];
    const name = String(params.title || '').trim() || collection.name;
    const report = (notes: readonly string[]) =>
      printHtml(
        ctx.services,
        recordsToHtml(collection, input.records, {
          links,
          template: params.template as RecordTemplate,
          title: String(params.title ?? ''),
          fields,
          pageSize,
          locale: ctx.locale,
          now: ctx.now(),
          notes,
        }),
        pageSize,
        name,
      );
    if (params.attachments !== true) return { type: 'pdf', items: [await report([])] };
    // D-425: Process attachments first so reports can state which ones were not included. Originals are read-only; intermediate files belong to this run and are deleted after use.
    let collected: CollectedAttachments | undefined;
    try {
      collected = await collectAttachments(
        ctx,
        collection,
        input.records,
        { fields, pageSize, links },
        (html, relName) => printHtml(ctx.services, html, pageSize, relName),
      );
      const item = await mergeReport(ctx, collected, report, name);
      return { type: 'pdf', items: [item] };
    } finally {
      await collected?.cleanup();
    }
  },

  // D-423: Generate files only when the user runs this quick action; leaving the app also requires chaining out.share, which is also user-triggered (invariant 10).
  async 'records.toVCard'(input, _params, ctx) {
    if (!input || input.type !== 'records') {
      throw new RunError('unexpected', { detail: 'no records' });
    }
    const table = ctx.services.collections.find((c) => c.id === input.collectionId);
    if (!table) throw new RunError('notFound', { name: input.name });
    const text = recordsToVCard(table.fields, input.records);
    if (!text) throw new RunError('noRecords', { name: input.name });
    const item = await writeItem(ctx.services, new TextEncoder().encode(text), {
      name: input.name,
      ext: 'vcf',
      mimeType: 'text/vcard',
    });
    return { type: 'files', items: [item] };
  },

  // D-428: Same content as records.toVCard, but as text: can be chained to generate a QR code.
  async 'records.toVCardText'(input, _params, ctx) {
    if (!input || input.type !== 'records') {
      throw new RunError('unexpected', { detail: 'no records' });
    }
    const table = ctx.services.collections.find((c) => c.id === input.collectionId);
    if (!table) throw new RunError('notFound', { name: input.name });
    const text = recordsToVCard(table.fields, input.records);
    if (!text) throw new RunError('noRecords', { name: input.name });
    return { type: 'text', text, name: input.name };
  },

  // D-428: Open text passed in: system dialer, SMS, email compose, browser pages; nothing is sent out. The only rule is core's actionLink.
  'out.call': openLinkAction('phone'),
  'out.message': openLinkAction('message'),
  'out.email': openLinkAction('email'),
  'out.website': openLinkAction('url'),

  // D-427: Like vCard, creates only a single file, and leaving the app requires chaining out.share (invariant 10). Columns are the same as CSV.
  async 'records.toExcel'(input, params, ctx) {
    if (!input || input.type !== 'records') {
      throw new RunError('unexpected', { detail: 'no records' });
    }
    const table = ctx.services.collections.find((c) => c.id === input.collectionId);
    if (!table) throw new RunError('notFound', { name: input.name });
    if (input.records.length === 0) throw new RunError('noRecords', { name: input.name });
    const collection = expandCollection(ctx.services.collections, table);
    const links = await loadLinkResolver(
      (id) => ctx.services.repo.listRecords(id),
      ctx.services.collections,
      linkedCollectionIds(collection),
      ctx.locale,
    );
    requireRecordTable(input, params.collectionId);
    const attachments =
      params.attachments === true
        ? await copyExcelAttachments(ctx, collection, input.records)
        : null;
    const rows = recordsToSheet(collection, input.records, ctx.locale, links, {
      fields: params.fields as string[] | undefined,
    });
    if (attachments) {
      rows[0]!.push({ kind: 'text', text: t(ctx.locale, 'exportAttachments') });
      attachments.rows.forEach((text, i) => rows[i + 1]!.push({ kind: 'text', text }));
    }
    const item = await writeItem(ctx.services, writeRowsXlsx(table.name, rows), {
      name: table.name,
      ext: 'xlsx',
      mimeType: OFFICE_MIME_BY_EXT.xlsx!,
    });
    return { type: 'files', items: [item, ...(attachments?.items ?? [])] };
  },

  'records.fill': fillRecord,

  async 'text.toPdf'(input, params, ctx) {
    const value = textOf(input);
    const pageSize = params.pageSize as PageSize;
    const html = textToHtml(value.text, { fontSize: Number(params.fontSize), pageSize });
    return { type: 'pdf', items: [await printHtml(ctx.services, html, pageSize, value.name)] };
  },

  async 'text.toFile'(input, _params, ctx) {
    const value = textOf(input);
    const bytes = new TextEncoder().encode(value.text);
    const item = await writeItem(ctx.services, bytes, {
      name: value.name,
      ext: 'txt',
      mimeType: 'text/plain',
    });
    return { type: 'files', items: [item] };
  },

  async 'text.toDocx'(input, _params, ctx) {
    const value = textOf(input);
    const doc = textToDocDoc(value.text);
    if (doc.pages[0]!.blocks.length === 0) throw new RunError('emptyText');
    const item = await writeItem(ctx.services, writeDocx(doc), {
      name: value.name,
      ext: 'docx',
      mimeType: OFFICE_MIME_BY_EXT.docx!,
    });
    return { type: 'files', items: [item] };
  },

  async 'text.copy'(input, _params, ctx) {
    const value = textOf(input);
    await ctx.services.files.copyText(value.text);
    return value;
  },

  // Text processing (D-245): Processed locally only. If the result is empty, it means do not pass empty text to the next step.
  async 'text.tidy'(input, params) {
    const value = textOf(input);
    const text = tidyText(value.text, params.blankLines as BlankLines, params.spaces === true);
    if (!text) throw new RunError('emptyText');
    return { ...value, text };
  },

  async 'text.replace'(input, params) {
    const value = textOf(input);
    const { text } = replaceText(
      value.text,
      String(params.find ?? ''),
      String(params.replaceWith ?? ''),
      params.ignoreCase === true,
    );
    if (!text.trim()) throw new RunError('emptyText');
    return { ...value, text };
  },

  async 'text.extract'(input, params, ctx) {
    const value = textOf(input);
    const text = extractText(value.text, params.kind as ExtractKind, ctx.locale);
    if (!text) throw new RunError('notFound', { name: value.name });
    return { ...value, text };
  },

  async 'text.lines'(input, params) {
    const value = textOf(input);
    const text = splitOrJoinLines(
      value.text,
      params.mode as 'split' | 'join',
      params.separator as LineSeparator,
    );
    if (!text.trim()) throw new RunError('emptyText');
    return { ...value, text };
  },

  async 'zip.create'(input, params, ctx) {
    const items = fileItems(input);
    // Pack in memory using fflate: video and audio also count towards the 50 MB limit of P-006 and cannot use MEDIA_LIMITS (D-142).
    for (const item of items) {
      if (item.size > FILE_LIMITS.maxFileBytes) {
        throw new RunError('tooLarge', {
          name: displayName(item),
          mb: FILE_LIMITS.maxFileBytes / MB,
        });
      }
    }
    // D-243: Group into one ZIP per group, named after the group name (date or the name of the first file).
    const groups = groupItems(
      items,
      params.group as GroupRule | undefined,
      params.groupSize as number | undefined,
      t(ctx.locale, 'groupUndated'),
    );
    const zips: RunItem[] = [];
    let done = 0;
    for (const group of groups) {
      const entries = [];
      for (const item of group.items) {
        ctx.throwIfCancelled();
        entries.push({ name: displayName(item), bytes: await readItem(ctx.services, item) });
        ctx.progress(++done, items.length);
      }
      let bytes: Uint8Array;
      try {
        bytes = createZip(entries);
      } catch (e) {
        throw archiveError(e, group.items[0]!);
      }
      zips.push(
        await writeItem(ctx.services, bytes, {
          name: group.name,
          ext: 'zip',
          mimeType: 'application/zip',
        }),
      );
    }
    return { type: 'zip', items: zips };
  },

  async 'zip.extract'(input, _params, ctx) {
    const out: RunItem[] = [];
    for (const item of fileItems(input)) {
      ctx.throwIfCancelled();
      let entries;
      try {
        entries = extractZip(await readItem(ctx.services, item));
      } catch (e) {
        throw archiveError(e, item);
      }
      for (const [i, entry] of entries.entries()) {
        // Remove directory nesting levels in the archive, keeping only file names (tool-archive has already removed paths like ../).
        const fileName = entry.name.split('/').pop()!;
        out.push(
          await writeItem(ctx.services, entry.bytes, {
            name: baseName(fileName),
            ext: extOf(fileName) || 'bin',
            mimeType: entry.mimeType || mimeTypeOfName(fileName),
          }),
        );
        ctx.progress(i + 1, entries.length);
      }
    }
    return { type: 'files', items: out };
  },

  async 'qr.generate'(input, params, ctx) {
    const value = textOf(input);
    let matrix;
    try {
      matrix = qrMatrix(value.text, { ecc: params.ecc as 'M' });
    } catch (e) {
      if (e instanceof QrError && e.code === 'tooLong') {
        throw new RunError('textTooLong', { max: MAX_TEXT_LENGTH });
      }
      throw new RunError('emptyText');
    }
    // An integer number of pixels per module, leaving a 4-module margin, as close to the requested size as possible.
    const scale = Math.max(1, Math.floor(Number(params.sizePx) / (matrix.size + 8)));
    const png = encodePng(qrToRgba(matrix, { scale }));
    const width = (matrix.size + 8) * scale;
    const item = await writeItem(ctx.services, png, {
      name: t(ctx.locale, 'more_QR_code_0d124'),
      ext: 'png',
      mimeType: 'image/png',
      width,
      height: width,
    });
    return { type: 'images', items: [item] };
  },

  async 'qr.read'(input, _params, ctx) {
    const items = fileItems(input);
    const found: string[] = [];
    for (const [i, item] of items.entries()) {
      ctx.throwIfCancelled();
      let pixels;
      try {
        pixels = await ctx.services.files.imagePixels(item.uri, 1600);
      } catch {
        throw new RunError('unreadable', { name: displayName(item) });
      }
      const text = decodeQr(downscaleRgba(pixels, 1600));
      if (text) found.push(text);
      ctx.progress(i + 1, items.length);
    }
    if (found.length === 0) throw new RunError('notFound', { name: displayName(items[0]!) });
    return { type: 'text', text: found.join('\n\n'), name: items[0]!.name };
  },
};

/** Convert HTML to PDF using system print layout. */
async function printHtml(
  services: RunServices,
  html: string,
  pageSize: PageSize,
  name: string,
): Promise<RunItem> {
  let out;
  try {
    out = await services.files.htmlToPdf(
      html,
      PAGE_POINTS[pageSize],
      services.runId,
      freshName(name, 'pdf'),
    );
  } catch (e) {
    throw new RunError('unexpected', { detail: String(e instanceof Error ? e.message : e) });
  }
  return {
    uri: out.uri,
    name,
    ext: 'pdf',
    mimeType: 'application/pdf',
    size: out.size,
    pageCount: out.pageCount,
  };
}

function archiveError(e: unknown, item: RunItem): RunError {
  const name = displayName(item);
  if (!(e instanceof ArchiveError)) return new RunError('unreadable', { name });
  switch (e.code) {
    case 'encrypted':
      return new RunError('encrypted', { name });
    case 'tooLarge':
      return new RunError('tooLargeTotal', { mb: 100 });
    case 'tooManyEntries':
      return new RunError('tooMany', { max: 500 });
    case 'empty':
      return new RunError('notFound', { name });
    default:
      return new RunError('unreadable', { name });
  }
}
