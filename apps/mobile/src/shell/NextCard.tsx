import { useRouter } from 'expo-router';
import { Text } from 'react-native';

import { t } from '../i18n';
import type { Palette } from '../renderer/theme';
import { Button, Card } from '../renderer/ui';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';

/**
 * "Modify next" (D-191): The remaining appearance requests in the sentence from the previous
 * feature modification. Tap to open the AI modification page, have the sentence automatically
 * typed in and sent, and enter the draft to view the effect.
 */
export function NextCard({ palette, primary }: { palette: Palette; primary?: boolean }) {
  const { locale } = useWorkspaceContext();
  const next = useWorkspace((s) => s.next);
  const router = useRouter();
  if (!next) return null;
  return (
    <Card palette={palette} background={palette.primaryTint} testID="next-card">
      <Text style={[palette.font('title', 15), { color: palette.text }]}>
        {t(locale, 'nextTitle')}
      </Text>
      <Text style={[palette.font('body', 14), { color: palette.muted }]}>
        {t(locale, 'nextHint')}
      </Text>
      <Button
        palette={palette}
        testID="next-go"
        variant={primary ? 'filled' : 'outline'}
        label={next}
        onPress={() => router.replace({ pathname: '/change', params: { next: '1' } })}
      />
    </Card>
  );
}
