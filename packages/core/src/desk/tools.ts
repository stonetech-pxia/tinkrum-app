import type { Registry } from '../registry';
import type { Locale, Workflow, WorkflowStep } from '../schema';
import { shareFit, type SharedFileInfo } from '../share';
import { MAX_PICK } from '../tools/io';
import { MEDIA_LIMITS } from '../limits';
import { initialParams, workflowProblems } from '../workflow/check';
import {
  actionAccepts,
  isSourceAction,
  outputTypeOf,
  type ActionDefinition,
} from '../workflow/contract';
import type { FileValueType } from '../workflow/engine';
import { builtInWorkflows, sharePresetOrder } from '../workflows/presets';
import type { DeskTool, DeskToolsConfig } from './layout';
import { deskKindOf, type DeskFile, type DeskKind } from './model';

// Room toolbar (file-room DESIGN §4, §5, D-359): when unconfigured, generated from the action
// registry based on the file types on the desk rather than being hardcoded. Using a tool = a
// two-step workflow (input + this tool), files on the desk are passed to the first step as if
// shared in (D-115), and execution reuses existing executors; quick action buttons work similarly,
// applying the entire quick action to the files on the desk.

/** Default toolbar groups: edit (requires user manual operation), process (type unchanged), convert (type changed, or text output only), quick actions. */
export type DeskGroupId = 'annotate' | 'pages' | 'edit' | 'adjust' | 'convert' | 'quick';

export interface DeskDefaultGroup {
  id: DeskGroupId;
  items: DeskTool[];
}

/** File type -> action input type. Office documents and other files use `files`. */
const VALUE_TYPE: Record<DeskKind, FileValueType> = {
  image: 'images',
  pdf: 'pdf',
  sheet: 'files',
  doc: 'files',
  video: 'video',
  audio: 'audio',
  other: 'files',
};

/** Maximum number of quick actions in the default toolbar. */
const MAX_QUICK = 8;

/**
 * Whether an action can act as a tool on the desk: selecting inputs, outputs (share, saving,
 * printing, logging an expense), and file organization (naming, filtering, sorting, adding
 * existing files) are room-specific functions ("Done", desk names) and are not placed in the
 * toolbar.
 */
function isDeskAction(action: ActionDefinition): boolean {
  if (isSourceAction(action)) return false;
  return !/^(in|out|file)\./.test(action.id);
}

/**
 * Whether this file type can use this action: the action's input explicitly specifies this type
 * (images, pdf, video, audio). Office documents only accept actions that "accept files but not
 * images and PDFs" (document-to-PDF); actions accepting any file (merge, bundle) are meaningless
 * for them.
 */
function fitsKind(action: ActionDefinition, kind: DeskKind): boolean {
  const type = VALUE_TYPE[kind];
  if (kind === 'other') return false;
  if (type !== 'files') return action.input.includes(type);
  return (
    action.input.includes('files') &&
    !!action.rejects?.includes('images') &&
    !!action.rejects.includes('pdf')
  );
}

/**
 * Whether this action can be placed on the configured toolbar: can run when tapped (broader than
 * `fitsKind`; `fitsKind` only determines default toolbar listings, whereas user-requested actions
 * like "bundle this document" can be placed if types are compatible, invariant 19).
 */
export function deskActionFits(action: ActionDefinition, kind: DeskKind): boolean {
  return isDeskAction(action) && actionAccepts(action, VALUE_TYPE[kind]);
}

/** PDF toolbar grouped by purpose: annotate (draw, write, sign on the page), pages (organize, split); others follow processing and conversion below. */
const PDF_GROUP: Readonly<Record<string, DeskGroupId>> = {
  'pdf.annotate': 'annotate',
  'pdf.sign': 'annotate',
  'pdf.stamp': 'annotate',
  'pdf.fillForm': 'annotate',
  'pdf.pages': 'pages',
  'pdf.selectPages': 'pages',
  'pdf.rotate': 'pages',
  'pdf.split': 'pages',
  'pdf.pageNumbers': 'pages',
};

/** Tools excluded from the PDF desk: compression (available under "More" on the preview page if the PDF is too large to upload). */
const PDF_LEFT_OUT: ReadonlySet<string> = new Set(['pdf.compress']);

function groupOf(action: ActionDefinition, kind: DeskKind): DeskGroupId {
  if (kind === 'pdf' && PDF_GROUP[action.id]) return PDF_GROUP[action.id]!;
  if (action.local) return 'edit';
  const type = VALUE_TYPE[kind];
  const out = outputTypeOf(action, initialParams(action), type);
  return out === type ? 'adjust' : 'convert';
}

/**
 * Default toolbar: usable tools for this file type from the registry, grouped by "edit, process,
 * convert" (in registry order), followed by compatible quick actions (custom ones first,
 * built-ins sorted by most common for this file type, D-237). Empty groups are omitted.
 */
export function defaultDeskTools(
  kind: DeskKind,
  registry: Registry,
  workflows: readonly Workflow[],
  locale: Locale,
): DeskDefaultGroup[] {
  const groups: Record<DeskGroupId, DeskTool[]> = {
    annotate: [],
    pages: [],
    edit: [],
    adjust: [],
    convert: [],
    quick: [],
  };
  for (const action of registry.actions.values()) {
    if (!isDeskAction(action) || !fitsKind(action, kind)) continue;
    if (kind === 'pdf' && PDF_LEFT_OUT.has(action.id)) continue;
    const group = groupOf(action, kind);
    // Each starting tool for annotating a PDF gets its own button (insert text, annotation, brush...).
    if (kind === 'pdf' && action.id === 'pdf.annotate' && action.presets) {
      for (const preset of action.presets)
        groups[group].push({ action: action.id, preset: preset.id });
      continue;
    }
    groups[group].push({ action: action.id });
  }
  const sample = SAMPLE_FILE[kind];
  if (sample) {
    // PDF desk only includes user's own quick actions: built-in ones (compress, convert to Word,
    // translate, convert to audio...) are either already tools above or unrelated to PDF editing
    // itself, and remain available under "More" on the preview page.
    const builtIns = kind === 'pdf' ? [] : builtInWorkflows(workflows, locale);
    const order = sharePresetOrder([sample]);
    const rank = (wf: Workflow) => {
      const i = order.indexOf(wf.id);
      return i < 0 ? order.length : i;
    };
    const own = workflows.filter((wf) => !wf.package);
    const quick = [...own, ...[...builtIns].sort((a, b) => rank(a) - rank(b))].filter(
      (wf) => shareFit(wf, [sample]).ok,
    );
    groups.quick = quick.slice(0, MAX_QUICK).map((wf) => wf.id);
  }
  return (['annotate', 'pages', 'edit', 'adjust', 'convert', 'quick'] as const)
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, items: groups[id] }));
}

/** Sample used when determining whether a quick action is compatible with this file type (checks type only). */
const SAMPLE_FILE: Record<DeskKind, SharedFileInfo | null> = {
  image: { name: 'a.jpg', mimeType: 'image/jpeg', size: 1 },
  pdf: { name: 'a.pdf', mimeType: 'application/pdf', size: 1 },
  sheet: {
    name: 'a.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 1,
  },
  doc: {
    name: 'a.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 1,
  },
  video: { name: 'a.mp4', mimeType: 'video/mp4', size: 1 },
  audio: { name: 'a.m4a', mimeType: 'audio/mp4', size: 1 },
  other: null,
};

/** Representation of files on the desk when treated as shared-in files (used to check quick action compatibility). */
export const deskShareInfos = (files: readonly DeskFile[]): SharedFileInfo[] =>
  files.map((f) => ({ name: `${f.name}.${f.ext}`, mimeType: f.mimeType, size: f.size }));

/** Input step for these files on the desk: selected by type, with the exact count of these files. */
export function deskInputStep(files: readonly DeskFile[]): WorkflowStep {
  const kinds = new Set(files.map(deskKindOf));
  const n = Math.max(1, files.length);
  const only = kinds.size === 1 ? [...kinds][0]! : null;
  if (only === 'image') {
    return {
      id: 'desk-input',
      action: 'in.photos',
      params: { source: 'files', min: 1, max: Math.min(n, MAX_PICK) },
    };
  }
  if (only === 'video' || only === 'audio') {
    return {
      id: 'desk-input',
      action: only === 'video' ? 'in.videos' : 'in.audio',
      params: { source: 'files', min: 1, max: Math.min(n, MEDIA_LIMITS.maxCount) },
    };
  }
  const accept =
    only === 'pdf'
      ? 'pdf'
      : only === 'sheet' || only === 'doc'
        ? 'documents'
        : [...kinds].every((k) => k === 'image' || k === 'pdf')
          ? 'pdfOrImages'
          : 'any';
  return {
    id: 'desk-input',
    action: 'in.files',
    params: { accept, min: 1, max: Math.min(n, MAX_PICK) },
  };
}

/**
 * Workflow run when using a single tool: input + this tool. `params` are defined by the user in
 * the parameter panel (uses tool defaults if omitted). Returns null if incompatible with these
 * files (wrong type, invalid params), causing the toolbar item to appear dimmed.
 */
export function deskToolWorkflow(
  actionId: string,
  files: readonly DeskFile[],
  registry: Registry,
  params?: Record<string, unknown>,
): Workflow | null {
  const action = registry.actions.get(actionId);
  if (!action || !isDeskAction(action) || files.length === 0) return null;
  const workflow: Workflow = {
    id: 'desk-tool',
    kind: 'quickAction',
    name: actionId,
    steps: [
      deskInputStep(files),
      { id: 'desk-step', action: actionId, params: params ?? initialParams(action) },
    ],
  };
  // Default parameters may still be incomplete (e.g., text stamp requires text): initially check only type compatibility, and validate parameters after they are filled in the panel.
  const problems = workflowProblems(workflow, registry).filter(
    (p) => params !== undefined || p.code !== 'params' || p.stepId !== 'desk-step',
  );
  return problems.length === 0 ? workflow : null;
}

/**
 * When using a single tool in the room, pop up the parameter panel to ask for specific parameters
 * (D-363). Rule: parameters with `ask: false` (default value is correct, e.g., recognition
 * language "auto", D-278) are not asked; passwords are not in the panel (asked when executor
 * runs); the rest are asked. Returns [] if none need to be asked and default parameters are
 * usable: runs directly without popping up the panel. If default parameters are unusable (e.g.,
 * text stamp needs text), asks for all even if marked `ask: false`, to avoid running a
 * guaranteed-to-fail tool.
 */
export function deskToolAsks(action: ActionDefinition): string[] {
  const shown = action.fields.filter((f) => f.kind !== 'secret');
  const asked = shown.filter((f) => f.ask !== false).map((f) => f.key);
  if (asked.length > 0) return asked;
  return action.params.safeParse(initialParams(action)).success ? [] : shown.map((f) => f.key);
}

/** Whether a quick action can apply to these files on the desk (checks its first step, same as the inbox page). */
export const deskWorkflowFits = (workflow: Workflow, files: readonly DeskFile[]) =>
  files.length > 0 && shareFit(workflow, deskShareInfos(files)).ok;

/** Groups written in config -> same format as defaults (title is text from config). */
export type DeskGroup = { title?: string; id?: DeskGroupId; items: DeskTool[] };

/**
 * Toolbar for this file type: uses config if specified (`DeskLayout.tools`), otherwise defaults.
 * Items pointing to non-existent actions or quick actions in the config are hidden.
 */
export function deskToolbar(
  kind: DeskKind,
  configured: DeskToolsConfig,
  registry: Registry,
  workflows: readonly Workflow[],
  locale: Locale,
): DeskGroup[] {
  const custom = configured[kind];
  if (!custom) return defaultDeskTools(kind, registry, workflows, locale);
  const known = new Set([...workflows, ...builtInWorkflows(workflows, locale)].map((w) => w.id));
  return custom
    .map((g) => ({
      ...(g.title ? { title: g.title } : {}),
      items: g.items.filter((item) =>
        typeof item === 'object' ? registry.actions.has(item.action) : known.has(item),
      ),
    }))
    .filter((g) => g.items.length > 0);
}
