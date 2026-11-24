// Desk directory (file-room DESIGN §3, D-357): desk/<deskId>/ under app document directory,
// excluding cache (system clears cache). Manages only files in the desk directory; paths are
// relative to desk/ (iOS absolute paths of document directories change after app updates).
// Originals (photo library, Files, content://) and inbox batch copies are only copied, never moved;
// only temporary files from the current run can be moved in (AGENTS.md "File ownership").

export interface DeskFs {
  /** Current URI for a relative path in the desk directory (for display, passing to runtime). */
  uri(path: string): string;
  /** Whether it is a temporary file in the run directory (cache/runs/): belongs to this run, can be moved into the desk. */
  isRunFile(uri: string): boolean;
  /** Returns the relative path of the URI if it is in the desk directory (files returned verbatim by tools), otherwise null. */
  pathOf(uri: string): string | null;
  /** Copy into the workspace directory (originals and inbox batch copies are left untouched), and return the size. */
  copyIn(uri: string, path: string): Promise<number>;
  /** Move into the workspace directory (used only for temporary files in the runtime directory), and return the size. */
  moveIn(uri: string, path: string): Promise<number>;
  writeText(path: string, text: string): Promise<number>;
  /** Write a file (xlsx / docx generated when closing an edit, D-366), and return the size. */
  writeBytes(path: string, bytes: Uint8Array): Promise<number>;
  /** Return null if it cannot be read. */
  readText(path: string): Promise<string | null>;
  /** Rename within the same workspace (using native rename without copying); if the target already exists, delete it first. */
  rename(from: string, to: string): Promise<void>;
  /** Delete specified files; only deletes files within the workspace directory, and missing files are not considered an error. */
  remove(paths: readonly string[]): Promise<void>;
  /** Delete the entire workspace. */
  removeDesk(deskId: string): Promise<void>;
  /** List available workspaces (directory names). */
  list(): Promise<string[]>;
}
