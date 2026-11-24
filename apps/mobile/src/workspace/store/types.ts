import type {
  AIProvider,
  AppConfigFileProblem,
  BuildStep,
  Locale,
  NavTarget,
  Op,
  Plan,
  PlanAbout,
  RejectReason,
  Registry,
  SampleApp,
  WorkSession,
  WorkspaceConfig,
  PlanProgress,
} from '@morph/core';
import type { StoreApi } from 'zustand/vanilla';

import type {
  RecordWrite,
  RevisionRecord,
  RevisionSource,
  SavedPreset,
  WorkspaceRepo,
} from '../../storage/types';

// Workspace store external types: state, actions, and their results. Action implementations are split across several files in the same directory (see ../store.ts).

export interface WorkspaceDeps {
  repo: WorkspaceRepo;
  provider: AIProvider;
  registry: Registry;
  locale: Locale;
  now: () => Date;
  /** First version on initial startup. The app uses createStarterWorkspace with preinstalled tools (D-104); if omitted, the workspace starts blank. */
  seed?: (locale: Locale, registry: Registry) => WorkspaceConfig;
  /** Name for a tool not found in the registry (looked up from downloaded tool directory, D-177); used for prompts when restoring historical versions missing a tool. */
  toolName?: (toolId: string) => string | undefined;
}

export interface Proposal {
  changeRequestId: number;
  kind: 'ops' | 'restore';
  baseRevisionId: number;
  before: WorkspaceConfig;
  after: WorkspaceConfig;
  lines: string[];
  source: RevisionSource;
  summary: string;
  /** Page displayed during preview. */
  focusPageId: string;
  /** A workflow that is newly created but not attached to any page: preview displays its steps, and applying it opens the workflow list (D-109). */
  focusWorkflowId?: string;
  /** "Put an entry on the home screen" option for AI-created workflows (D-109); when on, after already includes the home screen run card. */
  homeEntry?: { workflowIds: string[]; on: boolean };
  /** Operations in the AI plan (excluding the home screen entry point); recalculated when toggling the home screen entry. */
  ops?: Op[];
  /** Explanations written by the AI to the user: parts it could not do, and why added supplementary steps were needed (D-110). */
  notes?: string[];
  /** The version restored to (undo, restoring a history version); changes made in newer versions are no longer counted in the changelist (D-414). Preset changes do not have this field, counting all changes. */
  restoredTo?: number;
}

export type ProposeResult =
  | { kind: 'preview'; proposal: Proposal }
  | { kind: 'rejected'; message: string; examples: string[]; reason?: RejectReason }
  | { kind: 'invalid'; issues: string[] };

export interface Banner {
  kind: 'applied' | 'rolledBack' | 'recovered' | 'conflict';
  message: string;
  /** Version to restore to upon undo. */
  undoTo?: number;
  /** Finger is currently held down on "Undo": prevents it from disappearing on timeout, otherwise this action would be lost. */
  held?: boolean;
}

/** Edit mode draft (D-054): operations accumulate here first and are committed as a single version when clicking "Done". */
export interface EditDraft {
  pageId: string;
  mode: 'single' | 'page';
  /** Adjacent similar operations have been merged. */
  ops: Op[];
  /** Configuration after applying ops and passing validation; displayed on the page during edit mode. */
  config: WorkspaceConfig;
}

export type EditResult = { ok: true } | { ok: false; issues: string[] } | { ok: false; full: true };

/** A step of AI modifications to the draft (D-190): what the user said and the modifications provided by the AI. */
export interface DraftStep {
  input: string;
  /** Home screen entry point already including the new quick action. */
  ops: Op[];
  lines: string[];
  notes?: string[];
  changeRequestId: number;
  /** Configuration applied up to this step. Not persisted: recalculated on the latest version upon startup or returning to the draft (rebaseDraft). */
  config: WorkspaceConfig;
}

/** Where the draft originated from: used to take the user back after applying (opened from a quick action or inbox page). */
export interface DraftOrigin {
  about?: PlanAbout;
  /** App in which the modification was made (D-485): restricted to this app; the draft follows it, and continuing the conversation elsewhere behaves the same. Unspecified means the home (entire workspace). */
  appId?: string;
  /** Sample preset applied in onboarding step 3 (D-260): returns to its main page after applying, prompting that AI can be used for further modifications. */
  sample?: { id: SampleApp; pageId: string };
}

/**
 * AI modification draft (D-190): after processing, the AI enters draft mode directly, and the app
 * displays the modified result in view-only mode; "Modify" continues the conversation, "Step
 * back" undoes the latest step, "Apply" combines changes into a saved version, and "Leave"
 * returns to the official app while keeping the draft. Only one exists at a time, stored locally
 * (app_meta) and preserved across restarts.
 */
export interface Draft {
  steps: DraftStep[];
  /** Chat box messages and replies that did not become steps (D-207), stored together with the draft. */
  replies: DraftChatReply[];
  origin: DraftOrigin;
  /** Whether currently in draft mode; false = left, but draft still exists. */
  open: boolean;
}

/** A message in the draft chat box that did not become a step (D-207): items such as unachievable requests, invalid requests, functional changes that took effect immediately (D-411), or stepped-back actions. */
export interface DraftChatReply {
  /** Number of steps in the draft when said: chat box orders it after this step; removed together when stepping back past it. */
  afterSteps: number;
  input: string;
  kind: 'rejected' | 'invalid' | 'functionApplied' | 'steppedBack' | 'needsDraft';
  message: string;
  examples: string[];
  reason?: RejectReason;
  /** needsDraft: the step to execute next when the user clicks "Apply draft and continue" (D-413). Contains only configuration structure. */
  waiting?: WaitingForDraft;
}

/** This step requires items from the draft (D-413): waits for the user to click "Apply draft and continue". */
export interface WaitingForDraft {
  input: string;
  plan: Extract<Plan, { kind: 'ops' }>;
  origin: DraftOrigin;
}

export type BuildStepStatus = 'todo' | 'running' | 'done' | 'skipped' | 'failed';

export interface BuildRunStep extends BuildStep {
  status: BuildStepStatus;
  /** The previous step already performed this operation (model returned noChange): checked, but with a different explanation. Not counted as a failure. */
  already?: boolean;
  /** Reason for getting stuck. */
  reason?: string;
  /** The reason for getting stuck is that it requires items from the draft (D-413): displays "Apply draft and continue". */
  needsDraft?: boolean;
  /** The follow-up utterance after this step completes its functionality (next): retry resumes from here. */
  current?: string;
}

/**
 * A large project currently being built (D-415). review: waiting for user to review the plan;
 * running: in progress; failed: a step failed, waiting for user selection; paused: stopped (by
 * user, app entering background, or restart), waiting for user to continue (invariant 16);
 * finished: all tasks completed. Stored locally, preserved across app restarts.
 */
export interface BuildRun {
  summary: string;
  steps: BuildRunStep[];
  phase: 'review' | 'running' | 'failed' | 'paused' | 'finished';
  origin: DraftOrigin;
}

export type DraftResult =
  /** focusPageId: the page modified by this step, displayed when entering the draft. */
  | { kind: 'drafted'; step: DraftStep; focusPageId: string }
  /** Said "Undo" in the draft: stepped back by one step. Said "Undo" with no draft: returns directly to the previous version. */
  | { kind: 'steppedBack' }
  | { kind: 'restored' }
  | { kind: 'rejected'; message: string; examples: string[]; reason?: RejectReason }
  | { kind: 'invalid'; issues: string[] };

/**
 * A message produced by the AI modification page (D-191): functional changes are applied
 * immediately (applied), while appearance changes enter the draft; when a plan contains both,
 * functional changes apply immediately and the result is drafted due to appearance changes
 * entering the draft (D-419). Saying functional phrases in the draft chat box also applies them
 * immediately, keeping the draft open (D-411).
 */
export type ChangeResult =
  | DraftResult
  /**
   * focusPageId: the modified page, displayed when returning to the app. lines: summary of
   * changes. lookNotDone: appearance changes in this plan could not be applied and were skipped
   * (D-419); if successful, the result is drafted.
   */
  | {
      kind: 'applied';
      applied: Applied;
      lines: string[];
      focusPageId: string;
      lookNotDone?: boolean;
    }
  /** needsDraft: message: string; waiting: WaitingForDraft */
  | { kind: 'needsDraft'; message: string; waiting: WaitingForDraft }
  /** Large project (rule 53): plan is in build, waiting for the user to review and click "Start" (D-415). */
  | { kind: 'build' };

/** Information on where to take the user after application (draft or directly applied functionality). */
export interface Applied {
  addedWorkflowIds: string[];
  addedCollectionIds: string[];
  /** Quick actions newly placed on the phone desktop this time (D-271): opens its "Done" view when there is only one, explaining how to use it. */
  homeScreenWorkflowIds: string[];
  origin: DraftOrigin;
  /** AI explanations (D-110), displayed on the "Done" page for directly applied features. */
  notes?: string[];
}

/**
 * Record toast notification. Only supports undo for actions that cannot be easily reverted by a
 * simple operation (invariant 11, D-385, D-566): deletion (restoreRecordId, restorePreset),
 * tapping to change multiple places, and bulk creation (undo).
 */
export interface RecordToast {
  message: string;
  /**
   * undo: changes modified simultaneously by a tap (D-566) or bulk-created items (D-567): written
   * back within a single transaction, with each entry required to remain in its post-completion
   * state; modified during this period means none are changed.
   */
  undo?: {
    writes: RecordWrite[];
    tables: string[];
    failed: 'recordUndoFailed' | 'recordUndoBulkFailed';
  };
  restoreRecordId?: string;
  /** undoImport: id: string; table: string */
  undoImport?: { id: string; table: string };
  /** undoRestore: true */
  undoRestore?: true;
  /** restoreRecordIds: string[] */
  restoreRecordIds?: string[];
  /** restorePreset: SavedPreset */
  restorePreset?: SavedPreset;
  /** continueTable: string */
  continueTable?: string;
  /** Finger is currently held down on the notification button: prevents it from disappearing on timeout. */
  held?: boolean;
}

export type SavePresetResult =
  | { kind: 'saved'; preset: SavedPreset }
  /** Name is empty. */
  | { kind: 'noName' }
  /** Reached maximum limit (MAX_SAVED_PRESETS). */
  | { kind: 'full' };

/** Result of importing a preset from a file (D-485). */
export type ImportPresetResult =
  | { kind: 'saved'; preset: SavedPreset }
  /** Reached maximum limit (MAX_SAVED_PRESETS). */
  | { kind: 'full' }
  /** refused: problem: AppConfigFileProblem */
  | { kind: 'refused'; problem: AppConfigFileProblem }
  /** invalid: issues: string[] */
  | { kind: 'invalid'; issues: string[] };

export interface WorkspaceState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  config: WorkspaceConfig | null;
  head: RevisionRecord | null;
  proposal: Proposal | null;
  banner: Banner | null;
  busy: boolean;
  /** planProgress: PlanProgress | null */
  planProgress: PlanProgress | null;
  /** assetsVersion: number */
  assetsVersion: number;
  /** renderAttempt: number */
  renderAttempt: number;
  /** tab: NavTarget | null */
  tab: NavTarget | null;
  /** appId: string | null */
  appId: string | null;
  /** appEnters: number */
  appEnters: number;
  /** recordsVersion: number */
  recordsVersion: number;
  /**
   * tableVersions: Readonly<Record<string, number>>
   */
  tableVersions: Readonly<Record<string, number>>;
  /** recordsAll: number */
  recordsAll: number;
  /** presetsVersion: number */
  presetsVersion: number;
  /** toast: RecordToast | null */
  toast: RecordToast | null;
  /** editing: EditDraft | null */
  editing: EditDraft | null;
  /** draft: Draft | null */
  draft: Draft | null;
  /** draftNotice: string | null */
  draftNotice: string | null;
  /**
   * next: string | null
   */
  next: string | null;
  /** suggest: string[] */
  suggest: string[];

  boot(): Promise<void>;
  /**
   * propose(input: string, planner?: AIProvider, about?: PlanAbout): Promise<Propose
   */
  propose(input: string, planner?: AIProvider, about?: PlanAbout): Promise<ProposeResult>;
  proposeRestore(revisionId: number): Promise<ProposeResult>;
  /** proposePreset(presetId: string): Promise<ProposeResult>; */
  proposePreset(presetId: string, options?: { keepFiles?: boolean }): Promise<ProposeResult>;
  /** savePreset(name: string): Promise<SavePresetResult>; */
  savePreset(name: string): Promise<SavePresetResult>;
  /**
   * importPreset(text: string, fileName: string): Promise<ImportPresetResult>;
   */
  importPreset(text: string, fileName: string): Promise<ImportPresetResult>;
  /** renamePreset(presetId: string, name: string): Promise<boolean>; */
  renamePreset(presetId: string, name: string): Promise<boolean>;
  /** deletePreset(preset: SavedPreset): Promise<void>; */
  deletePreset(preset: SavedPreset): Promise<void>;
  /** restorePreset(preset: SavedPreset): Promise<void>; */
  restorePreset(preset: SavedPreset): Promise<void>;
  /**
   * proposeOps(
   */
  proposeOps(
    ops: Op[],
    summary: string,
    options?: { fromAppFile?: boolean },
  ): Promise<ProposeResult>;
  /** setHomeEntry(on: boolean): void; */
  setHomeEntry(on: boolean): void;
  /** confirm(options?: { quiet?: boolean }): Promise<boolean>; */
  confirm(options?: { quiet?: boolean }): Promise<boolean>;
  cancel(): Promise<void>;
  undo(): Promise<void>;
  markRendered(revisionId: number): Promise<void>;
  reportRenderError(error: unknown): Promise<void>;
  dismissBanner(): void;
  selectTab(target: NavTarget): void;
  /** enterApp(appId: string): void; */
  enterApp(appId: string): void;
  /** showInShell(config: WorkspaceConfig, target: NavTarget): boolean; */
  showInShell(config: WorkspaceConfig, target: NavTarget): boolean;
  leaveApp(): void;
  startEditing(pageId: string, mode?: EditDraft['mode']): void;
  /** editOps(ops: Op[]): EditResult; */
  editOps(ops: Op[]): EditResult;
  /** "Complete": Submits the draft as a version with source "user"; exits immediately if there are no actual changes. */
  finishEditing(summary: string): Promise<EditResult>;
  /** "Cancel": Discards the draft. */
  cancelEditing(): void;
  /**
   * Smth called after records are written. `tables`: Which tables were written (pass only when
   * known); omitted = unknown, re-evaluate all tables together (prefer slow over stale, D-555).
   */
  bumpRecords(tables?: readonly string[]): void;
  showToast(toast: RecordToast): void;
  dismissToast(): void;
  holdBanner(held: boolean): void;
  holdToast(held: boolean): void;
  listRevisions(limit?: number, beforeId?: number): Promise<RevisionRecord[]>;
  bumpAssets(): void;
  /**
   * A single sentence in the AI modification page (D-191): Feature changes take effect directly,
   * look changes enter a draft (creating a new one if none exists); uses the AI selected in
   * settings when `planner` is omitted.
   */
  change(input: string, planner?: AIProvider, origin?: DraftOrigin): Promise<ChangeResult>;
  /** A single sentence in the draft chat box: Look changes continue modifying the draft, feature changes take effect immediately (D-411). */
  draftChange(input: string, about?: PlanAbout): Promise<ChangeResult>;
  /**
   * Applying a sample app (D-260): The entire set of modifications (tables, quick actions, pages,
   * reminders) is applied as a single draft step without using the AI or sending requests; when
   * the user taps "Apply", it combines into a version that can be undone. If it doesn't fit, it
   * skips entering the draft and returns the reason.
   */
  draftSample(sample: SampleApp): Promise<DraftResult>;
  clearNext(): Promise<void>;
  clearSuggest(): Promise<void>;
  /** Tool session list (D-414). */
  session: WorkSession;
  /** Clears the session list and remembered notes; apps and records remain unchanged. */
  clearSession(): Promise<void>;
  /** User taps "Apply draft and continue" (D-413): Confirms the draft first, then executes the waiting step without prompting the model again. */
  continueWithDraft(waiting: WaitingForDraft): Promise<ChangeResult>;
  /** "Fill these in" (D-418): Sends the new problems added in this session to the AI once. Returns null when there are no problems, sending nothing. */
  fixProblems(): Promise<ChangeResult | null>;
  /** Plan and progress for large engineering tasks (D-415). */
  build: BuildRun | null;
  /** Removes a step from the plan; the plan is removed when all steps are cleared. */
  removeBuildStep(stepId: string): Promise<void>;
  /** User taps "Start": Executes this sequence continuously in one go (invariant 16, D-416). Returns when a step fails or pauses. */
  startBuild(): Promise<void>;
  /** Pauses as soon as the current step finishes (triggered by the user or when the app enters the background). */
  stopBuild(): Promise<void>;
  /** Resumes execution from the unfinished step. */
  resumeBuild(): Promise<void>;
  skipBuildStep(): Promise<void>;
  /** Blocked on needing a draft: Confirms the draft first, then re-runs this step. */
  applyDraftForBuild(): Promise<void>;
  /** Collapses the plan. Completed steps are kept, remaining steps stay in the session list. */
  endBuild(): Promise<void>;
  stepBack(): Promise<void>;
  openDraft(): void;
  closeDraft(): void;
  applyDraft(): Promise<Applied | null>;
  deleteDraft(): Promise<void>;
  /** Draft rendering failed: Rolls back the most recent step (deletes the draft if there was only one step), returning to a renderable state. */
  draftRenderFailed(error: unknown): Promise<void>;
  dismissDraftNotice(): void;
}

export type WorkspaceStore = StoreApi<WorkspaceState>;
