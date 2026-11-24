# Local Expo module (D-271): Home Screen Quick Actions menu when long-pressing the Morph icon. Relies solely on Apple system frameworks.

Pod::Spec.new do |s|
  s.name           = 'MorphShortcuts'
  s.version        = '1.0.0'
  s.summary        = 'Home screen quick actions for Morph'
  s.description    = 'UIApplicationShortcutItem for the quick actions the user put on the home screen.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Morph contributors'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
