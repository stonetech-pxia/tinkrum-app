import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { t } from '../messages';
import { boundedText, IdSchema } from '../schema-base';
import { defineLook, type LookDefinitionOf } from './define';

// Minimal appearance definition in docs/COMPONENTS.md step 1: this file undergoes type checking and
// execution, so incorrect syntax (changed defineLook signature, renamed keys) will fail compilation
// here first. Keep documentation code consistent with this file; update here first when changing
// defineLook, then update the documentation.

const shape = {
  show: z.strictObject({ title: boundedText(1, 60) }),
  source: z.strictObject({ table: IdSchema }),
};

export const exampleComponent: LookDefinitionOf<'example', typeof shape> = defineLook({
  look: 'example',
  shape,
  kind: 'container',
  layer: 'table',
  reads: 'table',
  writes: false,
  refs: { 'source.table': { to: 'table' } },
  describe: (c, _config, ctx) => t(ctx.locale, 'describeChart', { v0: c.show.title }),
  edit: { text: [{ prop: 'title', max: 60 }], style: ['tone'] },
  ai: { doc: 'show {title}, source {table}: one number per entry of the table' },
  example: { show: { title: 'Spending' }, source: { table: 'expenses' } },
});

describe('Minimal appearance definition in docs/COMPONENTS.md', () => {
  it('Generated schema accepts valid examples and rejects extraneous keys', () => {
    const block = { id: 'x', look: 'example', ...exampleComponent.example };
    expect(exampleComponent.schema.safeParse(block).success).toBe(true);
    expect(exampleComponent.schema.safeParse({ ...block, extra: 1 }).success).toBe(false);
    expect(exampleComponent.schema.safeParse({ ...block, show: { title: '' } }).success).toBe(
      false,
    );
  });
});
