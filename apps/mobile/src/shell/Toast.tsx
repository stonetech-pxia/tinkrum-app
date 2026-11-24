import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getBackup } from '../backup';
import { useRecordActions } from '../data/records';
import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { aboutParams } from './ai-entry';

/** How long ordinary prompts ("Logged") are displayed. Disappears when time's up, and switching pages will not keep it lingering. */
export const TOAST_MS = 4000;
/** Tappable prompts (undo after deletion, modify next) stay a bit longer, long enough to finish reading before tapping. */
export const TOAST_UNDO_MS = 8000;

/** "Undo" after restoring from backup stays longer: replacing all content at once requires giving people time to look closely before deciding (D-600). */
export const TOAST_RESTORE_MS = 15000;

/** Prompt bar for record operations (such as undo after deletion). Separate from version prompt bars: records do not belong to any version. */
export function Toast({ palette, bottom }: { palette: Palette; bottom: number }) {
  const { locale } = useWorkspaceContext();
  const toast = useWorkspace((s) => s.toast);
  const dismiss = useWorkspace((s) => s.dismissToast);
  const hold = useWorkspace((s) => s.holdToast);
  const restorePreset = useWorkspace((s) => s.restorePreset);
  const hasNext = useWorkspace((s) => !!s.next);
  const actions = useRecordActions();
  const router = useRouter();
  const canUndo = !!(
    toast?.restoreRecordId ||
    toast?.restoreRecordIds ||
    toast?.restorePreset ||
    toast?.undo ||
    toast?.undoImport ||
    toast?.undoRestore
  );
  const canContinue = !!toast?.continueTable;
  const timed = toast && !toast.held;
  const ms = toast?.undoRestore
    ? TOAST_RESTORE_MS
    : canUndo || canContinue
      ? TOAST_UNDO_MS
      : TOAST_MS;
  // Restart timer when a new prompt is received; does not disappear while the finger is pressing the button.
  useEffect(() => {
    if (!timed) return;
    const timer = setTimeout(dismiss, ms);
    return () => clearTimeout(timer);
  }, [toast, timed, ms, dismiss]);
  if (!toast) return null;
  return (
    <View
      testID="toast"
      style={[
        styles.toast,
        { bottom, backgroundColor: palette.text, borderRadius: palette.controlRadius },
      ]}>
      <Text style={[styles.flex, palette.font('bodyMedium', 14), { color: palette.surface }]}>
        {toast.message}
      </Text>
      {toast.continueTable ? (
        <Pressable
          testID="toast-continue"
          accessibilityRole="button"
          style={styles.action}
          onPressIn={() => hold(true)}
          onPressOut={() => hold(false)}
          onPress={() => {
            const tableId = toast.continueTable!;
            dismiss();
            // The previous statement left appearance incomplete (modify next): continue directly; if none, open the AI page, with this sentence defaulting to refer to this table.
            router.push({
              pathname: '/change',
              params: hasNext ? { next: '1' } : aboutParams({ kind: 'table', tableId }),
            });
          }}>
          <Text style={[palette.font('bodyBold', 14), { color: palette.surface }]}>
            {t(locale, 'toastContinue')}
          </Text>
        </Pressable>
      ) : null}
      {canUndo ? (
        <Pressable
          testID="toast-undo"
          accessibilityRole="button"
          style={styles.action}
          onPressIn={() => hold(true)}
          onPressOut={() => hold(false)}
          onPress={() => {
            if (toast.restoreRecordId) void actions.restore(toast.restoreRecordId);
            if (toast.restoreRecordIds) void actions.restoreMany(toast.restoreRecordIds);
            if (toast.restorePreset) void restorePreset(toast.restorePreset);
            // Start undo before closing the prompt: once the prompt closes, the pre-restoration data is deleted (undoing is set before await in backup/service.ts).
            if (toast.undoRestore) void getBackup().undoRestore();
            dismiss();
            // Undo failure results in a new prompt, so close this one first.
            if (toast.undo) void actions.undo(toast.undo);
            if (toast.undoImport) void actions.undoImport(toast.undoImport);
          }}>
          <Text style={[palette.font('bodyBold', 14), { color: palette.surface }]}>
            {t(locale, 'undo')}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={dismiss}
        style={styles.action}
        accessibilityRole="button"
        accessibilityLabel={t(locale, 'close')}>
        <Text style={[palette.font('bodyBold', 14), { color: palette.surface }]}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 4,
  },
  // Undo and close buttons are at least 44 square points for easy tapping.
  action: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
