package expo.modules.morphtranslate

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.languageid.LanguageIdentification
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.TranslateRemoteModel
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.TranslatorOptions
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.TimeUnit

// Android implementation of on-device translation (D-170): Google ML Kit translation + language
// recognition, sharing the same JS interface as iOS. Translation language models (approx. 30 MB
// each) are not included in the app: status reports languages not yet downloaded, the app prompts
// the user, and then calls download. ML Kit supports only one Chinese variant (Simplified Chinese
// output); Traditional Chinese returns unsupported. Text is returned only to the app and is never
// logged.

class TranslateUnsupportedException(what: String) :
  CodedException("ERR_TRANSLATE_UNSUPPORTED", "Translation is not available for $what", null)

class TranslateDownloadException(cause: Throwable?) :
  CodedException("ERR_TRANSLATE_DOWNLOAD", "The language model could not be downloaded: ${cause?.message}", cause)

class TranslateFailedException(cause: Throwable?) :
  CodedException("ERR_TRANSLATE_FAILED", "Translation failed: ${cause?.message}", cause)

/** Size of each language model (per ML Kit documentation: approx. 30 MB), used solely for user prompts. */
private const val MODEL_BYTES = 30L * 1024 * 1024

/** Maximum download timeout per language: ML Kit waits indefinitely without reporting errors when there is no network. */
private const val DOWNLOAD_TIMEOUT_MINUTES = 10L

class MorphTranslateModule : Module() {
  private val models get() = RemoteModelManager.getInstance()

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  /** Check whether internet connectivity is currently available (ML Kit downloads would hang indefinitely without network, so check first). */
  private fun online(): Boolean {
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return true
    val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
  }

  override fun definition() = ModuleDefinition {
    Name("MorphTranslate")

    Constants("downloadBytes" to MODEL_BYTES)

    Function("isSupported") { true }

    // Language of each text segment (BCP 47); returns null when uncertain (und).
    AsyncFunction("detectLanguages") { texts: List<String> ->
      val client = LanguageIdentification.getClient()
      try {
        texts.map { text ->
          val code = Tasks.await(client.identifyLanguage(text))
          if (code == "und") null else code
        }
      } finally {
        client.close()
      }
    }

    AsyncFunction("status") { from: String, to: String ->
      val source = mlkitLanguage(from)
      val target = mlkitLanguage(to)
      if (source == null || target == null || source == target) {
        return@AsyncFunction mapOf("status" to "unsupported")
      }
      val have = downloaded()
      val missing = listOf(from to source, to to target).filter { it.second !in have }.map { it.first }
      if (missing.isEmpty()) mapOf("status" to "installed")
      else mapOf("status" to "download", "missing" to missing)
    }

    // Download a language model (Wi-Fi restriction not enforced here: the user has already confirmed in the app prompt, which suggests using Wi-Fi).
    AsyncFunction("download") { language: String ->
      val code = mlkitLanguage(language) ?: throw TranslateUnsupportedException(language)
      if (!online()) throw TranslateDownloadException(null)
      try {
        Tasks.await(
          models.download(TranslateRemoteModel.Builder(code).build(), DownloadConditions.Builder().build()),
          DOWNLOAD_TIMEOUT_MINUTES,
          TimeUnit.MINUTES,
        )
      } catch (e: Exception) {
        throw TranslateDownloadException(e)
      }
    }

    AsyncFunction("translate") { texts: List<String>, from: String, to: String ->
      val source = mlkitLanguage(from) ?: throw TranslateUnsupportedException(from)
      val target = mlkitLanguage(to) ?: throw TranslateUnsupportedException(to)
      val translator = Translation.getClient(
        TranslatorOptions.Builder().setSourceLanguage(source).setTargetLanguage(target).build()
      )
      try {
        // No network requests are made when models are already downloaded; fails if models are missing (the app calls status / download first).
        val have = downloaded()
        if (source !in have || target !in have) throw TranslateDownloadException(null)
        texts.map { Tasks.await(translator.translate(it)) }
      } catch (e: CodedException) {
        throw e
      } catch (e: Exception) {
        throw TranslateFailedException(e)
      } finally {
        translator.close()
      }
    }

    // List and delete downloaded languages in settings (English is built into ML Kit and is not listed).
    AsyncFunction("downloadedLanguages") {
      downloaded().filter { it != TranslateLanguage.ENGLISH }
        .map { if (it == TranslateLanguage.CHINESE) "zh-Hans" else it }
    }

    AsyncFunction("deleteLanguage") { language: String ->
      val code = mlkitLanguage(language) ?: return@AsyncFunction
      if (code == TranslateLanguage.ENGLISH) return@AsyncFunction
      Tasks.await(models.deleteDownloadedModel(TranslateRemoteModel.Builder(code).build()))
    }
  }

  private fun downloaded(): Set<String> =
    Tasks.await(models.getDownloadedModels(TranslateRemoteModel::class.java)).map { it.language }.toSet()

  /** BCP 47 -> ML Kit language code mapping; ML Kit supports only Simplified Chinese. */
  private fun mlkitLanguage(tag: String): String? {
    val lower = tag.lowercase()
    if (lower.startsWith("zh")) {
      return if (lower.contains("hant") || lower.endsWith("-tw") || lower.endsWith("-hk")) null
      else TranslateLanguage.CHINESE
    }
    return TranslateLanguage.fromLanguageTag(lower.substringBefore('-'))
  }
}
