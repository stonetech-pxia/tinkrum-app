package expo.modules.morphvision

import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.entityextraction.DateTimeEntity
import com.google.mlkit.nl.entityextraction.Entity
import com.google.mlkit.nl.entityextraction.EntityExtraction
import com.google.mlkit.nl.entityextraction.EntityExtractionParams
import com.google.mlkit.nl.entityextraction.EntityExtractionRemoteModel
import com.google.mlkit.nl.entityextraction.EntityExtractorOptions
import expo.modules.kotlin.exception.CodedException
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

class NeedsDownloadException(language: String) :
  CodedException("ERR_VISION_NEEDS_DOWNLOAD", "The entity model for $language has to be downloaded first", null)

/**
 * System recognition used for pre-filling "log an expense", supplementing rules only (D-244): ML
 * Kit entity extraction (dates and amounts). Models for each language are downloaded from Google
 * on first use (not bundled in the app); the app prompts the user before downloading
 * (downloadDataModel). If models are not downloaded, downloading is disallowed (allowDownload =
 * false, always called this way from JS), or there is no network, it terminates with
 * ERR_VISION_NEEDS_DOWNLOAD, and JS falls back to rules. Positions are in UTF-16, matching JS
 * strings; dates are formatted as YYYY-MM-DD in the local timezone, precision to the day; amounts
 * are unassigned, leaving JS to parse the raw text consistently. Text is not logged.
 */
object DataDetection {
  private const val TIMEOUT_S = 30L
  private val DAY_OR_FINER = setOf(
    DateTimeEntity.GRANULARITY_DAY,
    DateTimeEntity.GRANULARITY_HOUR,
    DateTimeEntity.GRANULARITY_MINUTE,
    DateTimeEntity.GRANULARITY_SECOND,
  )

  private fun modelLanguage(code: String): String? = when (code.substringBefore('-')) {
    "zh" -> EntityExtractorOptions.CHINESE
    "en" -> EntityExtractorOptions.ENGLISH
    "fr" -> EntityExtractorOptions.FRENCH
    "de" -> EntityExtractorOptions.GERMAN
    "es" -> EntityExtractorOptions.SPANISH
    "it" -> EntityExtractorOptions.ITALIAN
    "pt" -> EntityExtractorOptions.PORTUGUESE
    "ja" -> EntityExtractorOptions.JAPANESE
    "ko" -> EntityExtractorOptions.KOREAN
    else -> null
  }

  /** ready: model is on-device; download: download required first; unsupported: language is not supported. */
  fun status(code: String): String {
    val language = modelLanguage(code) ?: return "unsupported"
    val model = EntityExtractionRemoteModel.Builder(language).build()
    val downloaded = Tasks.await(RemoteModelManager.getInstance().isModelDownloaded(model), TIMEOUT_S, TimeUnit.SECONDS)
    return if (downloaded) "ready" else "download"
  }

  /** Downloads the model for this language (called after the app prompts the user). Terminates with ERR_VISION_NEEDS_DOWNLOAD on network failure or error. */
  fun download(code: String) {
    val language = modelLanguage(code) ?: return
    val extractor = EntityExtraction.getClient(EntityExtractorOptions.Builder(language).build())
    try {
      Tasks.await(extractor.downloadModelIfNeeded(), 120, TimeUnit.SECONDS)
    } catch (e: Exception) {
      throw NeedsDownloadException(code)
    } finally {
      extractor.close()
    }
  }

  fun detect(text: String, code: String, allowDownload: Boolean): List<Map<String, Any>> {
    val language = modelLanguage(code) ?: return emptyList()
    if (!allowDownload && status(code) != "ready") throw NeedsDownloadException(code)
    val extractor = EntityExtraction.getClient(EntityExtractorOptions.Builder(language).build())
    try {
      if (allowDownload) {
        try {
          Tasks.await(extractor.downloadModelIfNeeded(), 120, TimeUnit.SECONDS)
        } catch (e: Exception) {
          throw NeedsDownloadException(code)
        }
      }
      val params = EntityExtractionParams.Builder(text)
        .setEntityTypesFilter(setOf(Entity.TYPE_DATE_TIME, Entity.TYPE_MONEY))
        .setPreferredLocale(Locale.forLanguageTag(code))
        .build()
      val annotations = Tasks.await(extractor.annotate(params), TIMEOUT_S, TimeUnit.SECONDS)
      val out = mutableListOf<Map<String, Any>>()
      for (annotation in annotations) {
        for (entity in annotation.entities) {
          when (entity.type) {
            Entity.TYPE_MONEY -> out.add(mapOf("kind" to "amount", "start" to annotation.start, "end" to annotation.end))
            Entity.TYPE_DATE_TIME -> {
              val date = entity.asDateTimeEntity() ?: continue
              if (date.dateTimeGranularity !in DAY_OR_FINER) continue
              val c = Calendar.getInstance(TimeZone.getDefault()).apply { timeInMillis = date.timestampMillis }
              val value = String.format(
                Locale.ROOT, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH),
              )
              out.add(mapOf("kind" to "date", "start" to annotation.start, "end" to annotation.end, "value" to value))
            }
          }
        }
      }
      return out
    } finally {
      extractor.close()
    }
  }
}
