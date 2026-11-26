import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// androidx.core's ServiceCompat.startForeground passes on only the foreground service types it
// knows (1.18.0: those up to Android 14). mediaProcessing, new in Android 15, reached the system
// as "no type", so every run fell back to dataSync. The service calls the platform method itself.
// The native code only runs on Android, so this checks the source; the type the system records is
// checked on an Android 15 emulator.
describe('Android: the background service starts with the type it asks for', () => {
  const source = readFileSync(
    join(
      __dirname,
      '../../modules/morph-background/android/src/main/java/expo/modules/morphbackground',
      'MorphBackgroundService.kt',
    ),
    'utf8',
  );

  it('asks for mediaProcessing first from Android 15', () => {
    expect(source).toMatch(
      /SDK_INT >= 35 -> listOf\(\s*ServiceInfo\.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING,/,
    );
  });

  it('gives the type to the platform, not to ServiceCompat', () => {
    expect(source).not.toContain('ServiceCompat.startForeground(');
    expect(source).toContain('startForeground(NOTIFICATION_ID, notification, type)');
  });
});
