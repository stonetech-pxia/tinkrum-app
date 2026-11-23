import { checkHandoffFileText, readAppLink } from '@morph/core';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, Text } from 'react-native';

import { useConfigImport } from '@/data/useConfigImport';
import { t } from '@/i18n';
import { usePalette } from '@/renderer/theme';
import { Button, Card } from '@/renderer/ui';
import { useAppTheme, useWorkspace, useWorkspaceContext } from '@/workspace/context';

/** 来自任何人的链接都是不可信输入。打开只解码、检查、显示；点查看后才进入共用导入预览。 */
export default function OpenRoute() {
  const { a } = useLocalSearchParams<{ a?: string | string[] }>();
  const { registry, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const { importText } = useConfigImport(true);
  const result = useMemo(() => {
    try {
      if (typeof a !== 'string') return null;
      const text = readAppLink(a);
      const check = checkHandoffFileText(text, { registry, locale, now: new Date() });
      return { text, check };
    } catch {
      return null;
    }
  }, [a, registry, locale]);
  return (
    <ScrollView
      testID="app-link-screen"
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap }}>
      <Card palette={palette}>
        <Text style={[palette.font('title', 22), { color: palette.text }]}>
          {result?.check.ok ? result.check.summary.name : t(locale, 'appLinkTitle')}
        </Text>
        <Text style={[palette.font('body', 15), { color: palette.caption }]}>
          {result?.check.ok ? t(locale, 'appLinkHint') : t(locale, 'appLinkInvalid')}
        </Text>
        {result && !result.check.ok
          ? result.check.problems.map((problem, i) => (
              <Text key={i} style={[palette.font('body', 14), { color: palette.text }]}>
                {problem}
              </Text>
            ))
          : null}
        {result?.check.ok ? (
          <Button
            palette={palette}
            testID="app-link-review"
            label={t(locale, 'appLinkReview')}
            onPress={() => void importText(result.text, '', t(locale, 'appLinkTitle'))}
          />
        ) : null}
      </Card>
    </ScrollView>
  );
}
