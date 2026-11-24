// iOS desktop widget (D-321): WidgetKit extension, generated at prebuild time by
// `@bacons/apple-targets`. Reads only the views computed by the app in the App Group
// (`snapshot.json`), writes operations to `queue/` on tap to be executed the next time the app
// opens. Tapping requires App Intents (iOS 17), so the minimum extension version is 17.0; the main
// app remains unchanged.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'MorphWidget',
  displayName: 'Tinkrum',
  bundleIdentifier: '.widget',
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit', 'AppIntents'],
  entitlements: {
    'com.apple.security.application-groups': ['group.dev.stonetech.tinkrum'],
  },
};
