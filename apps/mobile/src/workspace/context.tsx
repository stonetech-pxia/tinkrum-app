import {
  appViewOf,
  calendarOf,
  type Calendar,
  type Locale,
  type Registry,
  type Theme,
  type WorkspaceConfig,
} from '@morph/core';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { FilePlatform } from '../runtime/runner';
import type { WorkspaceRepo } from '../storage/types';
import type { WorkspaceState, WorkspaceStore } from './store';

interface WorkspaceContextValue {
  store: WorkspaceStore;
  registry: Registry;
  locale: Locale;
  /** Storage and platform file capabilities used by workflow execution and file lists. */
  repo: WorkspaceRepo;
  files: FilePlatform;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue;
  children: ReactNode;
}) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('WorkspaceProvider is missing');
  return value;
}

export function useWorkspace<T>(selector: (state: WorkspaceState) => T): T {
  return useStore(useWorkspaceContext().store, selector);
}

/**
 * Pages opened within a certain app (Settings, Tink, record page...) use that app's style, with
 * header matching content (D-485). When not in an app, use home page style. If config is omitted,
 * use the saved one.
 */
export function useAppTheme(config?: WorkspaceConfig): Theme {
  const appId = useWorkspace((s) => s.appId);
  const saved = useWorkspace((s) => s.config)!;
  return appViewOf(config ?? saved, appId).theme;
}

/** When a day or week begins (D-286): used for all day-based and week-based categorization calculations. */
export function useCalendar(): Calendar {
  const settings = useWorkspace((s) => s.config?.data.calendar);
  return useMemo(() => calendarOf({ data: { tables: [], calendar: settings } }), [settings]);
}
