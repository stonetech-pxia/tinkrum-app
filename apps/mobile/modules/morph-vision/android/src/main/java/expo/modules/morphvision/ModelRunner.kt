package expo.modules.morphvision

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel

// Runs an ONNX model with a single float32 input and a single float32 output (D-274: scanning
// flattened UVDoc mesh models), matching iOS's ModelRunner.swift: both inputs and outputs use
// temporary files from the current run (little-endian float32), with pre- and post-processing
// handled in JS. Models are cached by path (only one kept at a time, releasing the old one when
// switching).
object ModelRunner {
  private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
  private var loaded: String? = null
  private var session: OrtSession? = null

  /** Returns output shape; writes output as a float32 file. */
  @Synchronized
  fun run(model: String, input: File, shape: LongArray, output: File): List<Long> {
    if (loaded != model || session == null) {
      unload()
      val options = OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(1, 4))
      }
      session = env.createSession(model, options)
      loaded = model
    }
    val s = session ?: throw IllegalStateException("model not loaded")
    val count = shape.fold(1L) { a, b -> a * b }
    require(input.length() == count * 4) { "input has ${input.length()} bytes, expected ${count * 4}" }
    val buffer = RandomAccessFile(input, "r").use { raf ->
      raf.channel.map(FileChannel.MapMode.READ_ONLY, 0, count * 4).order(ByteOrder.LITTLE_ENDIAN)
    }
    OnnxTensor.createTensor(env, buffer.asFloatBuffer(), shape).use { tensor ->
      s.run(mapOf(s.inputNames.first() to tensor)).use { result ->
        val out = result[0] as OnnxTensor
        val floats = out.floatBuffer
        val bytes = ByteBuffer.allocate(floats.remaining() * 4).order(ByteOrder.LITTLE_ENDIAN)
        bytes.asFloatBuffer().put(floats)
        output.writeBytes(bytes.array())
        return out.info.shape.toList()
      }
    }
  }

  @Synchronized
  fun unload() {
    session?.close()
    session = null
    loaded = null
  }
}
