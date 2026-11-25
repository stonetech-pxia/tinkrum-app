package expo.modules.morphshare

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

// Copying files into the folder the user picked. No Android types here, so that unit tests can stand
// in for the content resolver and the document provider.

/** The picked folder. D is the document provider's handle of a created document. */
internal interface TargetFolder<D : Any> {
  /** Creates a new empty document; null when the provider refuses. */
  fun create(name: String, mimeType: String): D?

  fun openOutput(doc: D): OutputStream?

  fun delete(doc: D)
}

/**
 * Opens a source for reading. A content:// URI belongs to another app (a file shared in) and has no
 * file path, so only the content resolver can read it; anything else is a local file.
 */
internal fun openSource(
  uri: String,
  openContent: (String) -> InputStream?,
  openFile: (String) -> InputStream,
): InputStream =
  if (uri.startsWith("content://")) openContent(uri) ?: throw IOException("no input") else openFile(uri)

/**
 * Copies each source into a new document of the folder and returns the number of files. Sources are
 * only read. When a file fails, the document created for it is deleted; earlier ones stay saved.
 */
internal fun <D : Any> copyIntoFolder(
  uris: List<String>,
  names: List<String>,
  mimeTypes: List<String>,
  openContent: (String) -> InputStream?,
  openFile: (String) -> InputStream,
  folder: TargetFolder<D>,
): Int {
  for ((i, uri) in uris.withIndex()) {
    // Opened before anything is created, so an unreadable source leaves no empty file. Reported as a
    // failed save: a SecurityException here is not about the folder.
    val source = try {
      openSource(uri, openContent, openFile)
    } catch (e: Exception) {
      throw ExportFailedException(e.message)
    }
    source.use { from ->
      // Files with duplicate names are renamed by the document provider itself (e.g., "Report (1).pdf"), avoiding overwrites.
      val doc = folder.create(names[i], mimeTypes[i]) ?: throw FolderNotWritableException()
      try {
        val out = folder.openOutput(doc) ?: throw FolderNotWritableException()
        out.use { from.copyTo(it) }
      } catch (e: Throwable) {
        // If the provider cannot delete it either, the copy error is still the one reported.
        runCatching { folder.delete(doc) }
        throw e
      }
    }
  }
  return uris.size
}
