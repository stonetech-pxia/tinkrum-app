import { deflateSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';

import { appLink, appLinkPayload, readAppLink } from './app-link';
import { MAX_APP_CONFIG_SIZE } from './config-file';

it('round trips Unicode, punctuation and a large file with the payload only in the fragment', () => {
  for (const text of ['{"name":"账本 🪴 café & # + /"}', 'a'.repeat(MAX_APP_CONFIG_SIZE)]) {
    const link = appLink(text);
    expect(link).toMatch(/^https:\/\/tinkrum.stonetech.dev\/open#a=[\w-]+$/);
    expect(new URL(link).search).toBe('');
    expect(readAppLink(appLinkPayload(link)!)).toBe(text);
    expect(readAppLink(appLinkPayload(`morph://open?a=${link.split('#a=')[1]}`)!)).toBe(text);
  }
});

it('rejects truncated, corrupt, non-base64url and oversized input', () => {
  for (const bad of ['', 'a', 'abc+', 'abc=', '%%%20', 'AAAA', '_'.repeat(2_700_000)])
    expect(() => readAppLink(bad)).toThrow();
  expect(() => appLink('a'.repeat(MAX_APP_CONFIG_SIZE + 1))).toThrow();
  const payload = appLink('a'.repeat(5000)).split('#a=')[1]!;
  expect(() => readAppLink(payload.slice(0, -4))).toThrow();
});

it('stops expanding a compression bomb at the output limit', () => {
  const bomb = Buffer.from(deflateSync(strToU8('a'.repeat(MAX_APP_CONFIG_SIZE + 1)))).toString(
    'base64url',
  );
  expect(() => readAppLink(bomb)).toThrow(/too large/);
});

it('only extracts recognized import links; never changes unrelated routes or share links', () => {
  for (const link of [
    'morph://dataUrl=morphShareKey',
    'https://evil.test/open#a=abc',
    'https://tinkrum.stonetech.dev/other#a=abc',
    'morph://open?other=x',
    'morph://open?a=abc&a=def',
  ])
    expect(appLinkPayload(link)).toBeNull();
  expect(appLinkPayload('/open#a=abc')).toBe('abc');
  expect(appLinkPayload('/open?a=abc')).toBe('abc');
  expect(appLinkPayload('https://tinkrum.stonetech.dev/open#a=abc')).toBe('abc');
});
