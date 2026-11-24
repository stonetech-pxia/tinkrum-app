import {
  allComponents,
  componentTarget,
  createPrefill,
  isKnownComponent,
  isRecordToolUse,
  recordToolOf,
  type OpenTarget,
} from '@morph/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useNavigate } from '@/shell/navigation';
import { useCalendar, useWorkspace } from '@/workspace/context';

/**
 * Tapped a home screen widget (D-321): open page where component resides; buttons open their
 * target, form "Add" buttons open new record form (preset values filled in first, Q6). This page
 * itself is not displayed; first go back, then open like a page entry point tap. If widget no
 * longer exists, stay on home screen.
 */
export default function WidgetRoute() {
  const { componentId } = useLocalSearchParams<{ componentId: string }>();
  const config = useWorkspace((s) => s.config)!;
  const router = useRouter();
  const navigate = useNavigate();
  const cal = useCalendar();
  useEffect(() => {
    let target: OpenTarget | null = null;
    let form: { collectionId: string; prefill: string } | null = null;
    for (const page of config.containers.pages) {
      const c = allComponents(page).find((x) => x.id === componentId);
      if (!c) continue;
      const button = isKnownComponent(c) && c.look === 'button' ? c : null;
      const use = button?.tools?.[0];
      const tool = use && isRecordToolUse(use) ? recordToolOf(use) : null;
      if (tool?.do === 'create' && tool.ask !== undefined)
        form = {
          collectionId: tool.table,
          prefill: JSON.stringify(createPrefill(tool, { config, now: new Date(), cal })),
        };
      target = (button ? componentTarget(button) : null) ?? `page:${page.id}`;
      break;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/');
    if (form) {
      const params = form;
      setTimeout(() => router.push({ pathname: '/record/[collectionId]', params }), 0);
    } else if (target) {
      const to = target;
      setTimeout(() => navigate(to), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentId]);
  return null;
}
