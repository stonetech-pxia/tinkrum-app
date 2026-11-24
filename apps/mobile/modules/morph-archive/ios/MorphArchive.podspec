# Local Expo module (D-600): ZIP read/write for full export and restore. Depends only on Apple's
# system Foundation, libcompression, and libz (using only its crc32), with zero third-party code.

Pod::Spec.new do |s|
  s.name           = 'MorphArchive'
  s.version        = '1.0.0'
  s.summary        = 'Streaming zip writer and reader (Zip64) for Tinkrum backups'
  s.description    = 'Writes and safely unpacks a standard zip archive without loading it into memory.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Morph contributors'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Foundation'
  # Compression and libz are system dynamic libraries, not frameworks.
  s.libraries = 'compression', 'z'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
