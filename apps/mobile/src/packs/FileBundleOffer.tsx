import type { Locale } from '@morph/core';
import { useState, type ReactNode } from 'react';

import type { Palette } from '../renderer/theme';
import { useWorkspaceContext } from '../workspace/context';
import { FILE_BUNDLE_ASKED, fileBundleToOffer } from './file-bundle';
import { PackGate } from './PackGate';
import { usePacks } from './PackHost';

/**
 * File bundle offer asked all at once (D-456): offer() is called after the first scan, share, or
 * file opening; once asked, it is not asked again. Tapping download or remind me later records
 * that it was "asked" (invariant 16: writes originate from user actions).
 */
export function useFileBundleOffer(
  palette: Palette,
  locale: Locale,
): { offer: () => void; element: ReactNode } {
  const { repo, files } = useWorkspaceContext();
  const packs = usePacks();
  const [needs, setNeeds] = useState<string[] | null>(null);

  function offer() {
    if (!packs) return;
    void fileBundleToOffer(repo, files, packs.store)
      .then((missing) => {
        if (missing.length > 0) setNeeds(missing);
      })
      .catch(() => {
        // If it cannot be read, do not ask this time and try again later.
      });
  }

  const element =
    needs && packs ? (
      <PackGate
        bundle
        needs={needs.map((pack) => ({ pack, optional: true }))}
        store={packs.store}
        palette={palette}
        locale={locale}
        onDone={() => {
          setNeeds(null);
          void repo.setMeta(FILE_BUNDLE_ASKED, '1');
        }}
      />
    ) : null;
  return { offer, element };
}
