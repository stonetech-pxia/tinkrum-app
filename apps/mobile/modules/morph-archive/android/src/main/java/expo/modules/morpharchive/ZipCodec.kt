package expo.modules.morpharchive

import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Deflater
import java.util.zip.Inflater

// ZIP read/write (D-600), independent of Android and Expo, can be compiled and tested separately.
// Follows the same rules as iOS's ios/ZipCodec.swift:
// - Write: read-as-you-write, without reading files into memory; use Zip64 when a single file or
// the entire archive exceeds 4 GB. Already compressed files (photos, videos, PDFs, etc.) are stored
// without recompression; only databases and text are compressed. Backpatch the local header's
// checksum and size after writing each file, so data descriptors are not needed. Avoid
// java.util.zip.ZipOutputStream / ZipFile, as their Zip64 support varies across Android versions;
// use only Deflater, Inflater, and CRC32 here.
// - Read: read the central directory first and check each entry (name, symbolic links, encryption,
// compression method, size) one by one, unpacking only if all pass; count bytes as you decompress,
// stopping if it exceeds the declared size (zip bomb protection), and finally verify the checksum.
// Completely reject archives with unsafe names or symbolic links.

sealed class ZipFail(message: String) : Exception(message) {
  object Cancelled : ZipFail("cancelled")
  object NotZip : ZipFail("not a zip")
  class Damaged(detail: String) : ZipFail(detail)
  class Unsupported(detail: String) : ZipFail(detail)
  class Unsafe(detail: String) : ZipFail(detail)
  object NoSpace : ZipFail("no space")
  class Io(detail: String) : ZipFail(detail)
}

const val ZIP_CHUNK = 1 shl 20
const val ZIP_MAX_ENTRIES = 2_000_000L
const val ZIP_MAX_CENTRAL = 1L shl 29
const val ZIP_MAX_NAME = 4096
/** Single files smaller than this do not need Zip64 (leaves margin so that slightly larger compressed output still stays under 4 GB). */
const val ZIP_BIG_FILE = 0xF000_0000L
private const val U32 = 0xFFFF_FFFFL

/** Files that are already in a compressed format: store only, do not compress. */
val ZIP_STORED_EXTENSIONS = setOf(
  "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "avif", "jp2",
  "mp4", "mov", "m4v", "m4a", "mp3", "aac", "opus", "ogg", "flac", "webm", "mkv",
  "pdf", "zip", "docx", "xlsx", "pptx", "gz", "7z",
)

fun zipShouldStore(name: String): Boolean {
  val dot = name.lastIndexOf('.')
  if (dot < 0 || name.lastIndexOf('/') > dot) return false
  return ZIP_STORED_EXTENSIONS.contains(name.substring(dot + 1).lowercase())
}

/** Whether a name is valid: allows only relative paths, no .. or ., no empty segments, no backslashes, no drive letters. */
fun zipSafeName(raw: String): Boolean {
  if (raw.isEmpty() || raw.toByteArray(Charsets.UTF_8).size > ZIP_MAX_NAME) return false
  if (raw.contains('\u0000') || raw.contains('\\') || raw.startsWith("/")) return false
  if (raw.length >= 2 && raw[1] == ':' && raw[0].isLetter()) return false
  val parts = raw.split('/').toMutableList()
  if (parts.last().isEmpty()) parts.removeAt(parts.size - 1) // Trailing slash for directory entries
  if (parts.isEmpty()) return false
  return parts.none { it.isEmpty() || it == "." || it == ".." }
}

private class Le {
  companion object {
    fun u16(b: ByteArray, o: Int): Int = (b[o].toInt() and 0xFF) or ((b[o + 1].toInt() and 0xFF) shl 8)
    fun u32(b: ByteArray, o: Int): Long = u16(b, o).toLong() or (u16(b, o + 2).toLong() shl 16)
    fun u64(b: ByteArray, o: Int): Long = u32(b, o) or (u32(b, o + 4) shl 32)
  }
}

private class Out {
  private val bytes = java.io.ByteArrayOutputStream()
  fun u16(v: Int) = apply { bytes.write(v and 0xFF); bytes.write((v shr 8) and 0xFF) }
  fun u32(v: Long) = apply { for (i in 0 until 4) bytes.write(((v shr (8 * i)) and 0xFF).toInt()) }
  fun u64(v: Long) = apply { for (i in 0 until 8) bytes.write(((v shr (8 * i)) and 0xFF).toInt()) }
  fun raw(b: ByteArray) = apply { bytes.write(b) }
  fun toByteArray(): ByteArray = bytes.toByteArray()
}

private fun mapWrite(e: IOException): ZipFail =
  if ((e.message ?: "").contains("ENOSPC") || (e.message ?: "").contains("No space left")) ZipFail.NoSpace
  else ZipFail.Io(e.message ?: "write")

private fun dosDateTime(millis: Long): Pair<Int, Int> {
  val c = java.util.Calendar.getInstance().apply { timeInMillis = millis }
  val year = c.get(java.util.Calendar.YEAR).coerceIn(1980, 2107)
  val time = (c.get(java.util.Calendar.HOUR_OF_DAY) shl 11) or (c.get(java.util.Calendar.MINUTE) shl 5) or
    (c.get(java.util.Calendar.SECOND) / 2)
  val date = ((year - 1980) shl 9) or ((c.get(java.util.Calendar.MONTH) + 1) shl 5) or c.get(java.util.Calendar.DAY_OF_MONTH)
  return Pair(time, date)
}

// MARK: - Write

private class Central(
  val name: String,
  val method: Int,
  val crc: Long,
  val compressed: Long,
  val size: Long,
  val offset: Long,
  val time: Int,
  val date: Int,
  val local64: Boolean,
)

class ZipWriter(path: String, private val forceZip64: Boolean = false) {
  private val file = RandomAccessFile(path, "rw").also { it.setLength(0) }
  private val buffer = ByteArray(ZIP_CHUNK)
  private var buffered = 0
  /** Number of bytes already written (including buffered ones). */
  var offset = 0L
    private set
  private val central = ArrayList<Central>()
  /** Original raw bytes written into the archive (for progress reporting). */
  var inputBytes = 0L
    private set

  private fun flush() {
    if (buffered == 0) return
    try {
      file.write(buffer, 0, buffered)
    } catch (e: IOException) {
      throw mapWrite(e)
    }
    buffered = 0
  }

  private fun write(data: ByteArray, off: Int = 0, len: Int = data.size) {
    var at = off
    var left = len
    while (left > 0) {
      if (buffered == buffer.size) flush()
      val n = minOf(left, buffer.size - buffered)
      System.arraycopy(data, at, buffer, buffered, n)
      buffered += n
      at += n
      left -= n
    }
    offset += len
  }

  /** Write a file into the archive. read reads the next chunk into buf each time, returning the byte count (-1 indicates end). */
  fun add(
    name: String, declared: Long, modified: Long, store: Boolean,
    read: (ByteArray) -> Int, shouldCancel: () -> Boolean, progress: (Long) -> Unit,
  ) {
    val nameBytes = name.toByteArray(Charsets.UTF_8)
    if (nameBytes.size > ZIP_MAX_NAME) throw ZipFail.Unsafe("name length")
    val local64 = forceZip64 || declared >= ZIP_BIG_FILE
    val (time, date) = dosDateTime(modified)
    val start = offset
    val header = Out().u32(0x0403_4b50).u16(if (local64) 45 else 20).u16(0x0800).u16(if (store) 0 else 8)
      .u16(time).u16(date).u32(0).u32(if (local64) U32 else 0).u32(if (local64) U32 else 0)
      .u16(nameBytes.size).u16(if (local64) 20 else 0).raw(nameBytes)
    if (local64) header.u16(1).u16(16).u64(0).u64(0)
    write(header.toByteArray())

    val crc = CRC32()
    var size = 0L
    var packed = 0L
    val deflater = if (store) null else Deflater(Deflater.DEFAULT_COMPRESSION, true)
    val out = ByteArray(1 shl 18)
    fun drain(finish: Boolean) {
      val d = deflater ?: return
      while (true) {
        val n = d.deflate(out)
        if (n > 0) {
          write(out, 0, n)
          packed += n
        }
        if (finish) {
          if (d.finished() || n == 0) break
        } else if (n == 0) {
          break
        }
      }
    }
    try {
      val chunk = ByteArray(ZIP_CHUNK)
      while (true) {
        if (shouldCancel()) throw ZipFail.Cancelled
        val n = read(chunk)
        if (n <= 0) break
        crc.update(chunk, 0, n)
        size += n
        inputBytes += n
        if (deflater != null) {
          deflater.setInput(chunk, 0, n)
          drain(false)
        } else {
          write(chunk, 0, n)
          packed += n
        }
        progress(inputBytes)
      }
      if (deflater != null) {
        deflater.finish()
        drain(true)
      }
    } finally {
      deflater?.end()
    }

    // Backpatch the checksum and size in the local header.
    if (size >= U32 && !local64) throw ZipFail.Io("file grew while writing")
    flush()
    val end = offset
    try {
      file.seek(start + 14)
      val patch = Out().u32(crc.value)
      if (local64) patch.u32(U32).u32(U32) else patch.u32(packed).u32(size)
      file.write(patch.toByteArray())
      if (local64) {
        file.seek(start + 30 + nameBytes.size + 4)
        file.write(Out().u64(size).u64(packed).toByteArray())
      }
      file.seek(end)
    } catch (e: IOException) {
      throw mapWrite(e)
    }
    central.add(Central(name, if (store) 0 else 8, crc.value, packed, size, start, time, date, local64))
  }

  fun addBytes(name: String, bytes: ByteArray, modified: Long, shouldCancel: () -> Boolean) {
    require(bytes.size <= ZIP_CHUNK)
    var given = false
    add(name, bytes.size.toLong(), modified, false, { buf ->
      if (given) -1 else {
        given = true
        // Small text blocks (manifest) supplied all at once.
        System.arraycopy(bytes, 0, buf, 0, minOf(bytes.size, buf.size))
        bytes.size
      }
    }, shouldCancel) { }
  }

  /** Write the central directory and end record, then close the file. */
  fun finish() {
    val cdStart = offset
    for (e in central) {
      val nameBytes = e.name.toByteArray(Charsets.UTF_8)
      val big = e.local64 || e.size >= U32 || e.compressed >= U32 || forceZip64
      val bigOffset = e.offset >= U32 || forceZip64
      val extra = Out()
      if (big || bigOffset) {
        val body = Out()
        if (big) body.u64(e.size).u64(e.compressed)
        if (bigOffset) body.u64(e.offset)
        val b = body.toByteArray()
        extra.u16(1).u16(b.size).raw(b)
      }
      val extraBytes = extra.toByteArray()
      val rec = Out().u32(0x0201_4b50).u16((3 shl 8) or 45).u16(if (big || bigOffset) 45 else 20).u16(0x0800)
        .u16(e.method).u16(e.time).u16(e.date).u32(e.crc)
        .u32(if (big) U32 else e.compressed).u32(if (big) U32 else e.size)
        .u16(nameBytes.size).u16(extraBytes.size).u16(0).u16(0).u16(0)
        .u32(0x81A4L shl 16) // 0o100644
        .u32(if (bigOffset) U32 else e.offset)
        .raw(nameBytes).raw(extraBytes)
      write(rec.toByteArray())
    }
    val cdSize = offset - cdStart
    val count = central.size.toLong()
    val needs64 = forceZip64 || count >= 0xFFFF || cdStart >= U32 || cdSize >= U32
    val tail = Out()
    if (needs64) {
      val eocd64 = offset
      tail.u32(0x0606_4b50).u64(44).u16((3 shl 8) or 45).u16(45).u32(0).u32(0)
        .u64(count).u64(count).u64(cdSize).u64(cdStart)
        .u32(0x0706_4b50).u32(0).u64(eocd64).u32(1)
    }
    tail.u32(0x0605_4b50).u16(0).u16(0)
      .u16(if (needs64) 0xFFFF else count.toInt()).u16(if (needs64) 0xFFFF else count.toInt())
      .u32(if (needs64) U32 else cdSize).u32(if (needs64) U32 else cdStart).u16(0)
    write(tail.toByteArray())
    flush()
    try {
      file.fd.sync()
      file.close()
    } catch (e: IOException) {
      throw mapWrite(e)
    }
  }

  fun abort() {
    try {
      file.close()
    } catch (_: IOException) {
    }
  }
}

// MARK: - Read

/** Archive source: must support random reading (local file, or seekable content:// file descriptor). */
class ZipSource(private val channel: FileChannel, private val onClose: () -> Unit = {}) {
  val length: Long = channel.size()

  fun readAt(position: Long, count: Int): ByteArray {
    if (count == 0) return ByteArray(0)
    if (position < 0 || position > length || count.toLong() > length - position) throw ZipFail.Damaged("truncated")
    val buf = ByteBuffer.allocate(count)
    var at = position
    try {
      while (buf.hasRemaining()) {
        val n = channel.read(buf, at)
        if (n < 0) throw ZipFail.Damaged("truncated")
        at += n
      }
    } catch (e: IOException) {
      throw ZipFail.Io(e.message ?: "read")
    }
    return buf.array()
  }

  fun close() {
    try {
      channel.close()
    } catch (_: IOException) {
    }
    onClose()
  }
}

class ZipEntry(val name: String, val method: Int, val crc: Long, val compressed: Long, val size: Long, val offset: Long)

class ZipReader(private val source: ZipSource) {
  var entries: List<ZipEntry> = emptyList()
    private set
  private var dataEnd = 0L

  fun close() = source.close()

  /** Read the central directory and validate every entry. Reject the entire archive if any entry fails validation. */
  fun load() {
    val length = source.length
    if (length < 22) throw ZipFail.NotZip
    val tailLength = minOf(length, 65_557L).toInt()
    val tail = source.readAt(length - tailLength, tailLength)
    var eocd = -1
    var i = tailLength - 22
    while (i >= 0) {
      if (Le.u32(tail, i) == 0x0605_4b50L && i + 22 + Le.u16(tail, i + 20) == tailLength) {
        eocd = i
        break
      }
      i--
    }
    if (eocd < 0) throw ZipFail.NotZip
    var total = Le.u16(tail, eocd + 10).toLong()
    var cdSize = Le.u32(tail, eocd + 12)
    var cdOffset = Le.u32(tail, eocd + 16)
    if (Le.u16(tail, eocd + 4) != 0 || Le.u16(tail, eocd + 6) != 0) throw ZipFail.Unsupported("multi-disk")
    val eocdPosition = length - tailLength + eocd
    if (total == 0xFFFFL || cdSize == U32 || cdOffset == U32) {
      if (eocdPosition < 20) throw ZipFail.Damaged("zip64 locator")
      val locator = source.readAt(eocdPosition - 20, 20)
      if (Le.u32(locator, 0) != 0x0706_4b50L) throw ZipFail.Damaged("zip64 locator")
      val at = Le.u64(locator, 8)
      val record = source.readAt(at, 56)
      if (Le.u32(record, 0) != 0x0606_4b50L) throw ZipFail.Damaged("zip64 record")
      total = Le.u64(record, 32)
      cdSize = Le.u64(record, 40)
      cdOffset = Le.u64(record, 48)
    }
    if (total < 0 || total > ZIP_MAX_ENTRIES || cdSize < 0 || cdSize > ZIP_MAX_CENTRAL) throw ZipFail.Unsafe("too many entries")
    if (cdOffset < 0 || cdOffset > length || cdSize > length - cdOffset) throw ZipFail.Damaged("central directory")
    dataEnd = cdOffset
    val cd = source.readAt(cdOffset, cdSize.toInt())
    var pos = 0
    val seen = HashSet<String>()
    val list = ArrayList<ZipEntry>(total.toInt())
    for (n in 0 until total) {
      if (pos + 46 > cd.size || Le.u32(cd, pos) != 0x0201_4b50L) throw ZipFail.Damaged("central entry")
      val madeBy = Le.u16(cd, pos + 4)
      val flags = Le.u16(cd, pos + 8)
      val method = Le.u16(cd, pos + 10)
      val crc = Le.u32(cd, pos + 16)
      var compressed = Le.u32(cd, pos + 20)
      var size = Le.u32(cd, pos + 24)
      val nameLength = Le.u16(cd, pos + 28)
      val extraLength = Le.u16(cd, pos + 30)
      val commentLength = Le.u16(cd, pos + 32)
      val external = Le.u32(cd, pos + 38)
      var offset = Le.u32(cd, pos + 42)
      val end = pos + 46 + nameLength + extraLength + commentLength
      if (end > cd.size) throw ZipFail.Damaged("central entry")
      val nameData = cd.copyOfRange(pos + 46, pos + 46 + nameLength)
      // Entries with Zip64 extra fields: only the fields written as 0xFFFFFFFF are contained within, in a fixed order.
      var extra = pos + 46 + nameLength
      val extraEnd = extra + extraLength
      while (extra + 4 <= extraEnd) {
        val id = Le.u16(cd, extra)
        val len = Le.u16(cd, extra + 2)
        if (extra + 4 + len > extraEnd) throw ZipFail.Damaged("extra field")
        if (id == 1) {
          var at = extra + 4
          val stop = extra + 4 + len
          fun next(): Long {
            if (at + 8 > stop) throw ZipFail.Damaged("zip64 extra")
            val v = Le.u64(cd, at)
            at += 8
            return v
          }
          if (size == U32) size = next()
          if (compressed == U32) compressed = next()
          if (offset == U32) offset = next()
        }
        extra += 4 + len
      }
      pos = end
      if (flags and 0x1 != 0 || flags and 0x40 != 0) throw ZipFail.Unsupported("encrypted")
      if (method != 0 && method != 8) throw ZipFail.Unsupported("method $method")
      // Symbolic links and other special files: reject the entire archive.
      if (madeBy shr 8 == 3) {
        val type = ((external shr 16) and 0xF000L).toInt()
        if (type != 0 && type != 0x8000 && type != 0x4000) throw ZipFail.Unsafe("special file")
      }
      val name = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(nameData)).toString()
      } catch (e: CharacterCodingException) {
        if (flags and 0x800 == 0) String(nameData, Charsets.ISO_8859_1) else throw ZipFail.Unsafe("name encoding")
      }
      if (!zipSafeName(name)) throw ZipFail.Unsafe("name")
      if (name.endsWith("/")) continue
      if (size < 0 || compressed < 0 || offset < 0) throw ZipFail.Damaged("sizes")
      if (method == 0 && compressed != size) throw ZipFail.Damaged("sizes")
      if (offset >= dataEnd) throw ZipFail.Damaged("offset")
      if (!seen.add(name.lowercase())) throw ZipFail.Unsafe("duplicate name")
      list.add(ZipEntry(name, method, crc, compressed, size, offset))
    }
    entries = list
  }

  /** Extract an entry to dest (parent directories created as needed). Count bytes during extraction, stopping if it exceeds the declared size; finally verify the checksum. */
  fun extract(entry: ZipEntry, dest: java.io.File, shouldCancel: () -> Boolean, progress: (Long) -> Unit) {
    val local = source.readAt(entry.offset, 30)
    if (Le.u32(local, 0) != 0x0403_4b50L) throw ZipFail.Damaged("local header")
    val start = entry.offset + 30 + Le.u16(local, 26) + Le.u16(local, 28)
    if (start > dataEnd || entry.compressed > dataEnd - start) throw ZipFail.Damaged("data range")
    dest.parentFile?.mkdirs()
    val crc = CRC32()
    var produced = 0L
    val out = try {
      java.io.FileOutputStream(dest)
    } catch (e: IOException) {
      throw mapWrite(e)
    }
    val emit = { buf: ByteArray, len: Int ->
      produced += len
      if (produced > entry.size) throw ZipFail.Damaged("size")
      crc.update(buf, 0, len)
      try {
        out.write(buf, 0, len)
      } catch (e: IOException) {
        throw mapWrite(e)
      }
    }
    val inflater = if (entry.method == 8) Inflater(true) else null
    try {
      val scratch = ByteArray(1 shl 18)
      var consumed = 0L
      var ended = false
      while (consumed < entry.compressed) {
        if (shouldCancel()) throw ZipFail.Cancelled
        val n = minOf(ZIP_CHUNK.toLong(), entry.compressed - consumed).toInt()
        val chunk = source.readAt(start + consumed, n)
        consumed += n
        if (inflater != null) {
          if (ended) throw ZipFail.Damaged("trailing data")
          inflater.setInput(chunk, 0, n)
          try {
            while (!inflater.finished()) {
              val got = inflater.inflate(scratch)
              if (got > 0) emit(scratch, got)
              if (got == 0 && (inflater.needsInput() || inflater.needsDictionary())) break
            }
            // The last chunk of raw deflate sometimes requires an extra byte to finish.
            if (!inflater.finished() && consumed == entry.compressed) {
              inflater.setInput(ByteArray(1), 0, 1)
              while (!inflater.finished()) {
                val got = inflater.inflate(scratch)
                if (got > 0) emit(scratch, got)
                if (got == 0) break
              }
            }
          } catch (e: DataFormatException) {
            throw ZipFail.Damaged("deflate")
          }
          ended = inflater.finished()
        } else {
          emit(chunk, n)
        }
        progress(n.toLong())
      }
      if (inflater != null && !ended && !(entry.compressed == 0L && entry.size == 0L)) throw ZipFail.Damaged("deflate")
      if (produced != entry.size) throw ZipFail.Damaged("size")
      if (crc.value != entry.crc) throw ZipFail.Damaged("crc")
    } finally {
      inflater?.end()
      try {
        out.close()
      } catch (_: IOException) {
      }
    }
  }
}
