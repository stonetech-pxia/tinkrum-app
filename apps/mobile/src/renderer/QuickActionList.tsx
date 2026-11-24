import type { BlockOf } from '@morph/core';

import { WorkflowsScreen } from '../shell/WorkflowsScreen';
import type { RenderEnv } from './components';
import { RecentActions } from './RecentActions';

/**
 * Quick action library (look library, formerly quickActionList, D-230): places categorization
 * entries for "What Morph can do" or quick actions of a specific category onto the page. Content
 * is determined by core just like fixed pages; cannot be tapped in drafts and previews (prompts
 * to apply first in drafts).
 */
export function QuickActionList({ block, env }: { block: BlockOf<'library'>; env: RenderEnv }) {
  if (block.source.recent) return <RecentActions title={block.show?.title} env={env} />;
  return (
    <WorkflowsScreen
      palette={env.palette}
      locale={env.locale}
      registry={env.registry}
      kind={block.source.kind}
      inPage={{
        title: block.show?.title,
        guard: () => {
          if (env.locked) {
            env.locked();
            return true;
          }
          return !env.interactive;
        },
      }}
    />
  );
}
