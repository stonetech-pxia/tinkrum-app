// Two adjustments for the iOS share extension (D-114, D-118), executed after expo-share-intent
// generates the extension:
// 1. Display name: expo-share-intent uses iosShareExtensionName for both the Xcode target name and
// display name, but the target cannot share the same name as the main app ("Morph"), so the target
// is named MorphShare, and this changes the display name in the share sheet back to "Morph".
// 2. Controller: replaced with our own ShareViewController.swift (copies attachments sequentially
// and jumps back to the main app only after all are finished; expo-share-intent 9.0.0's controller
// processes multiple attachments in parallel and jumps as soon as the last index finishes, meaning
// earlier files might not be fully copied yet).
const fs = require('node:fs');
const path = require('node:path');
const { withFinalizedMod } = require('expo/config-plugins');

module.exports = function withShareExtension(config, { target, displayName }) {
  return withFinalizedMod(config, [
    'ios',
    (config) => {
      const dir = path.join(config.modRequest.platformProjectRoot, target);
      const plist = path.join(dir, 'ShareExtension-Info.plist');
      const xml = fs.readFileSync(plist, 'utf8');
      const next = xml.replace(
        /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${displayName}$2`,
      );
      if (!next.includes(`<string>${displayName}</string>`)) {
        throw new Error(`[with-share-extension] CFBundleDisplayName not found in ${plist}`);
      }
      fs.writeFileSync(plist, next);
      fs.copyFileSync(
        path.join(
          config.modRequest.projectRoot,
          'plugins',
          'share-extension',
          'ShareViewController.swift',
        ),
        path.join(dir, 'ShareViewController.swift'),
      );
      return config;
    },
  ]);
};
