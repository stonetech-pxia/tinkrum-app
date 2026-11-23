import {
  appConfigFile,
  appConfigFileName,
  appFileOfApp,
  appFileText,
  handoffPrompt,
  presetSnapshot,
  type HandoffScope,
} from '@morph/core';
import { Alert } from 'react-native';

import { t } from '@/i18n';
import { useWorkspaceContext } from '@/workspace/context';
import { useAiReturn } from './return';

/** 只有用户点分享才运行；App 和整份设置都清掉文件引用，记录不在配置中。 */
export function useAiHandoff() {
  const { store, files, locale } = useWorkspaceContext();
  return async (scope: HandoffScope, request?: string, appId?: string) => {
    const config = store.getState().config!;
    const now = new Date();
    const app = scope.kind === 'app' && appId ? appFileOfApp(config, appId) : null;
    if (scope.kind === 'app' && !app) return;
    const file =
      scope.kind === 'setup'
        ? { name: appConfigFileName(now), text: appConfigFile(presetSnapshot(config), now) }
        : app
          ? { name: `tinkrum-app-${app.app.id}.json`, text: appFileText(app, now) }
          : undefined;
    const previous = useAiReturn.getState().pending;
    const pending = useAiReturn.getState().start(scope.kind, now.getTime());
    try {
      await files.shareWithAi({
        ...(file ? { file } : {}),
        prompt: (how) =>
          handoffPrompt(scope, locale, now, { ...how, fileName: file?.name, request }),
      });
    } catch {
      if (useAiReturn.getState().pending?.id === pending.id)
        useAiReturn.getState().restore(previous);
      Alert.alert(t(locale, 'presetsShareToAi'), t(locale, 'handoffFailed'));
    }
  };
}
