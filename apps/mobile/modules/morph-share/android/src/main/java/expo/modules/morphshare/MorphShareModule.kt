package expo.modules.morphshare

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import kotlin.concurrent.thread

// Android implementation of sharing and saving to folders (D-119, D-120):
// - Share: ACTION_SEND_MULTIPLE with all files at once (content:// URIs, read-only permission).
// - Save to folder: Storage Access Framework ACTION_OPEN_DOCUMENT_TREE, user picks a folder (local,
// Google Drive, or other document providers), creates documents one by one and copies them.
// Remembers the last picked folder (P-019, D-123): requests long-term read/write permission, stores
// the URI in SharedPreferences, and saves directly next time; drops old permission when changing
// folders, and re-prompts the user if the folder is missing or permission is revoked. Each quick
// action records its own folder (D-196): saves "folder:quickActionId -> URI", falls back to the
// last picked one when not set; releases permission only when a folder is no longer used by any
// quick action (nor is the last picked one).
// - Preview (D-238): copies into preview/ cache then uses ACTION_VIEW to hand off to an app capable
// of opening the file (system PDF reader, Google Drive, etc.), with read-only permission. File
// contents and names are not logged.

class MorphShareFileProvider : FileProvider()

class SheetBusyException : CodedException("Another share or save sheet is open")

class NoActivityException : CodedException("There is no screen to show the sheet on")

class FolderNotWritableException :
  CodedException("ERR_FOLDER_NOT_WRITABLE", "Files can't be saved into this folder", null)

class ExportFailedException(detail: String?) : CodedException("Saving failed: $detail")

class NoViewerException : CodedException("ERR_NO_VIEWER", "No app can open this file", null)

class PreviewFailedException : CodedException("ERR_PREVIEW_FAILED", "The file could not be previewed", null)

private const val PREFS = "morph_share"
private const val FOLDER_KEY = "folder"
private const val FOLDER_PREFIX = "folder:"
private const val SHARE_REQUEST = 0x4d53
private const val FOLDER_REQUEST = 0x4d46

private class PendingExport(
  val key: String,
  val promise: Promise,
  val files: List<File>,
  val names: List<String>,
  val mimeTypes: List<String>,
)

class MorphShareModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  private var pendingShare: Promise? = null
  private var pendingExport: PendingExport? = null

  private fun fileOf(uri: String) = File(Uri.parse(uri).path!!)

  /** Opens the system share sheet once with all files; also includes text when not empty (EXTRA_TEXT). Promise resolves only after the share sheet is dismissed. */
  private fun shareSheet(text: String?, uris: List<String>, mimeTypes: List<String>, promise: Promise) {
    val activity = appContext.currentActivity
    if (activity == null) {
      promise.reject(NoActivityException())
      return
    }
    if (pendingShare != null || pendingExport != null) {
      promise.reject(SheetBusyException())
      return
    }
    val authority = "${context.packageName}.MorphShareFileProvider"
    val contentUris = ArrayList(uris.map { FileProvider.getUriForFile(context, authority, fileOf(it)) })
    val intent = if (contentUris.size == 1) {
      Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, contentUris[0])
    } else {
      Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, contentUris)
    }
    intent.type = commonType(mimeTypes)
    if (text != null) intent.putExtra(Intent.EXTRA_TEXT, text)
    // Read permission is granted to the selected app via ClipData (only it, read-only).
    val clip = ClipData.newRawUri(null, contentUris[0])
    for (uri in contentUris.drop(1)) clip.addItem(ClipData.Item(uri))
    intent.clipData = clip
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    pendingShare = promise
    activity.startActivityForResult(Intent.createChooser(intent, null), SHARE_REQUEST)
  }

  override fun definition() = ModuleDefinition {
    Name("MorphShare")

    AsyncFunction("shareFiles") { uris: List<String>, mimeTypes: List<String>, promise: Promise ->
      shareSheet(null, uris, mimeTypes, promise)
    }.runOnQueue(Queues.MAIN)

    // Hand off to other AI apps (D-611): prompt is passed in EXTRA_TEXT along with files; receiving app puts the text into its input box.
    AsyncFunction("shareFilesWithText") { text: String, uris: List<String>, mimeTypes: List<String>, promise: Promise ->
      shareSheet(text, uris, mimeTypes, promise)
    }.runOnQueue(Queues.MAIN)

    // Returns immediately after opening another app, without waiting for the user to return. First
    // copies the file into internal preview/ cache (using the original filename), then shares via
    // own FileProvider URI: incoming content:// URIs belong to other apps and may not be able to
    // re-grant read permission to a third-party app (founder's Samsung reported ERR_UNEXPECTED),
    // and file paths might not be within FileProvider allowed directories. Keeps only one copy at a
    // time: clears the previous one before copying.
    AsyncFunction("previewFile") { uri: String, mimeType: String, name: String, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject(NoActivityException())
        return@AsyncFunction
      }
      thread {
        val target = try {
          val dir = File(context.cacheDir, "preview")
          dir.deleteRecursively()
          dir.mkdirs()
          val safe = name.replace('/', '_').ifBlank { "file" }
          val copy = File(dir, safe)
          val input = if (uri.startsWith("content://")) {
            context.contentResolver.openInputStream(Uri.parse(uri))
          } else {
            fileOf(uri).inputStream()
          }
          requireNotNull(input) { "no input" }.use { from -> copy.outputStream().use { from.copyTo(it) } }
          FileProvider.getUriForFile(context, "${context.packageName}.MorphShareFileProvider", copy)
        } catch (e: Exception) {
          // Logs only exception type, not filenames or URIs.
          Log.w("MorphShare", "previewFile copy failed: ${e.javaClass.simpleName}")
          promise.reject(PreviewFailedException())
          return@thread
        }
        activity.runOnUiThread {
          val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(target, mimeType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          try {
            activity.startActivity(intent)
            promise.resolve(null)
          } catch (e: ActivityNotFoundException) {
            promise.reject(NoViewerException())
          } catch (e: Exception) {
            Log.w("MorphShare", "previewFile open failed: ${e.javaClass.simpleName}")
            promise.reject(PreviewFailedException())
          }
        }
      }
    }

    Function("rememberedFolder") { key: String -> rememberedFolder(key, adopt = false)?.second }

    Function("forgetFolders") { keep: List<String> ->
      updateFolders { edit ->
        for (name in prefs.all.keys) {
          if (name.startsWith(FOLDER_PREFIX) && name.removePrefix(FOLDER_PREFIX) !in keep) edit.remove(name)
        }
      }
    }

    // useRemembered: saves directly if a remembered folder exists, without showing the picker. key: quick action ID.
    AsyncFunction("exportFiles") { uris: List<String>, names: List<String>, mimeTypes: List<String>, useRemembered: Boolean, key: String, promise: Promise ->
      if (pendingShare != null || pendingExport != null) {
        promise.reject(SheetBusyException())
        return@AsyncFunction
      }
      val pending = PendingExport(key, promise, uris.map(::fileOf), names, mimeTypes)
      val remembered = if (useRemembered) rememberedFolder(key, adopt = true) else null
      if (remembered != null) {
        copyInBackground(remembered.first, remembered.second, pending)
        return@AsyncFunction
      }
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject(NoActivityException())
        return@AsyncFunction
      }
      pendingExport = pending
      activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), FOLDER_REQUEST)
    }.runOnQueue(Queues.MAIN)

    // When Tinkrum itself is selected as the share target, the system hands the share back to the
    // same interface, and onActivityResult is not delivered for the share sheet's return result
    // (real-device log: selecting Gmail or pressing back both trigger onActivityResult, only
    // selecting Tinkrum does not). If pendingShare is still present when returning to the
    // foreground, it means the sheet has closed: release it, otherwise every subsequent share or
    // save reports "Another share or save sheet is open" until the app is swiped away. On normal
    // close, the result arrives before returning to the foreground, where pendingShare is already
    // empty.
    OnActivityEntersForeground {
      pendingShare?.resolve(null)
      pendingShare = null
    }

    OnActivityResult { _, payload ->
      when (payload.requestCode) {
        SHARE_REQUEST -> {
          pendingShare?.resolve(null)
          pendingShare = null
        }
        FOLDER_REQUEST -> {
          val pending = pendingExport ?: return@OnActivityResult
          pendingExport = null
          val tree = payload.data?.data
          if (payload.resultCode != Activity.RESULT_OK || tree == null) {
            pending.promise.resolve(null)
            return@OnActivityResult
          }
          remember(tree, pending.key)
          copyInBackground(tree, folderName(tree) ?: "", pending)
        }
      }
    }
  }

  // Copies in the background without blocking the UI. Result: count of saved items, folder name.
  private fun copyInBackground(tree: Uri, name: String, pending: PendingExport) {
    thread {
      try {
        val saved = copyInto(tree, pending)
        pending.promise.resolve(mapOf("saved" to saved, "folder" to name))
      } catch (e: CodedException) {
        pending.promise.reject(e)
      } catch (e: SecurityException) {
        pending.promise.reject(FolderNotWritableException())
      } catch (e: Exception) {
        pending.promise.reject(ExportFailedException(e.message))
      }
    }
  }

  private val prefs
    get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // Folder (URI and name) for a quick action key: its own, or the last picked one if none (recorded
  // when adopt is true, only when actually saving). Returns null if none, authorization is revoked,
  // or folder no longer exists (and forgets the invalid one).
  private fun rememberedFolder(key: String, adopt: Boolean): Pair<Uri, String>? {
    usable(FOLDER_PREFIX + key)?.let { return it }
    val last = usable(FOLDER_KEY) ?: return null
    if (adopt) updateFolders { it.putString(FOLDER_PREFIX + key, last.first.toString()) }
    return last
  }

  // Folder stored under the pref entry; forgets this folder everywhere if authorization is revoked or the folder no longer exists.
  private fun usable(pref: String): Pair<Uri, String>? {
    val tree = prefs.getString(pref, null)?.let(Uri::parse) ?: return null
    val granted = context.contentResolver.persistedUriPermissions.any {
      it.uri == tree && it.isWritePermission
    }
    val name = if (granted) folderName(tree) else null
    if (name == null) {
      updateFolders { edit ->
        for ((k, v) in prefs.all) if (k.startsWith(FOLDER_KEY) && v == tree.toString()) edit.remove(k)
      }
      return null
    }
    return tree to name
  }

  // Record for this quick action, and also remember as the last picked one.
  private fun remember(tree: Uri, key: String) {
    val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    try {
      context.contentResolver.takePersistableUriPermission(tree, flags)
    } catch (e: SecurityException) {
      // This document provider does not grant long-term permission: saves this time, asks again next time.
      return
    }
    updateFolders {
      it.putString(FOLDER_KEY, tree.toString())
      it.putString(FOLDER_PREFIX + key, tree.toString())
    }
  }

  // Update remembered folders; releases long-term permissions for folders no longer used anywhere after updating.
  private fun updateFolders(change: (android.content.SharedPreferences.Editor) -> Unit) {
    val before = folderUris()
    val edit = prefs.edit()
    change(edit)
    edit.commit()
    val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    for (uri in before - folderUris()) {
      try {
        context.contentResolver.releasePersistableUriPermission(Uri.parse(uri), flags)
      } catch (e: SecurityException) {
        // No authorization existed in the first place.
      }
    }
  }

  // All currently remembered folder URIs (last picked one and each quick action's).
  private fun folderUris(): Set<String> =
    prefs.all.filterKeys { it.startsWith(FOLDER_KEY) }.values.filterIsInstance<String>().toSet()

  // Display name of the folder; returns null if the folder no longer exists.
  private fun folderName(tree: Uri): String? = try {
    val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    context.contentResolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
      ?.use { if (it.moveToFirst()) it.getString(0) else null }
  } catch (e: Exception) {
    null
  }

  private fun copyInto(tree: Uri, pending: PendingExport): Int {
    val resolver = context.contentResolver
    val folder = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    for ((i, file) in pending.files.withIndex()) {
      // Files with duplicate names are renamed by the document provider itself (e.g., "Report (1).pdf"), avoiding overwrites.
      val doc = DocumentsContract.createDocument(resolver, folder, pending.mimeTypes[i], pending.names[i])
        ?: throw FolderNotWritableException()
      val out = resolver.openOutputStream(doc) ?: throw FolderNotWritableException()
      out.use { sink -> file.inputStream().use { it.copyTo(sink) } }
    }
    return pending.files.size
  }

  // Use type directly if all are the same type; image/* if same broad category (all images); otherwise */*.
  private fun commonType(mimeTypes: List<String>): String {
    val distinct = mimeTypes.distinct()
    if (distinct.size == 1) return distinct[0]
    val groups = distinct.map { it.substringBefore('/') }.distinct()
    return if (groups.size == 1) "${groups[0]}/*" else "*/*"
  }
}
