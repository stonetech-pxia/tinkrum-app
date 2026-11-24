# Apply a small patch to the downloaded whisper.cpp (FetchContent PATCH_COMMAND, run in the source directory).
#
# When whisper outputs only a single sentence in a 30-second window ending with a single timestamp,
# the original rule assumed 'no one is speaking afterwards' and skipped the rest of the window.
# Since we enabled VAD, only audio containing speech is fed in, so this assumption no longer holds:
# on a Samsung SM-S948B, a 5-minute meeting recording would miss about 1 minute of speech, and the
# same version on a Mac would miss 15-30 seconds. Changed to continue transcription from the last
# timestamp (at least 1 second back to avoid getting stuck). When changing the whisper.cpp version,
# first verify this line is still present; if not found, fail the build rather than silently
# skipping.
set(file src/whisper.cpp)
file(READ ${file} text)
set(old "if (single_timestamp_ending) {")
set(new "if (single_timestamp_ending && !(params.vad && seek_delta >= 100)) {")
string(FIND "${text}" "${new}" done)
if(done EQUAL -1)
  string(FIND "${text}" "${old}" found)
  if(found EQUAL -1)
    message(FATAL_ERROR "patch-whisper.cmake: '${old}' not found in ${file}")
  endif()
  string(REPLACE "${old}" "${new}" text "${text}")
  file(WRITE ${file} "${text}")
endif()
