import type { Collection } from '@morph/core';
import { Fragment } from 'react';
import { ScrollView, Text } from 'react-native';

import { backupAvailable } from '@/backup';
import { useDataOverview } from '@/data/useDataOverview';
import { t } from '@/i18n';
import { SectionLabel } from '@/renderer/ui';
import { RowGroup } from '@/shell/RowGroup';

/**
 * 'Settings -> Data': user record management page, provided by the core, cannot be modified by AI
 * (invariant 8). Fits on one screen (D-614, D-615): backup and restore at the top (D-600),
 * recently deleted (D-037), unused tables (D-038, D-041), more; below are rows for each table
 * (name and count), grouped by app when multiple apps exist, tapping enters export, import,
 * batches, selective deletion, and attachment settings for that table (data-table/[tableId]);
 * privacy notice is the fine print at the bottom.
 */
export default function DataRoute() {
  const { locale, config, palette, router, counts, orphans, deleted } = useDataOverview();
  const apps = config.nav.apps ?? [];

  // Group by app: home first, then ordered by app sequence; tables pointing to non-existent apps default to home.
  const groups: { key: string; name: string; tables: Collection[] }[] = [];
  for (const c of config.data.tables) {
    const app = c.app ? apps.find((a) => a.id === c.app) : undefined;
    const key = app?.id ?? '';
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, name: app?.name ?? t(locale, 'dataTableHome'), tables: [] };
      groups.push(group);
    }
    group.tables.push(c);
  }
  const order = (key: string) => (key === '' ? -1 : apps.findIndex((a) => a.id === key));
  groups.sort((a, b) => order(a.key) - order(b.key));
  // Omit app name when there is only one group, keeping the title as 'Data Tables'.
  const single = groups.length <= 1;

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 48 }}>
      {/* Title is in the navigation bar, not repeated in the page (D-614). These lines are above the tables, ensuring they remain on the first screen regardless of how many tables exist (D-615). */}
      <RowGroup
        palette={palette}
        rows={[
          // Expo Go and tests lack native packaging modules, so backup cannot be performed and this row is omitted (D-600).
          ...(backupAvailable()
            ? [
                {
                  testID: 'data-backup',
                  label: t(locale, 'backupTitle'),
                  onPress: () => router.push('/data-backup'),
                },
              ]
            : []),
          {
            testID: 'data-deleted',
            label: t(locale, 'recentlyDeleted'),
            trailing: t(locale, 'recordCount', { count: deleted.length }),
            onPress: () => router.push('/data-deleted'),
          },
          // If there are no unused tables in the UI, this row does not appear.
          ...(orphans.length > 0
            ? [
                {
                  testID: 'data-unused',
                  label: t(locale, 'unusedTables'),
                  trailing: String(orphans.length),
                  onPress: () => router.push('/data-unused'),
                },
              ]
            : []),
          {
            testID: 'data-more',
            label: t(locale, 'dataMoreTitle'),
            onPress: () => router.push('/data-more'),
          },
        ]}
      />

      {groups.map((g) => (
        <Fragment key={g.key || 'home'}>
          <SectionLabel palette={palette}>{single ? t(locale, 'dataTables') : g.name}</SectionLabel>
          <RowGroup
            palette={palette}
            rows={g.tables.map((c) => ({
              testID: `table-${c.id}`,
              label: c.name,
              trailing: t(locale, 'recordCount', { count: counts.get(c.id) ?? 0 }),
              onPress: () =>
                router.push({ pathname: '/data-table/[tableId]', params: { tableId: c.id } }),
            }))}
          />
        </Fragment>
      ))}

      <Text style={[palette.font('body', 13), { color: palette.muted }]}>
        {t(locale, 'dataPrivacy')}
      </Text>
    </ScrollView>
  );
}
