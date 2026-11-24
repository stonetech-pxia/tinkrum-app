import type { RejectReason } from '@morph/core';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAISettings } from '../ai/context';
import { t } from '../i18n';
import type { Palette } from '../renderer/theme';

// Requirement recycling (D-189): when AI cannot fulfill a request, display "Tell us about this
// requirement" below the answer; only when tapped is that single sentence sent to Morph (excluding
// files, records, and settings). Shared between AI modification page and draft chat box.

/** These rejection types are "impossible", worth taking the requirements back; userData, protected, unavailable, etc. are not. */
const NEED_REASONS = ['unknown', 'errand', 'notInstalled'] as const;

export function NeedButton({
  text,
  reason,
  palette,
  locale,
}: {
  text: string;
  reason: RejectReason | undefined;
  palette: Palette;
  locale: 'en' | 'zh' | 'fr';
}) {
  const shown = useAISettings((s) => s.needsButton && s.canSendNeeds);
  const sendNeed = useAISettings((s) => s.sendNeed);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const need = NEED_REASONS.find((r) => r === reason);
  if (!shown || !need || !text) return null;
  if (state === 'sent') {
    return (
      <Text testID="need-sent" style={[palette.font('body', 13), { color: palette.muted }]}>
        {t(locale, 'needSent')}
      </Text>
    );
  }
  return (
    <View style={styles.wrap}>
      <Pressable
        testID="need-send"
        disabled={state === 'sending'}
        hitSlop={8}
        onPress={() => {
          setState('sending');
          void sendNeed({ text, locale, reason: need }).then((ok) =>
            setState(ok ? 'sent' : 'failed'),
          );
        }}>
        <Text style={[palette.font('bodyBold', 15), { color: palette.primaryText }]}>
          {t(locale, state === 'failed' ? 'needRetry' : 'needSend')}
        </Text>
      </Pressable>
      <Text style={[palette.font('body', 12), { color: palette.caption }]}>
        {t(locale, 'needPrivacy')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { gap: 4, marginTop: 4 } });
