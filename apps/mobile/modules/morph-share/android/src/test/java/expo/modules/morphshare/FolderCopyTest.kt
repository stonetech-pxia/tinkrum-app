package expo.modules.morphshare

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

private const val SHARED = "content://com.android.externalstorage.documents/document/primary%3ADownload%2Fphoto.png"
private const val LOCAL = "file:///data/user/0/app/cache/runs/r/1/scan.pdf"

private val photo = ByteArray(100_000) { (it % 251).toByte() }
private val scan = byteArrayOf(37, 80, 68, 70)

/** Like a document provider: a created document exists, empty, until something is written into it. */
private class MemoryFolder(private val refuseOutput: Boolean = false) : TargetFolder<String> {
  val docs = linkedMapOf<String, ByteArrayOutputStream>()

  override fun create(name: String, mimeType: String): String {
    docs[name] = ByteArrayOutputStream()
    return name
  }

  override fun openOutput(doc: String) = if (refuseOutput) null else docs.getValue(doc)

  override fun delete(doc: String) {
    docs.remove(doc)
  }
}

private class Sources(private val shared: Map<String, () -> InputStream> = mapOf(SHARED to { ByteArrayInputStream(photo) })) {
  // A content:// URI of another app has no file path: opening it as a file fails as on the phone.
  fun file(uri: String): InputStream =
    if (uri == LOCAL) ByteArrayInputStream(scan) else throw FileNotFoundException("open failed: ENOENT")

  fun content(uri: String): InputStream =
    shared[uri]?.invoke() ?: throw SecurityException("Permission Denial: reading $uri")
}

private fun copy(uris: List<String>, folder: MemoryFolder, sources: Sources = Sources()) =
  copyIntoFolder(
    uris,
    uris.indices.map { "file$it" },
    uris.map { "application/octet-stream" },
    sources::content,
    sources::file,
    folder,
  )

class FolderCopyTest {
  @Test
  fun savesTheWholeFileOfAContentUri() {
    val folder = MemoryFolder()
    assertEquals(1, copy(listOf(SHARED), folder))
    assertArrayEquals(photo, folder.docs.getValue("file0").toByteArray())
  }

  @Test
  fun savesLocalAndContentFilesTogether() {
    val folder = MemoryFolder()
    assertEquals(2, copy(listOf(LOCAL, SHARED), folder))
    assertArrayEquals(scan, folder.docs.getValue("file0").toByteArray())
    assertArrayEquals(photo, folder.docs.getValue("file1").toByteArray())
  }

  @Test
  fun leavesNoFileWhenTheSourceCannotBeOpened() {
    val folder = MemoryFolder()
    assertThrows(Exception::class.java) { copy(listOf("file:///gone.pdf"), folder) }
    assertEquals(emptySet<String>(), folder.docs.keys)
  }

  // The module reports a SecurityException as "this folder cannot be written", which a source without
  // read permission is not.
  @Test
  fun reportsASourceWithoutPermissionAsAFailedSave() {
    val folder = MemoryFolder()
    assertThrows(ExportFailedException::class.java) {
      copy(listOf(SHARED), folder, Sources(shared = emptyMap()))
    }
    assertEquals(emptySet<String>(), folder.docs.keys)
  }

  @Test
  fun removesTheHalfWrittenFileAndKeepsTheFinishedOnes() {
    val breaking = {
      object : InputStream() {
        var sent = false

        override fun read(): Int = throw IOException("connection lost")

        override fun read(b: ByteArray, off: Int, len: Int): Int {
          if (sent) throw IOException("connection lost")
          sent = true
          return 1
        }
      }
    }
    val folder = MemoryFolder()
    assertThrows(IOException::class.java) {
      copy(listOf(LOCAL, SHARED), folder, Sources(shared = mapOf(SHARED to breaking)))
    }
    assertEquals(setOf("file0"), folder.docs.keys)
    assertArrayEquals(scan, folder.docs.getValue("file0").toByteArray())
  }

  @Test
  fun removesTheCreatedFileWhenTheFolderRefusesToBeWritten() {
    val folder = MemoryFolder(refuseOutput = true)
    assertThrows(FolderNotWritableException::class.java) { copy(listOf(LOCAL), folder) }
    assertEquals(emptySet<String>(), folder.docs.keys)
  }
}
