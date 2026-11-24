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

/** Unified import and preview shared by files, manual paste, and deep links; opening the page itself does not read the clipboard or perform imports. */
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
  // Cards on the home screen can also use it; cannot unconditionally go back to a non-existent page.
  function goHome() {
    leaveApp();
    selectTab(pageTarget(HOME_PAGE_ID));
    if (router.canDismiss()) router.dismissAll();
    else router.replace('/');
  }
  /**
   * Paste from clipboard (D-593): app files written by other AIs (Claude, ChatGPT) in chat can be
   * copied and imported directly without saving to a file first. Followed by the exact same flow
   * as "Import from file" (prompt, preview, undoable); uses default name when saving full config
   * as preset.
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

  /** Process read text according to its format: app files added as new apps, full config saved as presets. Strip code blocks and surrounding conversational text first. */
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
    // When file claims to be an app file but fails to read (likely AI error): report specific errors line by line so they can be copied back to the authoring AI.
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
      // When the full setup is handed back from another AI app (via card tap, link open, or just handing out a setup): previews directly, leaving the user's selected images in place.
      if (previewPreset || pending?.scope === 'setup') await apply(result.preset, true);
    }
  }

  /**
   * App file import failure: lists initial reasons, plus a button to copy all reasons so the user
   * can paste them back to the AI author for correction. Structural issues only (IDs, appearance,
   * fields), no records or files; copies only upon user tap (invariant 10).
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
   * File outer manifest (D-556) contains items missing from this version: specifies exactly what
   * is missing and needs updating. Used instead of general wording only when import fails
   * (unrecognized appearances in this version are preserved as-is in the full config, D-254, and
   * such presets can still be saved). Returns null for files without a manifest.
   */
  function needsUpdate(text: string): string | null {
    const missing = missingUses(text, registry);
    return missing.length > 0
      ? t(locale, 'importNeedsUpdate', { missing: missing.join(t(locale, 'listSeparator')) })
      : null;
  }

  /** Import an app file: choose between "Import Home" or "Create New App", preview, confirm to apply, undoable in change history (invariants 5, 7). */
  function importApp(appFile: AppFile, text: string, title: string) {
    // Already installed the same app (returned after edits by another AI, D-611): defaults to updating it, connects by ID, preserves all records.
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
      // File states requirements used by it but missing from this version (D-556): explicitly state what is missing.
      const newer = needsUpdate(text);
      if (newer) {
        Alert.alert(title, newer);
        return;
      }
      // Same wording as website and self-test scripts (D-595): reports errors by file location
      // (tables.1.fields.3.id) rather than import operation ID. Does not prompt to "update first"
      // unless file specifies new dependencies. Reports local mismatch reasons (limits, table
      // ownership) when the file itself is valid but conflicts with existing device contents.
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
        // Update is removal followed by re-installation (D-611): step-by-step descriptions say "Remove App", here we list only actual changes.
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
              // For apps created as standalone apps, record original file locally: enables "Restore initial state" later.
              if (mode === 'app') await saveAppOrigin(repo, appFile.app.id, text);
              // Return to home screen, the new app's entry point (or new page) is located there.
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
              // Switched apps, leaving previous modification's remaining sentence and next step suggestions obsolete.
              await clearNext();
              await clearSuggest();
              // Return to home screen to view results, top prompt bar provides undo.
              goHome();
            })(),
        },
      ],
    );
  }

  return { importText, pasteFile, apply };
}

/** JSON format within text; undefined if not JSON or lacking format. */
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
