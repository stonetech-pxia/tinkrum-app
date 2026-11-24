import {
  builtInWorkflows,
  shareFit,
  sharePresetOrder,
  type Locale,
  type SharedFileInfo,
  type Workflow,
} from '@morph/core';

import { runsHere } from '../runtime/device-support';
import type { SucceededRuns } from '../storage/types';

export function shareRecommendations(
  workflows: Workflow[],
  infos: SharedFileInfo[],
  usage: SucceededRuns,
  locale: Locale,
  newest?: string,
) {
  // Built-in quick actions (D-236) are ordered after configured ones: when unused, fill in custom ones first, then built-in and tool-provided ones.
  const builtIns = builtInWorkflows(workflows, locale);
  const existing = [...workflows, ...builtIns]
    .filter(runsHere)
    .map((wf) => ({ wf, fit: shareFit(wf, infos) }))
    .filter(({ wf, fit }) => fit.ok || (fit.reason !== 'type' && usage.has(wf.id)));
  const fresh = existing.filter(({ wf }) => wf.id === newest);
  const used = existing
    .filter(({ wf }) => wf.id !== newest && usage.has(wf.id))
    .sort((a, b) => {
      const x = usage.get(a.wf.id)!;
      const y = usage.get(b.wf.id)!;
      return y.count - x.count || y.lastAt - x.lastAt;
    });
  const unused = existing.filter(({ wf }) => wf.id !== newest && !usage.has(wf.id));
  // Built-in and tool-provided ones are ordered by frequency for this file type (D-237): a
  // tool-provided one might share the same ID as a built-in one in the list (video-frame), in which
  // case the built-in one is omitted and the tool-provided one takes its place. Those not in the
  // list follow in their original order.
  const order = sharePresetOrder(infos);
  const rank = (wf: Workflow) => {
    const i = order.indexOf(wf.id);
    return i < 0 ? order.length : i;
  };
  const own = unused.filter(({ wf }) => !wf.package && !builtIns.includes(wf));
  const fillers = [
    ...own,
    ...[
      ...unused.filter(({ wf }) => builtIns.includes(wf)),
      ...unused.filter(({ wf }) => wf.package),
    ].sort((a, b) => rank(a.wf) - rank(b.wf)),
  ];
  // Only runnable ones count as "enough used": ensure at least 3 runnable ones first, then include
  // used ones with incorrect counts (grey cards with explanations), and fill remaining slots with
  // unused ones; grey cards must not push runnable ones into "View all".
  const usedOk = used.filter(({ fit }) => fit.ok);
  const usedOff = used.filter(({ fit }) => !fit.ok);
  const lead = fresh.length + usedOk.length;
  const needed = usedOk.length < 3 ? Math.max(0, 3 - lead) : 0;
  const all = [
    ...fresh,
    ...usedOk,
    ...fillers.slice(0, needed),
    ...usedOff,
    ...fillers.slice(needed),
  ];
  return {
    all,
    recommended: (usedOk.length < 3 ? all : [...fresh, ...usedOk, ...usedOff]).slice(0, 5),
    anyUsed: used.length > 0,
  };
}
