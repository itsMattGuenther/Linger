package io.github.itsmattguenther.linger

import android.Manifest
import android.app.Activity
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
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * The call bar (#429, SPEC §4.15): while you're in voice, the one
 * notification Linger ever shows, so the call keeps going with the phone
 * locked or another app in front. Android stops a background app's
 * microphone and network within seconds unless a foreground service holds
 * them, and a foreground service must show a notification. This is that
 * service. It plays nothing and records nothing itself: the page's call
 * (src/lib/pageVoice.ts) does, and this keeps the app alive while it does.
 *
 * It is silent, never pops up, and goes when the call does. Its buttons are
 * Mute and Leave, which reach the page as a `linger:callbar` event
 * (MainActivity). The page says when to show it and what it says, through
 * src-tauri/src/phone_call.rs, which calls [update].
 */
class VoiceCallService : Service() {
  companion object {
    const val CHANNEL = "voice"
    const val SHOWN = 429
    const val MUTE = "io.github.itsmattguenther.linger.callbar.MUTE"
    const val UNMUTE = "io.github.itsmattguenther.linger.callbar.UNMUTE"
    const val LEAVE = "io.github.itsmattguenther.linger.callbar.LEAVE"
    private const val PLACE = "place"
    private const val MUTED = "muted"
    private const val DEAFENED = "deafened"

    /** Whether the service is up, so a change only redraws the bar. */
    @Volatile private var running = false

    /** The app's one screen, to ask once whether the bar may show. */
    var activity: WeakReference<Activity>? = null

    /**
     * Show the bar for a call in [place] ("#general", or a DM's people), or
     * redraw it after mute or deafen; `null` ends it. Called from Rust
     * (phone_call.rs) on any thread.
     */
    @JvmStatic
    fun update(context: Context, place: String?, muted: Boolean, deafened: Boolean) {
      if (place == null) {
        context.stopService(Intent(context, VoiceCallService::class.java))
        return
      }
      if (running) {
        // Already a foreground service: redrawing it is a notification of
        // the same id. Starting it again from the background isn't allowed.
        if (mayShow(context)) {
          NotificationManagerCompat.from(context).notify(SHOWN, bar(context, place, muted, deafened))
        }
        return
      }
      askToShow()
      val start = Intent(context, VoiceCallService::class.java)
        .putExtra(PLACE, place)
        .putExtra(MUTED, muted)
        .putExtra(DEAFENED, deafened)
      ContextCompat.startForegroundService(context, start)
    }

    private fun mayShow(context: Context): Boolean =
      Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * Android 13 and later ask the person before any notification shows,
     * this one included. Asked on joining voice, the first time and until
     * they answer; Android stops asking after a second "Don't allow". The
     * call keeps going either way: without the bar it is only harder to
     * mute or leave from outside the app.
     */
    private fun askToShow() {
      val screen = activity?.get() ?: return
      if (mayShow(screen)) return
      screen.runOnUiThread {
        screen.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), SHOWN)
      }
    }

    private fun bar(context: Context, place: String, muted: Boolean, deafened: Boolean): android.app.Notification {
      channel(context)
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      fun action(what: String, code: Int) =
        PendingIntent.getBroadcast(context, code, Intent(what).setPackage(context.packageName), flags)
      val where = if (place.startsWith("#")) "In voice in $place" else "In voice with $place"
      return NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.ic_call_bar)
        .setContentTitle(where)
        .setContentText(if (deafened) "Deafened" else if (muted) "Muted" else "Linger")
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setOngoing(true)
        .setSilent(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(open?.let { PendingIntent.getActivity(context, 0, it, flags) })
        .addAction(0, if (muted) "Unmute" else "Mute", action(if (muted) UNMUTE else MUTE, 1))
        .addAction(0, "Leave", action(LEAVE, 2))
        .build()
    }

    /** The bar's channel: low, so it never makes a sound or pops up. */
    private fun channel(context: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(CHANNEL) != null) return
      val channel = NotificationChannel(CHANNEL, "Voice calls", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shows while you're in voice, so the call keeps going with the phone locked."
        setShowBadge(false)
        enableVibration(false)
        setSound(null, null)
      }
      manager.createNotificationChannel(channel)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val place = intent?.getStringExtra(PLACE)
    if (place == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val shown = bar(this, place, intent.getBooleanExtra(MUTED, false), intent.getBooleanExtra(DEAFENED, false))
    if (Build.VERSION.SDK_INT >= 30) {
      startForeground(SHOWN, shown, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(SHOWN, shown)
    }
    running = true
    // Killed by the system, it isn't brought back: the call lived in the
    // page, which went with it.
    return START_NOT_STICKY
  }

  // Swiped away from the recent apps: the page, and the call, are gone.
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }
}
