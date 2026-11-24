import {
  attachmentIds,
  knownValues,
  modelEngine,
  parsePickStore,
  PICK_STORE_KEY,
  putPick,
  rememberPick,
  ruleEngine,
  serializePickStore,
  usesValueMemory,
  type Collection,
  type FieldPick,
  type FieldSuggestions,
  type Locale,
  type PackNeed,
  type PrefillEngine,
  type TextPage,
  type ValueSuggestion,
} from '@morph/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePacks } from '../packs/PackHost';
import { VISION_LANGUAGES } from '../runtime/actions/ocr';
import { openLocalModel } from '../runtime/local-model';
import { resolveOcrLanguage } from '../runtime/ocr-language';
import type { AssetRecord } from '../storage/types';
import { useWorkspaceContext } from '../workspace/context';
import {
  MAX_READ_FILES,
  missingPacks,
  readableKind,
  readAttachmentCodes,
  readAttachmentPages,
  ReadCancelled,
  type AttachmentTextDeps,
} from './attachment-text';

// New record form candidate values (D-394): when attachments contain photos or PDFs (and the table
// has not disabled `readAttachments`, D-397), reads text in the background, providing up to 3
// candidates for each empty field, filled only when tapped by the user, never automatically. Reads
// automatically once the OCR model is installed; otherwise displays a single prompt line,
// downloading only after the user taps and confirms in the download dialog (D-064). Cancels upon
// leaving the form. Tapped candidates are recorded locally in `app_meta` under `prefill:picks`
// (table and field: label and position, not the value); "Settings -> Data -> Prefill memory" allows
// exporting, restoring, and clearing. Recognized text, file names, and records are never sent to
// cloud AI. Store names and company lookup records cached by this table (invariant 14: values not
// duplicated, read-only). When the on-device model (D-396) is downloaded, model candidates populate
// later; the form is agnostic to the engine. Fields where the user has tapped a candidate keep
// their candidates static (D-388: tapped items stay in place). Text has two sources (D-575):
// attachment-derived (described above) and user speech from quick actions (`heard`,
// speech-to-text). Spoken text requires no attachments or OCR model downloads, is processed by the
// same engine as `heard`, and confident candidates are marked `sure` to be filled directly by the
// form.

export interface FieldSuggestionsState {
  /** Currently reading attachments. */
  working: boolean;
  /** Missing downloadable components (OCR model, PDF preview): displays a prompt line and button above the form. */
  missing: PackNeed[];
  suggestions: FieldSuggestions;
  /** Confirmation dialog prompts (after tapping the prompt button). */
  asking: PackNeed[] | null;
  ask(): void;
  /** Confirmation dialog closed: re-reads once download completes. */
  answered(left: string[] | null): void;
  /** User tapped a candidate: records the label and position for this table and field. */
  remember(fieldId: string, suggestion: ValueSuggestion): void;
}

const NONE: FieldSuggestions = {};
/** Treats spoken text as a single page with one line (engine consumes text only, position is ignored). */
const spokenPage = (text: string): TextPage => ({
  width: 1000,
  height: 40,
  lines: [{ text, x: 0, y: 0, width: 1000, height: 24 }],
});
const NO_NEEDS: PackNeed[] = [];

export function useFieldSuggestions({
  enabled,
  collection,
  values,
  locale,
  engine: given,
  onPages,
  heard,
}: {
  /** Only in new record forms (candidates are not provided when editing existing records). */
  enabled: boolean;
  collection: Collection | undefined;
  values: Record<string, unknown>;
  locale: Locale;
  /** Source of candidates (D-398); when omitted: in pack environment it equals code + on-device model (equivalent to code only when not downloaded). */
  engine?: PrefillEngine;
  /** Notifies caller when text is read (used by new form page to find field names and recommended presets, D-444), avoiding re-reading. */
  onPages?: (pages: TextPage[]) => void;
  /** User speech for this entry (D-575): when present, candidates originate from this phrase instead of reading attachments. */
  heard?: string | undefined;
}): FieldSuggestionsState {
  const { repo, files } = useWorkspaceContext();
  const packs = usePacks();
  const store = packs?.store;
  const engine = useMemo<PrefillEngine>(
    () => given ?? (store ? modelEngine(openLocalModel(store)) : ruleEngine),
    [given, store],
  );
  // Each reading result carries the basis of that read (attachments and download count); if the basis changes, old results are discarded.
  const [workingFor, setWorkingFor] = useState<string | null>(null);
  const [needs, setNeeds] = useState<{ run: string; list: PackNeed[] } | null>(null);
  const [found, setFound] = useState<{ run: string; suggestions: FieldSuggestions } | null>(null);
  const [asking, setAsking] = useState<PackNeed[] | null>(null);
  // Fields with tapped candidates: the candidates visible at the time of tapping.
  const [tapped, setTapped] = useState<{ run: string; lists: FieldSuggestions } | null>(null);
  // Increments after download completes to trigger a re-read.
  const [installs, setInstalls] = useState(0);
  const picks = useRef<Record<string, FieldPick>>({});
  // Prevents re-reading the same batch of attachments: recalculates candidates here whenever the new form page modifies fields (D-444).
  const read = useRef<{ run: string; pages: TextPage[]; codes: string[] } | null>(null);
  const tellPages = useRef(onPages);
  useEffect(() => {
    tellPages.current = onPages;
  });

  const spoken = enabled && heard !== undefined && heard.trim() !== '' ? heard.trim() : null;
  // Files in attachment fields (in field order), serving as the basis for re-reading.
  const ids = useMemo(
    () =>
      enabled && spoken === null && collection && collection.readAttachments !== false
        ? collection.fields.flatMap((f) => (f.type === 'file' ? attachmentIds(values[f.id]) : []))
        : [],
    [enabled, spoken, collection, values],
  );
  const key = spoken !== null ? `heard:${spoken}` : ids.join(',');
  const run = `${key}#${installs}`;

  const deps = useMemo<AttachmentTextDeps>(
    () => ({
      files,
      packs: packs && {
        runtime: packs.bridge,
        isInstalled: (id: string) => packs.store.isInstalled(id),
      },
      languages: VISION_LANGUAGES[resolveOcrLanguage('auto', locale)],
      newRunId: () => `prefill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),
    [files, packs, locale],
  );

  useEffect(() => {
    if (!collection || !key) return;
    const abort = new AbortController();
    void (async () => {
      const assets: AssetRecord[] = [];
      if (spoken === null) {
        for (const id of key.split(',')) {
          const a = await repo.getAsset(id);
          if (a && readableKind(a)) assets.push(a);
        }
      }
      const first = assets.slice(0, MAX_READ_FILES);
      if (abort.signal.aborted) return;
      if (spoken === null && first.length === 0) return;
      const kinds = first.map((a) => readableKind(a)!);
      const list = spoken === null ? await missingPacks(kinds, deps) : NO_NEEDS;
      picks.current = parsePickStore(await repo.getMeta(PICK_STORE_KEY))[collection.id] ?? {};
      if (abort.signal.aborted) return;
      setNeeds({ run, list });
      setWorkingFor(run);
      try {
        const card = collection.prefillRules === 'card';
        const cached = read.current?.run === run ? read.current : null;
        const codes =
          cached?.codes ??
          (card && spoken === null ? await readAttachmentCodes(first, deps, abort.signal) : []);
        const pages =
          cached?.pages ??
          (spoken !== null
            ? [spokenPage(spoken)]
            : await readAttachmentPages(first, deps, abort.signal));
        if (abort.signal.aborted) return;
        if (!cached || (card && cached.codes.length === 0)) {
          read.current = { run, pages, codes };
          if (!cached && spoken === null) tellPages.current?.(pages);
        }
        const known = collection.fields.some(usesValueMemory)
          ? knownValues(collection.fields, await repo.listRecords(collection.id))
          : {};
        if (abort.signal.aborted) return;
        const suggestions = await engine(
          {
            fields: collection.fields,
            ...(collection.prefillRules ? { rules: collection.prefillRules } : {}),
            pages,
            ...(spoken !== null ? { spoken: true } : {}),
            ...(codes.length > 0 ? { codes } : {}),
            locale,
            picks: picks.current,
            known,
          },
          abort.signal,
          (partial) => {
            if (abort.signal.aborted) return;
            setFound({ run, suggestions: partial });
            // Stops considering it "reading" once candidates are available; model runs quietly in the background; this line collapses late, causing fields below to shift upward after the user taps a candidate (D-388).
            setWorkingFor(null);
          },
        );
        if (abort.signal.aborted) return;
        setFound({ run, suggestions });
      } catch (e) {
        // No candidates if unreadable; throws no errors.
        if (!(e instanceof ReadCancelled) && !abort.signal.aborted)
          setFound({ run, suggestions: NONE });
      } finally {
        if (!abort.signal.aborted) setWorkingFor(null);
      }
    })();
    return () => abort.abort();
  }, [collection, key, run, deps, repo, locale, engine, spoken]);

  const working = workingFor === run && key !== '';
  const missing = key && needs?.run === run ? needs.list : NO_NEEDS;
  const latest = key && found?.run === run ? found.suggestions : NONE;
  const lists = tapped?.run === run ? tapped.lists : null;
  const suggestions = useMemo(() => (lists ? { ...latest, ...lists } : latest), [latest, lists]);

  const ask = useCallback(() => setAsking(missing), [missing]);
  const answered = useCallback((left: string[] | null) => {
    setAsking(null);
    if (left !== null) setInstalls((n) => n + 1);
  }, []);
  const remember = useCallback(
    (fieldId: string, suggestion: ValueSuggestion) => {
      if (!collection) return;
      setTapped((t) => ({
        run,
        lists: {
          ...(t?.run === run ? t.lists : {}),
          [fieldId]: suggestions[fieldId] ?? [suggestion],
        },
      }));
      // Value has no position in text (no pick found): does not learn new labels, field's original memory is preserved.
      const pick = rememberPick(picks.current[fieldId], suggestion, suggestions[fieldId] ?? []);
      if (!pick) return;
      picks.current = { ...picks.current, [fieldId]: pick };
      void repo
        .getMeta(PICK_STORE_KEY)
        .then((raw) =>
          repo.setMeta(
            PICK_STORE_KEY,
            serializePickStore(putPick(parsePickStore(raw), collection.id, fieldId, pick)),
          ),
        )
        .catch(() => undefined);
    },
    [repo, collection, run, suggestions],
  );

  return { working, missing, suggestions, asking, ask, answered, remember };
}
