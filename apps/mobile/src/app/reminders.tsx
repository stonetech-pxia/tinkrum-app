import { reminderWhen, remindersOf, type Reminder } from '@morph/core';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { t } from '@/i18n';
import { useNotificationState } from '@/reminders/useReminders';
import { useWorkflowChange } from '@/run/workflow-change';
import { usePalette } from '@/renderer/theme';
import { Button, Card } from '@/renderer/ui';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '@/workspace/context';

/**
 * "Settings -> Reminders" (D-251): list reminders, can toggle or remove (both generate an
 * undoable version). Creating and rescheduling are handled by AI modifications ("Remind me to log
 * expenses every day at 9 AM"), explained here.
 */
export default function RemindersRoute() {
  const { locale } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const permission = useNotificationState((s) => s.permission);
  const change = useWorkflowChange();
  const reminders = remindersOf(config);
  const caption = [palette.font('body', 13), { color: palette.caption }];

  const toggle = (r: Reminder, enabled: boolean) =>
    change(
      [{ op: 'updateTool', tool: r.id, changes: { enabled } }],
      t(locale, 'describeUpdateReminder', { title: r.title }),
    );
  const remove = (r: Reminder) =>
    change(
      [{ op: 'removeTool', tool: r.id }],
      t(locale, 'describeRemoveReminder', { title: r.title }),
    );

  return (
    <ScrollView
      testID="reminders-screen"
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap, paddingBottom: 48 }}>
      <Text style={caption}>{t(locale, 'remindersHint')}</Text>
      {permission === 'denied' && reminders.some((r) => r.enabled) ? (
        <Text
          testID="reminders-off"
          style={[palette.font('bodyMedium', 14), { color: palette.danger }]}>
          {t(locale, 'remindersOff')}
        </Text>
      ) : null}
      {reminders.length === 0 ? (
        <Card palette={palette}>
          <Text style={caption}>{t(locale, 'remindersNone')}</Text>
        </Card>
      ) : (
        reminders.map((r) => (
          <Card key={r.id} palette={palette} testID={`reminder-${r.id}`}>
            <View style={styles.row}>
              <View style={styles.flex}>
                <Text style={[palette.font('title', 16), { color: palette.text }]}>{r.title}</Text>
                <Text style={caption}>{reminderWhen(r, config, locale)}</Text>
              </View>
              <Switch
                testID={`reminder-${r.id}-enabled`}
                value={r.enabled}
                onValueChange={(on) => void toggle(r, on)}
                trackColor={{ true: palette.primary }}
              />
            </View>
            <Button
              palette={palette}
              variant="text"
              testID={`reminder-${r.id}-remove`}
              label={t(locale, 'reminderRemove')}
              onPress={() => void remove(r)}
            />
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
});
