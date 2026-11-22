import { SITE_URL, type Locale } from '@morph/core';
import { Linking, Share } from 'react-native';

import type { RescueActions } from './RescueScreen';

// 兜底页按钮背后的事。数据库、备份、分享这些主流程的模块点了按钮才加载：它们自己坏了，兜底页也照样打开。

export function rescueActions(locale: Locale, now = () => new Date()): RescueActions {
  const steps = {};
  return {
    async exportBackup() {
      const { backupAvailable, getBackup } = await import('../backup');
      if (!backupAvailable()) throw new Error('unavailable');
      await getBackup().exportAll();
      const { useBackupStatus } = await import('../backup/service');
      const { exported, error } = useBackupStatus.getState();
      if (!exported) throw new Error(error?.kind ?? 'failed');
      const { expoFilePlatform } = await import('../runtime/expo-platform');
      await expoFilePlatform.shareUris([
        {
          uri: exported.uri,
          mimeType: 'application/zip',
          name: exported.name.replace(/\.zip$/, ''),
          ext: 'zip',
        },
      ]);
    },
    async stepBack() {
      const { openRepo } = await import('../storage/open');
      const { stepBack } = await import('./step-back');
      return stepBack(await openRepo(), steps, locale, now());
    },
    // 只交给系统的分享面板，发不发、发给谁由用户自己选（底线 10）；App 自己不联网。
    async shareError(text) {
      await Share.share({ message: text });
    },
    async openSite() {
      await Linking.openURL(SITE_URL);
    },
  };
}
