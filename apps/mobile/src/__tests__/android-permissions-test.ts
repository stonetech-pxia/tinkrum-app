import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Android build asks for no read access to the photo library or to audio files
// (D-new-playtest-1): files come in through the system pickers and the share sheet, and saving to
// the library only writes. Libraries declare these permissions in their own manifests, so app.json
// has to block them. The merged manifest can only be checked on a release build.
describe('Android media read permissions (D-new-playtest-1)', () => {
  it('app.json blocks them', () => {
    const app = JSON.parse(readFileSync(join(__dirname, '../../app.json'), 'utf8'));
    expect(app.expo.android.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      ]),
    );
  });
});
