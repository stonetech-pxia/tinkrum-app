import { findSimilarRecords, prepareRecordValues, recordTitle, type Collection } from '@morph/core';
import { useRef } from 'react';
import { Alert } from 'react-native';

import { t } from '../i18n';
import { useCalendar, useWorkspaceContext } from '../workspace/context';

// Prompts before saving a new record (D-426): triggers only if the table has `prefillRules` and
// similar-looking records exist. Read-only, reads records only upon tapping save so typing remains
// unaffected; runs entirely locally. The user can always choose "Save anyway" (invariant 19), with
// no records merged or deleted (invariant 5).

/** Returns a function: returns true if saving can proceed; false if the user chooses to return to the form (or while prompting). */
export function useSimilarCheck() {
  const { repo, locale } = useWorkspaceContext();
  const cal = useCalendar();
  // Double-tap save protection: while the first tap is still prompting, subsequent taps do nothing.
  const asking = useRef(false);
  return async function mayProceed(
    collection: Collection,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    if (!collection.prefillRules) return true;
    if (asking.current) return false;
    asking.current = true;
    try {
      const now = new Date();
      const prepared = prepareRecordValues(collection, input, null, now, cal);
      // Validation fails: proceeds anyway, letting the save step report validation errors.
      if (!prepared.ok) return true;
      // Failing to read records does not block saving.
      const records = await repo.listRecords(collection.id).catch(() => []);
      const similar = findSimilarRecords(collection, prepared.values, records);
      const first = similar[0];
      if (!first) return true;
      const title = recordTitle(first, collection, locale, now, cal);
      const message =
        similar.length === 1
          ? t(locale, 'similarRecordOne', { title, table: collection.name })
          : t(locale, 'similarRecordMany', {
              title,
              table: collection.name,
              n: similar.length - 1,
            });
      return await new Promise<boolean>((resolve) => {
        Alert.alert(
          t(locale, 'similarRecordTitle'),
          message,
          [
            {
              text: t(locale, 'similarRecordBack'),
              style: 'cancel',
              onPress: () => resolve(false),
            },
            { text: t(locale, 'similarRecordSave'), onPress: () => resolve(true) },
          ],
          // Android touch outside to close: returns to the form without hanging.
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      });
    } finally {
      asking.current = false;
    }
  };
}
