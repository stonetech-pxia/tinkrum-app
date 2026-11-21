import {
  MAX_CREATE_ALL,
  linkTitle,
  localeTag,
  pickChoices,
  pickedAlready,
  recordToolOf,
  type DataRecord,
  type RecordToolUse,
} from '@morph/core';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRecordActionRunner } from '@/data/record-actions';
import { useComputedRecords } from '@/data/records';
import { t } from '@/i18n';
import { Icon } from '@/renderer/Icon';
import { usePalette } from '@/renderer/theme';
import { Button } from '@/renderer/ui';
import { Toast } from '@/shell/Toast';
import { useCalendar, useWorkspace, useWorkspaceContext } from '@/workspace/context';

/**
 * 勾选新建（D-616）：列表下面的「添加」是 {do: "createAll", pick: true} 时打开这一页，勾另一张表（from）的几条，
 * 每条在列表那张表里建一条，带上这一段的值（here，"$here"）。这一段里已经连着的显示成「已添加」，不能再勾。
 * 只看不写（底线 15）：勾选只在这一页的内存里；下面的按钮写明条数和表，就是先问的那一句（底线 11，创始人 2026-11-21），
 * 点了直接建，建好了关掉这一页，提示条能撤回这一批。一次最多勾 MAX_CREATE_ALL 条。
 */

/** 多于这个数才显示搜索框（和放进已有的记录一样，D-443）。 */
const SEARCH_FROM = 8;

function parse<T>(text: string | undefined): T | undefined {
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

export default function PickRecordsRoute() {
  const params = useLocalSearchParams<{ tool: string; here?: string }>();
  const { locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(config.theme);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const cal = useCalendar();
  const runner = useRecordActionRunner();
  const use = useMemo(() => parse<RecordToolUse>(params.tool), [params.tool]);
  const pick = useMemo(() => {
    const tool = use && recordToolOf(use);
    return tool?.do === 'createAll' && tool.pick === true ? tool : undefined;
  }, [use]);
  const here = useMemo(() => parse<Record<string, unknown>>(params.here) ?? {}, [params.here]);
  const target = config.data.tables.find((c) => c.id === pick?.table);
  const source = config.data.tables.find((c) => c.id === pick?.from);
  const { view, records } = useComputedRecords(config.data.tables, source, cal);
  const { records: existing } = useComputedRecords(config.data.tables, target, cal);
  const [query, setQuery] = useState('');
  // 按勾的顺序（新的几条也按这个顺序建）。
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    if (!pick || !source || !view || !records) return null;
    const order = new Intl.Collator(localeTag(locale));
    return pickChoices(pick, view, records, { now: new Date(), cal })
      .map((r) => ({ record: r, title: linkTitle(r, source, locale) }))
      .sort((a, b) => order.compare(a.title, b.title));
  }, [pick, source, view, records, locale, cal]);
  const already = useMemo(
    () =>
      pick && target && existing ? pickedAlready(pick, target, existing, here) : new Set<string>(),
    [pick, target, existing, here],
  );

  if (!use || !pick || !target || !source) return null;
  const title = use.label ?? t(locale, 'recordPickTitle', { table: source.name });
  const q = query.trim().toLowerCase();
  const shown = rows && q ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows;
  const chosen = selected.filter((id) => !already.has(id) && rows?.some((r) => r.record.id === id));
  const full = chosen.length >= MAX_CREATE_ALL;

  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : s.length >= MAX_CREATE_ALL ? s : [...s, id],
    );

  async function add() {
    if (chosen.length === 0 || busy) return;
    setBusy(true);
    const created = await runner.runPick(use!, here, chosen);
    setBusy(false);
    if (created) router.back();
  }

  const caption = [palette.font('body', 13), { color: palette.caption }];
  return (
    <View testID="pick-records" style={[styles.flex, { backgroundColor: palette.background }]}>
      <Stack.Screen options={{ title }} />
      <FlatList
        data={shown ?? []}
        keyExtractor={(r) => r.record.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: palette.pad, gap: 8, paddingBottom: 160 }}
        ListHeaderComponent={
          rows && rows.length > 0 ? (
            <View style={{ gap: 8 }}>
              {rows.length > SEARCH_FROM ? (
                <TextInput
                  testID="pick-records-search"
                  value={query}
                  onChangeText={setQuery}
                  placeholder={t(locale, 'recordPickSearch')}
                  placeholderTextColor={palette.caption}
                  autoCorrect={false}
                  style={[
                    palette.font('body', 16),
                    styles.search,
                    {
                      color: palette.text,
                      borderColor: palette.border,
                      borderRadius: palette.controlRadius,
                      backgroundColor: palette.surface,
                    },
                  ]}
                />
              ) : null}
              <Text style={caption}>
                {full
                  ? t(locale, 'recordPickMax', { max: MAX_CREATE_ALL })
                  : t(locale, 'recordPickHint')}
              </Text>
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          rows === null ? undefined : (
            <Text testID="pick-records-empty" style={caption}>
              {rows.length === 0
                ? t(locale, 'recordPickEmpty', { table: source.name })
                : t(locale, 'recordPickNone')}
            </Text>
          )
        }
        renderItem={({ item }: { item: { record: DataRecord; title: string } }) => {
          const id = item.record.id;
          const added = already.has(id);
          const checked = added || selected.includes(id);
          const locked = added || (full && !checked);
          return (
            <Pressable
              testID={`pick-row-${id}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked, disabled: locked }}
              disabled={locked}
              onPress={() => toggle(id)}
              style={[
                styles.row,
                {
                  backgroundColor: palette.surface,
                  borderColor: checked && !added ? palette.primary : palette.border,
                  borderRadius: palette.controlRadius,
                  opacity: locked ? 0.55 : 1,
                },
              ]}>
              <View
                style={[
                  styles.check,
                  {
                    borderColor: checked ? palette.primary : palette.border,
                    backgroundColor: checked && !added ? palette.primary : palette.surface,
                  },
                ]}>
                {checked ? (
                  <Icon
                    name="check"
                    size={16}
                    color={added ? palette.primary : palette.onPrimary}
                  />
                ) : null}
              </View>
              <View style={styles.flex}>
                <Text
                  numberOfLines={1}
                  style={[palette.font('bodyMedium', 15), { color: palette.text }]}>
                  {item.title}
                </Text>
                {added ? <Text style={caption}>{t(locale, 'recordPickAdded')}</Text> : null}
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
          testID="pick-records-add"
          disabled={chosen.length === 0 || busy}
          loading={busy}
          label={
            chosen.length === 0
              ? t(locale, 'recordPickHint')
              : t(locale, 'recordPickAddButton', { n: chosen.length, table: target.name })
          }
          onPress={() => void add()}
        />
      </View>
      <Toast palette={palette} bottom={insets.bottom + 84} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  search: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
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
