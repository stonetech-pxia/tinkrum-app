import type { Palette } from '../renderer/theme';
import { CloseButton } from './CloseButton';

/** Navigation bar style for the page stack (matches theme). */
export function stackScreenOptions(palette: Palette) {
  return {
    headerStyle: { backgroundColor: palette.background },
    headerShadowVisible: false,
    headerTintColor: palette.text,
    headerBackButtonDisplayMode: 'minimal',
    headerTitleStyle: { ...palette.font('title', 17), color: palette.text } as never,
    contentStyle: palette.backdrop,
  } as const;
}

/** "Close" button in the top left corner of modal pages (D-111). */
export function closeButtonOption(palette: Palette) {
  return { headerLeft: () => <CloseButton palette={palette} /> };
}
