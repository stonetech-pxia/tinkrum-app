package expo.modules.morphshortcuts

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// Menu when long-pressing the Morph icon and standalone icons on the desktop (D-271). The shortcut
// ID is the quick action ID; tapping it opens the main app interface with intent action ACTION_OPEN
// and the ID in extras. On cold start, retrieved via takeLaunched after JS starts; while the app is
// running (singleTask, via onNewIntent), triggers onOpen. Uses the app's own icon; items with an
// image (D-606, user sub-apps) use the image drawn by JS: the full adaptive icon image (108dp
// square), which the desktop crops to its shape.

private const val ACTION_OPEN = "app.morph.mobile.OPEN_QUICK_ACTION"
private const val EXTRA_ID = "morphQuickAction"

class ShortcutItemRecord : Record {
  @Field val id: String = ""
  @Field val title: String = ""
  @Field val symbol: String? = null
  @Field val image: String? = null
}

class MorphShortcutsModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  override fun definition() = ModuleDefinition {
    Name("MorphShortcuts")

    Events("onOpen")

    AsyncFunction("setItems") { items: List<ShortcutItemRecord>, disabledMessage: String ->
      val ctx = context
      val infos = items.map { shortcut(ctx, it) }
      // Items already pinned to the desktop: re-enables those still in the menu and updates their
      // names; disables those no longer present (the app cannot remove desktop icons on behalf of
      // the user). Enables them first before adding them to the menu: disabled shortcuts cannot be
      // made dynamic directly.
      val wanted = items.map { it.id }.toSet()
      val pinned = ShortcutManagerCompat.getShortcuts(ctx, ShortcutManagerCompat.FLAG_MATCH_PINNED)
      val keep = infos.filter { info -> pinned.any { it.id == info.id } }
      val gone = pinned.map { it.id }.filter { it !in wanted }
      if (keep.isNotEmpty()) ShortcutManagerCompat.enableShortcuts(ctx, keep)
      ShortcutManagerCompat.setDynamicShortcuts(ctx, infos)
      if (keep.isNotEmpty()) ShortcutManagerCompat.updateShortcuts(ctx, keep)
      if (gone.isNotEmpty()) ShortcutManagerCompat.disableShortcuts(ctx, gone, disabledMessage)
    }

    Function("canPin") { ShortcutManagerCompat.isRequestPinShortcutSupported(context) }

    // The system displays a confirmation dialog (some desktops place the icon directly), and the user decides; this only indicates whether the request was successfully sent.
    AsyncFunction("pin") { item: ShortcutItemRecord ->
      val ctx = context
      ShortcutManagerCompat.isRequestPinShortcutSupported(ctx) &&
        ShortcutManagerCompat.requestPinShortcut(ctx, shortcut(ctx, item), null)
    }

    Function("takeLaunched") {
      val intent = appContext.currentActivity?.intent ?: return@Function null
      val id = idOf(intent) ?: return@Function null
      // Used only once: does not restart upon reloading JS or returning to the foreground.
      intent.action = Intent.ACTION_MAIN
      intent.removeExtra(EXTRA_ID)
      id
    }

    OnNewIntent { intent ->
      val id = idOf(intent) ?: return@OnNewIntent
      intent.action = Intent.ACTION_MAIN
      intent.removeExtra(EXTRA_ID)
      sendEvent("onOpen", mapOf("id" to id))
    }
  }

  private fun idOf(intent: Intent): String? =
    if (intent.action == ACTION_OPEN) intent.getStringExtra(EXTRA_ID)?.takeIf { it.isNotEmpty() } else null

  private fun shortcut(ctx: Context, item: ShortcutItemRecord): ShortcutInfoCompat {
    val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      ?: Intent().setPackage(ctx.packageName)
    val intent = Intent(ACTION_OPEN).apply {
      component = launch.component
      setPackage(ctx.packageName)
      putExtra(EXTRA_ID, item.id)
    }
    return ShortcutInfoCompat.Builder(ctx, item.id)
      .setShortLabel(item.title)
      .setLongLabel(item.title)
      .setIcon(iconOf(ctx, item))
      .setIntent(intent)
      .build()
  }

  /** The item's own icon; uses the app icon if missing or unreadable. */
  private fun iconOf(ctx: Context, item: ShortcutItemRecord): IconCompat {
    val bitmap = item.image?.let {
      runCatching {
        val bytes = Base64.decode(it, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      }.getOrNull()
    }
    return if (bitmap != null) IconCompat.createWithAdaptiveBitmap(bitmap)
    else IconCompat.createWithResource(ctx, ctx.applicationInfo.icon)
  }
}
