import { createDefaultWorkspace } from '@morph/core';

import { INTER_FONTS, makePalette } from '../renderer/theme';

// Inter 字体（D-591）：数字和大标题（display）用中等粗细，不是粗体；每个角色一个静态字体，不叠 fontWeight。

const theme = (font: 'clay' | 'inter') => ({ ...createDefaultWorkspace('zh').theme, font });

describe('theme font "inter" (D-591)', () => {
  it('draws numbers and big titles in Inter Medium, not bold', () => {
    const style = makePalette(theme('inter'), false).font('display', 26);
    expect(style).toMatchObject({ fontFamily: 'Inter_500Medium', fontSize: 26 });
    expect(style).not.toHaveProperty('fontWeight');
  });

  it('gives every role its own static Inter font', () => {
    const palette = makePalette(theme('inter'), false);
    for (const role of Object.keys(INTER_FONTS) as (keyof typeof INTER_FONTS)[]) {
      expect(palette.font(role, 14).fontFamily).toBe(INTER_FONTS[role]);
    }
    expect(INTER_FONTS.display).toBe('Inter_500Medium');
    expect(INTER_FONTS.bodyBold).toBe('Inter_700Bold');
  });

  it('leaves the default clay fonts as they were', () => {
    expect(makePalette(theme('clay'), false).font('display', 26).fontFamily).toBe('Sora_700Bold');
  });
});
