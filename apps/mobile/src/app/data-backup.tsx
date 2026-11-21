import { ScrollView } from 'react-native';

import { BackupCard } from '@/backup/BackupCard';
import { useDataOverview } from '@/data/useDataOverview';

/** 「数据 → 备份和恢复」（D-600、D-615）：整体导出和从压缩包恢复，原来在数据页里，挪到自己的页面让数据页一屏看完。 */
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
