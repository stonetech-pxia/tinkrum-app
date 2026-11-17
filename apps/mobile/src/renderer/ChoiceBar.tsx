import { choiceRowOptions, optionColor, type BlockOf } from '@morph/core';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import type { RenderEnv } from './components';
import { onPage } from './theme';

// 页面上的一排选项（D-573）：一个单选字段的选项排成一排（「全部」在前），点一个，同一页里跟着它的列表、数字和图表
// 只显示这一项的记录。和时间范围块（PeriodBar）一个样子；选了什么只放在页面的状态里（RenderEnv.pageChoice），
// 什么都不写（底线 15）。字段里有选项写了颜色（D-568）时，每一项前面一个那个颜色的点（和列表上的点一样）。

/** 最多几项还折行排；再多就排成一行横着滑（50 个选项折行会占掉好几屏）。 */
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
