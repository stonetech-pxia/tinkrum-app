import { migrateWorkspace, type WorkspaceConfig } from '@morph/core';

// Test-only: migrates legacy v33 config to v34 using the standard migration chain (migration only,
// no validation). New tests write v34 directly; use this only when inputs are long and assertions
// ignore its shape.
export function fromV33(raw: unknown): WorkspaceConfig {
  const result = migrateWorkspace({ schemaVersion: 33, ...(raw as object) });
  if (!result.ok) throw new Error(result.error);
  return result.config as WorkspaceConfig;
}
