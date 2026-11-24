package expo.modules.morphvision

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.net.Uri
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.FileOutputStream
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// Android implementation of text recognition and document scanning (D-087): fully processed
// on-device. Text recognition primarily uses PP-OCRv6 (D-269, running models via OcrRunner, with
// pre- and post-processing in JS); ML Kit retains only the Korean recognizer (since PP-OCRv6 does
// not recognize Korean). JavaScript interface matches iOS; ML Kit lacks an interface to find four
// corners in a photo, so canFindPaper is false, and border detection for photo gallery images falls
// back to the scanning pack. Recognized text is returned exclusively to the app and never logged.

class VisionFailedException(detail: String?) : CodedException("Vision failed: $detail")

class UnsupportedLanguageException(code: String) :
  CodedException("Text recognition does not support $code")

class DocumentCameraUnavailableException :
  CodedException("The document camera is not available on this device")

private const val SCAN_REQUEST = 0x4d56

class ClassifyOptions : Record {
  @Field val maxResults: Int = 10
  @Field val minConfidence: Double = 0.1
}


private class PendingScan(
  val promise: Promise,
  val directory: File,
  val maxSide: Int,
  val quality: Double,
)

class MorphVisionModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  private var pendingScan: PendingScan? = null

  override fun definition() = ModuleDefinition {
    Name("MorphVision")

    Function("backgroundRemovalSupported") { BackgroundRemoval.supported(context) }
    AsyncFunction("backgroundStatus") { BackgroundRemoval.status(context) }
    AsyncFunction("downloadBackgroundModel") { BackgroundRemoval.download(context) }
    AsyncFunction("removeBackground") { uri: String, background: String, output: String ->
      BackgroundRemoval.remove(context, Uri.parse(uri), background, File(Uri.parse(output).path!!))
    }

    // ID photo (D-252): ML Kit face detection (model bundled into the app); for changing the background color, use the subject segmentation above (Google Play services model).
    AsyncFunction("detectFaces") { uri: String -> FaceFinder.detect(context, Uri.parse(uri)) }

    // What is in the photo (used for recommendations on photos without text): ML Kit image labeling, see ImageClassifier. Runs on a background thread; polls until finished when cancelled.
    AsyncFunction("classifyImage") { taskId: String, uri: String, options: ClassifyOptions, promise: Promise ->
      thread(name = "morph-classify") {
        try {
          promise.resolve(
            ImageClassifier.classify(context, Uri.parse(uri), taskId, options.maxResults, options.minConfidence)
          )
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          promise.reject(VisionFailedException(e.message))
        }
      }
    }

    Function("cancelClassify") { taskId: String -> ImageClassifier.cancel(taskId) }

    // System recognition for "Log an expense" prefill (ML Kit entity recognition), acting only as a rule supplement; see DataDetection.
    AsyncFunction("detectData") { text: String, language: String, allowDownload: Boolean, promise: Promise ->
      thread(name = "morph-detect-data") {
        try {
          promise.resolve(DataDetection.detect(text, language, allowDownload))
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          promise.reject(VisionFailedException(e.message))
        }
      }
    }

    AsyncFunction("dataDetectionStatus") { language: String -> DataDetection.status(language) }

    // Download only after user consent (JS prompts first).
    AsyncFunction("downloadDataModel") { language: String, promise: Promise ->
      thread(name = "morph-data-model") {
        try {
          DataDetection.download(language)
          promise.resolve(null)
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          promise.reject(VisionFailedException(e.message))
        }
      }
    }

    AsyncFunction("adjustImage") { uri: String, options: Map<String, Any?>, format: String, output: String ->
      ImageAdjustment.adjust(context, Uri.parse(uri), options, format, File(Uri.parse(output).path!!))
    }

    Function("canFindPaper") { false }

    // PDF text layer (D-455): readable by the system starting from Android 15; earlier systems return null.
    AsyncFunction("pdfText") { uri: String -> PdfThumbnail.text(File(Uri.parse(uri).path!!)) }

    // PDF first-page thumbnail (D-451).
    AsyncFunction("pdfThumbnail") { uri: String, output: String, maxSide: Int ->
      PdfThumbnail.render(File(Uri.parse(uri).path!!), File(Uri.parse(output).path!!), maxSide)
    }

    // Document scanning is part of Google Play Services; phones without Google Play Services cannot use it.
    Function("isDocumentCameraSupported") {
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) ==
        ConnectionResult.SUCCESS
    }

    Function("isCameraAvailable") {
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }

    Function("supportsLanguage") { code: String -> recognizerFor(code) != null }

    // The two PP-OCRv6 models (D-269): paths are files within the pack; inputs and outputs are temporary files for the current run.
    AsyncFunction("ocrLoad") { det: String, rec: String ->
      OcrRunner.load(fileOf(det).path, fileOf(rec).path)
    }
    AsyncFunction("ocrDetect") { input: String, width: Int, height: Int, output: String ->
      OcrRunner.detect(fileOf(input), width, height, fileOf(output))
    }
    AsyncFunction("ocrRecognize") { input: String, count: Int, width: Int, output: String ->
      OcrRunner.recognize(fileOf(input), count, width, fileOf(output))
    }
    AsyncFunction("ocrUnload") { OcrRunner.unload() }

    // Scan-flattened UVDoc grid model (D-274): one float32 input and one float32 output, both via temporary files, returning the output shape.
    AsyncFunction("modelRun") { model: String, input: String, shape: List<Int>, output: String ->
      ModelRunner.run(
        fileOf(model).path,
        fileOf(input),
        shape.map { it.toLong() }.toLongArray(),
        fileOf(output),
      ).map { it.toInt() }
    }
    AsyncFunction("modelUnload") { ModelRunner.unload() }

    AsyncFunction("supportedLanguages") {
      listOf("ko")
    }

    // languages is BCP 47; the first is the user's chosen language, determining which recognizer to use (CJK recognizers also recognize Latin letters).
    AsyncFunction("recognizeText") { uri: String, languages: List<String> ->
      val first = languages.firstOrNull() ?: ""
      val recognizer = recognizerFor(first) ?: throw UnsupportedLanguageException(first)
      try {
        val image = InputImage.fromFilePath(context, Uri.parse(uri))
        val result = Tasks.await(recognizer.process(image))
        val lines = result.textBlocks.flatMap { block ->
          block.lines.mapNotNull { line -> line.boundingBox?.let { TextLine(line.text, it) } }
        }
        // Line positions (D-195): pixels, origin at top-left; bounding boxes are coordinates adjusted after straightening according to shooting orientation, and width/height are also given accordingly.
        val turned = image.rotationDegrees == 90 || image.rotationDegrees == 270
        val items = lines.map {
          mapOf(
            "text" to it.text,
            "x" to it.box.left.toDouble(),
            "y" to it.box.top.toDouble(),
            "width" to it.box.width().toDouble(),
            "height" to it.box.height().toDouble(),
          )
        }
        mapOf(
          "text" to layout(lines),
          "lines" to lines.size,
          "languages" to listOf(first),
          "width" to (if (turned) image.height else image.width),
          "height" to (if (turned) image.width else image.height),
          "items" to items,
        )
      } catch (e: Exception) {
        throw VisionFailedException(e.message)
      } finally {
        recognizer.close()
      }
    }

    // System document scanning (ML Kit): real-time edge detection, auto-capture, multi-page, can
    // import from photo library, straightened upon capture. Each page is saved as a JPG (long side
    // not exceeding maxSide) in directory; returns null if cancelled by the user.
    AsyncFunction("scanDocuments") { directory: String, maxSide: Int, quality: Double, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null || pendingScan != null) {
        promise.reject(DocumentCameraUnavailableException())
        return@AsyncFunction
      }
      val options = GmsDocumentScannerOptions.Builder()
        .setGalleryImportAllowed(true)
        .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
        .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
        .build()
      GmsDocumentScanning.getClient(options).getStartScanIntent(activity)
        .addOnSuccessListener { intentSender ->
          pendingScan = PendingScan(promise, File(Uri.parse(directory).path!!), maxSide, quality)
          activity.startIntentSenderForResult(intentSender, SCAN_REQUEST, null, 0, 0, 0)
        }
        .addOnFailureListener { promise.reject(DocumentCameraUnavailableException()) }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode != SCAN_REQUEST) return@OnActivityResult
      val pending = pendingScan ?: return@OnActivityResult
      pendingScan = null
      val result = GmsDocumentScanningResult.fromActivityResultIntent(payload.data)
      if (payload.resultCode != Activity.RESULT_OK || result == null) {
        pending.promise.resolve(null)
        return@OnActivityResult
      }
      // Decoding and encoding are moved to the background to avoid blocking the UI.
      thread {
        try {
          pending.promise.resolve(savePages(result, pending))
        } catch (e: Exception) {
          pending.promise.reject(VisionFailedException(e.message))
        }
      }
    }
  }

  private fun recognizerFor(code: String): TextRecognizer? {
    val lang = code.substringBefore('-')
    return when {
      // Other languages are recognized by JS using PP-OCRv6 (D-269), bypassing ML Kit.
      lang == "ko" -> TextRecognition.getClient(KoreanTextRecognizerOptions.Builder().build())
      else -> null
    }
  }

  private fun savePages(result: GmsDocumentScanningResult, pending: PendingScan): List<Map<String, Any>> {
    pending.directory.mkdirs()
    return (result.pages ?: emptyList()).mapIndexed { i, page ->
      val bitmap = decodeScaled(page.imageUri, pending.maxSide)
      val file = File(pending.directory, "page-${i + 1}.jpg")
      FileOutputStream(file).use {
        bitmap.compress(Bitmap.CompressFormat.JPEG, (pending.quality * 100).roundToInt(), it)
      }
      val saved = mapOf(
        "uri" to Uri.fromFile(file).toString(),
        "width" to bitmap.width,
        "height" to bitmap.height,
        "size" to file.length().toInt(),
      )
      bitmap.recycle()
      saved
    }
  }

  /** Decode by first scaling down by powers of 2 (saving memory), then precisely scaling to maxSide on the long side. */
  private fun decodeScaled(uri: Uri, maxSide: Int): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    val decoded = context.contentResolver.openInputStream(uri).use {
      BitmapFactory.decodeStream(it, null, options)
    } ?: throw VisionFailedException("could not decode page")
    val side = max(decoded.width, decoded.height)
    if (side <= maxSide) return decoded
    val k = maxSide.toDouble() / side
    val scaled = Bitmap.createScaledBitmap(
      decoded, (decoded.width * k).roundToInt(), (decoded.height * k).roundToInt(), true,
    )
    decoded.recycle()
    return scaled
  }
}

private class TextLine(val text: String, val box: Rect)

/**
 * Layout matches iOS: segments at the same height (such as item name and price on a receipt) are
 * placed on the same line and separated by spaces; leaves a blank line when line spacing
 * increases significantly. ML Kit's coordinate origin is at the top-left, where larger y means
 * further down.
 */
private fun layout(lines: List<TextLine>): String {
  val sorted = lines.sortedBy { it.box.exactCenterY() }
  val rows = mutableListOf<MutableList<TextLine>>()
  for (line in sorted) {
    val first = rows.lastOrNull()?.firstOrNull()
    if (first != null) {
      val overlap = min(first.box.bottom, line.box.bottom) - max(first.box.top, line.box.top)
      if (overlap >= 0.5 * min(first.box.height(), line.box.height())) {
        rows.last().add(line)
        continue
      }
    }
    rows.add(mutableListOf(line))
  }
  val heights = sorted.map { it.box.height() }.sorted()
  val typical = if (heights.isEmpty()) 0 else heights[heights.size / 2]
  val out = mutableListOf<String>()
  var previousBottom: Int? = null
  for (row in rows) {
    out.add(row.sortedBy { it.box.left }.joinToString(" ") { it.text }.let { text ->
      val top = row.minOf { it.box.top }
      val prev = previousBottom
      previousBottom = row.maxOf { it.box.bottom }
      if (prev != null && top - prev > 1.2 * typical) "\n$text" else text
    })
  }
  return out.joinToString("\n")
}

/** file:// URI or path -> File. */
private fun fileOf(uri: String): File = File(Uri.parse(uri).path ?: uri)
