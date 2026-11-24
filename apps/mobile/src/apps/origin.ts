import { readAppFile, type AppFile } from '@morph/core';

import type { WorkspaceRepo } from '../storage/types';

// Original files of imported app (D-485): stored only in local app_meta, not in config, not sent to
// AI, used for "restore initial state". Apps not imported from files (built by Tink or user) have
// no original files, hence no "restore initial state".

type Meta = Pick<WorkspaceRepo, 'getMeta' | 'setMeta'>;
const key = (appId: string) => `app.origin.${appId}`;

export async function saveAppOrigin(repo: Meta, appId: string, text: string): Promise<void> {
  await repo.setMeta(key(appId), text);
}

export async function loadAppOrigin(repo: Meta, appId: string): Promise<AppFile | null> {
  const text = await repo.getMeta(key(appId));
  return text ? readAppFile(text) : null;
}
