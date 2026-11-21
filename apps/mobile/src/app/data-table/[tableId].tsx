import { formatTimestamp, importTargets } from '@morph/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';

import { useDataOverview } from '@/data/useDataOverview';
import { t } from '@/i18n';
import { Card, Pill, SectionLabel } from '@/renderer/ui';
import { RowGroup } from '@/shell/RowGroup';

/** 表上的「附件是」的选项（D-421）。 */
const PREFILL_RULES = [
  { rules: undefined, label: 'prefillRulesGeneral' },
  { rules: 'receipt', label: 'prefillRulesReceipt' },
  { rules: 'card', label: 'prefillRulesCard' },
] as const;

/**
 * 「数据」里的一张表（D-614）：导出 CSV、从文件导入记录和导入过的批次（D-574）、选择删除，
 * 有文件字段时还有「自动读取附件」（D-397）和「附件是」（D-421）。系统层，AI 不能修改（底线 8）。
 */
export default function DataTableRoute() {
  const { tableId } = useLocalSearchParams<{ tableId: string }>();
  const data = useDataOverview();
  const { locale, config, palette, router, counts, imports } = data;
  const c = config.data.tables.find((x) => x.id === tableId);
  if (!c) return null;
  const count = counts.get(c.id) ?? 0;
  const batches = imports.get(c.id) ?? [];
  const hasFiles = c.fields.some((f) => f.type === 'file');
  const caption = [palette.font('body', 13), { color: palette.muted }];

  return (
    <ScrollView
      testID="data-table-screen"
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: c.name }} />
      <Text style={caption}>{t(locale, 'recordCount', { count })}</Text>
      <RowGroup
        palette={palette}
        rows={[
          {
            testID: `export-${c.id}`,
            label: t(locale, 'exportCsv'),
            onPress: () => void data.exportCsv(c),
          },
          ...(importTargets(c).length > 0
            ? [
                {
                  testID: `import-${c.id}`,
                  label: t(locale, 'importEntries'),
                  onPress: () =>
                    router.push({ pathname: '/import-records', params: { table: c.id } }),
                },
              ]
            : []),
          ...(count > 0
            ? [
                {
                  testID: `select-${c.id}`,
                  label: t(locale, 'bulkSelectTitle'),
                  onPress: () =>
                    router.push({ pathname: '/select-records', params: { table: c.id } }),
                },
              ]
            : []),
        ]}
      />
      {batches.length > 0 ? (
        <>
          <SectionLabel palette={palette}>{t(locale, 'importBatches')}</SectionLabel>
          {batches.map((b) => (
            <Card key={b.id} palette={palette} testID={`import-batch-${b.id}`}>
              <Text style={caption}>
                {t(locale, 'importBatch', {
                  date: formatTimestamp(b.createdAt, locale),
                  file: b.fileName,
                  n: b.present,
                })}
              </Text>
              <View style={{ flexDirection: 'row' }}>
                <Pill
                  palette={palette}
                  danger
                  testID={`import-delete-${b.id}`}
                  label={t(locale, 'importDeleteBatch')}
                  onPress={() => data.deleteImport(c, b)}
                />
              </View>
            </Card>
          ))}
        </>
      ) : null}
      {hasFiles ? (
        <Card palette={palette}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={[palette.font('bodyMedium', 14), { color: palette.text }]}>
                {t(locale, 'readAttachmentsLabel')}
              </Text>
              <Text style={caption}>{t(locale, 'readAttachmentsHint')}</Text>
            </View>
            <Switch
              testID={`read-attachments-${c.id}`}
              value={c.readAttachments !== false}
              onValueChange={(on) => void data.setReadAttachments(c, on)}
              trackColor={{ true: palette.primary }}
            />
          </View>
          {/* 「附件是」只在会读附件时才有用（D-614）。 */}
          {c.readAttachments !== false ? (
            <View style={{ gap: 6 }}>
              <Text style={[palette.font('bodyMedium', 14), { color: palette.text }]}>
                {t(locale, 'prefillRulesLabel')}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {PREFILL_RULES.map(({ rules, label }) => {
                  const selected = c.prefillRules === rules;
                  return (
                    <Pressable
                      key={label}
                      testID={`prefill-rules-${c.id}-${rules ?? 'general'}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      onPress={() => void data.setPrefillRules(c, rules)}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 16,
                        borderWidth: 1,
                        borderColor: selected ? palette.primary : palette.border,
                      }}>
                      <Text
                        style={[
                          palette.font('bodyMedium', 14),
                          { color: selected ? palette.primary : palette.text },
                        ]}>
                        {t(locale, label)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={caption}>{t(locale, 'prefillRulesHint')}</Text>
            </View>
          ) : null}
        </Card>
      ) : null}
    </ScrollView>
  );
}
