package expo.modules.morphtts

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

// WAV reading and joining (D-270): TextToSpeech.synthesizeToFile writes a 16-bit PCM WAV for each
// segment, which are concatenated in order here. Only supports PCM (format 1); requires matching
// formats across segments of the same audio, otherwise throws an error (prevents silent mixing that
// alters pitch). Pure Kotlin, Android-independent; tests located in src/test/…/WavTest.kt.

/** Format and data position of a WAV file. */
data class WavInfo(
  val channels: Int,
  val sampleRate: Int,
  val bitsPerSample: Int,
  val dataOffset: Long,
  val dataSize: Long,
) {
  val bytesPerSecond: Long get() = sampleRate.toLong() * channels * (bitsPerSample / 8)
  val durationMs: Double get() = if (bytesPerSecond == 0L) 0.0 else dataSize * 1000.0 / bytesPerSecond
  fun sameFormat(other: WavInfo) =
    channels == other.channels && sampleRate == other.sampleRate && bitsPerSample == other.bitsPerSample
}

object Wav {
  private const val HEADER_BYTES = 44

  /** Read RIFF chunks to locate fmt and data. Some engines write incrementally, leaving data length as 0 or 0xFFFFFFFF, in which case file length is used. */
  fun read(file: File): WavInfo = RandomAccessFile(file, "r").use { raf ->
    val length = raf.length()
    if (length < 12) throw IOException("not a WAV: too short")
    val head = ByteArray(12)
    raf.readFully(head)
    if (String(head, 0, 4, Charsets.US_ASCII) != "RIFF" || String(head, 8, 4, Charsets.US_ASCII) != "WAVE") {
      throw IOException("not a WAV")
    }
    var channels = 0
    var sampleRate = 0
    var bits = 0
    var pos = 12L
    val chunk = ByteArray(8)
    while (pos + 8 <= length) {
      raf.seek(pos)
      raf.readFully(chunk)
      val id = String(chunk, 0, 4, Charsets.US_ASCII)
      val size = ByteBuffer.wrap(chunk, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xFFFFFFFFL
      val body = pos + 8
      when (id) {
        "fmt " -> {
          val fmt = ByteArray(16)
          raf.readFully(fmt)
          val b = ByteBuffer.wrap(fmt).order(ByteOrder.LITTLE_ENDIAN)
          val format = b.short.toInt() and 0xFFFF
          channels = b.short.toInt() and 0xFFFF
          sampleRate = b.int
          b.int // byteRate
          b.short // blockAlign
          bits = b.short.toInt() and 0xFFFF
          // 1 = PCM; 0xFFFE = WAVE_FORMAT_EXTENSIBLE (can also be joined if it contains PCM).
          if (format != 1 && format != 0xFFFE) throw IOException("not PCM: $format")
        }
        "data" -> {
          if (channels == 0) throw IOException("data before fmt")
          val rest = length - body
          val dataSize = if (size == 0L || size > rest) rest else size
          return WavInfo(channels, sampleRate, bits, body, dataSize)
        }
      }
      pos = body + size + (size and 1L)
    }
    throw IOException("no data chunk")
  }

  /** Standard 44-byte PCM header. */
  fun header(channels: Int, sampleRate: Int, bitsPerSample: Int, dataSize: Long): ByteArray {
    val blockAlign = channels * (bitsPerSample / 8)
    return ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray(Charsets.US_ASCII))
      putInt((36 + dataSize).toInt())
      put("WAVE".toByteArray(Charsets.US_ASCII))
      put("fmt ".toByteArray(Charsets.US_ASCII))
      putInt(16)
      putShort(1)
      putShort(channels.toShort())
      putInt(sampleRate)
      putInt(sampleRate * blockAlign)
      putShort(blockAlign.toShort())
      putShort(bitsPerSample.toShort())
      put("data".toByteArray(Charsets.US_ASCII))
      putInt(dataSize.toInt())
    }.array()
  }

  /**
   * Concatenate into output in order (overwriting existing files); returns the format of the
   * result. Checks cancellation every 1 MB copied. On error, output is not deleted; deletion is
   * left to the caller (which must also delete it on cancellation).
   */
  fun join(inputs: List<File>, output: File, isCancelled: () -> Boolean = { false }): WavInfo {
    if (inputs.isEmpty()) throw IOException("nothing to join")
    val infos = inputs.map { read(it) }
    val first = infos.first()
    infos.forEachIndexed { i, info ->
      if (!info.sameFormat(first)) throw IOException("segment $i has a different format")
    }
    val total = infos.sumOf { it.dataSize }
    // WAV length field is 32-bit: cannot write files over 4 GB (TTS reads at most a few hundred MB, so it never reaches this limit).
    if (total + 36 > 0xFFFFFFFFL) throw IOException("too long for a WAV")
    output.parentFile?.mkdirs()
    FileOutputStream(output).use { out ->
      out.write(header(first.channels, first.sampleRate, first.bitsPerSample, total))
      val buffer = ByteArray(1 shl 20)
      inputs.zip(infos).forEach { (file, info) ->
        RandomAccessFile(file, "r").use { raf ->
          raf.seek(info.dataOffset)
          var left = info.dataSize
          while (left > 0) {
            if (isCancelled()) throw InterruptedException("cancelled")
            val n = raf.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
            if (n < 0) break
            out.write(buffer, 0, n)
            left -= n
          }
        }
      }
    }
    return first.copy(dataOffset = HEADER_BYTES.toLong(), dataSize = total)
  }
}
