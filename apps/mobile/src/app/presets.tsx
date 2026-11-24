import {
  SITE_URL,
  MAX_PRESET_NAME,
  MAX_SAVED_PRESETS,
  canSavePreset,
  checkTools,
  issueReason,
  quickActionsOf,
  sessionIsEmpty,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useConfigImport } from '@/data/useConfigImport';
import { useAiHandoff } from '@/ai/useAiHandoff';
import { configFileProblemText, pickConfigText } from '@/data/config-file-import';
import { SampleRows, usePickSample } from '@/guide/GuideCard';
import { formatWhen, t } from '@/i18n';
import { usePalette, type Palette } from '@/renderer/theme';
import { Button, Card, Pill, SectionLabel } from '@/renderer/ui';
import { RowGroup } from '@/shell/RowGroup';
import { Toast } from '@/shell/Toast';
import type { SavedPreset } from '@/storage/types';
import { useWorkspace, useWorkspaceContext, useAppTheme } from '@/workspace/context';

/** "Build Apps with your own AI" page on website (D-593): writing instructions, examples, and app file checks. Opens webpage only, without transmitting any data. */
const MAKE_WITH_AI_URL = `${SITE_URL}/make.html`;

/**
 * Settings -> My Presets (D-410): save the entire app to switch back later. System-layer page,
 * cannot be modified by AI (invariant 8). Applying and restoring history versions prompts first,
 * generates a version upon confirmation, and is undoable (invariant 7); records are preserved
 * (invariant 5). "Import from file" is also located here (D-497): app file added as a new app,
 * entire config saved as a preset. Sample apps are also listed here (D-544): same path as
 * tutorial step 3, enters draft first, undoable after "Apply".
 */
export default function PresetsRoute() {
  const { repo, files, locale, registry } = useWorkspaceContext();
  const config = useWorkspace((s) => s.config)!;
  const palette = usePalette(useAppTheme(config));
  const version = useWorkspace((s) => s.presetsVersion);
  const savePreset = useWorkspace((s) => s.savePreset);
  const renamePreset = useWorkspace((s) => s.renamePreset);
  const deletePreset = useWorkspace((s) => s.deletePreset);
  const leaveApp = useWorkspace((s) => s.leaveApp);
  const hasSession = useWorkspace((s) => !sessionIsEmpty(s.session));
  const clearSession = useWorkspace((s) => s.clearSession);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [presets, setPresets] = useState<SavedPreset[] | null>(null);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // Expanded section (D-614): app addition methods, sample apps, save current state.
  const [open, setOpen] = useState<'add' | 'samples' | 'save' | null>(null);
  const sample = usePickSample();
  const { importText, pasteFile, apply } = useConfigImport();
  const sendToAi = useAiHandoff();

  useEffect(() => {
    let alive = true;
    void repo.listPresets().then((list) => alive && setPresets(list));
    return () => {
      alive = false;
    };
  }, [repo, version]);

  async function save() {
    const result = await savePreset(name);
    if (result.kind !== 'saved') return;
    setName('');
    setOpen(null);
    // This app is completed: tool list can be cleared, ready for the next one (D-414).
    if (hasSession)
      Alert.alert(t(locale, 'sessionClearAfterPreset'), undefined, [
        { text: t(locale, 'sessionKeep'), style: 'cancel' },
        { text: t(locale, 'sessionClear'), onPress: () => void clearSession() },
      ]);
  }

  /**
   * Import from file (D-497): app file (tinkrum-app, D-485) prompts first, adds as a new app upon
   * confirmation, undoable; full config file (morph-app-config) saved as a new preset, current
   * app unchanged until "Apply" is tapped.
   */
  async function importFile() {
    const title = t(locale, 'presetsImport');
    const picked = await pickConfigText(files);
    if (picked.kind === 'cancelled') return;
    if (picked.kind === 'refused') {
      Alert.alert(title, configFileProblemText(locale, picked.problem));
      return;
    }
    await importText(picked.text, picked.fileName, title);
  }

  async function rename() {
    if (renaming && (await renamePreset(renaming.id, renaming.name))) setRenaming(null);
  }

  const caption = [palette.font('body', 13), { color: palette.caption }];
  const full = presets !== null && !canSavePreset(presets.length);
  // Current completion status of this app (D-417): warning only, does not block (invariant 19).
  const check = useMemo(() => {
    const { tools, issues } = checkTools(config, registry);
    // Quick actions bundled with tool packs are not counted as user-created tools, otherwise an empty app would have dozens.
    const packaged = new Set(
      quickActionsOf(config)
        .filter((w) => w.package)
        .map((w) => w.id),
    );
    return {
      tools: tools.filter((x) => x.kind === 'record' || !packaged.has(x.id)).length,
      blockers: issues.filter((i) => i.severity === 'blocker'),
    };
  }, [config, registry]);

  /** "..." next to preset: rename, delete (D-614). */
  function presetMenu(preset: SavedPreset) {
    Alert.alert(preset.name, undefined, [
      {
        text: t(locale, 'presetRename'),
        onPress: () => setRenaming({ id: preset.id, name: preset.name }),
      },
      {
        text: t(locale, 'delete'),
        style: 'destructive',
        onPress: () => void deletePreset(preset),
      },
      { text: t(locale, 'cancel'), style: 'cancel' },
    ]);
  }

  /** Item in "Add App": collapses upon tap, then executes. */
  const addRow = (testID: string, label: string, value: string, run: () => void) => ({
    testID,
    label,
    value,
    onPress: () => {
      setOpen(null);
      run();
    },
  });

  // Viewable in a single screen (D-614): top "Add App" and "Save current state" buttons expand
  // downward when tapped; below that are my presets, tap to switch, use "..." to rename or delete.
  // Avoid popups: opening file pickers or share panels immediately after closing popups fails on
  // iOS.
  return (
    <View style={styles.flex}>
      <ScrollView
        testID="presets-screen"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 96 }}>
        <Button
          palette={palette}
          testID="preset-add"
          label={t(locale, 'presetsAdd')}
          onPress={() => setOpen(open === 'add' || open === 'samples' ? null : 'add')}
        />
        {open === 'add' ? (
          <>
            <RowGroup
              palette={palette}
              rows={[
                addRow(
                  'preset-samples',
                  t(locale, 'presetsSamplesTitle'),
                  t(locale, 'presetsSamplesRowHint'),
                  () => setOpen('samples'),
                ),
                addRow(
                  'preset-import',
                  t(locale, 'presetsImport'),
                  t(locale, 'presetsImportRowHint'),
                  () => void importFile(),
                ),
                addRow(
                  'preset-paste',
                  t(locale, 'presetsPaste'),
                  t(locale, 'presetsPasteRowHint'),
                  () => void pasteFile(),
                ),
                addRow(
                  'preset-share-to-ai',
                  t(locale, 'presetsAskAi'),
                  t(locale, 'presetsAskAiRowHint'),
                  () => void sendToAi({ kind: 'new' }),
                ),
              ]}
            />
            <Button
              palette={palette}
              testID="preset-make-with-ai"
              variant="text"
              label={t(locale, 'presetsMakeWithAi')}
              onPress={() => void Linking.openURL(MAKE_WITH_AI_URL).catch(() => {})}
            />
            <Text style={caption}>{t(locale, 'presetsAddUpdateNote')}</Text>
          </>
        ) : null}
        {open === 'samples' ? (
          <Card palette={palette} testID="preset-samples-panel">
            <Text style={[palette.font('title', 16), { color: palette.text }]}>
              {t(locale, 'presetsSamplesTitle')}
            </Text>
            <Text style={caption}>{t(locale, 'presetsSamplesHint')}</Text>
            <SampleRows
              palette={palette}
              testPrefix="preset-sample"
              busy={sample.busy}
              onPick={(id) =>
                void sample.pick(id, () => {
                  // Return to home screen to view draft.
                  leaveApp();
                  router.back();
                })
              }
            />
          </Card>
        ) : null}
        {full ? (
          <Card palette={palette}>
            <Text testID="presets-full" style={caption}>
              {t(locale, 'presetsFull', { max: MAX_SAVED_PRESETS })}
            </Text>
          </Card>
        ) : (
          <Button
            palette={palette}
            testID="preset-new"
            variant="outline"
            label={t(locale, 'presetsSave')}
            onPress={() => setOpen(open === 'save' ? null : 'save')}
          />
        )}
        {open === 'save' && !full ? (
          <Card palette={palette} testID="preset-save-panel">
            <Text style={[palette.font('title', 16), { color: palette.text }]}>
              {t(locale, 'presetsNew')}
            </Text>
            <NameInput
              palette={palette}
              testID="preset-name-input"
              autoFocus
              value={name}
              placeholder={t(locale, 'presetsNamePlaceholder')}
              onChangeText={setName}
            />
            <Text testID="preset-check-tools" style={caption}>
              {t(locale, 'presetCheckTools', { n: check.tools })}
            </Text>
            <Text testID="preset-check-summary" style={caption}>
              {check.blockers.length > 0
                ? t(locale, 'presetCheckProblems', { n: check.blockers.length })
                : t(locale, 'presetCheckOk')}
            </Text>
            {check.blockers.slice(0, 4).map((issue) => (
              <Text
                key={`${issue.code}|${issue.target}`}
                testID="preset-check-problem"
                style={caption}>
                • {issueReason(issue, config, locale)}
              </Text>
            ))}
            <Button
              palette={palette}
              testID="preset-save"
              label={t(locale, check.blockers.length > 0 ? 'presetSaveAnyway' : 'save')}
              disabled={!name.trim()}
              onPress={() => void save()}
            />
          </Card>
        ) : null}
        <SectionLabel palette={palette}>{t(locale, 'presetsListTitle')}</SectionLabel>
        {presets?.length === 0 ? (
          <Card palette={palette}>
            <Text testID="presets-none" style={caption}>
              {t(locale, 'presetsNone')}
            </Text>
          </Card>
        ) : null}
        {presets
          ?.filter((preset) => renaming?.id === preset.id)
          .map((preset) => (
            <Card key={preset.id} palette={palette} testID={`preset-${preset.id}`}>
              <NameInput
                palette={palette}
                testID="preset-rename-input"
                autoFocus
                value={renaming!.name}
                placeholder={t(locale, 'presetsNamePlaceholder')}
                onChangeText={(text) => setRenaming({ id: preset.id, name: text })}
              />
              <View style={styles.row}>
                <Pill
                  palette={palette}
                  testID="preset-rename-save"
                  label={t(locale, 'save')}
                  onPress={() => void rename()}
                />
                <Pill
                  palette={palette}
                  label={t(locale, 'cancel')}
                  onPress={() => setRenaming(null)}
                />
              </View>
            </Card>
          ))}
        <RowGroup
          palette={palette}
          rows={(presets ?? [])
            .filter((preset) => renaming?.id !== preset.id)
            .map((preset) => ({
              testID: `preset-${preset.id}`,
              label: preset.name,
              value: formatWhen(locale, new Date(preset.createdAt), new Date()),
              onPress: () => void apply(preset),
              extra: (
                <Pressable
                  testID={`preset-${preset.id}-more`}
                  accessibilityRole="button"
                  accessibilityLabel={t(locale, 'presetMore')}
                  hitSlop={12}
                  onPress={() => presetMenu(preset)}>
                  <Text style={[palette.font('title', 20), { color: palette.caption }]}>⋯</Text>
                </Pressable>
              ),
            }))}
        />
        <Text style={caption}>{t(locale, 'presetsHint')}</Text>
      </ScrollView>
      <Toast palette={palette} bottom={insets.bottom + 16} />
    </View>
  );
}

function NameInput({
  palette,
  ...props
}: {
  palette: Palette;
  testID: string;
  value: string;
  placeholder: string;
  autoFocus?: boolean;
  onChangeText: (text: string) => void;
}) {
  return (
    <TextInput
      {...props}
      maxLength={MAX_PRESET_NAME}
      returnKeyType="done"
      placeholderTextColor={palette.caption}
      style={[
        palette.font('body', 16),
        styles.input,
        {
          color: palette.text,
          borderColor: palette.border,
          borderRadius: palette.controlRadius,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
});
