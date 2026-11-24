# Local Expo module (D-170): Uses native iOS Translation framework for on-device translation, and
# NaturalLanguage for language recognition. Relies solely on Apple system frameworks with no
# third-party code. Translation is available starting from iOS 18 (weakly linked); isSupported
# returns false on earlier systems.

Pod::Spec.new do |s|
  s.name           = 'MorphTranslate'
  s.version        = '1.0.0'
  s.summary        = 'On-device translation for Morph'
  s.description    = 'Apple Translation framework sessions (with the system download prompt) and NaturalLanguage language detection.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Morph contributors'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'NaturalLanguage', 'SwiftUI'
  s.weak_frameworks = 'Translation'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
