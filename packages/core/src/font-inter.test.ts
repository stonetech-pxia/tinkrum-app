import { describe, expect, it } from 'vitest';

import { FONT_CHOICES, ThemeSchema } from './schema-base';
import { createDefaultWorkspace } from './defaults';

// Additional theme font inter (D-591): writing "inter" passes, unrecognized names are rejected as usual.

const theme = createDefaultWorkspace('zh').theme;

describe('theme font inter (D-591)', () => {
  it('is one of the choices and a theme with it validates', () => {
    expect(FONT_CHOICES).toContain('inter');
    expect(ThemeSchema.safeParse({ ...theme, font: 'inter' }).success).toBe(true);
  });

  it('still refuses a font name the app does not have', () => {
    expect(ThemeSchema.safeParse({ ...theme, font: 'comic-sans' }).success).toBe(false);
  });
});
