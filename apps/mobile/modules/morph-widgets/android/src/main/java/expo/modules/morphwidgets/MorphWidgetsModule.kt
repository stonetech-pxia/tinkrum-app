package expo.modules.morphwidgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// App-side implementation for desktop widgets (D-321–D-323): renders and redraws layouts, retrieves
// tapped actions, and requests pinning widgets to the desktop. When a widget action is tapped while
// the app is running, triggers onQueue so JS immediately retrieves and executes it.

class MorphWidgetsModule : Module() {
  companion object {
    @Volatile private var current: MorphWidgetsModule? = null

    fun notifyQueue() {
      current?.sendEvent("onQueue", mapOf<String, Any>())
    }
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  override fun definition() = ModuleDefinition {
    Name("MorphWidgets")

    Events("onQueue")

    OnCreate { current = this@MorphWidgetsModule }
    OnDestroy { if (current === this@MorphWidgetsModule) current = null }

    AsyncFunction("setSnapshot") { json: String ->
      val ctx = context
      WidgetStore.writeSnapshot(ctx, json)
      WidgetRender.updateAll(ctx)
      WidgetRender.scheduleNext(ctx)
    }

    AsyncFunction("readQueue") { WidgetStore.readQueue(context) }

    AsyncFunction("removeQueue") { ids: List<String> -> WidgetStore.removeQueue(context, ids) }

    Function("canPin") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        AppWidgetManager.getInstance(context).isRequestPinAppWidgetSupported
    }

    // System pops up a confirmation dialog (some launchlers place it directly), determined by the user; upon successful placement, the system callbacks ACTION_BIND to record which component is displayed.
    AsyncFunction("pin") { itemId: String, _: String ->
      val ctx = context
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction false
      val manager = AppWidgetManager.getInstance(ctx)
      if (!manager.isRequestPinAppWidgetSupported) return@AsyncFunction false
      val callback = Intent(ctx, MorphWidgetProvider::class.java)
        .setAction(ACTION_BIND)
        .setData(Uri.parse("morph-widget://bind/${Uri.encode(itemId)}"))
        .putExtra(EXTRA_ITEM, itemId)
      // The system needs to populate the widget ID into the callback, so it is MUTABLE.
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
      val pending = PendingIntent.getBroadcast(ctx, itemId.hashCode(), callback, flags)
      manager.requestPinAppWidget(ComponentName(ctx, MorphWidgetProvider::class.java), null, pending)
    }
  }
}
