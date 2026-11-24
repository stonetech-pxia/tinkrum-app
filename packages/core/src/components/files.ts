import { z } from 'zod';

import { FILES_TABLE } from '../files-table';
import { t } from '../messages';
import { boundedText, filterSchema, SortSchema } from '../schema-base';
import { type LookDefinitionOf, defineLook } from './define';

const shape = {
  show: z.strictObject({ title: boundedText(1, 60) }),
  /** Reads system table $files (Q2); sorting defaults to creation time newest-first (same-day order) if omitted. */
  source: z.strictObject({
    table: z.literal(FILES_TABLE),
    filter: filterSchema().optional(),
    sort: SortSchema.optional(),
    limit: z.number().int().min(1).max(50),
  }),
};

/** File list (original fileList): a category of user files (filtering automatic fields like kind in $files). */
export const filesComponent: LookDefinitionOf<'files', typeof shape> = defineLook({
  look: 'files',
  shape,
  kind: 'container',
  layer: 'file',
  reads: 'files',
  writes: false,
  describe: (c, _config, ctx) => t(ctx.locale, 'describe_file_list_a11dd', { v0: c.show.title }),
  edit: { text: [{ prop: 'title', max: 60 }], style: [] },
  ai: {
    doc: 'show {title}, source {table: "$files", filter? (on name, kind: "image"|"pdf"|"video"|"audio"|"sheet"|"doc"|"other", size, source, createdAt), sort?, limit (1-50)}: the user\'s files of that kind; for "their documents" filter kind isNot "image" (photos used in image blocks are not listed). You never see file names or contents.',
  },
  example: {
    show: { title: 'Recent PDFs' },
    source: {
      table: '$files',
      filter: [{ field: 'kind', op: 'is', value: 'pdf' }],
      limit: 5,
    },
  },
});
