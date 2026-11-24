import { CollectionSchema, migrateWorkspace, type Collection } from '@morph/core';

/**
 * Data tables in a historical version (upgrade pre-v34 versions first, v33 reference field syntax
 * differs). Used to find structures of tables moved out of the interface (versions are
 * append-only, never deleted). Skip unreadable versions.
 */
export function revisionTables(raw: unknown): Collection[] {
  const migrated = migrateWorkspace(raw);
  if (!migrated.ok) return [];
  const list = (migrated.config as { data?: { tables?: unknown[] } }).data?.tables ?? [];
  return list.flatMap((c) => {
    const parsed = CollectionSchema.safeParse(c);
    return parsed.success ? [parsed.data] : [];
  });
}
