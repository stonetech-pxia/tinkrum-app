# Native loudness measurement: libebur128 1.2.6 (MIT), BSD-3 queue.h, see ebur128/.
Pod::Spec.new do |s|
  s.name = 'MorphDsp'
  s.version = '1.0.0'
  s.summary = 'On-device audio loudness processing for Morph'
  s.license = 'AGPL-3.0-only'
  s.author = 'Morph contributors'
  s.homepage = 'https://github.com/jiixyj/libebur128'
  s.source = { git: '' }
  s.platforms = { :ios => '16.4' }
  s.static_framework = true
  s.source_files = 'Morph*.{c,h}', 'ebur128/*.{c,h}', 'rnnoise/include/*.h', 'rnnoise/src/*.h', 'rnnoise/src/{denoise,rnn,pitch,kiss_fft,celt_lpc,nnet,nnet_default,parse_lpcnet_weights,rnnoise_data,rnnoise_tables}.c'
  s.header_mappings_dir = '.'
  # DISABLE_DEBUG_FLOAT: Do not compile in floating-point weights used for RNNoise debugging
  # (approx. 4 MB); inference uses the int8 path. Debug builds also use -O2, otherwise denoising is
  # unrealistically slow in the simulator.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/rnnoise/include" "$(PODS_TARGET_SRCROOT)/rnnoise/src"',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) DISABLE_DEBUG_FLOAT=1',
    'GCC_OPTIMIZATION_LEVEL' => '2',
  }
  s.public_header_files = 'MorphDsp.h', 'MorphDenoise.h'
  s.resource_bundles = { 'MorphDspLicenses' => ['notices/*.txt'] }
end
