# Local Expo module (D-160–D-163): long-running tasks continue even when switched to the background.
# iOS 26 BGContinuedProcessingTask (disabled by default). Depends only on Apple system frameworks
# (BackgroundTasks) with no third-party code.

Pod::Spec.new do |s|
  s.name           = 'MorphBackground'
  s.version        = '1.0.0'
  s.summary        = 'Keep long media jobs running in the background for Morph'
  s.description    = 'BGContinuedProcessingTask (iOS 26+) around user-started video and audio jobs.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Morph contributors'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'
  s.frameworks = 'BackgroundTasks'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
