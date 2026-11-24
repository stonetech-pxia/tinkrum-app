import type { Locale } from '@morph/core';
import { usePreventRemove, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';

import { t, type StringKey } from '../i18n';

/**
 * When there are unsaved changes, prompt "Discard changes?" before returning via button or
 * gesture (2026-11-06 test: new record form, edits on desk were quietly lost upon returning). The
 * leave() function for returning is used after saving or deleting: returns directly without
 * prompting.
 */
export function useConfirmLeave(unsaved: boolean, message: StringKey, locale: Locale) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const disable = usePreventRemove(unsaved && !leaving, ({ repeat }) => {
    Alert.alert(t(locale, 'discardTitle'), t(locale, message), [
      { text: t(locale, 'keepEditing'), style: 'cancel' },
      {
        text: t(locale, 'discard'),
        style: 'destructive',
        onPress: () => {
          setLeaving(true);
          repeat();
        },
      },
    ]);
  });
  return () => {
    setLeaving(true);
    disable();
    router.back();
  };
}
