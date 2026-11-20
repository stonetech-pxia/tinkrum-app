import { formatFileSize, formatTimestamp, type Locale } from '@morph/core';
import { useState } from 'react';
import { Alert, Text, View } from 'react-native';

import { t, type StringKey } from '@/i18n';
import { Card, Pill, SectionLabel } from '@/renderer/ui';
import type { Palette } from '@/renderer/theme';
import type { FilePlatform } from '@/runtime/platform';
import { backupAvailable, getBackup } from './index';
import { useBackupStatus, type BackupErrorKind, type BackupStep } from './service';

// 「设置 → 数据」里的「备份和恢复」（D-600）：整体导出、从压缩包恢复。流程和规则在 service.ts；
// 状态在 useBackupStatus 里，所以离开这一页再回来，进度还在。

/** 恢复只收 zip；有的文件提供者把 zip 标成 octet-stream，也让它能选（选了不是备份会被拒绝）。 */
const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];

const STEP_TEXT: Record<BackupStep, StringKey> = {
  prepare: 'backupWorking_prepare',
  write: 'backupWorking_write',
  unpack: 'backupWorking_unpack',
  verify: 'backupWorking_verify',
  switch: 'backupWorking_switch',
};

const ERROR_TEXT: Record<BackupErrorKind, StringKey> = {
  notBackup: 'backupError_notBackup',
  damaged: 'backupError_damaged',
  newer: 'backupError_newer',
  noSpace: 'backupError_noSpace',
  cancelled: 'backupError_cancelled',
  switchFailed: 'backupError_switchFailed',
  failed: 'backupError_failed',
};

export function BackupCard({
  palette,
  locale,
  files,
}: {
  palette: Palette;
  locale: Locale;
  files: FilePlatform;
}) {
  const status = useBackupStatus();
  // 存到哪个文件夹了（给「已存到…」用）；save 失败的说明。
  const [saved, setSaved] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  // Expo Go 和测试里没有原生模块：这一块不显示。
  if (!backupAvailable()) return null;
  const backup = getBackup();
  const caption = [palette.font('body', 13), { color: palette.muted }];
  const busy = status.phase !== 'idle' && status.phase !== 'exported';
  const size = (bytes: number) => formatFileSize(bytes, locale);

  function exportAll() {
    setSaved(null);
    setSaveFailed(false);
    backup.dismissError();
    // 备份文件没有加密，先说清楚（D-600）。
    Alert.alert(t(locale, 'backupExportTitle'), t(locale, 'backupExportConfirm'), [
      { text: t(locale, 'cancel'), style: 'cancel' },
      { text: t(locale, 'backupExportAction'), onPress: () => void backup.exportAll() },
    ]);
  }

  async function restore() {
    backup.dismissError();
    const picked = await files.pickDocuments(ZIP_TYPES, false, true);
    const file = picked?.[0];
    if (!file) return;
    await backup.restore(
      file.uri,
      (preview) =>
        new Promise<boolean>((resolve) =>
          Alert.alert(
            t(locale, 'backupRestoreTitle'),
            t(locale, 'backupRestoreConfirm', {
              date: formatTimestamp(preview.manifest.createdAt, locale),
              n: preview.manifest.contains.records,
              size: size(preview.bytes),
            }),
            [
              { text: t(locale, 'cancel'), style: 'cancel', onPress: () => resolve(false) },
              {
                text: t(locale, 'backupRestoreAction'),
                style: 'destructive',
                onPress: () => resolve(true),
              },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          ),
        ),
    );
  }

  async function saveToFolder() {
    if (!status.exported) return;
    setSaveFailed(false);
    try {
      const result = await files.saveToFolder(
        [
          {
            uri: status.exported.uri,
            name: status.exported.name.replace(/\.zip$/, ''),
            ext: 'zip',
            mimeType: 'application/zip',
          },
        ],
        'backup',
        true,
      );
      if (result) setSaved(result.folder);
    } catch {
      setSaveFailed(true);
    }
  }

  const progress = status.total > 0 ? Math.min(1, Math.max(0, status.done / status.total)) : null;
  const working = status.step
    ? t(locale, status.phase === 'checking' ? 'backupWorking_checking' : STEP_TEXT[status.step], {
        done: size(status.done),
        total: size(status.total),
      })
    : '';

  return (
    <>
      <SectionLabel palette={palette}>{t(locale, 'backupTitle')}</SectionLabel>
      <Card palette={palette} testID="backup">
        <Text style={caption}>{t(locale, 'backupHint')}</Text>
        {busy ? (
          <View style={{ gap: 8 }}>
            <Text
              testID="backup-working"
              style={[palette.font('bodyMedium', 14), { color: palette.text }]}>
              {working}
            </Text>
            {progress !== null && (status.step === 'write' || status.step === 'unpack') ? (
              <View
                testID="backup-progress"
                style={{ height: 6, borderRadius: 3, backgroundColor: palette.border }}>
                <View
                  style={{
                    height: 6,
                    borderRadius: 3,
                    width: `${Math.round(progress * 100)}%`,
                    backgroundColor: palette.primary,
                  }}
                />
              </View>
            ) : null}
            {(status.phase === 'exporting' && status.step === 'write') ||
            (status.phase === 'restoring' && status.step === 'unpack') ? (
              <View style={{ flexDirection: 'row' }}>
                <Pill
                  palette={palette}
                  testID="backup-cancel"
                  label={t(locale, 'cancel')}
                  onPress={backup.cancel}
                />
              </View>
            ) : null}
          </View>
        ) : status.phase === 'exported' && status.exported ? (
          <View style={{ gap: 8 }} testID="backup-ready">
            <Text style={[palette.font('bodyMedium', 14), { color: palette.text }]}>
              {t(locale, 'backupReady', {
                name: status.exported.name,
                size: size(status.exported.bytes),
              })}
            </Text>
            <Text style={caption}>{t(locale, 'backupReadyHint')}</Text>
            {saved ? (
              <Text testID="backup-saved" style={caption}>
                {t(locale, 'backupSaved', { folder: saved })}
              </Text>
            ) : null}
            {saveFailed ? (
              <Text testID="backup-save-failed" style={[caption, { color: palette.danger }]}>
                {t(locale, 'backupSaveFailed')}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Pill
                palette={palette}
                testID="backup-save-folder"
                label={t(locale, 'backupSaveToFolder')}
                onPress={() => void saveToFolder()}
              />
              <Pill
                palette={palette}
                testID="backup-share"
                label={t(locale, 'backupShare')}
                onPress={() =>
                  void files
                    .shareUris([
                      {
                        uri: status.exported!.uri,
                        mimeType: 'application/zip',
                        name: status.exported!.name.replace(/\.zip$/, ''),
                        ext: 'zip',
                      },
                    ])
                    .catch(() => setSaveFailed(true))
                }
              />
              <Pill
                palette={palette}
                testID="backup-done"
                label={t(locale, 'done')}
                onPress={() => void backup.discardExport()}
              />
            </View>
          </View>
        ) : (
          <>
            {status.error ? (
              <Text
                testID="backup-error"
                style={[palette.font('bodyMedium', 14), { color: palette.danger }]}>
                {t(locale, ERROR_TEXT[status.error.kind], {
                  size: size(status.error.needed ?? 0),
                })}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Pill
                palette={palette}
                testID="backup-export"
                label={t(locale, 'backupExport')}
                onPress={exportAll}
              />
              <Pill
                palette={palette}
                testID="backup-restore"
                label={t(locale, 'backupRestore')}
                onPress={() => void restore()}
              />
            </View>
          </>
        )}
      </Card>
    </>
  );
}
