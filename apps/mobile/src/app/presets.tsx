import {
  SITE_URL,
  APP_FILE_FORMAT,
  HOME_PAGE_ID,
  MAX_APP_CONFIG_SIZE,
  MAX_PRESET_NAME,
  MAX_SAVED_PRESETS,
  appFileJsonText,
  appFileOps,
  appUpdateOps,
  checkAppFileText,
  describeAppUpdate,
  handoffPrompt,
  missingUses,
  canSavePreset,
  checkTools,
  issueReason,
  pageTarget,
  quickActionsOf,
  readAppFile,
  sessionIsEmpty,
  type AppFile,
  type ImportMode,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { saveAppOrigin } from '@/apps/origin';
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
  const importPreset = useWorkspace((s) => s.importPreset);
  const proposeOps = useWorkspace((s) => s.proposeOps);
  const renamePreset = useWorkspace((s) => s.renamePreset);
  const deletePreset = useWorkspace((s) => s.deletePreset);
  const proposePreset = useWorkspace((s) => s.proposePreset);
  const confirm = useWorkspace((s) => s.confirm);
  const cancel = useWorkspace((s) => s.cancel);
  const clearNext = useWorkspace((s) => s.clearNext);
  const clearSuggest = useWorkspace((s) => s.clearSuggest);
  const selectTab = useWorkspace((s) => s.selectTab);
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

  /**
   * 从剪贴板粘贴（D-593）：别的 AI（Claude、ChatGPT）在对话里写好的 App 文件，复制过来直接导入，不用先存成文件。
   * 之后和「从文件导入」完全一样（先问、预览、能撤销）；整份配置存成预设时用默认名字。
   */
  async function pasteFile() {
    const title = t(locale, 'presetsPaste');
    const text = await files.readClipboardText();
    if (!text.trim()) {
      Alert.alert(title, t(locale, 'presetsPasteEmpty'));
      return;
    }
    if (text.length > MAX_APP_CONFIG_SIZE) {
      Alert.alert(title, configFileProblemText(locale, 'tooLarge'));
      return;
    }
    await importText(text, '', title);
  }

  /** 读出来的文字按自己的格式处理：App 文件加成新 App，整份配置存成预设。代码块、前后的话先去掉。 */
  async function importText(raw: string, fileName: string, title: string) {
    const text = appFileJsonText(raw);
    const appFile = readAppFile(text);
    if (appFile) {
      importApp(appFile, text, title);
      return;
    }
    // 说自己是 App 文件、却读不了的（多半是 AI 写错了）：逐条说哪里不对，可以复制给写它的 AI。
    if (formatOf(text) === APP_FILE_FORMAT) {
      const check = checkAppFileText(text, { registry, locale, now: new Date() });
      if (!check.ok) {
        problemsAlert(title, t(locale, 'importAppFileBroken'), check.problems);
        return;
      }
    }
    const result = await importPreset(text, fileName);
    const newer = needsUpdate(text);
    if ((result.kind === 'refused' || result.kind === 'invalid') && newer)
      Alert.alert(title, newer);
    else if (result.kind === 'refused')
      Alert.alert(title, configFileProblemText(locale, result.problem));
    else if (result.kind === 'invalid')
      Alert.alert(
        title,
        [t(locale, 'importAppConfigBroken'), ...result.issues.slice(0, 5)].join('\n'),
      );
    else if (result.kind === 'full')
      Alert.alert(title, t(locale, 'presetsFull', { max: MAX_SAVED_PRESETS }));
  }

  /**
   * App 文件导入不了：列出前几条原因，另有一个按钮把全部原因复制下来，用户贴回给写文件的 AI 去改。
   * 只有结构上的问题（ID、外观、字段），没有记录和文件；只在用户点了才复制（底线 10）。
   */
  function problemsAlert(title: string, lead: string, problems: readonly string[]) {
    Alert.alert(title, [lead, ...problems.slice(0, 3)].join('\n'), [
      {
        text: t(locale, 'importCopyProblems'),
        onPress: () =>
          void files.copyText(
            [t(locale, 'importProblemsForAi'), ...problems.map((p) => `- ${p}`)].join('\n'),
          ),
      },
      { text: t(locale, 'ok'), style: 'cancel' },
    ]);
  }

  /**
   * 文件外层的清单（D-556）里有这个版本没有的：准确地说缺什么、要更新。只在导入不成的时候用它代替笼统的说法
   * （这个版本不认识的外观在整份配置里会原样留着，D-254，那样的预设照样存得进去）。没有清单的文件返回 null。
   */
  function needsUpdate(text: string): string | null {
    const missing = missingUses(text, registry);
    return missing.length > 0
      ? t(locale, 'importNeedsUpdate', { missing: missing.join(t(locale, 'listSeparator')) })
      : null;
  }

  /** 导入一个 App 文件：先选「导入主页」还是「做成新 App」，再预览，确认后生效，能在改动记录里撤销（底线 5、7）。 */
  function importApp(appFile: AppFile, text: string, title: string) {
    // 已经装了同一个 App（别的 AI 改完交回来的，D-611）：默认更新它，按 ID 接上，记录都留着。
    const installed = (config.nav.apps ?? []).find((a) => a.id === appFile.app.id);
    if (installed) {
      Alert.alert(installed.name, t(locale, 'importUpdateChoose', { name: installed.name }), [
        {
          text: t(locale, 'importUpdateButton', { name: installed.name }),
          style: 'default',
          isPreferred: true,
          onPress: () => void proceedImport(appFile, text, 'update', title),
        },
        { text: t(locale, 'cancel'), style: 'cancel' },
      ]);
      return;
    }
    Alert.alert(appFile.app.name, t(locale, 'importAppChoose'), [
      {
        text: t(locale, 'importAppToHome'),
        onPress: () => void proceedImport(appFile, text, 'home', title),
      },
      {
        text: t(locale, 'importAppToApp'),
        onPress: () => void proceedImport(appFile, text, 'app', title),
      },
      { text: t(locale, 'cancel'), style: 'cancel' },
    ]);
  }

  async function proceedImport(
    appFile: AppFile,
    text: string,
    mode: ImportMode | 'update',
    title: string,
  ) {
    const plan =
      mode === 'update'
        ? appUpdateOps(appFile, config, registry)
        : appFileOps(appFile, config, { mode });
    if (!plan.ok) {
      problemsAlert(title, t(locale, 'importAppClash', { reason: '' }).trimEnd(), [plan.error]);
      return;
    }
    const result = await proposeOps(
      plan.ops,
      t(
        locale,
        mode === 'home'
          ? 'importHomeSummary'
          : mode === 'update'
            ? 'importUpdateSummary'
            : 'importAppSummary',
        { name: plan.name },
      ),
      { fromAppFile: true },
    );
    if (result.kind === 'invalid') {
      // 文件说了它用到的、这个版本没有的（D-556）：直接说缺什么。
      const newer = needsUpdate(text);
      if (newer) {
        Alert.alert(title, newer);
        return;
      }
      // 和网站、自检脚本同一套说法（D-595）：按文件里的位置说哪里不对（tables.1.fields.3.id），不是导入操作的
      // 编号；文件没说自己用到了新东西，就不说「先更新」。文件本身没错、只是和这台手机上已有的东西对不上的
      // （上限、表的归属这类），说这里的原因。
      const check = checkAppFileText(text, { registry, locale, now: new Date() });
      if (check.ok) problemsAlert(title, t(locale, 'importAppConfigBroken'), result.issues);
      else problemsAlert(title, t(locale, 'importAppFileBroken'), check.problems);
      return;
    }
    if (result.kind !== 'preview') {
      Alert.alert(t(locale, 'invalidPlan'), result.message);
      return;
    }
    Alert.alert(
      title,
      [
        t(
          locale,
          mode === 'home'
            ? 'importHomeConfirm'
            : mode === 'update'
              ? 'importUpdateConfirm'
              : 'importAppConfirm',
          { name: plan.name },
        ),
        // 更新是先移除再装回（D-611）：逐个操作的说法会说「移除 App」，这里只列真正变了的。
        ...(mode === 'update'
          ? describeAppUpdate(result.proposal.before, result.proposal.after, appFile.app.id, locale)
          : result.proposal.lines),
      ].join('\n'),
      [
        { text: t(locale, 'cancel'), style: 'cancel', onPress: () => void cancel() },
        {
          text: t(locale, 'presetApply'),
          onPress: () =>
            void (async () => {
              if (!(await confirm())) return;
              // 做成 App 的，原文件记在本机：以后能「恢复初始样子」。
              if (mode === 'app') await saveAppOrigin(repo, appFile.app.id, text);
              // 回到主页，新 App 的入口（或新页面）就在那里。
              leaveApp();
              selectTab(pageTarget(HOME_PAGE_ID));
              router.back();
            })(),
        },
      ],
    );
  }

  async function rename() {
    if (renaming && (await renamePreset(renaming.id, renaming.name))) setRenaming(null);
  }

  async function apply(preset: SavedPreset) {
    const result = await proposePreset(preset.id);
    if (result.kind !== 'preview') {
      Alert.alert(
        t(locale, 'invalidPlan'),
        result.kind === 'invalid' ? result.issues.join('\n') : result.message,
      );
      return;
    }
    Alert.alert(
      t(locale, 'presetApplyTitle', { name: preset.name }),
      result.proposal.lines.join('\n'),
      [
        { text: t(locale, 'cancel'), style: 'cancel', onPress: () => void cancel() },
        {
          text: t(locale, 'presetApply'),
          onPress: () =>
            void (async () => {
              if (!(await confirm())) return;
              // 换了一个 App，上一次修改剩下的那句和下一步的建议也就接不上了。
              await clearNext();
              await clearSuggest();
              // 回到首页看结果，顶部的提示条能撤销。
              leaveApp();
              selectTab(pageTarget(HOME_PAGE_ID));
              router.back();
            })(),
        },
      ],
    );
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
                  () =>
                    // 系统分享面板：用户自己挑一个 App，再自己点发送（底线 10）。
                    void Share.share(
                      { message: handoffPrompt({ kind: 'new' }, locale, new Date()) },
                      { dialogTitle: t(locale, 'presetsShareToAi') },
                    ).catch(() => {}),
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

/** 文字里 JSON 的 format；不是 JSON 或没有 format 时是 undefined。 */
function formatOf(text: string): unknown {
  try {
    const data = JSON.parse(text) as unknown;
    return typeof data === 'object' && data !== null
      ? (data as { format?: unknown }).format
      : undefined;
  } catch {
    return undefined;
  }
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
