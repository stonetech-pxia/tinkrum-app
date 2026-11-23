import { useEffect, useState } from 'react';
import { AppState, Text, type StyleProp, type ViewStyle } from 'react-native';

import { useConfigImport } from '@/data/useConfigImport';
import { t } from '@/i18n';
import type { Palette } from '@/renderer/theme';
import { Button, Card } from '@/renderer/ui';
import { useWorkspaceContext } from '@/workspace/context';
import { AI_RETURN_TTL, aiReturnIsActive, useAiReturn } from './return';

/** 不自动碰剪贴板：只有「粘贴」的这一次点击才读。 */
export function AiReturnCard({
  palette,
  style,
}: {
  palette: Palette;
  style?: StyleProp<ViewStyle>;
}) {
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
  return (
    <Card palette={palette} style={style} testID="ai-return-card">
      <Button
        palette={palette}
        label={t(locale, 'handoffPaste')}
        testID="ai-return-paste"
        disabled={busy}
        loading={busy}
        onPress={() => {
          setBusy(true);
          void pasteFile().finally(() => setBusy(false));
        }}
      />
      <Text style={[palette.font('body', 14), { color: palette.caption }]}>
        {t(locale, 'handoffPasteHint')}
      </Text>
      <Button
        palette={palette}
        variant="text"
        label={t(locale, 'handoffDismiss')}
        testID="ai-return-dismiss"
        onPress={() => useAiReturn.getState().dismiss(pending!.id)}
      />
    </Card>
  );
}
