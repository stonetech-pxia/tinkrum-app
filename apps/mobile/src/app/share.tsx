import { FilePreviewScreen } from '@/share/FilePreviewScreen';
import { useIncoming } from '@/share/incoming';
import { ShareScreen } from '@/share/ShareScreen';

/** Received files (D-117): single file goes straight to preview page (D-457), multiple files go to inbox. */
export default function ShareRoute() {
  const count = useIncoming((s) => s.share?.files.length ?? 0);
  return count === 1 ? <FilePreviewScreen /> : <ShareScreen />;
}
