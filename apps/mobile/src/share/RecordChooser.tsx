import { MAX_ATTACHMENTS, MEDIA_LIMITS, type Locale } from '@morph/core';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { IMPORT_PROBLEMS } from '../renderer/Attachments';
import type { Palette } from '../renderer/theme';
import { copyUserFiles } from '../storage/copy-files';
import { recordTargets } from '../runtime/actions/records';
import type { PickedFile } from '../runtime/platform';
import { useReceiptLike } from './receipt-like';
import { deleteUserFiles } from '../storage/user-files';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { holdFormCopies, recordChoices, type RecordChoice } from './save-as-record';

/**
 * Save as record (D-392, selected by founder in conversation on 2026-10-31): received files are
 * copied as user files (the inbox batch remains as is, released upon leaving the inbox page). Add
 * to existing table: open new record form with attachments pre-populated. Create new: open new
 * form page, table is created only when tapping 'Log' (D-444). If leaving without saving, the
 * next page deletes these copies. Shared between the inbox page and the preview page (D-457).
 */
export function useSaveAsRecord(picked: readonly PickedFile[], onDone: () => void) {
  const { repo, files, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const bumpAssets = useWorkspace((s) => s.bumpAssets);
  const router = useRouter();
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveAsRecord(choice: RecordChoice | null) {
    if (placing) return;
    setPlacing(true);
    setError(null);
    let copied: string[] = [];
    try {
      const result = await copyUserFiles(picked.slice(0, MAX_ATTACHMENTS), files, repo);
      // Files already stored in the document library when opened or shared are not counted as copies (D-455): only newly copied files from this session are deleted upon cancellation.
      copied = result.created;
      const attached = result.assetIds;
      if (result.problem) {
        setError(
          t(locale, IMPORT_PROBLEMS[result.problem], {
            gb: MEDIA_LIMITS.maxFileBytes / 1024 / 1024 / 1024,
          }),
        );
        return;
      }
      if (!choice) {
        const ids = copied;
        copied = [];
        bumpAssets();
        onDone();
        router.push({
          pathname: '/new-table',
          params: { copies: holdFormCopies(ids), attached: JSON.stringify(attached) },
        });
        return;
      }
      const table = config.data.tables.find((c) => c.id === choice.tableId);
      const field = table && recordTargets(table).fileField;
      if (!table || !field) return;
      const ids = copied;
      copied = [];
      bumpAssets();
      onDone();
      router.push({
        pathname: '/record/[collectionId]',
        params: {
          collectionId: table.id,
          prefill: JSON.stringify({ [field]: attached }),
          copies: holdFormCopies(ids),
        },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      // Do not retain copies that were not handed over to the next page.
      if (copied.length > 0) await deleteUserFiles(copied, repo, files).catch(() => undefined);
      setPlacing(false);
    }
  }

  return { placing, error, saveAsRecord };
}

/** List for saving as records: 'New form' is placed at the top (avoiding scrolling when there are many tables), followed by tables containing attachment fields. */
export function RecordChooser({
  count,
  files,
  placing,
  palette,
  locale,
  onChoose,
}: {
  count: number;
  /** Received files: reads text locally; for items like receipts, recommends tables with receipt rules (D-477). */
  files: readonly PickedFile[];
  placing: boolean;
  palette: Palette;
  locale: Locale;
  onChoose: (choice: RecordChoice | null) => void;
}) {
  const config = useWorkspace((s) => s.config)!;
  const caption = [palette.font('body', 13), { color: palette.muted }];
  const hasReceiptTable = recordChoices(config).some(
    (c) => config.data.tables.find((x) => x.id === c.tableId)?.prefillRules === 'receipt',
  );
  const tables = recordChoices(config, useReceiptLike(files, hasReceiptTable));
  const row = (id: string, name: string, about: string | null, choice: RecordChoice | null) => (
    <Pressable
      key={id}
      testID={id}
      accessibilityRole="button"
      disabled={placing}
      onPress={() => onChoose(choice)}
      style={({ pressed }) => [styles.choice, (pressed || placing) && { opacity: 0.6 }]}>
      <View style={styles.flex}>
        <Text numberOfLines={1} style={[palette.font('bodyMedium', 15), { color: palette.text }]}>
          {name}
        </Text>
        {about ? <Text style={caption}>{about}</Text> : null}
      </View>
      <Text style={[palette.font('title', 18), { color: palette.caption }]}>›</Text>
    </Pressable>
  );
  return (
    <View testID="share-record-list" style={styles.chooser}>
      {count > MAX_ATTACHMENTS ? (
        <Text testID="share-record-too-many" style={caption}>
          {t(locale, 'shareRecordTooMany', { n: MAX_ATTACHMENTS })}
        </Text>
      ) : null}
      {row('share-record-new', t(locale, 'shareRecordNew'), t(locale, 'shareRecordNewAbout'), null)}
      {tables.length > 0 ? (
        <Text style={[palette.font('bodyBold', 13), styles.heading, { color: palette.muted }]}>
          {t(locale, 'shareRecordTables')}
        </Text>
      ) : null}
      {tables.map((c) =>
        row(
          `share-record-table-${c.tableId}`,
          c.name,
          c.recommended ? t(locale, 'shareRecordLooksLikeReceipt') : null,
          c,
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Separates "Your tables" from the explanation for "New form" above (2026-11-06 test: jammed together).
  heading: { marginTop: 12 },
  chooser: { gap: 4, paddingBottom: 8 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingLeft: 8,
    paddingVertical: 6,
  },
});
