package expo.modules.morphbackground

import android.Manifest
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// Android portion for keeping long tasks running in the background (D-160–D-162). JS calls begin at
// the start of a run, update during execution, and end upon completion; implemented in
// MorphBackgroundService.kt. Shares the same JS interface as iOS.

class DoneNotice : Record {
  @Field val title: String = ""
  @Field val body: String = ""
}

private const val PREFS = "morph-background"
private const val KEY_ASKED = "askedNotifications"

class MorphBackgroundModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React Application Context is null" }

  /**
   * True after successful begin and before end. Only during this period and when the service has
   * truly entered the foreground will progress notifications be updated; otherwise, an ordinary
   * notification would be sent that cannot be dismissed by stopping the service.
   */
  private var active = false
  private var title = ""

  override fun definition() = ModuleDefinition {
    Name("MorphBackground")

    Constant("continuesInBackground") { true }

    // Starting with Android 13, user permission is required to show notifications: ask once if never permitted, and never ask again (D-161). If denied, the task runs as usual.
    AsyncFunction("ensureNotificationPermission") { promise: Promise ->
      val permissions = appContext.permissions
      if (Build.VERSION.SDK_INT < 33 || permissions == null) {
        promise.resolve(NotificationManagerCompat.from(context).areNotificationsEnabled())
        return@AsyncFunction
      }
      if (permissions.hasGrantedPermissions(Manifest.permission.POST_NOTIFICATIONS)) {
        promise.resolve(true)
        return@AsyncFunction
      }
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (prefs.getBoolean(KEY_ASKED, false)) {
        promise.resolve(false)
        return@AsyncFunction
      }
      prefs.edit { putBoolean(KEY_ASKED, true) }
      permissions.askForPermissions(
        { result ->
          promise.resolve(result[Manifest.permission.POST_NOTIFICATIONS]?.status == PermissionsStatus.GRANTED)
        },
        Manifest.permission.POST_NOTIFICATIONS,
      )
    }

    Function("begin") { title: String, text: String ->
      this@MorphBackgroundModule.title = title
      active = MorphBackgroundService.start(context, title, text)
      active
    }

    Function("update") { text: String, fraction: Double? ->
      if (!active || !MorphBackgroundService.running || !MorphBackgroundService.canNotify(context)) {
        return@Function
      }
      try {
        NotificationManagerCompat.from(context).notify(
          MorphBackgroundService.NOTIFICATION_ID,
          MorphBackgroundService.progressNotification(context, title, text, fraction),
        )
      } catch (_: SecurityException) {
      }
    }

    // Background handling for the reminder button (D-318) on Android is managed by expo-task-manager's background task, so nothing needs to be done here.
    Function("releaseActionTime") {}

    Function("end") { done: DoneNotice? ->
      if (active) MorphBackgroundService.stop(context)
      active = false
      if (done == null || !MorphBackgroundService.canNotify(context)) return@Function
      try {
        NotificationManagerCompat.from(context).notify(
          MorphBackgroundService.DONE_NOTIFICATION_ID,
          MorphBackgroundService.doneNotification(context, done.title, done.body),
        )
      } catch (_: SecurityException) {
      }
    }
  }
}
