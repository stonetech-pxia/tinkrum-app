import { SITE_URL, type Locale } from '@morph/core';
import { Linking, Share } from 'react-native';

import type { RescueActions } from './RescueScreen';

// Logic behind rescue page buttons. Main flow modules like database, backup, and sharing are loaded only when buttons are tapped: if those modules themselves are broken, the rescue page still opens successfully.

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
    // Passed only to the system share sheet; whether to send and to whom is chosen entirely by the user (Invariant 10); the app itself makes no network requests.
    async shareError(text) {
      await Share.share({ message: text });
    },
    async openSite() {
      await Linking.openURL(SITE_URL);
    },
  };
}
