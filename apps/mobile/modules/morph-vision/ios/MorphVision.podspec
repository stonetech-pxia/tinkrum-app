# Local Expo module (D-084): uses iOS built-in Vision / VisionKit / Core Image for scanning, and
# PP-OCRv6 for text recognition (D-269, running model via ONNX Runtime, MIT; Vision is used only for
# languages not recognized by PP-OCRv6).

Pod::Spec.new do |s|
  s.name           = 'MorphVision'
  s.version        = '1.0.0'
  s.summary        = 'On-device text recognition and document scanning for Morph'
  s.description    = 'Vision text recognition, paper edge detection, perspective correction and the VisionKit document camera.'
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Morph contributors'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'onnxruntime-objc', '1.30.0'
  s.frameworks = 'Vision', 'VisionKit', 'CoreImage', 'ImageIO', 'PDFKit'
  # DataDetection is available starting from iOS 26 (date and amount recognition for prefilling): weakly linked, not loaded on earlier systems, falling back to NSDataDetector.
  s.weak_frameworks = 'DataDetection'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
