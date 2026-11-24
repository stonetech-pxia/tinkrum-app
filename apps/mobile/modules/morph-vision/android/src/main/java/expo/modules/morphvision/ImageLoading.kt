package expo.modules.morphvision

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Reads into an oriented, mutable ARGB bitmap with a long side not exceeding maxSide. Decoding
 * Samsung 50 / 200 MP photos raw consumes 200–800 MB each, leading to out-of-memory errors if
 * multiple copies exist: therefore, downscale during decoding, and perform subsequent processing
 * on this single instance where possible.
 */
object ImageLoading {
  fun decodeUpright(context: Context, uri: Uri, maxSide: Int): Bitmap {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      // ImageDecoder corrects orientation via EXIF (HEIC is also supported) and decodes directly to the target dimensions without allocating extra memory.
      val source = ImageDecoder.createSource(context.contentResolver, uri)
      return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        val side = max(info.size.width, info.size.height)
        if (side > maxSide) {
          val k = maxSide.toDouble() / side
          decoder.setTargetSize((info.size.width * k).roundToInt().coerceAtLeast(1), (info.size.height * k).roundToInt().coerceAtLeast(1))
        }
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        decoder.isMutableRequired = true
      }
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / sample > maxSide) sample *= 2
    val options = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
      inMutable = true
    }
    val bitmap = context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, options) }
      ?: throw VisionFailedException("unreadable image")
    val orientation = try {
      context.contentResolver.openInputStream(uri).use { ExifInterface(it!!).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }
    } catch (_: Exception) { 1 }
    val values = when (orientation) {
      2 -> floatArrayOf(-1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
      3 -> floatArrayOf(-1f, 0f, 0f, 0f, -1f, 0f, 0f, 0f, 1f)
      4 -> floatArrayOf(1f, 0f, 0f, 0f, -1f, 0f, 0f, 0f, 1f)
      5 -> floatArrayOf(0f, 1f, 0f, 1f, 0f, 0f, 0f, 0f, 1f)
      6 -> floatArrayOf(0f, -1f, 0f, 1f, 0f, 0f, 0f, 0f, 1f)
      7 -> floatArrayOf(0f, -1f, 0f, -1f, 0f, 0f, 0f, 0f, 1f)
      8 -> floatArrayOf(0f, 1f, 0f, -1f, 0f, 0f, 0f, 0f, 1f)
      else -> return bitmap
    }
    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { setValues(values) }, true)
    if (rotated !== bitmap) bitmap.recycle()
    if (rotated.isMutable) return rotated
    return rotated.copy(Bitmap.Config.ARGB_8888, true).also { rotated.recycle() }
  }
}
