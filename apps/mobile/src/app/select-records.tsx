import { linkTitle, type DataRecord } from '@morph/core';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useComputedRecords } from '@/data/records';
import { formatWhen, t } from '@/i18n';
import { Icon } from '@/renderer/Icon';
import { usePalette } from '@/renderer/theme';
import { Button } from '@/renderer/ui';
import { Toast } from '@/shell/Toast';
import { useCalendar, useWorkspace, useWorkspaceContext } from '@/workspace/context';

/**
 * 「设置 → 数据 → 选几条删除」（D-547）：系统层的页面，AI 改不了，不在配置的页面里，所以不和长按编辑（D-235）抢手势。
 * 删之前先问一句（底线 11）；删了和一条条删一样进回收站（30 天），提示条能撤销，「设置 → 数据」里也能恢复。
 * 只看不写（底线 15）：选中只在这一页的内存里。
 */
export default function SelectRecordsRoute() {
  const { table } = useLocalSearchParams<{ table: string }>();
  const { repo, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const bump = useWorkspace((s) => s.bumpRecords);
  const showToast = useWorkspace((s) => s.showToast);
  const palette = usePalette(config.theme);
  const insets = useSafeAreaInsets();
  const collection = config.data.tables.find((c) => c.id === table);
  const { records } = useComputedRecords(config.data.tables, collection, useCalendar());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  if (!collection) return null;
  const list = [...(records ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  // 已经不在的（别处删了）不算。
  const chosen = list.filter((r) => selected.has(r.id)).map((r) => r.id);
  const all = list.length > 0 && chosen.length === list.length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  function remove() {
    const ids = chosen;
    if (ids.length === 0) return;
    Alert.alert(
      t(locale, 'delete'),
      t(locale, 'bulkDeleteConfirm', { n: ids.length, name: collection!.name }),
      [
        { text: t(locale, 'cancel'), style: 'cancel' },
        {
          text: t(locale, 'delete'),
          style: 'destructive',
          onPress: () =>
            void (async () => {
              const at = Date.now();
              for (const id of ids) await repo.deleteRecord(id, at);
              setSelected(new Set());
              bump();
              showToast({
                message: t(locale, 'bulkDeleted', { n: ids.length }),
                restoreRecordIds: ids,
              });
            })(),
        },
      ],
    );
  }

  const caption = [palette.font('body', 13), { color: palette.caption }];
  return (
    <View testID="select-records" style={[styles.flex, { backgroundColor: palette.background }]}>
      <FlatList
        data={list}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: palette.pad, gap: 8, paddingBottom: 160 }}
        ListHeaderComponent={
          list.length > 0 ? (
            <Pressable
              testID="select-all"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setSelected(all ? new Set() : new Set(list.map((r) => r.id)))}
              style={styles.all}>
              <Text style={[palette.font('bodyBold', 14), { color: palette.primaryText }]}>
                {t(locale, all ? 'bulkSelectNone' : 'bulkSelectAll')}
              </Text>
            </Pressable>
          ) : undefined
        }
        ListEmptyComponent={
          records === null ? undefined : <Text style={caption}>{t(locale, 'bulkSelectEmpty')}</Text>
        }
        renderItem={({ item }: { item: DataRecord }) => {
          const checked = selected.has(item.id);
          return (
            <Pressable
              testID={`select-row-${item.id}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              onPress={() => toggle(item.id)}
              style={[
                styles.row,
                {
                  backgroundColor: palette.surface,
                  borderColor: checked ? palette.primary : palette.border,
                  borderRadius: palette.controlRadius,
                },
              ]}>
              <View
                style={[
                  styles.check,
                  {
                    borderColor: checked ? palette.primary : palette.border,
                    backgroundColor: checked ? palette.primary : palette.surface,
                  },
                ]}>
                {checked ? <Icon name="check" size={16} color={palette.onPrimary} /> : null}
              </View>
              <View style={styles.flex}>
                <Text
                  numberOfLines={1}
                  style={[palette.font('bodyMedium', 15), { color: palette.text }]}>
                  {linkTitle(item, collection, locale)}
                </Text>
                <Text style={caption}>
                  {formatWhen(locale, new Date(item.updatedAt), new Date())}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
      <View
        style={[
          styles.bar,
          { paddingBottom: insets.bottom + 12, backgroundColor: palette.background },
        ]}>
        <Button
          palette={palette}
          testID="select-delete"
          danger
          disabled={chosen.length === 0}
          label={
            chosen.length === 0
              ? t(locale, 'delete')
              : t(locale, 'bulkDeleteButton', { n: chosen.length })
          }
          onPress={remove}
        />
      </View>
      <Toast palette={palette} bottom={insets.bottom + 84} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  all: { alignSelf: 'flex-end', paddingVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderWidth: 1,
  },
  check: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bar: { position: 'absolute', left: 16, right: 16, bottom: 0, paddingTop: 12 },
});
