import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// expo-share-intent reads each shared file's name and size without checking the answer. A file the
// app cannot read (no read grant, gone since it was shared) crashed Android while the app was
// running (CursorIndexOutOfBoundsException). patches/expo-share-intent+9.0.0.patch leaves such a
// file out. The native code only runs on Android, so this checks the patch is applied; the crash
// itself is reproduced on an emulator.
describe('Android: a shared file that cannot be read does not crash the app', () => {
  const source = readFileSync(
    join(
      __dirname,
      '../../../..',
      'node_modules/expo-share-intent/android/src/main/java/expo/modules/shareintent/ExpoShareIntentModule.kt',
    ),
    'utf8',
  );

  it('every shared file is read through the guard', () => {
    expect(source).toContain('private fun readFileInfo(uri: Uri)');
    expect(source).toContain('catch (e: Exception)');
    // The one call left is the one inside the guard.
    expect(source.match(/(?<!fun )\bgetFileInfo\((uri|it)\)/g)).toHaveLength(1);
  });

  it('the reported error names no file (invariants 1, 2)', () => {
    const guard = source.slice(source.indexOf('private fun readFileInfo'));
    const message = /notifyError\((.*)\)/.exec(guard)![1]!;
    expect(message).not.toMatch(/uri|e\.message/i);
  });
});
