import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import { useConfigImport } from '@/data/useConfigImport';
import { t } from '@/i18n';
import type { Palette } from '@/renderer/theme';
import { useWorkspaceContext } from '@/workspace/context';
import { AI_RETURN_TTL, aiReturnIsActive, useAiReturn } from './return';

/**
 * What Tink says when the user comes back from another AI app: a speech bubble in the look of the
 * guide's (GuideBubble). Tapping it pastes; "Not now" in the bottom right dismisses it. Does not
 * automatically touch the clipboard: reads only on the single tap on the bubble. With `tail` the
 * tip points up at Tink in the top right.
 */
export function AiReturnBubble({ palette, tail = true }: { palette: Palette; tail?: boolean }) {
  const { locale } = useWorkspaceContext();
  const pending = useAiReturn((s) => s.pending);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const { pasteFile } = useConfigImport(true);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    const remaining = pending ? pending.at + AI_RETURN_TTL - Date.now() : 0;
    const timer = remaining > 0 ? setTimeout(refresh, remaining) : undefined;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [pending]);
  if (!aiReturnIsActive(pending, now)) return null;
  const onBubble = { color: palette.onPrimary };
  return (
    <Pressable
      testID="ai-return-card"
      accessibilityRole="button"
      accessibilityLabel={t(locale, 'handoffPaste')}
      disabled={busy}
      onPress={() => {
        setBusy(true);
        void pasteFile().finally(() => setBusy(false));
      }}
      style={({ pressed }) => [
        styles.bubble,
        {
          paddingHorizontal: palette.inset,
          backgroundColor: palette.primary,
          opacity: pressed || busy ? 0.85 : 1,
          boxShadow: `0px 0px 18px ${palette.primary}99`,
        },
      ]}>
      {tail ? <View style={[styles.tail, { borderBottomColor: palette.primary }]} /> : null}
      <Text testID="ai-return-paste" style={[palette.font('bodyBold', 16), onBubble]}>
        {t(locale, 'handoffPaste')}
      </Text>
      <Text style={[palette.font('body', 14), onBubble, { opacity: 0.9, lineHeight: 20 }]}>
        {t(locale, 'handoffPasteHint')}
      </Text>
      <Pressable
        testID="ai-return-dismiss"
        accessibilityRole="button"
        accessibilityLabel={t(locale, 'handoffDismiss')}
        hitSlop={10}
        style={styles.action}
        onPress={() => useAiReturn.getState().dismiss(pending!.id)}>
        <Text style={[palette.font('bodyBold', 14), onBubble, { opacity: 0.75 }]}>
          {t(locale, 'handoffNotNow')}
        </Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The same shape as the guide's bubble: the corner facing Tink is small and the tip sits on the straight edge.
  bubble: {
    maxWidth: 300,
    borderRadius: 18,
    borderTopRightRadius: 6,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 6,
  },
  tail: {
    position: 'absolute',
    top: -10,
    right: 6,
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 11,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  action: { alignSelf: 'flex-end', paddingVertical: 2 },
});
