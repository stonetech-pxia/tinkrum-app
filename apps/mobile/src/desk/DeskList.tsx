import { DESK_STALE_DAYS, type Locale } from '@morph/core';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Text, View } from 'react-native';

import { t } from '../i18n';
import { formatSize } from '../renderer/FileList';
import type { Palette } from '../renderer/theme';
import { Card, Pill, SectionLabel } from '../renderer/ui';
import type { FilePlatform } from '../runtime/platform';
import { clearDesk, deskSummary, listDesks } from './store';

// The desk in "Settings -> Storage" (D-357): returns to the desk after leaving the room; prompts
// for files untouched for 7 days can be cleared (confirmed by founder 2026-10-30: prompt only, no
// automatic deletion). Filenames are displayed locally only.

export function DeskList({
  files,
  palette,
  locale,
}: {
  files: FilePlatform;
  palette: Palette;
  locale: Locale;
}) {
  const router = useRouter();
  const [desks, setDesks] = useState<ReturnType<typeof deskSummary>[]>([]);
  const reload = useCallback(() => {
    let alive = true;
    void listDesks(files).then(
      (list) => {
        const now = Date.now();
        if (alive) setDesks(list.map((d) => deskSummary(d, now)));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [files]);
  useFocusEffect(reload);

  if (desks.length === 0) return null;
  const caption = [palette.font('body', 13), { color: palette.muted }];
  return (
    <View testID="desk-list" style={{ gap: palette.gap - 4 }}>
      <SectionLabel palette={palette}>{t(locale, 'deskStorageTitle')}</SectionLabel>
      <Text style={caption}>{t(locale, 'deskStorageAbout')}</Text>
      {desks.map((s) => {
        return (
          <Card key={s.id} palette={palette}>
            <View testID={`desk-row-${s.id}`} style={{ gap: 4 }}>
              <Text
                numberOfLines={2}
                style={[palette.font('bodyMedium', 15), { color: palette.text }]}>
                {s.names.join(t(locale, 'separatorList'))}
              </Text>
              <Text style={caption}>{formatSize(s.bytes, locale)}</Text>
              {s.stale ? (
                <Text
                  testID={`desk-stale-${s.id}`}
                  style={[palette.font('bodyMedium', 13), { color: palette.danger }]}>
                  {t(locale, 'deskStale', { n: DESK_STALE_DAYS })}
                </Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                <Pill
                  palette={palette}
                  testID={`desk-open-${s.id}`}
                  label={t(locale, 'open')}
                  onPress={() =>
                    router.push({ pathname: '/desk/[deskId]', params: { deskId: s.id } })
                  }
                />
                <Pill
                  palette={palette}
                  danger
                  testID={`desk-clear-${s.id}`}
                  label={t(locale, 'deskClear')}
                  onPress={() =>
                    Alert.alert(t(locale, 'deskClearTitle'), t(locale, 'deskClearMessage'), [
                      { text: t(locale, 'cancel'), style: 'cancel' },
                      {
                        text: t(locale, 'deskClear'),
                        style: 'destructive',
                        onPress: () => void clearDesk(files, s.id).then(reload),
                      },
                    ])
                  }
                />
              </View>
            </View>
          </Card>
        );
      })}
    </View>
  );
}
