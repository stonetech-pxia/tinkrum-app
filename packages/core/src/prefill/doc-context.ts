// Context for the current document: rules need to know currency, full text, number of amounts in
// the row, and current year before and after scoring. Initialized at the start of suggestValues /
// planDocument and used synchronously (without await), hence stored in module variables.
export type DocumentKind = '' | 'card' | 'receipt' | 'other';

export const ctx: {
  currency: string;
  text: string;
  /** Number of two-decimal numbers in the current row being read (used for space-separated thousand separator detection). */
  rowMany: number;
  /** "Current" year: used for century resolution on two-digit years. */
  nowYear: number;
  /** The text appears to be an invoice (rather than a receipt). */
  invoice: boolean;
  /** Rule set to use (prefillRules on the table, other = general rules only); '' = uninitialized via planDocument. */
  kind: DocumentKind;
} = {
  kind: '',
  rowMany: 0,
  nowYear: 0,
  invoice: false,
  currency: '',
  text: '',
};

/** Clear document context after processing a document so that un-planned calls (attachment text, checks) do not bleed the currency and text of the previous document. */
export function resetDocContext(): void {
  ctx.rowMany = 0;
  ctx.nowYear = 0;
  ctx.invoice = false;
  ctx.kind = '';
  ctx.currency = '';
  ctx.text = '';
}

/** Receipt rules (D-403) apply only to receipts; un-planned calls (kind set to '') behave as before. */
export const receiptRules = (): boolean => ctx.kind === '' || ctx.kind === 'receipt';
/** Business card rules apply only to business cards. */
export const cardRules = (): boolean => ctx.kind === 'card';

/** Synchronous calls following planDocument (querying models, validating model answers) also follow this table's rules. */
export function withDocKind<T>(kind: DocumentKind, work: () => T): T {
  const before = ctx.kind;
  ctx.kind = kind;
  try {
    return work();
  } finally {
    ctx.kind = before;
  }
}
