import { rulePreset } from '@morph/core';
import { useEffect, useMemo, useState } from 'react';

import { readableKind, readPagesOf, type AttachmentTextDeps } from '../data/attachment-text';
import { usePacks } from '../packs/PackHost';
import { VISION_LANGUAGES } from '../runtime/actions/ocr';
import { resolveOcrLanguage } from '../runtime/ocr-language';
import type { PickedFile } from '../runtime/platform';
import { useWorkspaceContext } from '../workspace/context';

/**
 * Whether received files look like receipts (receipts, bills, invoices with totals, D-476,
 * D-477): read text from the first 3 files locally, evaluate using rules (`rulePreset`), discard
 * after reading without storing or sending to the AI. If OCR is unavailable, unreadable, or
 * dissimilar: all false, panel remains unchanged without throwing errors. Not read when there is
 * no table with receipt rules (no recommendations available). Read-only, originals untouched
 * (Invariant 4).
 */
export function useReceiptLike(picked: readonly PickedFile[], enabled: boolean): boolean {
  const { files, locale } = useWorkspaceContext();
  const packs = usePacks();
  const [like, setLike] = useState(false);
  const deps = useMemo<AttachmentTextDeps>(
    () => ({
      files,
      packs: packs && {
        runtime: packs.bridge,
        isInstalled: (id: string) => packs.store.isInstalled(id),
      },
      languages: VISION_LANGUAGES[resolveOcrLanguage('auto', locale)],
      newRunId: () => `receipt-like-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),
    [files, packs, locale],
  );
  const key = picked.map((p) => p.uri).join('|');
  useEffect(() => {
    const items = picked.flatMap((p) => {
      const kind = readableKind({ mimeType: p.mimeType ?? '', name: p.name });
      // Read images only: PDFs require re-reading text layers or rendering pages, and forms require another read; defer for now.
      return kind === 'image' ? [{ kind, uri: p.uri }] : [];
    });
    if (!enabled || items.length === 0) return;
    const abort = new AbortController();
    void readPagesOf(items, deps, abort.signal)
      .then((pages) => {
        if (!abort.signal.aborted) setLike(rulePreset(pages) === 'purchase');
      })
      .catch(() => undefined);
    return () => abort.abort();
    // Key represents this batch of files; picked itself is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, deps, enabled]);
  return like;
}
