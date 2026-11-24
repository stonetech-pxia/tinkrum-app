import { useLocalSearchParams } from 'expo-router';

import { FilePreviewScreen } from '@/share/FilePreviewScreen';

/** Viewing a single file tapped from the multi-file inbox (D-457): view-only, no tools. */
export default function FilePreviewRoute() {
  const { index } = useLocalSearchParams<{ index?: string }>();
  return <FilePreviewScreen index={Number(index ?? 0)} />;
}
