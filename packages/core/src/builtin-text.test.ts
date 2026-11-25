import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { builtinText } from './builtin-text';
import { applyOps } from './ops';
import { pageTarget, TOOLBOX_PAGE_ID } from './schema';
import { createStarterWorkspace, paperAppOps } from './starter';
import { registry } from './test-helpers';

// User report (2026-11-06 emulator): workspace created in Chinese retains Chinese group names and installed tool names in the toolbox after switching to French.
describe('builtinText', () => {
  const withPaper = (locale: 'zh' | 'fr') => {
    const start = createStarterWorkspace(locale, registry);
    const result = applyOps(start, paperAppOps(start, locale, registry), { registry, locale });
    if (!result.ok) throw new Error(result.error);
    return result.config;
  };
  const toolboxOf = (config: ReturnType<typeof withPaper>) =>
    config.containers.pages.find((p) => p.id === 'paper-toolbox')!;
  const zh = withPaper('zh');
  const toolbox = toolboxOf(zh);
  const imagePage = zh.containers.pages.find((p) => p.package === 'image')!;

  it('shows the starter texts of a Chinese workspace in French and English', () => {
    expect(builtinText(toolbox.title, 'fr', registry)).toBe(toolboxOf(withPaper('fr')).title);
    // "Paper" is the app's name in every language (D-645) and is never translated.
    for (const locale of ['zh', 'en', 'fr'] as const)
      expect(builtinText(zh.nav.apps![0]!.name, locale, registry)).toBe('Paper');
    expect(builtinText('照片、视频和声音', 'en', registry)).toBe('Photos, video and audio');
    expect(builtinText(imagePage.title, 'en', registry)).not.toMatch(/[一-鿿]/);
    expect(builtinText('图片转 PDF', 'fr', registry)).toBe('Images en PDF');
    expect(builtinText('最近操作', 'en', registry)).not.toMatch(/[一-鿿]/);
  });

  it('keeps what the user wrote', () => {
    expect(builtinText('我的工具', 'en', registry)).toBe('我的工具');
    expect(builtinText(undefined, 'en', registry)).toBeUndefined();
    expect(builtinText('', 'en', registry)).toBe('');
  });

  it('round-trips between all three languages', () => {
    const fr = builtinText('Photos, video and audio', 'fr', registry);
    expect(builtinText(fr, 'zh', registry)).toBe('照片、视频和声音');
  });

  it('does not translate ids and targets', () => {
    expect(builtinText(pageTarget(TOOLBOX_PAGE_ID), 'zh', registry)).toBe(
      pageTarget(TOOLBOX_PAGE_ID),
    );
  });

  // Found on simulator (2026-11-14): Portal's Clay preset retains English title, description, and bookshelf name on the "Files" page after switching to French.
  it('shows every text of the Clay preset in French and Chinese', () => {
    const file = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'portal-apps', 'tinkrum-app-clay.json'), 'utf8'),
    ) as { pages: { title: string; blocks: { show?: Record<string, unknown> }[] }[] };
    const texts = file.pages.flatMap((p) => [
      p.title,
      ...p.blocks.flatMap((b) =>
        ['title', 'subtitle', 'label']
          .map((k) => b.show?.[k])
          .filter((v): v is string => typeof v === 'string'),
      ),
    ]);
    // Words with identical English spelling (names, format names, French "Images") require no translation.
    const same = {
      fr: ['Tinkrum', 'PDF', 'Word', 'Excel', 'Images'],
      zh: ['Tinkrum', 'PDF', 'Word', 'Excel'],
    };
    for (const locale of ['fr', 'zh'] as const) {
      const left = texts.filter(
        (s) => !same[locale].includes(s) && builtinText(s, locale, registry) === s,
      );
      expect(left, locale).toEqual([]);
    }
    expect(builtinText('Everything you scan, convert or open, by type.', 'fr', registry)).toBe(
      'Tout ce que vous scannez, convertissez ou ouvrez, classé par type.',
    );
    expect(builtinText('Images', 'zh', registry)).toBe('图片');
  });
});
