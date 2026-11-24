import { SearchInput } from '../../renderer/ui';
import { recordTitle } from '@morph/core';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../../i18n';
import { useCalendar } from '../../workspace/context';
import type { LocalScreenProps } from '../RunScreen';
import { LocalFrame } from './LocalFrame';

// Pick existing record (D-443): when reaching the "log an entry" step during a quick action, pick
// an entry from existing records in this table. Displays only the title of each entry (as
// elsewhere, defaults to the date when there is no title field), with recently modified ones first;
// allows searching by title when records are numerous. Confirmed upon selection; canceling changes
// nothing.

/** Display search bar only when the count exceeds this number. */
const SEARCH_FROM = 8;

export function RecordPickScreen({
  input,
  palette,
  locale,
  onDone,
  onCancel,
}: LocalScreenProps<'recordPick'>) {
  const { collection, records, select } = input;
  const cal = useCalendar();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(() => {
    const now = new Date();
    return records
      .map((r) => ({
        id: r.id,
        title: recordTitle(r, collection, locale, now, cal),
        at: r.updatedAt,
      }))
      .sort((a, b) => b.at - a.at);
  }, [records, collection, locale, cal]);
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows;
  return (
    <LocalFrame
      palette={palette}
      title={collection.name}
      cancelLabel={t(locale, 'cancel')}
      doneLabel={t(locale, select ? 'recordPickSelect' : 'recordPickChoose')}
      doneDisabled={selected === null}
      onCancel={onCancel}
      onDone={() => selected !== null && onDone({ recordId: selected })}
      avoidKeyboard>
      {rows.length > SEARCH_FROM ? (
        <SearchInput
          palette={palette}
          testID="pick-search"
          value={query}
          onChangeText={setQuery}
          placeholder={t(locale, 'recordPickSearch')}
          style={{ marginHorizontal: 20, marginBottom: 8 }}
        />
      ) : null}
      {shown.length === 0 ? (
        <Text
          testID="pick-none"
          style={[palette.font('body', 15), styles.none, { color: palette.muted }]}>
          {t(locale, 'recordPickNone')}
        </Text>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(r) => r.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const on = item.id === selected;
            return (
              <Pressable
                testID={`pick-row-${item.id}`}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setSelected(item.id)}
                style={[
                  styles.row,
                  {
                    borderColor: on ? palette.primary : palette.border,
                    borderRadius: palette.controlRadius,
                    backgroundColor: on ? palette.surface : 'transparent',
                  },
                ]}>
                <View style={styles.titleBox}>
                  <Text
                    numberOfLines={2}
                    style={[palette.font(on ? 'bodyBold' : 'body', 16), { color: palette.text }]}>
                    {item.title}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </LocalFrame>
  );
}

const styles = StyleSheet.create({
  none: { textAlign: 'center', padding: 24 },
  list: { paddingHorizontal: 20, paddingBottom: 12, gap: 8 },
  row: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  titleBox: { flexShrink: 1 },
});
