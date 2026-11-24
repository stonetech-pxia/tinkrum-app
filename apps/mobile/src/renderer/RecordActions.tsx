import type { DataRecord, IconValue, OpenUse, RecordToolUse } from '@morph/core';
import { Pressable, Text, type StyleProp, type ViewStyle } from 'react-native';

import { useRecordActionRunner } from '../data/record-actions';
import type { RenderEnv } from './components';
import type { Palette } from './theme';
import { Button } from './ui';

// Two button types for one-tap record tool (D-300): page buttons (button's tools[0]) and small
// buttons on the right of each record list row. In drafts (D-190), tapping only prompts to apply
// before use.

export function ActionButton({
  action,
  label,
  variant,
  icon,
  env,
  style,
}: {
  action: RecordToolUse;
  label: string;
  variant: 'filled' | 'outline' | 'text' | 'icon';
  icon?: IconValue;
  env: RenderEnv;
  style?: StyleProp<ViewStyle>;
}) {
  const runner = useRecordActionRunner();
  return (
    <Button
      palette={env.palette}
      label={label}
      variant={variant}
      icon={icon}
      onPress={
        env.interactive
          ? (env.locked ?? (() => void runner.runButton(action, label, env.recordId)))
          : undefined
      }
      onLongPress={env.onLongPress}
      style={style}
    />
  );
}

/** Button on the right of a list row: at least 44 high, dims on press; tapping does not open this entry. */
export function RowActionButton({
  action,
  record,
  env,
  palette,
}: {
  action: RecordToolUse | OpenUse;
  record: DataRecord;
  env: RenderEnv;
  palette: Palette;
}) {
  const runner = useRecordActionRunner();
  return (
    <Pressable
      testID={`row-action-${record.id}`}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      disabled={!env.interactive}
      onPress={env.locked ?? (() => void runner.runRow(action, record))}
      onLongPress={env.onLongPress}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 14,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: palette.controlRadius,
        backgroundColor: palette.primary,
        opacity: pressed ? 0.7 : 1,
      })}>
      <Text numberOfLines={1} style={[palette.font('bodyBold', 14), { color: palette.onPrimary }]}>
        {action.label}
      </Text>
    </Pressable>
  );
}
