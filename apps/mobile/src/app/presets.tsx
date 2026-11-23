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

/** 网站上「用你自己的 AI 做 App」的页面（D-593）：写法说明、示例和 App 文件检查。只打开网页，不带任何数据。 */
const MAKE_WITH_AI_URL = `${SITE_URL}/make.html`;

/**
 * 「设置 → 我的预设」（D-410）：把整个 App 存起来，以后换回来。系统层的页面，AI 改不了（底线 8）。
 * 应用和恢复历史版本一样先问一句，确认后生成一个版本，能撤销（底线 7）；记录都留着（底线 5）。
 * 「从文件导入」也在这里（D-497）：App 文件加成新 App，整份配置存成预设。
 * 样板 App 也列在这里（D-544）：和引导第 3 步同一条路，先进草稿，「应用」后能撤销。
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
  // 展开的是哪一块（D-614）：添加 App 的几种方式、示例 App、保存现在的样子。
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
    // 这个 App 做好了：工具清单可以清掉，开始下一个（D-414）。
    if (hasSession)
      Alert.alert(t(locale, 'sessionClearAfterPreset'), undefined, [
        { text: t(locale, 'sessionKeep'), style: 'cancel' },
        { text: t(locale, 'sessionClear'), onPress: () => void clearSession() },
      ]);
  }

  /**
   * 从文件导入（D-497）：App 文件（tinkrum-app，D-485）先问一句，确认后加成一个新 App，能撤销；
   * 整份配置的文件（morph-app-config）存成一个新预设，当前的 App 不变，点「应用」才换。
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
  // 这个 App 现在的完成度（D-417）：只提醒，不阻止（底线 19）。
  const check = useMemo(() => {
    const { tools, issues } = checkTools(config, registry);
    // 工具包自带的快捷操作不算用户做的工具，否则一个空 App 也有几十个。
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

  /** 预设旁边的「⋯」：改名、删除（D-614）。 */
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

  /** 「添加 App」里的一项：点了先收起，再做。 */
  const addRow = (testID: string, label: string, value: string, run: () => void) => ({
    testID,
    label,
    value,
    onPress: () => {
      setOpen(null);
      run();
    },
  });

  // 一屏看完（D-614）：上面「添加 App」「保存现在的样子」两个按钮，点了在下面展开；再下面是我的预设，
  // 点一下换成它，「⋯」里改名、删除。不用弹出层：iOS 上弹出层收起时接着打开文件选择或分享面板会失败。
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
                  // 回到主页看草稿。
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
