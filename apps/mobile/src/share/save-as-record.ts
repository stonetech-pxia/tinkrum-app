import type { WorkspaceConfig } from '@morph/core';

// Inbox "Save as record" (D-392, D-444): lists tables with attachment fields (all, unfiltered) and
// "New form". No AI, no OCR, no prefilled default values; received files are copied as user files
// into attachment fields for the user to complete and save.

export type RecordChoice = {
  kind: 'table';
  tableId: string;
  name: string;
  /** Files resemble a receipt, and this table has receipt rules (D-421): sorted first and marked recommended (D-477). */
  recommended?: true;
};

/** Existing tables that can hold files. Creating a new table goes through the new form page (D-444). */
export function recordChoices(config: WorkspaceConfig, receiptLike = false): RecordChoice[] {
  const tables = config.data.tables.filter((c) => c.fields.some((f) => f.type === 'file'));
  const choice = (c: (typeof tables)[number]): RecordChoice => ({
    kind: 'table',
    tableId: c.id,
    name: c.name,
  });
  if (!receiptLike) return tables.map(choice);
  const rule = tables.filter((c) => c.prefillRules === 'receipt');
  return [
    ...rule.map((c) => ({ ...choice(c), recommended: true as const })),
    ...tables.filter((c) => c.prefillRules !== 'receipt').map(choice),
  ];
}

/**
 * User files copied out for the new record form (not yet saved to any record). Kept in memory
 * only, passed to the record page via a random key: if the user leaves without saving, the record
 * page deletes them using this key. Not placed in route parameters: external links cannot
 * leverage this to delete user files.
 */
const formCopies = new Map<string, string[]>();

export function holdFormCopies(assetIds: string[]): string {
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  formCopies.set(key, assetIds);
  return key;
}

/** Retrieve files for this key (can only be retrieved once); returns empty if the key was not provided here. */
export function takeFormCopies(key: string | undefined): string[] {
  if (!key) return [];
  const ids = formCopies.get(key) ?? [];
  formCopies.delete(key);
  return ids;
}
