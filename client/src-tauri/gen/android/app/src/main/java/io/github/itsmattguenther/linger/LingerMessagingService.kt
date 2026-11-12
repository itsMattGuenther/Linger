package io.github.itsmattguenther.linger

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * A phone notification arriving (#830, SPEC §4.15, PROTOCOL §5), with Linger
 * closed or open. Google hands over what the relay passed on: the server's
 * notification, encrypted to one of this phone's keys. It's opened here
 * (PushCrypto, with the keys PushKeys keeps) and shown in the server's words.
 * Nothing in it is kept, and nothing is sent anywhere.
 */
class LingerMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val sealed = message.data["p"] ?: return
    val bytes = try {
      Base64.decode(sealed, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    } catch (e: IllegalArgumentException) {
      return
    }
    // Each server has keys of its own, so no two servers can tell they reach
    // this phone; the one that opens it says which server it's from.
    for (keys in PushKeys.all(this)) {
      val words = PushCrypto.decrypt(keys.private, keys.public, keys.auth, bytes) ?: continue
      show(this, keys.server, JSONObject(String(words, Charsets.UTF_8)))
      return
    }
  }

  // A new push address from Google: the page registers it with each server
  // the next time Linger starts (core/push.ts), as it does every start.
  override fun onNewToken(token: String) {}

  companion object {
    /** Each kind is a channel of its own, so the phone's own settings can turn one off. */
    private val CHANNELS = linkedMapOf(
      "mention" to ("mentions" to "Mentions"),
      "dm" to ("dms" to "DMs"),
      "knock" to ("knocks" to "Knocks"),
      "follow" to ("follows" to "People you follow"),
      "room" to ("rooms" to "Rooms"),
    )

    /** The channels, made once; never with a badge (hard rule 3). */
    fun channels(context: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val manager = context.getSystemService(NotificationManager::class.java)
      for ((id, name) in CHANNELS.values) {
        if (manager.getNotificationChannel(id) != null) continue
        manager.createNotificationChannel(
          NotificationChannel(id, name, NotificationManager.IMPORTANCE_DEFAULT).apply { setShowBadge(false) },
        )
      }
    }

    fun show(context: Context, server: String, note: JSONObject) {
      if (note.optInt("v") != 1) return
      // On screen, the app has it already, with its own sound.
      if (PushBridge.inFront) return
      val kind = note.optString("kind")
      val channel = CHANNELS[kind]?.first ?: return
      channels(context)
      val room = note.optString("room_id").ifEmpty { null }
      val message = note.optString("message_id").ifEmpty { null }
      val person = note.optString("user_id")
      // A room's notifications replace each other, a knock replaces that
      // person's last, and anything addressed to you stacks.
      val tag = when (kind) {
        "room" -> "room $server $room"
        "knock" -> "knock $server $person"
        else -> "message $server ${message ?: person}"
      }
      val open = Intent(context, MainActivity::class.java).apply {
        action = PushBridge.OPEN
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        putExtra(PushBridge.SERVER, server)
        room?.let { putExtra(PushBridge.ROOM, it) }
        message?.let { putExtra(PushBridge.MESSAGE, it) }
      }
      val tap = PendingIntent.getActivity(
        context, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val body = note.optString("body")
      val shown = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(note.optString("title"))
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setGroup("$server ${room ?: "knocks"}")
        .setBadgeIconType(NotificationCompat.BADGE_ICON_NONE)
        .setAutoCancel(true)
        .setContentIntent(tap)
        .build()
      try {
        NotificationManagerCompat.from(context).notify(tag, 1, shown)
      } catch (e: SecurityException) {
        // The permission was taken back since it was given: nothing to show.
      }
    }
  }
}
