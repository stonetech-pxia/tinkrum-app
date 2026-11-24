import { describe, expect, it } from 'vitest';

import { AUDIO_COMPRESS_PARAMS, AUDIO_CONVERT_PARAMS, AUDIO_ACTIONS } from '../tools/audio';
import { implOf, type StepContext } from './engine';

// R14: Action parameter schemas and implementations are tied together—the params type in the implementation is inferred from the schema (type checking in this file acts as the test).

describe('implOf', () => {
  it('passes the params through and types them from the schema', async () => {
    let seen: unknown;
    const impl = implOf(AUDIO_CONVERT_PARAMS, async (_input, params) => {
      // Type is 'm4a' | 'wav' | 'mp3' | ..., not unknown.
      const format: string = params.format;
      // @ts-expect-error parameter does not exist in schema: if renamed in core, implementation compilation will fail here
      void params.nothing;
      seen = format;
      return { type: 'files', items: [] };
    });
    await impl(null, { format: 'm4a' }, {} as StepContext<unknown>);
    expect(seen).toBe('m4a');
  });

  it('the definition and the implementation share one schema object', () => {
    const compress = AUDIO_ACTIONS.find((a) => a.id === 'audio.compress')!;
    const convert = AUDIO_ACTIONS.find((a) => a.id === 'audio.convert')!;
    expect(compress.params).toBe(AUDIO_COMPRESS_PARAMS);
    expect(convert.params).toBe(AUDIO_CONVERT_PARAMS);
  });
});
