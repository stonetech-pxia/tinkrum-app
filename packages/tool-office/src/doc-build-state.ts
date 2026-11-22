import type { DocBuildOptions, DocPage, DocPageInput } from './doc-support';
export type RebuildPage = (
  input: DocPageInput,
  options: DocBuildOptions,
  protectFigures: boolean,
  repairTables?: boolean,
  repairBarcodes?: boolean,
) => DocPage;
export interface PageBuildContext {
  input: DocPageInput;
  options: DocBuildOptions;
  protectFigures: boolean;
  repairTables: boolean;
  repairBarcodes: boolean;
  buildPage: RebuildPage;
}
export type StageState<T> = T extends { state: infer S } ? S : never;
export function donePage(done: DocPage): { done: DocPage } {
  return { done };
}
export function nextStage<T>(state: T): { state: T } {
  return { state };
}
