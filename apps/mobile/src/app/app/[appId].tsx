import { appTarget } from '@morph/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { useNavigate } from '@/shell/navigation';

/**
 * morph://app/<id> (D-485): directly open an app. iOS users can create a desktop shortcut via
 * Shortcuts to open this URL; widgets and notifications can also use it. This page itself is
 * invisible, first goes back, then enters that app just like tapping its home screen entry point;
 * stays on the home screen if the app no longer exists.
 */
export default function OpenAppRoute() {
  const { appId } = useLocalSearchParams<{ appId: string }>();
  const router = useRouter();
  const navigate = useNavigate();
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
    setTimeout(() => navigate(appTarget(appId)), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);
  return null;
}
