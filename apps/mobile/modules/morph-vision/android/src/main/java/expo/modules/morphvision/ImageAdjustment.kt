package expo.modules.morphvision

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ColorMatrix
import android.net.Uri
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt

object ImageAdjustment {
  /** Long side upper limit: extremely large photos (Samsung 50 / 200 MP) are downscaled to this size before processing to avoid out-of-memory errors. */
  private const val MAX_SIDE = 6144

  fun adjust(context: Context, uri: Uri, options: Map<String, Any?>, format: String, output: File): Map<String, Any> {
    val bitmap = ImageLoading.decodeUpright(context, uri, MAX_SIDE)
    try {
      var brightness = (options["brightness"] as? Number)?.toDouble() ?: 0.0
      var contrast = (options["contrast"] as? Number)?.toDouble() ?: 100.0
      var saturation = (options["saturation"] as? Number)?.toDouble() ?: 100.0
      if (options["mode"] == "auto") {
        // Samples at most about 65536 pixels without retaining content; moderately brightens dark images while preventing pure black images from turning gray.
        val step = max(1, sqrt(bitmap.width.toDouble()*bitmap.height/65536).toInt())
        var sum = 0.0; var weight = 0.0
        for (y in 0 until bitmap.height step step) for (x in 0 until bitmap.width step step) {
          val pixel = bitmap.getPixel(x,y); val alpha = Color.alpha(pixel)/255.0
          sum += (.2126*Color.red(pixel)+.7152*Color.green(pixel)+.0722*Color.blue(pixel))*alpha; weight += alpha
        }
        val mean = if (weight>0) sum/weight/255 else 0.0
        brightness = if (mean>.01) ((.45-mean).coerceIn(-.12,.20)*100) else 0.0
        contrast = if (mean>.01) 105.0 else 100.0; saturation = 100.0
      }
      if (!brightness.isFinite() || !contrast.isFinite() || !saturation.isFinite() || brightness !in -100.0..100.0 || contrast !in 0.0..200.0 || saturation !in 0.0..200.0) throw VisionFailedException("invalid adjustment")
      val scale = (contrast/100).toFloat()
      val offset = (128*(1-scale)+brightness*255/100).toFloat()
      val m = ColorMatrix().apply { setSaturation((saturation/100).toFloat()); postConcat(ColorMatrix(floatArrayOf(scale,0f,0f,0f,offset, 0f,scale,0f,0f,offset, 0f,0f,scale,0f,offset, 0f,0f,0f,1f,0f))) }.array
      // Modifies the bitmap row-by-row in place without allocating a separate result image (saving memory on large photos). Transparency remains unchanged.
      val row = IntArray(bitmap.width)
      fun channel(i: Int, r: Int, g: Int, b: Int, a: Int) = (m[i]*r + m[i+1]*g + m[i+2]*b + m[i+3]*a + m[i+4]).roundToInt().coerceIn(0, 255)
      for (y in 0 until bitmap.height) {
        bitmap.getPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
        for (x in row.indices) {
          val p = row[x]
          val a = Color.alpha(p); val r = Color.red(p); val g = Color.green(p); val b = Color.blue(p)
          row[x] = Color.argb(a, channel(0, r, g, b, a), channel(5, r, g, b, a), channel(10, r, g, b, a))
        }
        bitmap.setPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
      }
      output.parentFile?.mkdirs()
      output.outputStream().use { if (!bitmap.compress(if (format=="png") Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 92, it)) throw VisionFailedException("image encode") }
      return mapOf("width" to bitmap.width, "height" to bitmap.height, "size" to output.length())
    } finally { bitmap.recycle() }
  }
}
