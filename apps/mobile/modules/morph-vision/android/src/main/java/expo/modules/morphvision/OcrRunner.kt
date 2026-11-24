package expo.modules.morphvision

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import kotlin.math.roundToInt

// Text recognition model (PP-OCRv6, D-269) runs only here: inputs and outputs use temporary files
// for the current run (a few MB to tens of MB, avoiding parameter conversion between JS and
// native). Pre- and post-processing are in JS (@morph/tool-ocr), and only ONNX Runtime runs here.
// Finding text lines: inputs [1, 3, h, w] float32, outputs probability × 255 per pixel (1 byte).
// Recognizing text: inputs [n, 3, 48, w], outputs the highest-probability category index (int32)
// and probability (float32) for each sequence step, arranged as [n, steps].
object OcrRunner {
  private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
  private var loaded: Pair<String, String>? = null
  private var det: OrtSession? = null
  private var rec: OrtSession? = null

  @Synchronized
  fun load(detPath: String, recPath: String) {
    if (loaded == detPath to recPath) return
    unload()
    val options = OrtSession.SessionOptions().apply {
      setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(1, 4))
    }
    det = env.createSession(detPath, options)
    rec = env.createSession(recPath, options)
    loaded = detPath to recPath
  }

  @Synchronized
  fun unload() {
    det?.close()
    rec?.close()
    det = null
    rec = null
    loaded = null
  }

  /** Read a float32 file (little-endian, same as JS Float32Array). */
  private fun readFloats(file: File, count: Long): ByteBuffer {
    require(file.length() == count * 4) { "input has ${file.length()} bytes, expected ${count * 4}" }
    return RandomAccessFile(file, "r").use { raf ->
      raf.channel.map(FileChannel.MapMode.READ_ONLY, 0, count * 4).order(ByteOrder.LITTLE_ENDIAN)
    }
  }

  @Synchronized
  fun detect(input: File, width: Int, height: Int, output: File) {
    val session = det ?: throw IllegalStateException("models not loaded")
    val shape = longArrayOf(1, 3, height.toLong(), width.toLong())
    val buffer = readFloats(input, 3L * width * height)
    OnnxTensor.createTensor(env, buffer.asFloatBuffer(), shape).use { tensor ->
      session.run(mapOf(session.inputNames.first() to tensor)).use { result ->
        val prob = (result[0] as OnnxTensor).floatBuffer
        val bytes = ByteArray(width * height)
        for (i in bytes.indices) bytes[i] = (prob.get(i).coerceIn(0f, 1f) * 255f).roundToInt().toByte()
        output.writeBytes(bytes)
      }
    }
  }

  /** Returns the number of time steps. */
  @Synchronized
  fun recognize(input: File, count: Int, width: Int, output: File): Int {
    val session = rec ?: throw IllegalStateException("models not loaded")
    val shape = longArrayOf(count.toLong(), 3, 48, width.toLong())
    val buffer = readFloats(input, 3L * 48 * width * count)
    OnnxTensor.createTensor(env, buffer.asFloatBuffer(), shape).use { tensor ->
      session.run(mapOf(session.inputNames.first() to tensor)).use { result ->
        val out = result[0] as OnnxTensor
        val dims = out.info.shape
        val steps = dims[1].toInt()
        val classes = dims[2].toInt()
        val probs = out.floatBuffer
        // First count × steps int32 categories, followed by count × steps float32 probabilities.
        val packed = ByteBuffer.allocate(count * steps * 8).order(ByteOrder.LITTLE_ENDIAN)
        val best = IntArray(count * steps)
        val bestProb = FloatArray(count * steps)
        for (r in 0 until count * steps) {
          var k = 0
          var p = probs.get(r * classes)
          for (c in 1 until classes) {
            val v = probs.get(r * classes + c)
            if (v > p) {
              p = v
              k = c
            }
          }
          best[r] = k
          bestProb[r] = p
        }
        for (k in best) packed.putInt(k)
        for (p in bestProb) packed.putFloat(p)
        output.writeBytes(packed.array())
        return steps
      }
    }
  }
}
