import {
  APP_FILE_FORMAT,
  HOME_PAGE_ID,
  MAX_APP_CONFIG_SIZE,
  MAX_SAVED_PRESETS,
  appFileJsonText,
  appFileOps,
  appUpdateOps,
  checkAppFileText,
  describeAppUpdate,
  missingUses,
  pageTarget,
  readAppFile,
  type AppFile,
  type ImportMode,
} from '@morph/core';
import { useRouter } from 'expo-router';
import { Alert } from 'react-native';

import { saveAppOrigin } from '@/apps/origin';
import { configFileProblemText } from '@/data/config-file-import';
import { t } from '@/i18n';
import type { SavedPreset } from '@/storage/types';
import { useWorkspaceContext } from '@/workspace/context';
import { useAiReturn } from '@/ai/return';

/** 文件、主动粘贴和深链接共用的导入与预览；打开页面本身不读取剪贴板、不导入。 */
export function useConfigImport(previewPreset = false) {
  const { repo, files, locale, registry, store } = useWorkspaceContext();
  const router = useRouter();
  const state = () => store.getState();
  const {
    importPreset,
    proposeOps,
    confirm,
    cancel,
    clearNext,
    clearSuggest,
    selectTab,
    leaveApp,
    proposePreset,
  } = state();
  // 回到主页上的卡片也能用，不能无条件 back 到一张不存在的页面。
  function goHome() {
    leaveApp();
    selectTab(pageTarget(HOME_PAGE_ID));
    if (router.canDismiss()) router.dismissAll();
    else router.replace('/');
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
    if (raw.length > MAX_APP_CONFIG_SIZE) {
      Alert.alert(title, configFileProblemText(locale, 'tooLarge'));
      return;
    }
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
    const pending = useAiReturn.getState().pending;
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
    else if (result.kind === 'saved') {
      useAiReturn.getState().dismiss(pending?.id);
      // 整套设置从别的 AI App 交回来（点了卡片、打开链接，或刚交出去一套设置）：直接预览，用户选的图片留在原处。
      if (previewPreset || pending?.scope === 'setup') await apply(result.preset, true);
    }
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
    const installed = (state().config!.nav.apps ?? []).find((a) => a.id === appFile.app.id);
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
    const pending = useAiReturn.getState().pending;
    const config = state().config!;
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
              useAiReturn.getState().dismiss(pending?.id);
              goHome();
            })(),
        },
      ],
    );
  }

  async function apply(preset: SavedPreset, fromAi = false) {
    const result = await proposePreset(preset.id, { keepFiles: fromAi });
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
              goHome();
            })(),
        },
      ],
    );
  }

  return { importText, pasteFile, apply };
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
