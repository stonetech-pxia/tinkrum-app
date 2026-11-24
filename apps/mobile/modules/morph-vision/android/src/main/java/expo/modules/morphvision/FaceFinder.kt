package expo.modules.morphvision

import android.content.Context
import android.net.Uri
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.util.concurrent.TimeUnit

/**
 * Automatic face bounding for ID photos (D-252): ML Kit face detection, models bundled in the app
 * (does not require Google Play services or downloads). Corrects orientation and downscales to a
 * long side of 2048 before detection (face detection does not require higher resolution, and
 * decoding 200 MP original images causes out-of-memory errors); returned coordinates are pixels
 * of this scaled image, returned along with its width and height so JS can scale them back to the
 * original proportions.
 */
object FaceFinder {
  private const val MAX_SIDE = 2048

  fun detect(context: Context, uri: Uri): Map<String, Any> {
    val bitmap = ImageLoading.decodeUpright(context, uri, MAX_SIDE)
    val detector = FaceDetection.getClient(
      FaceDetectorOptions.Builder()
        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
        .setMinFaceSize(0.1f)
        .build()
    )
    try {
      val faces = Tasks.await(detector.process(InputImage.fromBitmap(bitmap, 0)), 30, TimeUnit.SECONDS)
      return mapOf(
        "width" to bitmap.width,
        "height" to bitmap.height,
        "faces" to faces.map {
          val box = it.boundingBox
          mapOf("x" to box.left, "y" to box.top, "width" to box.width(), "height" to box.height())
        },
      )
    } finally {
      bitmap.recycle()
      detector.close()
    }
  }
}
