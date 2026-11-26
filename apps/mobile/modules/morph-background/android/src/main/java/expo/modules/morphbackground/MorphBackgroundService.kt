package expo.modules.morphbackground

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlin.math.roundToInt

// Foreground service for long-running tasks (D-160): during execution, there is a progress
// notification in the status bar, and tasks continue to run even when Morph switches to another app
// or the lock screen activates. The service itself does not perform tasks; it only prevents the
// system from freezing or killing the app process. Video and audio are still handled by morph-media
// / morph-speech. Starting with Android 15, the type is mediaProcessing (at most 6 hours every 24
// hours; onTimeout is called when reached); Android 14 uses dataSync.

private const val TAG = "MorphBackground"

class MorphBackgroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stop()
      return START_NOT_STICKY
    }
    val notification = progressNotification(
      this,
      intent?.getStringExtra(EXTRA_TITLE).orEmpty(),
      intent?.getStringExtra(EXTRA_TEXT).orEmpty(),
      null,
    )
    // Try mediaProcessing first and fall back to dataSync if the system refuses it. Call the platform method, not ServiceCompat's: androidx.core (1.18.0) drops mediaProcessing, and the system then sees no type.
    val started = serviceTypes().any { type ->
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          startForeground(NOTIFICATION_ID, notification, type)
        } else {
          startForeground(NOTIFICATION_ID, notification)
        }
        true
      } catch (e: Exception) {
        Log.w(TAG, "startForeground failed (type $type)", e)
        false
      }
    }
    if (!started) {
      // When the system disallows it (e.g. already in the background): do not keep alive, and tasks run only in the foreground as usual.
      stopSelf()
      return START_NOT_STICKY
    }
    running = true
    if (wakeLock == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      // Keep the CPU awake after screen lock; maximum of 7 hours (mediaProcessing allows up to 6 hours daily) to prevent forgetting to release it.
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Morph:background").apply {
        setReferenceCounted(false)
        acquire(7 * 60 * 60 * 1000L)
      }
    }
    return START_NOT_STICKY
  }

  // Android 15: today's 6 hours for this type have been exhausted. Stop the service, and return the task to normal background rules.
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(TAG, "foreground service timed out")
    stop()
  }

  override fun onDestroy() {
    running = false
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun stop() {
    running = false
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  companion object {
    const val NOTIFICATION_ID = 3101
    const val DONE_NOTIFICATION_ID = 3102
    private const val CHANNEL_WORK = "morph_background_work"
    private const val CHANNEL_DONE = "morph_background_done"
    private const val ACTION_STOP = "expo.modules.morphbackground.STOP"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"

    /** The service is already in the foreground (startForeground succeeded and not yet stopped): only update the progress notification under this condition. */
    @Volatile
    var running = false
      private set

    private fun serviceTypes(): List<Int> = when {
      Build.VERSION.SDK_INT >= 35 -> listOf(
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> listOf(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else -> listOf(0)
    }

    /** Start keep-alive; returns false when the system disallows it (starting with Android 12, apps cannot start foreground services from the background). */
    fun start(context: Context, title: String, text: String): Boolean {
      ensureChannels(context)
      val intent = Intent(context, MorphBackgroundService::class.java)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_TEXT, text)
      return try {
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (e: Exception) {
        Log.w(TAG, "could not start the foreground service", e)
        false
      }
    }

    /** End keep-alive. Follows the same queue as start to ensure startForeground runs before stopping (doing it in reverse causes the system to crash the app). */
    fun stop(context: Context) {
      val intent = Intent(context, MorphBackgroundService::class.java).setAction(ACTION_STOP)
      try {
        context.startService(intent)
      } catch (e: Exception) {
        // When the service is not running (start failed previously), background apps cannot call startService.
        context.stopService(Intent(context, MorphBackgroundService::class.java))
      }
    }

    fun canNotify(context: Context): Boolean =
      Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED

    fun progressNotification(context: Context, title: String, text: String, fraction: Double?): Notification =
      NotificationCompat.Builder(context, CHANNEL_WORK)
        .setSmallIcon(R.drawable.morph_background_working)
        .setContentTitle(title)
        .setContentText(text)
        .setProgress(100, ((fraction ?: 0.0) * 100).roundToInt().coerceIn(0, 100), fraction == null)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(openApp(context))
        .build()

    fun doneNotification(context: Context, title: String, body: String): Notification {
      ensureChannels(context)
      return NotificationCompat.Builder(context, CHANNEL_DONE)
        .setSmallIcon(R.drawable.morph_background_done)
        .setContentTitle(title)
        .setContentText(body)
        .setAutoCancel(true)
        .setCategory(NotificationCompat.CATEGORY_STATUS)
        .setContentIntent(openApp(context))
        .build()
    }

    /** Tapping the notification returns to Morph's original task (run page or result page) without opening a new page. */
    private fun openApp(context: Context): PendingIntent? =
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { intent ->
        PendingIntent.getActivity(
          context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
      }

    private fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (manager.getNotificationChannel(CHANNEL_WORK) == null) {
        manager.createNotificationChannel(
          NotificationChannel(
            CHANNEL_WORK,
            context.getString(R.string.morph_background_channel_work),
            NotificationManager.IMPORTANCE_LOW,
          ).apply {
            description = context.getString(R.string.morph_background_channel_work_description)
            setShowBadge(false)
          }
        )
      }
      if (manager.getNotificationChannel(CHANNEL_DONE) == null) {
        manager.createNotificationChannel(
          NotificationChannel(
            CHANNEL_DONE,
            context.getString(R.string.morph_background_channel_done),
            NotificationManager.IMPORTANCE_DEFAULT,
          ).apply {
            description = context.getString(R.string.morph_background_channel_done_description)
          }
        )
      }
    }
  }
}
