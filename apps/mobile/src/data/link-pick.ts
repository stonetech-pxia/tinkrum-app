import { create } from 'zustand';

/**
 * In relation fields, "Add new" (D-546): opens the new record page for that table in the relation
 * input (passing its own token). After the user saves, the new record page passes back the record
 * ID, and the input selects it. Memory-only, no data written; if left without saving, passes
 * nothing back.
 */
export const useLinkPick = create<{ picked: { token: string; id: string } | null }>(() => ({
  picked: null,
}));

export const deliverLinkPick = (token: string, id: string) =>
  useLinkPick.setState({ picked: { token, id } });
