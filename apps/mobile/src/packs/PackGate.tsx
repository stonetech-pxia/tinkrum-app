import { Dialog } from '../renderer/Overlays';
import { localize, t, packById, type Locale, type PackNeed } from '@morph/core';

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Palette } from '../renderer/theme';
import { formatBytes } from '../run/ResultView';
import type { PackStore } from './store';

// Confirmation dialog when a pack is needed (D-064): displays name, purpose, size, and Wi-Fi
// recommendation. Download occurs only when the user taps "Download"; for required packs, canceling
// the download cancels the current run; optional packs (D-274, e.g., scan flattening model) can be
// unchecked and the operation proceeds without downloading them. All required packs for a single
// run are listed in one dialog and downloaded together (D-299). Neither AI nor workflows can
// trigger downloads autonomously.

/** An individual pack's file size excluding dependencies. */
const ownSize = (id: string) => packById(id)?.files.reduce((sum, f) => sum + f.size, 0) ?? 0;

export function PackGate({
  needs,
  bundle,
  store,
  palette,
  locale,
  onDone,
}: {
  /** Packs to download (caller has already filtered out installed ones); optional: step proceeds even if not downloaded. */
  needs: readonly PackNeed[];
  /** File bundle offer all-at-once (D-456): change title and description, button says "Remind me later", and individual items do not state "can continue without downloading". */
  bundle?: boolean;
  store: PackStore;
  palette: Palette;
  locale: Locale;
  /** After download: optional packs that were not downloaded; null indicates a required pack was not downloaded (canceling execution). */
  onDone: (left: string[] | null) => void;
}) {
  const zh = locale === 'zh';
  const key = needs.map((n) => n.pack).join(',');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [have, setHave] = useState<Set<string> | null>(null);
  const [left, setLeft] = useState<string[]>([]);
  // Tapping "Download in background": dialog closes, download continues in background, and the store notifies upon completion (shell pops a notification).
  const background = useRef(false);
  // When prompting for the next pack in the same run, the dialog does not remount; progress, errors, and checkbox states from the previous one must be cleared.
  const [shownFor, setShownFor] = useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    setProgress(null);
    setError(null);
    setLeft([]);
  }

  // Sizes must deduct installed dependencies; uninstalled dependencies (e.g., language packs requiring OCR packs) are calculated and explained together.
  useEffect(() => {
    void store.installed().then((list) => setHave(new Set(list.map((p) => p.id))));
  }, [store, key]);

  const chosen = needs.filter((n) => !left.includes(n.pack));
  const missingDeps = (id: string) =>
    (packById(id)?.requires ?? []).filter((d) => have !== null && !have.has(d));
  // A listed row counts only itself and unlisted dependencies without double counting.
  const unlistedDeps = (id: string) =>
    missingDeps(id).filter((d) => !needs.some((n) => n.pack === d));
  const toFetch = new Set(chosen.flatMap((n) => [...missingDeps(n.pack), n.pack]));
  const total = have === null ? null : [...toFetch].reduce((sum, id) => sum + ownSize(id), 0);
  const anyRequired = needs.some((n) => !n.optional);

  async function download() {
    setError(null);
    setProgress(0);
    const done = new Map<string, number>();
    const all = [...toFetch].reduce((sum, id) => sum + ownSize(id), 0);
    try {
      for (const { pack } of chosen) {
        await store.install(pack, (p) => {
          done.set(p.packId, p.doneBytes);
          setProgress(all ? [...done.values()].reduce((a, b) => a + b, 0) / all : 0);
        });
      }
      if (background.current) {
        store.finishedInBackground(
          chosen.map((n) => n.pack),
          true,
        );
        return;
      }
      onDone([...left]);
    } catch (e) {
      if (background.current) {
        store.finishedInBackground(
          chosen.map((n) => n.pack),
          false,
        );
        return;
      }
      setProgress(null);
      setError(
        t(locale, 'PackGate_The_download_did_not_finish_Check_the__9d7b7', {
          v0: String((e as Error).message),
        }),
      );
    }
  }

  const text = (role: 'title' | 'body', value: string, extra = {}) => (
    <Text
      style={[
        palette.font(role === 'title' ? 'title' : 'body', role === 'title' ? 18 : 15),
        { color: role === 'title' ? palette.text : palette.muted },
        extra,
      ]}>
      {value}
    </Text>
  );

  const licenses = [...new Set(needs.map((n) => packById(n.pack)?.license ?? ''))].filter(Boolean);

  return (
    <Dialog
      palette={palette}
      locale={locale}
      visible
      animationType="fade"
      onClose={() => onDone(null)}
      backdropLabel={t(locale, 'close')}
      testID="pack-gate"
      style={[styles.dialog, { backgroundColor: palette.surface, borderRadius: palette.radius }]}>
      {/* First-use prompt (D-112): avoids the word "pack", stating only the download size and offline availability. */}
      {text(
        'title',
        t(locale, bundle ? 'packBundleTitle' : 'PackGate_First_use_needs_a_download_3c1d7', {
          v0: total === null ? '…' : formatBytes(total, locale),
        }),
      )}
      {text(
        'body',
        t(
          locale,
          bundle ? 'packBundleBody' : 'PackGate_After_that_it_works_offline_Wi_Fi_is_r_77ca7',
        ),
      )}
      {needs.map(({ pack: id, optional }) => {
        const pack = packById(id);
        if (!pack) return null;
        const on = !left.includes(id);
        const size = [...unlistedDeps(id), id].reduce((sum, d) => sum + ownSize(d), 0);
        const about = [pack, ...unlistedDeps(id).map((d) => packById(d) ?? null)]
          .flatMap((p) => (p ? [localize(p.description, locale)] : []))
          .join(zh ? '' : ' ');
        const body = (
          <View style={styles.itemText}>
            <Text style={[palette.font('bodyBold', 15), { color: palette.text }]}>
              {localize(pack.name, locale)}
              {have === null ? '' : ` · ${formatBytes(size, locale)}`}
            </Text>
            {/* When prompting all at once, list only names and sizes (D-456). */}
            {bundle ? null : text('body', about, { fontSize: 13 })}
            {optional && !bundle
              ? text('body', t(locale, 'packOptionalHint'), { fontSize: 13 })
              : null}
          </View>
        );
        return optional ? (
          <Pressable
            key={id}
            testID={`pack-item-${id}`}
            disabled={progress !== null}
            onPress={() => setLeft((l) => (on ? [...l, id] : l.filter((x) => x !== id)))}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            style={styles.item}>
            <View
              testID={`pack-include-${id}`}
              style={[
                styles.box,
                {
                  borderColor: on ? palette.primary : palette.border,
                  backgroundColor: on ? palette.primary : 'transparent',
                },
              ]}>
              {on ? <Text style={[styles.tick, { color: palette.surface }]}>✓</Text> : null}
            </View>
            {body}
          </Pressable>
        ) : (
          <View key={id} testID={`pack-item-${id}`} style={styles.item}>
            {needs.some((n) => n.optional) ? <View style={styles.box} /> : null}
            {body}
          </View>
        );
      })}
      {/* When prompting all at once, licenses are omitted; view them after installation under "Settings → Downloaded Content" (D-456). */}
      {bundle
        ? null
        : text('body', t(locale, 'PackGate_License_ff05c', { v0: licenses.join('; ') }), {
            fontSize: 12,
          })}
      {progress !== null ? (
        <View style={styles.progressRow}>
          <ActivityIndicator />
          <View style={[styles.bar, { backgroundColor: palette.primaryTint }]}>
            <View
              style={[
                styles.fill,
                { width: `${Math.round(progress * 100)}%`, backgroundColor: palette.primary },
              ]}
            />
          </View>
        </View>
      ) : null}
      {error ? (
        <Text style={[palette.font('bodyMedium', 14), { color: palette.danger }]}>{error}</Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          testID="pack-cancel"
          onPress={() => onDone(anyRequired ? null : needs.map((n) => n.pack))}
          hitSlop={8}>
          <Text style={[palette.font('bodyBold', 16), { color: palette.muted }]}>
            {t(
              locale,
              anyRequired ? 'PackGate_Cancel_bd576' : bundle ? 'packBundleLater' : 'packSkip',
            )}
          </Text>
        </Pressable>
        {progress !== null ? (
          <Pressable
            testID="pack-background"
            onPress={() => {
              // Treat this run as canceled (required packs not run, optional packs continued without them); the user can trigger it again after download completes.
              background.current = true;
              onDone(anyRequired ? null : needs.map((n) => n.pack));
            }}
            hitSlop={8}>
            <Text style={[palette.font('bodyBold', 16), { color: palette.primaryText }]}>
              {t(locale, 'packBackground')}
            </Text>
          </Pressable>
        ) : null}
        {progress === null && chosen.length > 0 ? (
          <Pressable testID="pack-download" onPress={() => void download()} hitSlop={8}>
            <Text style={[palette.font('bodyBold', 16), { color: palette.primaryText }]}>
              {t(locale, error ? 'retry' : 'speechDownload')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  dialog: { padding: 22, gap: 12 },
  item: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  itemText: { flex: 1, gap: 2 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: 'transparent' },
  tick: { fontSize: 14, lineHeight: 18, textAlign: 'center', fontWeight: '700' },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bar: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 24, marginTop: 6 },
});
