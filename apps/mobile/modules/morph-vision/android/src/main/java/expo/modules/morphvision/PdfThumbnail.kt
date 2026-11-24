package expo.modules.morphvision

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

// PDF first-page thumbnail (D-451): system PdfRenderer, rendered locally, offline. White background
// (PDF pages may be transparent), long side not exceeding maxSide, saved as JPEG. Throws when it
// cannot be opened (damaged, password-protected), causing the app to display a PDF icon.
object PdfThumbnail {
  fun render(input: File, output: File, maxSide: Int): Map<String, Any> {
    val fd = ParcelFileDescriptor.open(input, ParcelFileDescriptor.MODE_READ_ONLY)
    try {
      PdfRenderer(fd).use { renderer ->
        if (renderer.pageCount == 0) throw VisionFailedException("PDF has no pages")
        renderer.openPage(0).use { page ->
          val scale = maxSide.toDouble() / max(page.width, page.height)
          val width = max(1, (page.width * scale).roundToInt())
          val height = max(1, (page.height * scale).roundToInt())
          val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
          try {
            bitmap.eraseColor(Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            output.parentFile?.mkdirs()
            FileOutputStream(output).use { bitmap.compress(Bitmap.CompressFormat.JPEG, 80, it) }
          } finally {
            bitmap.recycle()
          }
          return mapOf("width" to width, "height" to height, "pageCount" to renderer.pageCount)
        }
      }
    } catch (e: VisionFailedException) {
      throw e
    } catch (e: Exception) {
      throw VisionFailedException(e.message)
    } finally {
      fd.close()
    }
  }

  /** PDF text layer (D-455): PdfRenderer can read page text starting from Android 15 (API 35); returns null on earlier systems or when it cannot be opened. */
  fun text(input: File): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return null
    return try {
      ParcelFileDescriptor.open(input, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        PdfRenderer(fd).use { renderer ->
          val out = StringBuilder()
          for (i in 0 until renderer.pageCount) {
            renderer.openPage(i).use { page ->
              for (content in page.textContents) out.append(content.text).append('\n')
            }
          }
          out.toString().trim().ifEmpty { null }
        }
      }
    } catch (e: Exception) {
      null
    }
  }
}
