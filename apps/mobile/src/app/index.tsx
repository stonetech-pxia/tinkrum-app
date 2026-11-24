import { View } from 'react-native';

import { ErrorBoundary } from '@/renderer/ErrorBoundary';
import { Shell } from '@/shell/Shell';
import { useWorkspace } from '@/workspace/context';

export default function HomeRoute() {
  const headId = useWorkspace((s) => s.head!.id);
  const attempt = useWorkspace((s) => s.renderAttempt);
  const reportRenderError = useWorkspace((s) => s.reportRenderError);
  const draftFailed = useWorkspace((s) => s.draftRenderFailed);
  // Draft mode shows the draft (D-190): if it fails to render, undo the most recent step of the draft without affecting the saved version.
  const draftKey = useWorkspace((s) =>
    s.draft?.open ? `d${s.draft.steps.at(-1)!.changeRequestId}` : '',
  );
  // Key changes with version: remount the entire shell upon rolling back to a new version; current navigation item is preserved in the store and will not be lost.
  return (
    <ErrorBoundary
      key={`${headId}${draftKey}-${attempt}`}
      onError={draftKey ? draftFailed : reportRenderError}
      fallback={<View />}>
      <Shell />
    </ErrorBoundary>
  );
}
