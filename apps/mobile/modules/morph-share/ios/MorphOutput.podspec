# Local Expo module (D-119): uses native iOS share sheet and document picker to share multiple files
# at once and save them to folders in the Files app. Relies solely on Apple system frameworks with
# no third-party code. Named MorphOutput instead of MorphShare because the iOS share extension
# target is named MorphShare (D-114), and Swift modules with the same name would conflict.

Pod::Spec.new do |s|
  s.name           = 'MorphOutput'
  s.version        = '1.0.0'
  s.summary        = 'Share several files at once and save them to a folder for Morph'
  s.description    = 'UIActivityViewController with several files and a UIDocumentPickerViewController folder picker.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Morph contributors'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit', 'UniformTypeIdentifiers', 'QuickLook'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
