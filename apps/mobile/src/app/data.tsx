import type { Collection } from '@morph/core';
import { Fragment } from 'react';
import { ScrollView, Text } from 'react-native';

import { backupAvailable } from '@/backup';
import { useDataOverview } from '@/data/useDataOverview';
import { t } from '@/i18n';
import { SectionLabel } from '@/renderer/ui';
import { RowGroup } from '@/shell/RowGroup';

/**
 * 「设置 → 数据」：用户记录的管理页，由内核提供，AI 不能修改（底线 8）。
 * 一屏看完（D-614、D-615）：最上面是备份和恢复（D-600）、最近删除（D-037）、不在界面里的表（D-038、D-041）、更多；
 * 下面每张表一行（名字和条数），有几个 App 时按 App 分组，点进去是这张表的导出、导入、批次、选择删除、
 * 附件设置（data-table/[tableId]）；隐私说明是页底的一行小字。
 */
export default function DataRoute() {
  const { locale, config, palette, router, counts, orphans, deleted } = useDataOverview();
  const apps = config.nav.apps ?? [];

  // 按 App 分组：主页在前，再按 App 的顺序；表指向的 App 不存在时算主页。
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
  // 只有一组时不写 App 名字，标题还是「数据表」。
  const single = groups.length <= 1;

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 48 }}>
      {/* 标题在导航栏上，页面里不再写一遍（D-614）。这几行在表的上面，表再多也总在第一屏（D-615）。 */}
      <RowGroup
        palette={palette}
        rows={[
          // Expo Go 和测试里没有原生的打包模块，备份做不了，这一行就不出现（D-600）。
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
          // 没有不在界面里的表，这一行就不出现。
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
