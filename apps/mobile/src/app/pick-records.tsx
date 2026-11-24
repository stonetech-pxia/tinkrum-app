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
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRecordActionRunner } from '@/data/record-actions';
import { useComputedRecords } from '@/data/records';
import { t } from '@/i18n';
import { Icon } from '@/renderer/Icon';
import { usePalette } from '@/renderer/theme';
import { SearchInput, Button } from '@/renderer/ui';
import { Toast } from '@/shell/Toast';
import { useCalendar, useWorkspace, useWorkspaceContext } from '@/workspace/context';

/**
 * Check-to-create (D-616): "Add" at the bottom of the list opens this page when {do: "createAll",
 * pick: true}, selects entries from another table (from), creates an entry in the list table for
 * each, carrying the values from this section (here, "$here"). Already linked entries in this
 * section show as "Added" and cannot be re-selected. Read-only (invariant 15): selections exist
 * only in this page's memory; the bottom button specifies count and table, serving as the
 * preliminary confirmation prompt (invariant 11, founder 2026-11-21). Tapping builds immediately,
 * closes the page upon completion, and the prompt bar can undo the batch. Maximum of
 * MAX_CREATE_ALL entries per batch.
 */

/** Show search box only when count exceeds this threshold (same as putting into existing records, D-443). */
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
  // In selection order (new entries are also created in this order).
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
                <SearchInput
                  palette={palette}
                  testID="pick-records-search"
                  value={query}
                  onChangeText={setQuery}
                  placeholder={t(locale, 'recordPickSearch')}
                  style={{ backgroundColor: palette.surface }}
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
