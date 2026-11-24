package expo.modules.morphvision

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabel
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions
import expo.modules.kotlin.exception.CodedException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

class VisionCancelledException : CodedException("ERR_VISION_CANCELLED", "Cancelled", null)

/**
 * Image content classification (used for recommendations on photos without text, not yet
 * integrated into recommendations): ML Kit base image labeling model, bundled in the app (does
 * not require Google Play services or downloads). Labels are ML Kit's own English terms, distinct
 * from iOS Vision. Corrects orientation and downscales to a long side of 1024 before labeling
 * (the model inspects very small images, and decoding original images causes out-of-memory
 * errors); no intermediate files are written, and bitmaps and labelers are released upon success,
 * failure, or cancellation. cancel(taskId) terminates the operation with ERR_VISION_CANCELLED.
 */
object ImageClassifier {
  private const val MAX_SIDE = 1024
  /** Interval for checking cancellation status. */
  private const val POLL_MS = 100L

  private val running = ConcurrentHashMap<String, AtomicBoolean>()

  fun classify(
    context: Context,
    uri: Uri,
    taskId: String,
    maxResults: Int,
    minConfidence: Double,
  ): Map<String, Any> {
    val flag = AtomicBoolean(false)
    running[taskId] = flag
    // Threshold filtering is delegated to ML Kit (default 0.5); count limits and sorting are handled here.
    val labeler = ImageLabeling.getClient(
      ImageLabelerOptions.Builder().setConfidenceThreshold(minConfidence.toFloat()).build()
    )
    var bitmap: Bitmap? = null
    var task: Task<List<ImageLabel>>? = null
    try {
      val image = ImageLoading.decodeUpright(context, uri, MAX_SIDE)
      bitmap = image
      if (flag.get()) throw VisionCancelledException()
      val pending = labeler.process(InputImage.fromBitmap(image, 0))
      task = pending
      while (true) {
        if (flag.get()) throw VisionCancelledException()
        val labels = try {
          Tasks.await(pending, POLL_MS, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
          continue
        }
        return mapOf(
          "labels" to labels.sortedByDescending { it.confidence }.take(maxOf(0, maxResults)).map {
            mapOf("id" to it.text, "confidence" to it.confidence.toDouble())
          },
          "width" to image.width,
          "height" to image.height,
        )
      }
    } finally {
      running.remove(taskId)
      val done = { labeler.close(); bitmap?.recycle() }
      // ML Kit may still be reading the bitmap upon cancellation: wait for it to finish before recycling, otherwise it may read a recycled bitmap.
      val unfinished = task?.takeIf { !it.isComplete }
      if (unfinished != null) unfinished.addOnCompleteListener { done() } else done()
    }
  }

  /** Cancellations for tasks that have not started or already finished have no effect (JS terminates its own Promise beforehand). */
  fun cancel(taskId: String) {
    running[taskId]?.set(true)
  }
}
