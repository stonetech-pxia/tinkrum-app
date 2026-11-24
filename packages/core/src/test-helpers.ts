// Test-only helper functions (not exported from index.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { migrateWorkspace } from './migrate';
import { applyOps, type Op } from './ops';
import { createRegistry } from './registry';
import { createDefaultWorkspace } from './defaults';
import { STARTER_THEME } from './theme';
import type { Locale, WorkspaceConfig } from './schema';
import { BUILTIN_TOOLS } from './tools';

export const registry = createRegistry(BUILTIN_TOOLS);

export function apply(config: WorkspaceConfig, ops: Op[], locale: Locale = 'zh'): WorkspaceConfig {
  const result = applyOps(config, ops, { registry, locale });
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

export function workspace(locale: Locale = 'zh', { withPdf = false } = {}): WorkspaceConfig {
  const config = createDefaultWorkspace(locale);
  return withPdf
    ? apply(config, [{ op: 'setPackage', package: 'pdf', do: 'add' }], locale)
    : config;
}

/**
 * A v33 configuration (written as usual in tests, or stored in fixtures/v33/) upgraded to v34 via
 * migration chain. Migrate only, no validation: validation delegated to the tested step.
 */
export function fromV33(raw: unknown): WorkspaceConfig {
  const result = migrateWorkspace({ schemaVersion: 33, ...(raw as object) });
  if (!result.ok) throw new Error(result.error);
  return result.config as WorkspaceConfig;
}

/**
 * D-450: Scanning tools ("Scan to PDF", "Photo scan to PDF") now have an extra final step to save
 * to files (all scanned files remain in document library); D-455: PDF conversion step includes
 * text layer. Stored v33 golden samples lack this step: supplemented when comparing with current
 * new config, otherwise compared line by line as usual.
 */
export function withScanKeep(config: WorkspaceConfig): WorkspaceConfig {
  const next = structuredClone(config);
  for (const tool of next.tools) {
    if (tool.kind !== 'quickAction' || tool.package !== 'scan') continue;
    if (tool.id !== 'scan-camera' && tool.id !== 'scan-library') continue;
    if (tool.steps.at(-1)?.action !== 'file.save')
      tool.steps.push({ id: 'keep', action: 'file.save', params: {} });
    // D-455: Scan to PDF includes text layer.
    const pdf = tool.steps.find((s) => s.action === 'pdf.fromImages');
    if (pdf) pdf.params = { ...pdf.params, textLayer: true };
  }
  return next;
}

/**
 * D-487: New users' starting config uses refined Clay (STARTER_THEME). v33 stored starting config
 * and sample apps use old style; replaced with new style when comparing with current new config,
 * otherwise compared line by line as usual.
 */
export function withStarterTheme(config: WorkspaceConfig): WorkspaceConfig {
  return { ...structuredClone(config), theme: structuredClone(STARTER_THEME) };
}

/** fixtures/v33/<name>.json: configuration saved using v33 code before v34 migration (default, new user, template, sample app, evaluation setup). */
export function v33Fixture(name: string): Record<string, unknown> {
  // Welcome message is the default copy when saved; after D-436 renamed AI to Tink, new configs
  // have different default copy, old configs remain unchanged. D-510: File tools are bundled with
  // the app, scanner and OCR tool page descriptions no longer state first-time download is
  // required; similarly only new configs have updated copy.
  const raw = readFileSync(join(__dirname, 'fixtures', 'v33', `${name}.json`), 'utf8')
    .replaceAll('点「AI 修改」', '点「Tink」')
    .replaceAll('Tap AI and describe', 'Tap Tink and describe')
    .replaceAll('Touchez « IA »', 'Touchez « Tink »')
    .replaceAll(
      '不会上传。扫描用系统自带的文档扫描；拉正已有照片时，有的设备第一次要下载一些内容（之后不联网也能用）。',
      '不联网也能用，不会上传。扫描用系统自带的文档扫描。',
    )
    .replaceAll('第一次用时下载文字识别模型（约 30 MB）；', '文字识别模型已经内置，不联网也能用；')
    .replaceAll(
      'Everything runs on this device; nothing is uploaded. Scanning uses the built-in document scanner; straightening photos may download what it needs the first time (it works offline after that).',
      'Everything runs on this device and works offline; nothing is uploaded. Scanning uses the built-in document scanner.',
    )
    .replaceAll(
      'The text recognition model (about 30 MB) is downloaded the first time you use it;',
      'The text recognition model comes with the app and works offline;',
    );
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Compact formatting for snapshots: one item per line ("path = JSON"), much smaller than expanded
 * objects and easier to read differences. Objects and arrays that are too long are split another
 * level down; undefined rendered as "∅undefined".
 */
export function snapshotLines(value: unknown, width = 100): string {
  const out: string[] = [];
  const json = (v: unknown) =>
    JSON.stringify(v, (_k, x: unknown) => (x === undefined ? '∅undefined' : x)) ?? '∅undefined';
  const walk = (v: unknown, path: string) => {
    const text = json(v);
    if (v !== null && typeof v === 'object' && text.length > width && Object.keys(v).length > 0) {
      for (const [k, x] of Object.entries(v))
        walk(x, Array.isArray(v) ? `${path}[${k}]` : path ? `${path}.${k}` : k);
    } else out.push(`${path} = ${text}`);
  };
  walk(value, '');
  return `\n${out.join('\n')}\n`;
}
