import { choiceRowOptions, optionColor, type BlockOf } from '@morph/core';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import type { RenderEnv } from './components';
import { onPage } from './theme';

// A row of options on the page (D-573): options of a single-select field are laid out in a row
// ("All" first), and tapping one filters the list, counts, and charts on the same page to show only
// records for this item. Same appearance as the time range block (PeriodBar); selections are kept
// only in page state (RenderEnv.pageChoice) without writing anything (invariant 15). When options
// have assigned colors in the field (D-568), each item is preceded by a dot of that color (matching
// list dots).

/** Maximum number of items to wrap to multiple lines; any more are arranged in a single horizontally scrollable row (wrapping 50 options would span multiple screens). */
const WRAP_UP_TO = 8;

export function ChoiceBar({ block, env }: { block: BlockOf<'choices'>; env: RenderEnv }) {
  const { locale, interactive } = env;
  const page = onPage(env.palette);
  const state = env.pageChoice;
  const table = env.config.data.tables.find((x) => x.id === block.source.table);
  const field = table?.fields.find((f) => f.id === block.source.field);
  const all = field?.type === 'choice' ? field.options : [];
  const options = choiceRowOptions(block, table);
  const dots = all.some((o) => o.color !== undefined);
  const picked = state?.option ?? null;
  const chip = (id: string, label: string, on: boolean, press: () => void, dot?: string) => (
    <Pressable
      key={id}
      testID={`choices-${id}`}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      disabled={!interactive || !state}
      onPress={press}
      onLongPress={env.onLongPress}
      style={[
        styles.chip,
        {
          borderColor: on ? page.primary : page.border,
          backgroundColor: on ? page.primaryTint : 'transparent',
        },
      ]}>
      {dot ? (
        <View testID={`choices-dot-${id}`} style={[styles.dot, { backgroundColor: dot }]} />
      ) : null}
      <Text
        numberOfLines={1}
        style={[page.font('bodyMedium', 13), { color: on ? page.primaryText : page.muted }]}>
        {label}
      </Text>
    </Pressable>
  );
  const count = options.length + (block.show.all !== false ? 1 : 0);
  const chips = (
    <>
      {block.show.all !== false
        ? chip('all', t(locale, 'choicesAll'), picked === null, () => state?.set(null))
        : null}
      {options.map((o) =>
        chip(
          o.id,
          o.label,
          picked === o.id,
          () => state?.set(o.id),
          dots
            ? optionColor(
                o,
                all.findIndex((x) => x.id === o.id),
                env.palette.dark,
                all,
              )
            : undefined,
        ),
      )}
    </>
  );
  if (count > WRAP_UP_TO)
    return (
      <ScrollView
        testID="choices-scroll"
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.line}>
        {chips}
      </ScrollView>
    );
  return <View style={styles.row}>{chips}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chip: {
    minHeight: 32,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
