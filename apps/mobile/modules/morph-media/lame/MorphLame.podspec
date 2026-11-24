# LAME 3.100 MP3 encoder (D-183, LGPL-2.0+, see README.md). MorphMedia depends on it to output MP3.
# A separate pod: LAME macros and internal headers (util.h, tables.h...) are isolated here and do
# not affect other code.

Pod::Spec.new do |s|
  s.name           = 'MorphLame'
  s.version        = '3.100.0'
  s.summary        = 'LAME MP3 encoder (libmp3lame 3.100) for Morph'
  s.description    = 'The unmodified libmp3lame encoder sources, built without the mpglib decoder.'
  s.license        = { :type => 'LGPL-2.0-or-later', :file => 'COPYING' }
  s.author         = 'The LAME project'
  s.homepage       = 'https://lame.sourceforge.io/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.source_files = 'include/lame.h', 'libmp3lame/**/*.{c,h}'
  s.public_header_files = 'include/lame.h'
  s.compiler_flags = '-w'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/include" "$(PODS_TARGET_SRCROOT)/libmp3lame"',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) STDC_HEADERS=1 HAVE_STDINT_H=1 HAVE_INTTYPES_H=1 HAVE_LIMITS_H=1 HAVE_ERRNO_H=1 HAVE_FCNTL_H=1 HAVE_UNISTD_H=1 HAVE_MEMCPY=1 HAVE_STRCHR=1 USE_FAST_LOG=1 LAME_LIBRARY_BUILD=1 ieee754_float32_t=float ieee754_float64_t=double'
  }
end
