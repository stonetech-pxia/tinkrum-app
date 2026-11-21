import { ScrollView, Text } from 'react-native';

import { BackupCard } from '@/backup/BackupCard';
import { useDataOverview } from '@/data/useDataOverview';
import { t } from '@/i18n';
import { Card, SectionLabel } from '@/renderer/ui';
import { RowGroup } from '@/shell/RowGroup';

/**
 * 「设置 → 数据」：用户记录的管理页，由内核提供，AI 不能修改（底线 8）。
 * 一屏看完（D-614）：每张表一行，点进去是这张表的导出、导入、批次、选择删除、附件设置（data-table/[tableId]）；
 * 整体备份和恢复（D-600）；最近删除（D-037）、不在界面里的表（D-038、D-041）各一行；
 * 填写记忆、导出 App 设计、本机模型、已下载内容在「更多」里。
 */
export default function DataRoute() {
  const { locale, config, palette, router, counts, orphans, deleted, files } = useDataOverview();
  const appName = (id: string | undefined) =>
    (id ? config.nav.apps?.find((a) => a.id === id)?.name : undefined) ??
    t(locale, 'dataTableHome');

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 48 }}>
      {/* 标题在导航栏上，页面里不再写一遍（D-614）。 */}
      <Card palette={palette} background={palette.secondaryTint}>
        <Text style={[palette.font('bodyMedium', 14), { color: palette.onSecondaryTint }]}>
          {t(locale, 'dataPrivacy')}
        </Text>
      </Card>

      <SectionLabel palette={palette}>{t(locale, 'dataTables')}</SectionLabel>
      <RowGroup
        palette={palette}
        rows={config.data.tables.map((c) => ({
          testID: `table-${c.id}`,
          label: c.name,
          value: `${t(locale, 'recordCount', { count: counts.get(c.id) ?? 0 })} · ${appName(c.app)}`,
          onPress: () =>
            router.push({ pathname: '/data-table/[tableId]', params: { tableId: c.id } }),
        }))}
      />

      <BackupCard palette={palette} locale={locale} files={files} />

      <RowGroup
        palette={palette}
        rows={[
          {
            testID: 'data-deleted',
            label: t(locale, 'recentlyDeleted'),
            value: t(locale, 'recordCount', { count: deleted.length }),
            onPress: () => router.push('/data-deleted'),
          },
          // 没有不在界面里的表，这一行就不出现。
          ...(orphans.length > 0
            ? [
                {
                  testID: 'data-unused',
                  label: t(locale, 'unusedTables'),
                  value: orphans.map((o) => o.collection?.name ?? o.id).join(', '),
                  onPress: () => router.push('/data-unused'),
                },
              ]
            : []),
          {
            testID: 'data-more',
            label: t(locale, 'dataMoreTitle'),
            value: t(locale, 'dataMoreHint'),
            onPress: () => router.push('/data-more'),
          },
        ]}
      />
    </ScrollView>
  );
}
