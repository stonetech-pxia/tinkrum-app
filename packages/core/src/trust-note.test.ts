import { describe, expect, it } from 'vitest';

import { en } from './messages/en';
import { fr } from './messages/fr';
import { zh } from './messages/zh';

// D-436: Named Tink in the UI, but the trust notice must inform the user that it is an AI and state who provides it by default.
describe('trust note says what Tink is', () => {
  it.each([
    ['en', en.trustNote, /Tink is this app’s AI/],
    ['zh', zh.trustNote, /Tink 是这个 App 里的 AI/],
    ['fr', fr.trustNote, /Tink est l’IA de cette application/],
  ])('%s', (_locale, note, says) => {
    expect(note).toMatch(says);
    expect(note).toContain('Claude');
    expect(note).toContain('Anthropic');
  });
});
