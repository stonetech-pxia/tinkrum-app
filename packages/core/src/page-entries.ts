import { componentRefs } from './components';
import {
  HOME_PAGE_ID,
  TOOLBOX_PAGE_ID,
  allComponents,
  pageTarget,
  remindersOf,
  type Component,
  type WorkspaceConfig,
} from './schema';

// Entry point for new pages: when the AI adds a new page but no place in the entire app can open it
// (navigation bar, floating entry, buttons or entry points on other pages, reminders), the user
// cannot find the page after applying (founder 2026-10-31: often forgot entry points when AI builds
// a Todoist page). In such cases, append an entry point at the end of the home screen (only in AI
// and user modification prepareOps; samples and templates follow their own definitions). Considers
// only newly added pages: if the user removes the entry point later, other modifications will not
// add it back. Package pages (package), single-record pages (of, opened from record blocks), and
// the toolbox (system entry point tools) are excluded.

/** All targets opened across other pages, navigation, and reminders. */
function openedTargets(config: WorkspaceConfig, except: string): Set<unknown> {
  const targets = new Set<unknown>([...config.nav.bar, ...config.nav.floating]);
  for (const app of config.nav.apps ?? []) for (const t of app.bar) targets.add(t);
  for (const page of config.containers.pages) {
    if (page.id === except) continue;
    for (const c of allComponents(page)) for (const t of componentRefs(c, 'target')) targets.add(t);
  }
  for (const r of remindersOf(config)) targets.add(r.opens);
  return targets;
}

/** Adds home screen entry points for un-openable new pages added to after; returns the titles of pages for which entry points were added. */
export function addMissingPageEntries(before: WorkspaceConfig, after: WorkspaceConfig): string[] {
  const home = after.containers.pages.find((p) => p.id === HOME_PAGE_ID);
  if (!home) return [];
  const added: string[] = [];
  for (const page of after.containers.pages) {
    if (page.id === HOME_PAGE_ID || page.id === TOOLBOX_PAGE_ID || page.package || page.of)
      continue;
    if (before.containers.pages.some((p) => p.id === page.id)) continue;
    const target = pageTarget(page.id);
    if (openedTargets(after, page.id).has(target)) continue;
    // Pages inside an app: placed in this app's bottom bar (before Tink); if the bottom bar is full, placed at the end of its first page (D-485).
    const app = page.app !== undefined ? after.nav.apps?.find((a) => a.id === page.app) : undefined;
    if (page.app !== undefined) {
      if (!app) continue;
      if (app.bar.length < 5) {
        const at = app.bar.indexOf('ai');
        app.bar.splice(at < 0 ? app.bar.length : at, 0, target);
        added.push(page.title);
        continue;
      }
    }
    const holder = app
      ? after.containers.pages.find((p) => p.app === app.id && p.id !== page.id)
      : home;
    if (!holder) continue;
    const ids = new Set(after.containers.pages.flatMap((p) => allComponents(p).map((c) => c.id)));
    const stem = `open-${page.id}`.slice(0, 44);
    let id = stem;
    for (let n = 2; ids.has(id); n++) id = `${stem}-${n}`;
    holder.blocks.push({
      id,
      look: 'button',
      show: { label: page.title.slice(0, 40), icon: page.icon ?? 'document' },
      opens: target,
    } as unknown as Component);
    added.push(page.title);
  }
  return added;
}
