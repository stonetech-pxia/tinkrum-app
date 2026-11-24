import { useLinkingURL } from 'expo-linking';
import { useRouter } from 'expo-router';
import { ShareIntentModule } from 'expo-share-intent';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import type { FilePlatform } from '../runtime/platform';
import { keepIncomingFiles } from '../storage/keep-files';
import { useWorkspace, useWorkspaceContext } from '../workspace/context';
import { nativeCopies, normalizeShare, useIncoming } from './incoming';

// Key used by the share extension to store data: `<scheme>ShareKey`.

/** Key used by share extension to store data: `<scheme>ShareKey`. */
const SHARE_KEY = 'morphShareKey';

export const isShareLink = (url: string) => url.includes('dataUrl=');

/** Placed in root layout: opens inbox page upon receiving files. Does not automatically run any workflows. */
export function useIncomingShare(files: Pick<FilePlatform, 'removeShared'>) {
  const url = useLinkingURL();
  const router = useRouter();
  const receive = useIncoming((s) => s.receive);
  const workspace = useWorkspaceContext();
  const bumpAssets = useWorkspace((s) => s.bumpAssets);

  useEffect(() => {
    const native = ShareIntentModule;
    if (!native) return;
    const subscription = native.addListener('onChange', (event) => {
      const shared = normalizeShare(event.value);
      void native.clearShareIntent(SHARE_KEY);
      // Unprocessed files from the previous batch are no longer needed, keep only this batch. Android copies are stored with original filenames; duplicate names already belong to this batch.
      const copies = nativeCopies(event.value);
      const previous = (useIncoming.getState().share?.copies ?? []).filter(
        (uri) => !copies.includes(uri),
      );
      void files
        .removeShared(
          shared.map((f) => f.uri),
          previous,
        )
        .catch(() => undefined);
      // Save shared files into the document library (D-455) before entering the inbox page.
      void keepIncomingFiles(shared, workspace.files, workspace.repo).then((kept) => {
        bumpAssets();
        receive(kept, copies);
        router.navigate('/share');
      });
    });
    return () => subscription.remove();
  }, [files, receive, router, workspace, bumpAssets]);

  useEffect(() => {
    const native = ShareIntentModule;
    if (!native) return;
    if (Platform.OS === 'ios') {
      if (url && isShareLink(url)) native.getShareIntent(url);
    } else if (Platform.OS === 'android') {
      // Shares during cold start are retrieved here; while the app is running, the native module directly emits onChange for new Intents.
      native.getShareIntent('');
    }
  }, [url]);
}
