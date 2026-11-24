package expo.modules.morpharchive

import android.net.Uri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

// Android implementation of bulk export and restore (D-600): serializes directories and files into
// a standard ZIP, and safely extracts a ZIP into a directory. Read and write are entirely streaming
// (ZipCodec.kt) without loading files into memory; processes one task at a time; cancel() halts
// ongoing work at the next data chunk, deletes unfinished files, and terminates with
// ERR_ARCHIVE_CANCELLED. Archives may be content:// URIs: reads file descriptors directly without
// prior copying; copies into cache only when descriptors do not support random access (found in
// some document providers), deleting after use (our copies are used, originals remain untouched).
// Local files only, no networking. File names and contents are never logged.

class ArchiveException(code: String, detail: String) : CodedException(code, detail, null)

private class Item(val name: String, val file: File?, val bytes: ByteArray?, val size: Long, val modified: Long)

private const val MANIFEST = "tinkrum-backup.json"
private const val MANIFEST_MAX = 1L shl 20

class MorphArchiveModule : Module() {
  private val cancelRequested = AtomicBoolean(false)
  private val running = AtomicBoolean(false)

  private val context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  private fun fileOf(uri: String) = File(Uri.parse(uri).path!!)

  override fun definition() = ModuleDefinition {
    Name("MorphArchive")
    Events("onProgress")

    Function("cancel") { cancelRequested.set(true) }

    // Number of files and total bytes in these directories (does not follow symlinks).
    AsyncFunction("scanTree") { uris: List<String>, promise: Promise ->
      perform(promise) {
        var files = 0
        var bytes = 0L
        for (uri in uris) for (item in walk(fileOf(uri), "")) {
          files++
          bytes += item.size
        }
        mapOf("files" to files, "bytes" to bytes.toDouble())
      }
    }

    // sources: all files in directory { dir, prefix } placed under prefix/; single file { file, name }; text block { text, name }.
    AsyncFunction("createArchive") { dest: String, sources: List<Map<String, Any?>>, promise: Promise ->
      perform(promise) {
        val items = ArrayList<Item>()
        for (source in sources) {
          val text = source["text"] as? String
          val file = source["file"] as? String
          val dir = source["dir"] as? String
          val name = source["name"] as? String
          if (text != null && name != null) {
            val bytes = text.toByteArray(Charsets.UTF_8)
            items.add(Item(name, null, bytes, bytes.size.toLong(), System.currentTimeMillis()))
          } else if (file != null && name != null) {
            val f = fileOf(file)
            items.add(Item(name, f, null, f.length(), f.lastModified()))
          } else if (dir != null) {
            items.addAll(walk(fileOf(dir), (source["prefix"] as? String) ?: ""))
          }
        }
        write(items, fileOf(dest))
      }
    }

    // Reads archive directory and inspects entries sequentially (without extraction): name,
    // symlink, encryption, compression method, size. Returns name and size for each file, along
    // with tinkrum-backup.json content (null if absent).
    AsyncFunction("inspectArchive") { src: String, promise: Promise ->
      perform(promise) {
        val reader = ZipReader(openSource(src))
        try {
          reader.load()
          var manifest: String? = null
          val entry = reader.entries.firstOrNull { it.name == MANIFEST }
          if (entry != null && entry.size <= MANIFEST_MAX) {
            val temp = File.createTempFile("manifest", null, context.cacheDir)
            try {
              reader.extract(entry, temp, { cancelRequested.get() }, { })
              manifest = temp.readText(Charsets.UTF_8)
            } finally {
              temp.delete()
            }
          }
          var bytes = 0L
          val list = reader.entries.map {
            bytes += it.size
            mapOf("name" to it.name, "size" to it.size.toDouble())
          }
          mapOf("entries" to list, "bytes" to bytes.toDouble(), "manifest" to manifest)
        } finally {
          reader.close()
        }
      }
    }

    // Extracts archive to dest (which must not yet exist). On error or cancellation, dest is completely deleted.
    AsyncFunction("extractArchive") { src: String, dest: String, promise: Promise ->
      perform(promise) {
        val root = fileOf(dest)
        if (root.exists()) throw ArchiveException("ERR_ARCHIVE_IO", "destination exists")
        try {
          root.mkdirs()
          val reader = ZipReader(openSource(src))
          try {
            reader.load()
            val total = reader.entries.sumOf { it.size }
            val base = root.canonicalPath + File.separator
            var done = 0L
            var lastReport = 0L
            for (entry in reader.entries) {
              val target = File(root, entry.name)
              // The extracted path must reside inside dest (names already checked, blocked here as a secondary safeguard).
              if (!target.canonicalPath.startsWith(base)) throw ZipFail.Unsafe("path")
              reader.extract(entry, target, { cancelRequested.get() }, { })
              done += entry.size
              val now = System.currentTimeMillis()
              if (now - lastReport > 250) {
                lastReport = now
                sendEvent("onProgress", mapOf("phase" to "extract", "done" to done.toDouble(), "total" to total.toDouble()))
              }
            }
            mapOf("files" to reader.entries.size, "bytes" to total.toDouble())
          } finally {
            reader.close()
          }
        } catch (e: Throwable) {
          root.deleteRecursively()
          throw e
        }
      }
    }

    // Rename/move (in the same volume, instantaneous, no copy): 'to' must not exist yet. Used when changing data directory during restore.
    AsyncFunction("moveTree") { from: String, to: String, promise: Promise ->
      thread {
        val target = fileOf(to)
        if (target.exists() || !fileOf(from).renameTo(target)) {
          promise.reject(ArchiveException("ERR_ARCHIVE_IO", "move failed"))
        } else {
          promise.resolve(null)
        }
      }
    }

    AsyncFunction("removeTree") { uri: String, promise: Promise ->
      thread {
        try {
          fileOf(uri).deleteRecursively()
        } catch (_: Exception) {
        }
        promise.resolve(null)
      }
    }
  }

  /** Do only one thing at a time; run on a background thread; replace errors with code-bearing exceptions. */
  private fun perform(promise: Promise, body: () -> Any?) {
    if (!running.compareAndSet(false, true)) {
      promise.reject(ArchiveException("ERR_ARCHIVE_BUSY", "Another archive operation is running"))
      return
    }
    cancelRequested.set(false)
    thread {
      try {
        promise.resolve(body())
      } catch (e: Throwable) {
        promise.reject(exception(e))
      } finally {
        running.set(false)
      }
    }
  }

  private fun exception(e: Throwable): CodedException = when (e) {
    is CodedException -> e
    is ZipFail.Cancelled -> ArchiveException("ERR_ARCHIVE_CANCELLED", "Cancelled")
    is ZipFail.NotZip -> ArchiveException("ERR_ARCHIVE_NOT_ZIP", "Not a zip archive")
    is ZipFail.Damaged -> ArchiveException("ERR_ARCHIVE_DAMAGED", e.message ?: "")
    is ZipFail.Unsupported -> ArchiveException("ERR_ARCHIVE_UNSUPPORTED", e.message ?: "")
    is ZipFail.Unsafe -> ArchiveException("ERR_ARCHIVE_UNSAFE", e.message ?: "")
    is ZipFail.NoSpace -> ArchiveException("ERR_ARCHIVE_NO_SPACE", "Not enough free space")
    else -> ArchiveException("ERR_ARCHIVE_IO", e.message ?: e.javaClass.simpleName)
  }

  /**
   * Open archive: read file:// directly; read content:// file descriptor. If the descriptor
   * cannot be read randomly (pipe), copy it to cache first and read from the copy, deleting the
   * copy upon closing (original untouched).
   */
  private fun openSource(uri: String): ZipSource {
    val parsed = Uri.parse(uri)
    if (parsed.scheme != "content") return ZipSource(RandomAccessFile(fileOf(uri), "r").channel)
    val descriptor = context.contentResolver.openFileDescriptor(parsed, "r")
      ?: throw ZipFail.Io("cannot open")
    try {
      val channel = FileInputStream(descriptor.fileDescriptor).channel
      channel.position(0)
      val size = channel.size()
      if (size > 0) {
        return ZipSource(channel) {
          try {
            descriptor.close()
          } catch (_: Exception) {
          }
        }
      }
    } catch (_: Exception) {
      // Cannot read randomly: copy one below.
    }
    val copy = File.createTempFile("archive-copy", ".zip", context.cacheDir)
    try {
      FileInputStream(descriptor.fileDescriptor).use { input -> copy.outputStream().use { input.copyTo(it, 1 shl 20) } }
    } catch (e: java.io.IOException) {
      copy.delete()
      throw if ((e.message ?: "").contains("ENOSPC")) ZipFail.NoSpace else ZipFail.Io(e.message ?: "copy")
    } finally {
      try {
        descriptor.close()
      } catch (_: Exception) {
      }
    }
    return ZipSource(RandomAccessFile(copy, "r").channel) { copy.delete() }
  }

  /** All regular files in the directory (including those starting with .), sorted by name; ignore symbolic links and other special files. */
  private fun walk(dir: File, prefix: String): List<Item> {
    val items = ArrayList<Item>()
    fun visit(folder: File, relative: String) {
      val children = folder.listFiles() ?: return
      for (child in children.sortedBy { it.name }) {
        val name = if (relative.isEmpty()) child.name else "$relative/${child.name}"
        if (Files.isSymbolicLink(child.toPath())) continue
        if (child.isDirectory) visit(child, name)
        else if (child.isFile) items.add(Item(name, child, null, child.length(), child.lastModified()))
      }
    }
    if (dir.exists()) visit(dir, prefix.removeSuffix("/"))
    return items
  }

  private fun write(items: List<Item>, dest: File): Map<String, Any?> {
    val total = items.sumOf { it.size }
    val writer = ZipWriter(dest.path)
    var lastReport = 0L
    try {
      for (item in items) {
        if (item.bytes != null) {
          writer.addBytes(item.name, item.bytes, item.modified) { cancelRequested.get() }
          continue
        }
        FileInputStream(item.file!!).use { input ->
          writer.add(
            item.name, item.size, item.modified, zipShouldStore(item.name),
            { buf -> input.read(buf) },
            { cancelRequested.get() },
            { done ->
              val now = System.currentTimeMillis()
              if (now - lastReport > 250) {
                lastReport = now
                sendEvent("onProgress", mapOf("phase" to "write", "done" to done.toDouble(), "total" to total.toDouble()))
              }
            },
          )
        }
      }
      writer.finish()
    } catch (e: Throwable) {
      writer.abort()
      dest.delete()
      throw e
    }
    return mapOf("entries" to items.size, "bytes" to dest.length().toDouble())
  }
}
