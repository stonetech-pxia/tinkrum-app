# 本地 Expo 模块（D-600）：整体导出和恢复用的 zip 读写。只依赖 Apple 系统自带的 Foundation、libcompression
# 和 libz（只用它的 crc32），没有第三方代码。

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
  # Compression 和 libz 是系统的动态库，不是 framework。
  s.libraries = 'compression', 'z'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
