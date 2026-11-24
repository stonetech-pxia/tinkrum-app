import {
  MAX_TRANSLATE_CHARS,
  RunCancelled,
  RunError,
  groupBySource,
  joinTranslation,
  splitForTranslation,
  translateLanguageName,
  type ActionImpl,
} from '@morph/core';

import { t } from '../../i18n';
import type { RunServices } from './helpers';

// Translate (D-170): system built-in local translation (iOS Translation framework, Android ML Kit).
// First split text into segments (core's splitForTranslation), group and translate by source
// language, then stitch back according to original segments. Text is processed entirely locally,
// never uploaded or sent to the AI (D-036).

type Impl = ActionImpl<RunServices>;

/** Number of segments to send to the system translator at once: if too large, the progress bar stalls for a long time; if too small, too many calls are made. */
const BATCH = 20;
const MB = 1024 * 1024;

const codeOf = (e: unknown) => (e as { code?: string }).code;

export const TRANSLATE_IMPLS: Record<string, Impl> = {
  async 'translate.text'(input, params, ctx) {
    if (input?.type !== 'text') throw new RunError('emptyText');
    const text = input.text.trim();
    if (!text) throw new RunError('emptyText');
    if (text.length > MAX_TRANSLATE_CHARS) {
      throw new RunError('textTooLong', { max: MAX_TRANSLATE_CHARS });
    }
    const { locale } = ctx;
    const translator = ctx.services.files.translator;
    if (!translator) {
      throw new RunError('unsupportedAction', { action: t(locale, 'translateNeedsFullApp') });
    }
    if (!translator.supported) {
      throw new RunError('unsupportedAction', { action: t(locale, 'translateOsTooOld') });
    }
    const from = String(params.from);
    const to = String(params.to);
    const name = (code: string) => translateLanguageName(code, locale);
    const names = (codes: readonly string[]) =>
      [...new Set(codes)].map(name).join(t(locale, 'separatorList'));

    const pieces = splitForTranslation(text);
    const flat = pieces.flat(2);
    const detected = from === 'auto' ? await translator.detectLanguages(flat) : null;
    const groups = groupBySource(flat, detected, from, to);
    // Already in the target language (e.g., translating Chinese content into Chinese): pass through to the next step as-is.
    if (groups.size === 0) return input;

    // First, ensure every language pair can be translated; for Android, ask for all required languages to be downloaded at once (D-064, D-112: only state how many to download and that they can be used offline afterwards).
    const missing = new Set<string>();
    // iOS does not report which language is missing; the system handles downloads per language pair.
    const systemPairs: string[] = [];
    for (const source of groups.keys()) {
      const status = await translator.status(source, to);
      if (status.status === 'unsupported') {
        throw new RunError('unsupportedAction', {
          action: t(locale, 'translatePairUnsupported', { from: name(source), to: name(to) }),
        });
      }
      if (status.status === 'download') {
        if (status.missing) for (const l of status.missing) missing.add(l);
        else systemPairs.push(source);
      }
    }
    // iOS: First explain that the system needs to download language packs (which may take a few minutes), then let the system download them; do not pause mid-translation to wait for downloads.
    if (systemPairs.length > 0 && translator.prepare) {
      const langs = names([...systemPairs, to]);
      const ok = await ctx.services.ui.confirm(
        t(locale, 'translateSystemDownloadAsk'),
        t(locale, 'translateDownload'),
        t(locale, 'cancel'),
        t(locale, 'translateSystemDownloadBody', { langs }),
      );
      if (!ok) throw new RunCancelled();
      for (const source of systemPairs) {
        ctx.throwIfCancelled();
        try {
          await translator.prepare(source, to);
        } catch (e) {
          if (codeOf(e) === 'cancelled') throw new RunCancelled();
          throw new RunError('packFailed', {
            detail: t(locale, 'translateDownloadFailed', { langs: names([source, to]) }),
          });
        }
      }
    }
    if (missing.size > 0 && translator.download) {
      const langs = names([...missing]);
      const mb = Math.round((missing.size * (translator.downloadBytes ?? 0)) / MB);
      const ok = await ctx.services.ui.confirm(
        t(locale, 'translateDownloadAsk', { mb }),
        t(locale, 'translateDownload'),
        t(locale, 'cancel'),
        t(locale, 'translateDownloadBody', { langs }),
      );
      if (!ok) throw new RunCancelled();
      for (const language of missing) {
        ctx.throwIfCancelled();
        try {
          await translator.download(language);
        } catch {
          throw new RunError('packFailed', {
            detail: t(locale, 'translateDownloadFailed', { langs }),
          });
        }
      }
    }

    const out = [...flat];
    const total = [...groups.values()].reduce((n, list) => n + list.length, 0);
    let done = 0;
    for (const [source, indexes] of groups) {
      for (let i = 0; i < indexes.length; i += BATCH) {
        ctx.throwIfCancelled();
        const batch = indexes.slice(i, i + BATCH);
        let result: string[];
        try {
          result = await translator.translate(
            batch.map((k) => flat[k]!),
            source,
            to,
          );
        } catch (e) {
          // iOS: The user tapped cancel in the system download dialog.
          if (codeOf(e) === 'cancelled') throw new RunCancelled();
          if (codeOf(e) === 'unsupported') {
            throw new RunError('unsupportedAction', {
              action: t(locale, 'translatePairUnsupported', { from: name(source), to: name(to) }),
            });
          }
          if (codeOf(e) === 'download') {
            throw new RunError('packFailed', {
              detail: t(locale, 'translateDownloadFailed', { langs: names([source, to]) }),
            });
          }
          throw new RunError('unexpected', { detail: String((e as Error).message ?? e) });
        }
        batch.forEach((k, j) => (out[k] = result[j] ?? flat[k]!));
        done += batch.length;
        ctx.progress(done, total);
      }
    }

    let k = 0;
    const translated = pieces.map((lines) => lines.map((parts) => parts.map(() => out[k++]!)));
    // Translated text stays on-device: the result page allows copying, subsequent steps can save as files or generate PDFs, and it is never sent to the AI.
    return { type: 'text', text: joinTranslation(translated, to), name: input.name };
  },
};
