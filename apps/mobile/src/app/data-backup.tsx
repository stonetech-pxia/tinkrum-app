import { ScrollView } from 'react-native';

import { BackupCard } from '@/backup/BackupCard';
import { useDataOverview } from '@/data/useDataOverview';

/** 'Data -> Backup and Restore' (D-600, D-615): full export and restore from archive, previously in the data page, moved to its own page so the data page fits on one screen. */
export default function DataBackupRoute() {
  const { locale, palette, files } = useDataOverview();
  return (
    <ScrollView
      testID="data-backup-screen"
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={{ padding: palette.pad, gap: palette.gap - 4, paddingBottom: 48 }}>
      <BackupCard palette={palette} locale={locale} files={files} />
    </ScrollView>
  );
}
