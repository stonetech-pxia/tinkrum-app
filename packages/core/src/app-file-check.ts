import { z } from 'zod';

import { APP_FILE_FORMAT, appFileOps, readAppFile, type AppFile } from './app-file';
import { explainProblems } from './app-file-explain';
import { prepareOps } from './change';
import type { Registry } from './registry';
import {
  CURRENT_SCHEMA_VERSION,
  PageSchema,
  ToolSchema,
  quickActionsOf,
  remindersOf,
  type Locale,
  type WorkspaceConfig,
} from './schema';
import { AppSchema, CollectionSchema } from './schema-base';
import { createStarterWorkspace } from './starter';
import { checkTools, type ToolIssue } from './tool-check';
import { issueLines } from './zod-issues';

// 检查一份 App 文件（tinkrum-app，D-485）能不能导入，说清楚哪里不对（D-593）：给用别的 AI（Claude、ChatGPT）
// 写 App 文件的人用，网站上的检查页和 App 里导入失败时说的是同一套。走的就是 App 导入的路：读文件（旧版本迁移）、
// 做成导入操作、在新用户的工作区上 prepareOps（和「从文件导入」一样带 fromAppFile）。只看结构，不碰记录和文件。

/**
 * App 文件的形状（当前版本），用来生成给别的 AI 看的 JSON Schema，也用来在导入前逐项说出哪里不对。
 * 外层的 exportedAt、uses 可有可无：导入不读它们（uses 只用来说缺什么，D-556）。
 */
export const AppFileSchema = z.object({
  format: z.literal(APP_FILE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().optional(),
  schemaVersion: z.number().int().min(1).max(CURRENT_SCHEMA_VERSION),
  uses: z.unknown().optional(),
  app: AppSchema,
  pages: z.array(PageSchema).min(1),
  tables: z.array(CollectionSchema),
  tools: z.array(ToolSchema),
});

export interface AppFileSummary {
  name: string;
  pages: number;
  tables: number;
  quickActions: number;
  reminders: number;
}

export type AppFileCheck =
  | { ok: true; file: AppFile; summary: AppFileSummary; warnings: string[] }
  | { ok: false; problems: string[] };

/** 最多说这么多条：再多对改文件也没帮助，先改前面的。 */
const MAX_PROBLEMS = 20;

/** 别的 AI 常把 JSON 包在代码块里，或者前后多一句话：取第一个 { 到最后一个 }。 */
export function appFileJsonText(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

export function checkAppFileText(
  text: string,
  ctx: { registry: Registry; locale: Locale; now: Date },
): AppFileCheck {
  const fail = (problems: string[]): AppFileCheck => ({
    ok: false,
    problems:
      problems.length > MAX_PROBLEMS
        ? [...problems.slice(0, MAX_PROBLEMS), `…and ${problems.length - MAX_PROBLEMS} more`]
        : problems,
  });
  let data: unknown;
  try {
    data = JSON.parse(appFileJsonText(text));
  } catch (e) {
    return fail([`not valid JSON: ${e instanceof Error ? e.message : String(e)}`]);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return fail(['the file must be one JSON object']);
  const raw = data as Record<string, unknown>;
  if (raw.format !== APP_FILE_FORMAT)
    return fail([`format must be "${APP_FILE_FORMAT}" (got ${JSON.stringify(raw.format)})`]);
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > CURRENT_SCHEMA_VERSION)
    return fail([
      `schemaVersion ${raw.schemaVersion} is newer than this checker knows (${CURRENT_SCHEMA_VERSION}); write schemaVersion ${CURRENT_SCHEMA_VERSION}`,
    ]);
  // 先按当前版本的形状逐项查（路径从文件的顶层算起）；旧版本的文件先迁移，形状交给导入时的校验。
  const older = typeof raw.schemaVersion === 'number' && raw.schemaVersion < CURRENT_SCHEMA_VERSION;
  if (!older) {
    const shape = AppFileSchema.safeParse(raw);
    if (!shape.success) return fail(issueLines(shape.error, { value: raw }));
  }
  const file = readAppFile(JSON.stringify(raw));
  if (!file)
    return fail([
      'cannot read the file: it needs format, version, schemaVersion, app {id, name, bar, theme}, pages, tables and tools',
    ]);

  const starter = createStarterWorkspace(ctx.locale, ctx.registry);
  const plan = appFileOps(file, starter);
  if (!plan.ok) return fail(explainProblems([plan.error], file, ctx.registry));
  const prepared = prepareOps(starter, plan.ops, { ...ctx, fromAppFile: true });
  if (!prepared.ok) return fail(explainProblems(prepared.issues, file, ctx.registry));

  // 能导入了。下面的只提醒（和「我的预设」上的完成度一样，D-417）：导入后才有的、用不了的地方。
  const after = prepared.after;
  const issueText = (i: ToolIssue) => `${i.target}: ${i.message}`;
  const blockers = (config: WorkspaceConfig) =>
    checkTools(config, ctx.registry)
      .issues.filter((i) => i.severity === 'blocker')
      .map(issueText);
  const before = new Set(blockers(starter));
  const warnings = blockers(after).filter((line) => !before.has(line));
  const mine = <T extends { app?: string | undefined }>(items: T[]) =>
    items.filter((x) => x.app === file.app.id).length;
  return {
    ok: true,
    file,
    summary: {
      name: file.app.name,
      pages: mine(after.containers.pages),
      tables: mine(after.data.tables),
      quickActions: mine(quickActionsOf(after)),
      reminders: mine(remindersOf(after)),
    },
    warnings,
  };
}
