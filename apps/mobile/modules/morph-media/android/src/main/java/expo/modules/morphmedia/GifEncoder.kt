package expo.modules.morphmedia

import java.io.OutputStream

// Animated GIF encoder (D-184): Android system lacks a GIF encoder, so we write our own without
// introducing third-party libraries. Each frame has its own 256-color palette (median cut), 4x4
// ordered dithering to reduce banding, LZW compression, and loop playback. Uses only ARGB pixel
// arrays without touching Android classes, allowing testing on the desktop JVM (GifEncoderTest).

class GifEncoder(
  private val out: OutputStream,
  private val width: Int,
  private val height: Int,
) {
  private var started = false
  private val lzw = Lzw()

  /** Add a frame: pixels is width × height ARGB values (alpha ignored), delayMs is the display duration for this frame. */
  fun addFrame(pixels: IntArray, delayMs: Int) {
    require(pixels.size == width * height) { "frame size" }
    if (!started) writeHeader()
    val palette = Palette.of(pixels)
    val indices = palette.map(pixels, width)
    // Graphics Control Extension: delay time (hundredths of a second), opaque.
    val delay = ((delayMs + 5) / 10).coerceIn(2, 65535)
    out.write(byteArrayOf(0x21, 0xF9.toByte(), 4, 0x04, (delay and 0xFF).toByte(), (delay shr 8).toByte(), 0, 0))
    // Image Descriptor: full canvas, with a local 256-color palette.
    out.write(0x2C)
    writeShort(0)
    writeShort(0)
    writeShort(width)
    writeShort(height)
    out.write(0x87)
    out.write(palette.rgb)
    lzw.encode(indices, out)
  }

  fun finish() {
    out.write(0x3B)
    out.flush()
  }

  private fun writeHeader() {
    started = true
    out.write("GIF89a".toByteArray(Charsets.US_ASCII))
    writeShort(width)
    writeShort(height)
    out.write(byteArrayOf(0x70, 0, 0)) // No global palette
    // NETSCAPE2.0: infinite loop.
    out.write(byteArrayOf(0x21, 0xFF.toByte(), 0x0B))
    out.write("NETSCAPE2.0".toByteArray(Charsets.US_ASCII))
    out.write(byteArrayOf(3, 1, 0, 0, 0))
  }

  private fun writeShort(value: Int) {
    out.write(value and 0xFF)
    out.write((value shr 8) and 0xFF)
  }
}

/** Single-frame palette: median cut, divided using a histogram with 5 bits per channel (32,768 colors). */
internal class Palette private constructor(
  /** 256 × 3 bytes (padded with 0s if fewer than 256 colors). */
  val rgb: ByteArray,
  /** 5-bit RGB -> palette index. */
  private val lookup: ByteArray,
) {
  /** Pixel -> palette index, with 4x4 ordered dithering added (scaled to a 5-bit grid step size). */
  fun map(pixels: IntArray, width: Int): ByteArray {
    val indices = ByteArray(pixels.size)
    for (i in pixels.indices) {
      val p = pixels[i]
      val d = BAYER[((i / width) and 3) * 4 + ((i % width) and 3)]
      val r = (((p shr 16) and 0xFF) + d).coerceIn(0, 255) shr 3
      val g = (((p shr 8) and 0xFF) + d).coerceIn(0, 255) shr 3
      val b = ((p and 0xFF) + d).coerceIn(0, 255) shr 3
      indices[i] = lookup[(r shl 10) or (g shl 5) or b]
    }
    return indices
  }

  companion object {
    /** 4x4 Bayer matrix, converted to -4..+3 (one step on a 5-bit grid is 8). */
    private val BAYER = intArrayOf(0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5).map { it / 2 - 4 }.toIntArray()

    fun of(pixels: IntArray): Palette {
      val counts = IntArray(32768)
      for (p in pixels) counts[(((p shr 19) and 31) shl 10) or (((p shr 11) and 31) shl 5) or ((p shr 3) and 31)]++
      val colors = counts.indices.filter { counts[it] > 0 }.toIntArray()
      val boxes = ArrayList<IntArray>()
      boxes.add(colors)
      // Each step splits the box with the largest dimension ("span of dimension with most colors × pixel count") along that dimension at the median, until 256 boxes are reached.
      while (boxes.size < 256) {
        var best = -1
        var bestScore = 0L
        var bestAxis = 0
        for ((i, box) in boxes.withIndex()) {
          if (box.size < 2) continue
          val (axis, span) = widestAxis(box)
          if (span == 0) continue
          var pixelsIn = 0L
          for (c in box) pixelsIn += counts[c]
          val score = span.toLong() * pixelsIn
          if (score > bestScore) {
            bestScore = score
            best = i
            bestAxis = axis
          }
        }
        if (best < 0) break
        val box = boxes[best].sortedBy { channel(it, bestAxis) }.toIntArray()
        var total = 0L
        for (c in box) total += counts[c]
        var acc = 0L
        var cut = 1
        for (k in box.indices) {
          acc += counts[box[k]]
          if (acc * 2 >= total) {
            cut = (k + 1).coerceIn(1, box.size - 1)
            break
          }
        }
        boxes[best] = box.copyOfRange(0, cut)
        boxes.add(box.copyOfRange(cut, box.size))
      }
      val rgb = ByteArray(256 * 3)
      val lookup = ByteArray(32768)
      for ((i, box) in boxes.withIndex()) {
        // Box color = average weighted by pixel count (converted back to 8 bits).
        var r = 0L
        var g = 0L
        var b = 0L
        var n = 0L
        for (c in box) {
          val w = counts[c].toLong()
          r += channel(c, 0) * w
          g += channel(c, 1) * w
          b += channel(c, 2) * w
          n += w
        }
        rgb[i * 3] = ((r * 8 + n * 4) / n).coerceAtMost(255).toByte()
        rgb[i * 3 + 1] = ((g * 8 + n * 4) / n).coerceAtMost(255).toByte()
        rgb[i * 3 + 2] = ((b * 8 + n * 4) / n).coerceAtMost(255).toByte()
        for (c in box) lookup[c] = i.toByte()
      }
      // Dithering may land on colors not present in this frame: these colors find the nearest palette color.
      val used = boxes.size
      for (c in 0 until 32768) {
        if (counts[c] > 0) continue
        val r = channel(c, 0) * 8 + 4
        val g = channel(c, 1) * 8 + 4
        val b = channel(c, 2) * 8 + 4
        var best = 0
        var bestDist = Int.MAX_VALUE
        for (i in 0 until used) {
          val dr = r - (rgb[i * 3].toInt() and 0xFF)
          val dg = g - (rgb[i * 3 + 1].toInt() and 0xFF)
          val db = b - (rgb[i * 3 + 2].toInt() and 0xFF)
          val dist = dr * dr * 2 + dg * dg * 4 + db * db
          if (dist < bestDist) {
            bestDist = dist
            best = i
          }
        }
        lookup[c] = best.toByte()
      }
      return Palette(rgb, lookup)
    }

    private fun channel(color: Int, axis: Int) = (color shr (10 - axis * 5)) and 31

    private fun widestAxis(box: IntArray): Pair<Int, Int> {
      var axis = 0
      var span = -1
      for (a in 0..2) {
        var lo = 31
        var hi = 0
        for (c in box) {
          val v = channel(c, a)
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        if (hi - lo > span) {
          span = hi - lo
          axis = a
        }
      }
      return axis to span
    }
  }
}

/**
 * GIF LZW: 8-bit minimum code length, sends a clear code to restart when the code table reaches
 * 4096; output is split into data blocks of at most 255 bytes. One code table (4 MB) per encoder,
 * clearing only used slots per frame and per clear operation.
 */
internal class Lzw {
  private companion object {
    const val CLEAR = 256
    const val END = 257
    const val MAX_CODES = 4096
  }

  /** (prefix code << 8 | next byte) -> code; 0 indicates none. */
  private val table = IntArray(MAX_CODES shl 8)
  private val used = IntArray(MAX_CODES)
  private var usedCount = 0

  private fun clearTable() {
    for (u in 0 until usedCount) table[used[u]] = 0
    usedCount = 0
  }

  fun encode(indices: ByteArray, out: OutputStream) {
    out.write(8)
    val bits = BlockWriter(out)
    clearTable()
    var codeSize = 9
    var next = END + 1
    bits.write(CLEAR, codeSize)
    if (indices.isEmpty()) {
      bits.write(END, codeSize)
      bits.finish()
      return
    }
    var prefix = indices[0].toInt() and 0xFF
    for (i in 1 until indices.size) {
      val k = indices[i].toInt() and 0xFF
      val key = (prefix shl 8) or k
      val code = table[key]
      if (code != 0) {
        prefix = code
        continue
      }
      bits.write(prefix, codeSize)
      if (next < MAX_CODES) {
        table[key] = next
        used[usedCount++] = key
        // Decoder adds this entry before reading the next code: increases code length by 1 when the next code table entry reaches 2^codeSize.
        if (next == (1 shl codeSize) && codeSize < 12) codeSize++
        next++
      } else {
        bits.write(CLEAR, codeSize)
        clearTable()
        codeSize = 9
        next = END + 1
      }
      prefix = k
    }
    bits.write(prefix, codeSize)
    bits.write(END, codeSize)
    bits.finish()
  }

  /** Packs codes from lower bits, writes a data block when 255 bytes are full. */
  private class BlockWriter(private val out: OutputStream) {
    private val block = ByteArray(255)
    private var size = 0
    private var acc = 0L
    private var count = 0

    fun write(code: Int, bits: Int) {
      acc = acc or (code.toLong() shl count)
      count += bits
      while (count >= 8) {
        put((acc and 0xFF).toInt())
        acc = acc ushr 8
        count -= 8
      }
    }

    fun finish() {
      if (count > 0) put((acc and 0xFF).toInt())
      if (size > 0) flushBlock()
      out.write(0)
    }

    private fun put(byte: Int) {
      block[size++] = byte.toByte()
      if (size == 255) flushBlock()
    }

    private fun flushBlock() {
      out.write(size)
      out.write(block, 0, size)
      size = 0
    }
  }
}
