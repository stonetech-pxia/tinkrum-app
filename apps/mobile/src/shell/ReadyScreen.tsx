import {
  allComponents,
  HOME_PAGE_ID,
  handedInput,
  isKnownComponent,
  stepLabel,
  type Workflow,
} from '@morph/core';

import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { Icon } from '../renderer/Icon';
import { usePalette } from '../renderer/theme';
import { Button, Card } from '../renderer/ui';
import { HomeScreenCard } from '../home-screen/HomeScreenCard';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '../workspace/context';
import { openRunAfterClosing } from './navigation';
import { NextCard } from './NextCard';
import { Banner } from './Shell';

/**
 * "Quick action is ready" (D-125): Opened after AI creates a new quick action. AI does not run it
 * for the user (D-113); the user taps "Use once now" themselves; also explains where to find it
 * in the future. Feature modifications take effect directly (D-191), and AI's explanation and
 * "Modify next" are also here. Explains how to place it on the mobile home screen (D-271): on
 * iOS, long-press the Morph icon; Android also has an "Add to Home screen" button (tapping it
 * brings up the system prompt).
 */
export function ReadyScreen({ workflow, notes = [] }: { workflow: Workflow; notes?: string[] }) {
  const { locale, registry } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const router = useRouter();
  const onHome = config.containers.pages.some(
    (p) =>
      p.id === HOME_PAGE_ID &&
      allComponents(p).some(
        (c) =>
          isKnownComponent(c) &&
          c.look === 'action' &&
          c.tools.some((u) => 'tool' in u && u.tool === workflow.id),
      ),
  );
  const needsContainer = handedInput(workflow.steps, registry) !== null;
  const body = [palette.font('body', 15), { color: palette.text }];

  return (
    <ScrollView
      testID="ready-screen"
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap, paddingBottom: 48 }}>
      {/* Directly applied features (D-191): "Modified successfully · Undo" can also be seen here. */}
      <Banner palette={palette} />
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: palette.secondary }]}>
          <Icon name="check" size={22} color="#FFFFFF" />
        </View>
        <Text style={[palette.font('heading', 22), styles.flex, { color: palette.text }]}>
          {t(locale, 'readyTitle')}
        </Text>
      </View>
      <Card palette={palette}>
        <Text testID="ready-name" style={[palette.font('title', 17), { color: palette.text }]}>
          {workflow.name}
        </Text>
        {workflow.steps.map((step, i) => (
          <View key={step.id} style={styles.step}>
            <Text style={[body, styles.flex]}>
              {`${i + 1}. ${stepLabel(registry.actions.get(step.action), step.params, locale) ?? step.action}`}
            </Text>
          </View>
        ))}
        {notes.map((note, i) => (
          <Text
            key={`n${i}`}
            testID={`ready-note-${i}`}
            style={[palette.font('body', 13), { color: palette.muted }]}>
            {note}
          </Text>
        ))}
        <Text style={[palette.font('body', 13), { color: palette.caption }]}>
          {t(locale, onHome ? 'readyHome' : 'workflowWhere')}
        </Text>
      </Card>
      <HomeScreenCard workflow={workflow} palette={palette} />
      {/* Those that require containers to return values (D-428) cannot be run from here: they are tapped on the record page and list. */}
      {needsContainer ? null : (
        <Button
          palette={palette}
          testID="ready-run"
          label={t(locale, 'readyRunNow')}
          onPress={() => openRunAfterClosing(router, workflow.id)}
        />
      )}
      <NextCard palette={palette} />
      <Button
        palette={palette}
        testID="ready-later"
        variant="outline"
        label={t(locale, 'readyLater')}
        onPress={() => router.back()}
      />
      <Pressable
        testID="ready-fix"
        accessibilityRole="link"
        hitSlop={8}
        style={styles.link}
        onPress={() => router.replace({ pathname: '/change', params: { workflow: workflow.id } })}>
        <Text style={[palette.font('bodyMedium', 14), { color: palette.primaryText }]}>
          {t(locale, 'readyFix')}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  link: { alignSelf: 'center', paddingVertical: 4 },
});
