import { strToU8 } from 'fflate';
import { appFileJsonText, checkAppFileText, type AppFileSummary } from './app-file-check';
import { APP_CONFIG_FILE_FORMAT, MAX_APP_CONFIG_SIZE, parseAppConfigFile } from './config-file';
import type { Registry } from './registry';
import { preparePreset } from './saved-presets';
import { quickActionsOf, remindersOf, type Locale, type WorkspaceConfig } from './schema';
import { checkTools } from './tool-check';

/** 单 App 的导入检查保持不变；整份设置走预设的迁移与校验，不把它当成一个子 App 安装。 */
export function checkHandoffFileText(
  text: string,
  ctx: { registry: Registry; locale: Locale; now: Date },
) {
  if (text.length > MAX_APP_CONFIG_SIZE || strToU8(text).length > MAX_APP_CONFIG_SIZE)
    return { ok: false as const, problems: ['app file too large'] };
  const json = appFileJsonText(text);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return checkAppFileText(text, ctx);
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { format?: unknown }).format !== APP_CONFIG_FILE_FORMAT
  )
    return checkAppFileText(text, ctx);
  const parsed = parseAppConfigFile(json);
  if (!parsed.ok)
    return { ok: false as const, problems: [`cannot read the setup: ${parsed.problem}`] };
  const prepared = preparePreset(parsed.config, ctx.registry);
  if (!prepared.ok) return { ok: false as const, problems: prepared.issues };
  const config = prepared.after;
  const summary: AppFileSummary = {
    name: 'Tinkrum',
    pages: config.containers.pages.length,
    tables: config.data.tables.length,
    quickActions: quickActionsOf(config).length,
    reminders: remindersOf(config).length,
  };
  return {
    ok: true as const,
    config,
    summary,
    warnings: checkTools(config, ctx.registry)
      .issues.filter((i) => i.severity === 'blocker')
      .map((i) => `${i.target}: ${i.message}`),
    hints: [] as string[],
  };
}

/** 网站上复用现有 App 草图预览，整份设置按各自的 App/主页分开预览；不引入第二个 renderer。 */
export function setupPreviewFiles(config: WorkspaceConfig) {
  return [
    {
      app: { id: 'setup-home', name: 'Tinkrum', theme: config.theme, bar: config.nav.bar },
      pages: config.containers.pages.filter((p) => !p.app),
      tables: config.data.tables.filter((t) => !t.app),
      tools: config.tools.filter((t) => !t.app),
      icons: config.icons,
    },
    ...(config.nav.apps ?? []).map((app) => ({
      app,
      pages: config.containers.pages.filter((p) => p.app === app.id),
      tables: config.data.tables.filter((t) => t.app === app.id),
      tools: config.tools.filter((t) => t.app === app.id),
      icons: config.icons,
    })),
  ];
}
