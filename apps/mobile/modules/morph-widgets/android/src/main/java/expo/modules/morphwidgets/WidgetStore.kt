package expo.modules.morphwidgets

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

// Two files for desktop widgets (D-321–D-323), located in the app's own files/widgets directory:
// snapshot.json is the app-rendered layout (format defined in src/widgets/types.ts), queue/ stores
// actions tapped on widgets that the app has not yet executed, one file per tap. Which widget
// displays which component is recorded in SharedPreferences (bound upon desktop placement, local
// only).

object WidgetStore {
  private const val PREFS = "morph_widgets"

  private fun dir(ctx: Context) = File(ctx.filesDir, "widgets")
  private fun queueDir(ctx: Context) = File(dir(ctx), "queue")

  fun writeSnapshot(ctx: Context, json: String) {
    val d = dir(ctx).apply { mkdirs() }
    val temp = File(d, "snapshot.json.tmp")
    temp.writeText(json)
    temp.renameTo(File(d, "snapshot.json"))
  }

  fun snapshot(ctx: Context): JSONObject? =
    try {
      File(dir(ctx), "snapshot.json").takeIf { it.exists() }?.readText()?.let { JSONObject(it) }
    } catch (e: Exception) {
      null
    }

  /** Record a tap: rename only after writing is complete so the app never reads a half-written file. */
  fun enqueue(ctx: Context, entry: JSONObject) {
    val q = queueDir(ctx).apply { mkdirs() }
    val name = "${entry.getLong("at")}-${UUID.randomUUID()}"
    val temp = File(q, "$name.tmp")
    temp.writeText(entry.toString())
    temp.renameTo(File(q, "$name.json"))
  }

  fun queued(ctx: Context): List<JSONObject> =
    (queueDir(ctx).listFiles() ?: emptyArray())
      .filter { it.name.endsWith(".json") }
      .mapNotNull { f -> try { JSONObject(f.readText()) } catch (e: Exception) { null } }
      .sortedBy { it.optDouble("at") }

  /**
   * App reads unprocessed tapped actions without deleting them (R07): the app executes them one
   * by one, records completion, and then uses removeQueue to confirm deletion. id is the filename
   * (without .json). Unreadable ones are kept and retried next time.
   */
  fun readQueue(ctx: Context): List<Map<String, String>> {
    val files = (queueDir(ctx).listFiles() ?: emptyArray())
      .filter { it.name.endsWith(".json") }
      .sortedBy { it.name }
    return files.mapNotNull { f ->
      try { mapOf("id" to f.name.removeSuffix(".json"), "text" to f.readText()) } catch (e: Exception) { null }
    }
  }

  /** Delete processed taps. Only recognizes filenames within the queue directory: paths containing IDs are not deleted. */
  fun removeQueue(ctx: Context, ids: List<String>) {
    val dir = queueDir(ctx)
    for (id in ids) {
      if (id.isEmpty() || id.contains('/') || id.contains("..")) continue
      File(dir, "$id.json").delete()
    }
  }

  fun bind(ctx: Context, widgetId: Int, itemId: String) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("w$widgetId", itemId).apply()
  }

  fun unbind(ctx: Context, widgetId: Int) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("w$widgetId").apply()
  }

  /** Which component this widget displays: bound upon desktop placement; if added directly from the desktop's widget list, displays the most recently placed one. */
  fun itemFor(ctx: Context, widgetId: Int, snap: JSONObject): String? {
    val bound = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("w$widgetId", null)
    val items = snap.optJSONArray("items") ?: JSONArray()
    if (bound != null) return bound
    return if (items.length() > 0) items.getJSONObject(items.length() - 1).getString("id") else null
  }
}

/** Which layout this component should currently render; stale: tapped actions cannot be re-evaluated (mixed taps of various types, too many taps, or spanning across days). Same as iOS resolveView. */
data class Resolved(val view: JSONObject?, val stale: Boolean)

fun resolveView(snap: JSONObject, item: String, nowMs: Double, queued: List<JSONObject>): Resolved {
  val states = snap.optJSONArray("states") ?: return Resolved(null, false)
  if (states.length() == 0) return Resolved(null, false)
  var state: JSONObject = states.getJSONObject(states.length() - 1)
  for (i in 0 until states.length()) {
    val s = states.getJSONObject(i)
    if (nowMs < s.getDouble("until")) { state = s; break }
  }
  val pastEnd = nowMs >= states.getJSONObject(states.length() - 1).getDouble("until")
  val base = state.getJSONObject("views").optJSONObject(item)
  if (queued.isEmpty()) return Resolved(base, pastEnd)
  val keys = queued.map { it.getString("op") }.toSet()
  val list = if (keys.size == 1) state.getJSONObject("after").optJSONArray(keys.first()) else null
  val from = state.getDouble("from")
  if (list != null && queued.size <= list.length() && queued.all { it.getDouble("at") >= from }) {
    return Resolved(list.getJSONObject(queued.size - 1).optJSONObject(item) ?: base, pastEnd)
  }
  return Resolved(base, true)
}
