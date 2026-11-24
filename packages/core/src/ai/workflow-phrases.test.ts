import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CORE_ACTIONS } from '../registry';
import { BUILTIN_TOOLS } from '../tools';
import { parseStepPhrase, splitStepPhrases } from './workflow-phrases';

// Step phrasings are defined within individual action definitions (D-265), and built-in rules are
// checked action by action: when phrasings of two actions match a single phrase, the result depends
// on the check order. We check this using the phrase list and phrases appearing in built-in rule
// tests to prevent such overlaps.

const actions = [...CORE_ACTIONS, ...BUILTIN_TOOLS.flatMap((t) => t.actions)];

function fragments(): Set<string> {
  const files = [
    path.resolve(__dirname, '../../../../docs/MOCK_AI_PHRASES.md'),
    ...fs
      .readdirSync(__dirname)
      .filter((f) => /^mock.*\.test\.ts$|^eval-cases\.ts$/.test(f))
      .map((f) => path.join(__dirname, f)),
  ];
  // Phrases missing from the list (which could be recognized by both actions).
  const all = new Set<string>([
    '合并成一个',
    '合成一个',
    '合并',
    'merge',
    'join',
    'record',
    'save it',
  ]);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const quoted of text.matchAll(/['"`“「]([^'"`\n”」]{1,200})['"`”」]/g))
      for (const part of quoted[1]!.split(/[:：]/))
        for (const p of splitStepPhrases(part))
          all.add(p.replace(/^(?:再|然后|最后|先|接着|and then|then|and)\s*/i, '').trim());
    for (const line of text.split('\n'))
      for (const p of line.split(/[/|、，,；;（）()「」“”]/)) all.add(p.trim());
  }
  return all;
}

describe('step phrases in action definitions', () => {
  it('no phrase is claimed by two actions', () => {
    let matched = 0;
    for (const text of fragments()) {
      const owners = actions.filter((a) => a.phrases?.some((p) => p.match.test(text)));
      if (owners.length > 0) matched++;
      expect(
        owners.map((a) => a.id),
        text,
      ).toHaveLength(Math.min(owners.length, 1));
    }
    expect(matched).toBeGreaterThan(50);
  });

  it('turns a phrase into its action and parameters', () => {
    expect(parseStepPhrase('压到 500KB', 'zh')).toEqual({
      action: 'image.compress',
      params: { maxKB: 500, format: 'jpeg' },
    });
    expect(parseStepPhrase('合并成一个', 'zh')?.action).toBe('audio.merge');
    expect(parseStepPhrase('合并成一个 PDF', 'zh')?.action).toBe('pdf.merge');
    expect(parseStepPhrase('按"合并-日期"命名', 'zh')).toEqual({
      action: 'file.rename',
      params: { template: '合并-{date:YYYY-MM-DD}' },
    });
    expect(parseStepPhrase('翻译', 'fr')).toMatchObject({ action: 'translate.text', ask: ['to'] });
    // Export to Excel (D-272): language matches interface language, defaults to all content.
    expect(parseStepPhrase('表格转 Excel', 'zh')).toEqual({
      action: 'ocr.toExcel',
      params: { lang: 'auto', scope: 'all' },
    });
    expect(parseStepPhrase('convert to an Excel workbook', 'fr')).toEqual({
      action: 'ocr.toExcel',
      params: { lang: 'auto', scope: 'all' },
    });
    // Convert to Word (D-328): automatic language.
    expect(parseStepPhrase('转成 Word', 'zh')).toEqual({
      action: 'ocr.toWord',
      params: { lang: 'auto' },
    });
    expect(parseStepPhrase('convert to a Word document', 'en')).toEqual({
      action: 'ocr.toWord',
      params: { lang: 'auto' },
    });
  });

  // After the save buttons were renamed to "Save to phone" and "Save to Tinkrum" (2026-11-09), phrasing matching the button text must also be recognized.
  it('knows the words on the save buttons', () => {
    expect(parseStepPhrase('存到手机', 'zh')?.action).toBe('out.saveToFolder');
    expect(parseStepPhrase('save to phone', 'en')?.action).toBe('out.saveToFolder');
    expect(parseStepPhrase('save them to my phone', 'en')?.action).toBe('out.saveToFolder');
    expect(parseStepPhrase('存到 Tinkrum', 'zh')?.action).toBe('file.save');
    expect(parseStepPhrase('save to Tinkrum', 'en')?.action).toBe('file.save');
  });
});
