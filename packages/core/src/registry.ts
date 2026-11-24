import { IO_ACTIONS } from './tools/io';
import type { IconName, Locale, Localized, Page, QuickAction } from './schema';
import type { ActionDefinition, Permission } from './workflow/contract';

// Registry of actions and tools (§6 ActionDefinition / ToolDefinition, §7B Tool Manifest). Only
// registered actions can appear in workflows; action implementations are provided by tool-*
// packages and the App runtime, this file describes contracts only. In v34, "tools" here refers to
// tool packages (config packages, still called "tools" in the UI); tool package pages are defined
// in containers.pages, and quick actions in tools[] (kind "quickAction", package is tool package
// ID).

export interface ToolDefinition {
  id: string;
  version: string;
  name: Localized;
  description: Localized;
  icon: IconName;
  /** Aliases (lowercase) for natural language parsing matching. */
  aliases: readonly string[];
  permissions: readonly Permission[];
  actions: readonly ActionDefinition[];
  /** Tool package pages (v34 blocks, page.package is tool package ID). */
  createPage(locale: Locale): Page;
  /** Quick actions written into config tools[] upon installation (single-function workflows and tool-native procedures, D-061; package is tool package ID). */
  createWorkflows(locale: Locale): QuickAction[];
  /** Tools downloaded from server (D-177); built-in tools shipped with the App lack this entry. */
  origin?: 'download';
}

/** Kernel actions: not part of any tool, available in all workflows. */
export const CORE_ACTIONS: readonly ActionDefinition[] = IO_ACTIONS;

export interface Registry {
  tools: ReadonlyMap<string, ToolDefinition>;
  actions: ReadonlyMap<string, ActionDefinition>;
  /** Action -> owning tool; kernel actions are absent from this table. */
  actionOwner: ReadonlyMap<string, string>;
}

export function createRegistry(tools: readonly ToolDefinition[]): Registry {
  const toolMap = new Map<string, ToolDefinition>();
  const actions = new Map<string, ActionDefinition>();
  const actionOwner = new Map<string, string>();
  for (const action of CORE_ACTIONS) actions.set(action.id, action);
  for (const tool of tools) {
    if (toolMap.has(tool.id)) throw new Error(`duplicate tool ${tool.id}`);
    toolMap.set(tool.id, tool);
    for (const action of tool.actions) {
      if (!action.id.startsWith(`${tool.id}.`)) {
        throw new Error(`action ${action.id} must be namespaced under ${tool.id}.`);
      }
      if (actions.has(action.id)) throw new Error(`duplicate action ${action.id}`);
      actions.set(action.id, action);
      actionOwner.set(action.id, tool.id);
    }
  }
  return { tools: toolMap, actions, actionOwner };
}

const revisions = new WeakMap<Registry, number>();

/** Number of times the registry has been modified (incremented when adding or replacing downloaded tools); used for prompt caching. */
export const registryRevision = (registry: Registry) => revisions.get(registry) ?? 0;

/**
 * Add or replace a downloaded tool (D-177). Modifies this registry directly so that all consumers
 * (execution, validation, AI) can access it. Downloaded tools have no actions of their own (the
 * first step only composes existing actions) and cannot override built-in tools.
 */
export function registerTool(registry: Registry, tool: ToolDefinition): void {
  if (tool.origin !== 'download') throw new Error(`tool ${tool.id} is not a downloaded tool`);
  if (tool.actions.length > 0) throw new Error(`downloaded tool ${tool.id} must not add actions`);
  const existing = registry.tools.get(tool.id);
  if (existing && existing.origin !== 'download') throw new Error(`tool ${tool.id} is built in`);
  (registry.tools as Map<string, ToolDefinition>).set(tool.id, tool);
  revisions.set(registry, registryRevision(registry) + 1);
}
