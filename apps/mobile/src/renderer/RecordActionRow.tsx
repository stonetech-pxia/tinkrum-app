import {
  attachmentIds,
  prepareRecordValues,
  quickActionsOf,
  recordRowButtons,
  recordRowValue,
  type AttachmentInfo,
  type Collection,
  type DataRecord,
} from '@morph/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useHandedRun } from '../run/useHandedRun';
import { useCalendar, useWorkspace, useWorkspaceContext } from '../workspace/context';
import { useAssets } from './Attachments';
import { Icon } from './Icon';
import type { Palette } from './theme';

// Top button row on detail page for existing records (D-428, replacing hardcoded row in D-423):
// determined by recordRow on table, each button is a quick action, passing field values or record
// upon tap (Invariant 17). Reads current values in form, performs no writes (Invariant 15).

export function RecordActionRow({
  collection,
  record,
  values,
  palette,
}: {
  collection: Collection;
  /** The current record (with calculated values). */
  record: DataRecord;
  values: Readonly<Record<string, unknown>>;
  palette: Palette;
}) {
  const { registry, locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config!);
  const cal = useCalendar();
  const { run, elements } = useHandedRun(palette);
  /** Current values in form: includes unsaved edits. Fields with invalid inputs (e.g., text in amount) pass their raw form input. */
  const current = (): DataRecord => {
    const prepared = prepareRecordValues(collection, values, record.values, new Date(), cal);
    return {
      ...record,
      values: { ...record.values, ...(prepared.ok ? prepared.values : values) },
    };
  };
  // Values inspected by buttons: current form values (normalized to storage format, numbers as numbers; cleared fields have no value).
  const prepared = prepareRecordValues(collection, values, record.values, new Date(), cal);
  const shown = prepared.ok ? prepared.values : values;
  // File intake buttons require knowing what the attachment files are (images, PDFs...), appearing only after reading them successfully (D-442).
  const fileIds = [
    ...new Set(
      (collection.recordRow ?? []).flatMap((item) => {
        const field = collection.fields.find((f) => f.id === item.field);
        return field?.type === 'file' ? attachmentIds(shown[field.id]) : [];
      }),
    ),
  ];
  const loaded = useAssets(fileIds);
  const infos = new Map<string, AttachmentInfo>(
    [...loaded].flatMap(([id, asset]) =>
      asset ? [[id, { id, name: asset.name, mimeType: asset.mimeType, size: asset.size }]] : [],
    ),
  );
  const buttons = recordRowButtons(
    collection,
    quickActionsOf(config),
    registry,
    locale,
    shown,
    infos,
  );
  if (buttons.length === 0) return null;
  return (
    <View testID="record-actions" style={styles.row}>
      {buttons.map((button) => (
        <Pressable
          key={button.key}
          testID={`record-action-${button.key}`}
          accessibilityRole="button"
          onPress={() => void run(button.workflow, recordRowValue(button, collection, current()))}
          style={({ pressed }) => [styles.action, { opacity: pressed ? 0.6 : 1 }]}>
          <Icon name={button.workflow.icon ?? 'workflow'} size={22} color={palette.primaryText} />
          <Text
            numberOfLines={2}
            style={[palette.font('bodyMedium', 12), styles.label, { color: palette.primaryText }]}>
            {button.workflow.name}
          </Text>
          {button.showField ? (
            <Text
              numberOfLines={1}
              style={[palette.font('body', 11), styles.label, { color: palette.caption }]}>
              {button.field?.name}
            </Text>
          ) : null}
        </Pressable>
      ))}
      {elements}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  action: {
    flexGrow: 1,
    flexBasis: 56,
    minHeight: 56,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
  },
  label: { textAlign: 'center' },
});
