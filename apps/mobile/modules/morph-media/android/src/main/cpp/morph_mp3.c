// JNI for MP3 encoding (D-183): Mp3Encoder.kt passes interleaved 16-bit PCM, LAME encodes them into MP3 frames and returns them, and file writing is handled in Kotlin.
#include <jni.h>
#include <stdint.h>

#include "lame.h"

#define EXPORT __attribute__((visibility("default")))

/** Returns the encoder handle; returns 0 if parameters are not accepted by LAME. Quality uses LAME's 2 (good, slightly slower than the default 5). */
EXPORT JNIEXPORT jlong JNICALL
Java_expo_modules_morphmedia_Mp3Encoder_nativeInit(JNIEnv *env, jclass cls, jint sampleRate, jint channels,
                                                   jint kbps) {
  lame_t lame = lame_init();
  if (!lame) return 0;
  lame_set_in_samplerate(lame, sampleRate);
  lame_set_num_channels(lame, channels);
  lame_set_mode(lame, channels == 1 ? MONO : JOINT_STEREO);
  lame_set_brate(lame, kbps);
  lame_set_quality(lame, 2);
  if (lame_init_params(lame) < 0) {
    lame_close(lame);
    return 0;
  }
  return (jlong)(intptr_t)lame;
}

/** frames frames of interleaved samples -> MP3 bytes, returns the number of bytes written to out (negative values are LAME error codes). */
EXPORT JNIEXPORT jint JNICALL
Java_expo_modules_morphmedia_Mp3Encoder_nativeEncode(JNIEnv *env, jclass cls, jlong handle, jshortArray pcm,
                                                     jint frames, jbyteArray out) {
  lame_t lame = (lame_t)(intptr_t)handle;
  jshort *samples = (*env)->GetShortArrayElements(env, pcm, NULL);
  jbyte *bytes = (*env)->GetByteArrayElements(env, out, NULL);
  int size = (*env)->GetArrayLength(env, out);
  int written = lame_get_num_channels(lame) == 1
                    ? lame_encode_buffer(lame, samples, samples, frames, (unsigned char *)bytes, size)
                    : lame_encode_buffer_interleaved(lame, samples, frames, (unsigned char *)bytes, size);
  (*env)->ReleaseByteArrayElements(env, out, bytes, 0);
  (*env)->ReleaseShortArrayElements(env, pcm, samples, JNI_ABORT);
  return written;
}

/** Remaining samples in the encoder -> final few frames, returns the byte count. */
EXPORT JNIEXPORT jint JNICALL
Java_expo_modules_morphmedia_Mp3Encoder_nativeFlush(JNIEnv *env, jclass cls, jlong handle, jbyteArray out) {
  lame_t lame = (lame_t)(intptr_t)handle;
  jbyte *bytes = (*env)->GetByteArrayElements(env, out, NULL);
  int size = (*env)->GetArrayLength(env, out);
  int written = lame_encode_flush(lame, (unsigned char *)bytes, size);
  (*env)->ReleaseByteArrayElements(env, out, bytes, 0);
  return written;
}

EXPORT JNIEXPORT void JNICALL
Java_expo_modules_morphmedia_Mp3Encoder_nativeClose(JNIEnv *env, jclass cls, jlong handle) {
  lame_close((lame_t)(intptr_t)handle);
}
