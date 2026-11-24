# Local Expo module (D-150): converts audio recordings to text on-device using Apple's built-in
# Speech framework. Relies solely on Apple system frameworks with no third-party code.

Pod::Spec.new do |s|
  s.name           = 'MorphSpeech'
  s.version        = '1.0.0'
  s.summary        = 'On-device speech to text for Morph'
  s.description    = 'Transcribes audio files with SpeechAnalyzer (iOS 26+) or on-device SFSpeechRecognizer.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Morph contributors'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Speech', 'AVFoundation', 'CryptoKit'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
