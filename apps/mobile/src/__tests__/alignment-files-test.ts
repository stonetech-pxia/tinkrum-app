import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// D-454: There are only two vertical lines on the page: block borders and text outside blocks align
// with the page margin palette.pad, while content inside blocks is indented by palette.inset. These
// files render elements that float on the page or adhere to page margins: left and right offsets
// adhering to page margins must come exclusively from palette. Small buttons and small capsule
// internal padding (e.g., paddingHorizontal: 12) and single-digit shape offsets (such as bubble
// arrow tips) are excluded.

const SRC = join(__dirname, '..');
const FILES = [
  'shell/Shell.tsx',
  'shell/Banner.tsx',
  'shell/ChangeScreen.tsx',
  'shell/AISettingsScreen.tsx',
  'guide/GuideBubble.tsx',
  'guide/GuideCard.tsx',
  'guide/SampleHint.tsx',
  'renderer/IconButton.tsx',
  'renderer/FileList.tsx',
  'renderer/RecentActions.tsx',
  'app/files.tsx',
];

/**
 * Hardcoded left/right margins adhering to page margins: left / right / marginHorizontal assigned
 * literal numbers, or calculated as pad - 2. Small buttons, small capsule internal paddings (like
 * paddingHorizontal: 12), and single-digit shape offsets (bubble tips) are excluded.
 */
const HARD_CODED = /\b(?:left|right|marginHorizontal): [1-9]\d\b|pad - 2/;

describe('page alignment uses the two theme lines (D-454)', () => {
  it.each(FILES)('%s has no hard-coded side spacing', (file) => {
    const lines = readFileSync(join(SRC, file), 'utf8')
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => !line.trim().startsWith('//') && HARD_CODED.test(line));
    expect(lines).toEqual([]);
  });
});
