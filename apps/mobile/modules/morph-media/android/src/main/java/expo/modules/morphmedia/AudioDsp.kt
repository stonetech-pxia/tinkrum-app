package expo.modules.morphmedia

/** Shared LUFS/peak analyzer (libebur128, MIT). Each task maintains its own state. */
object AudioDsp {
  init { System.loadLibrary("morphdsp") }
  @JvmStatic external fun nativeCreate(rate: Int, channels: Int): Long
  @JvmStatic external fun nativeAdd(handle: Long, pcm: ShortArray, count: Int): Int
  @JvmStatic external fun nativeGain(handle: Long, automatic: Boolean, db: Double): Double
  @JvmStatic external fun nativeDestroy(handle: Long)
  @JvmStatic external fun nativeDenoiseCreate(channels: Int): Long
  @JvmStatic external fun nativeDenoise(handle: Long, input: FloatArray, output: FloatArray): Int
  @JvmStatic external fun nativeDenoiseDestroy(handle: Long)
}
