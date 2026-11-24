import {
  MAX_ATTACHMENTS,
  dayOf,
  formInput,
  issuesLeft,
  prepareRecordValues,
  type FieldIssue,
} from '@morph/core';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useSimilarCheck } from '../../data/similar-records';
import { t } from '../../i18n';
import { toFormValues } from '../../renderer/data';
import { SuggestedFields } from '../../renderer/SuggestedFields';
import { useCalendar } from '../../workspace/context';
import type { LocalScreenProps } from '../RunScreen';
import { LocalFrame } from './LocalFrame';

// Log an entry (D-187, D-397): when a quick action reaches this step, opens a new record form
// identical to the record page. Files for this step are already in attachments, and the form reads
// them for suggestions (D-394), while the user can also take new photos, choose photos, and pick
// files (D-263); formulas are computed on the fly from entered values. Filled content is written
// directly to the local data table and does not enter...

export function RecordEntryScreen({
  input,
  palette,
  locale,
  onDone,
  onCancel,
}: LocalScreenProps<'recordEntry'>) {
  const { collection, prefill, file, overflow, existing, index, total, heard } = input;
  const cal = useCalendar();
  // New record: first apply field default values (date is today, based on day start time, D-286),
  // then populate pre-filled text. Inserting into an existing record (D-443): start from the
  // record's current values, then apply subsequent files and text.
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (existing) return { ...toFormValues(collection, existing), ...prefill };
    const defaults: Record<string, unknown> = {};
    for (const f of collection.fields) {
      if ('default' in f && f.default !== undefined)
        defaults[f.id] = f.type === 'date' ? dayOf(new Date(), cal) : f.default;
    }
    const base = toFormValues(collection, {
      id: '',
      collectionId: collection.id,
      values: defaults,
      createdAt: 0,
      updatedAt: 0,
    });
    return { ...base, ...prefill };
  });
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const mayProceed = useSimilarCheck();
  async function done() {
    // D-570: fields in hidden sections are not submitted.
    const input = formInput(collection, values, new Date(), cal);
    const prepared = prepareRecordValues(
      collection,
      input,
      existing?.values ?? null,
      new Date(),
      cal,
    );
    if (!prepared.ok) {
      setIssues(prepared.issues);
      return;
    }
    // Inserting into an existing record: modifies this specific entry without creating duplicates, so it does not prompt "appears identical".
    if (existing) {
      onDone({ values: input });
      return;
    }
    // D-426: prompt when an identical-looking record exists in this table; records created during the same run also count (out.addRecord saves before opening the next form).
    if (await mayProceed(collection, input)) onDone({ values: input });
  }

  const isImage = file?.mimeType.startsWith('image/') && file.ext !== 'heic';
  return (
    <LocalFrame
      palette={palette}
      title={total > 1 ? `${collection.name} · ${index + 1}/${total}` : collection.name}
      cancelLabel={t(locale, 'cancel')}
      doneLabel={t(locale, 'RecordEntryScreen_Save_0e67b')}
      onCancel={onCancel}
      onDone={() => void done()}
      avoidKeyboard>
      <ScrollView
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        {file ? (
          <View style={styles.file}>
            {isImage ? (
              <Image
                source={{ uri: file.uri }}
                contentFit="contain"
                style={[styles.preview, { borderRadius: palette.controlRadius }]}
              />
            ) : null}
            <Text
              numberOfLines={1}
              style={[palette.font('bodyMedium', 14), { color: palette.muted }]}>
              {t(locale, 'RecordEntryScreen_Attachment_9a7fe', { v0: file.name, v1: file.ext })}
            </Text>
          </View>
        ) : null}
        {overflow ? (
          <Text
            testID="entry-overflow"
            style={[palette.font('body', 13), { color: palette.muted }]}>
            {t(locale, 'shareRecordTooMany', { n: MAX_ATTACHMENTS })}
          </Text>
        ) : null}
        <SuggestedFields
          suggest
          collection={collection}
          values={values}
          onChange={(next) => {
            // Modifying a field clears its validation error (D-572).
            setIssues((now) => issuesLeft(now, values, next));
            setValues(next);
          }}
          issues={issues}
          palette={palette}
          locale={locale}
          testPrefix="entry"
          heard={heard}
        />
        {total > 1 ? (
          <Pressable
            testID="entry-skip"
            onPress={() => onDone({ skip: true })}
            style={styles.skip}
            hitSlop={8}>
            <Text style={[palette.font('bodyBold', 15), { color: palette.primaryText }]}>
              {t(locale, 'RecordEntryScreen_Skip_this_one_d0de1')}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </LocalFrame>
  );
}

const styles = StyleSheet.create({
  list: { padding: 20, gap: 18 },
  file: { gap: 8 },
  preview: { width: '100%', height: 220 },
  skip: { alignSelf: 'center', paddingVertical: 8 },
});
