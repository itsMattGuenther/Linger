package io.github.itsmattguenther.linger

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import java.lang.ref.WeakReference
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Phone notifications, what the page asks of Android (#830,
 * src-tauri/src/phone_push.rs). Rust calls `answer` with a small JSON request
 * and gets JSON back: one name crosses between them, which
 * scripts/android-jni.mjs checks a release build keeps.
 *
 * Firebase only ever runs when somebody turns notifications on: it doesn't
 * start itself (`firebase_messaging_auto_init_enabled` is off in the
 * manifest), and asking for the push address is what starts it.
 */
object PushBridge {
  /** Linger's notification permission request, told apart from the call bar's (429). */
  const val ASK = 830

  const val OPEN = "io.github.itsmattguenther.linger.PUSH_OPEN"
  const val SERVER = "linger_push_server"
  const val ROOM = "linger_push_room"
  const val MESSAGE = "linger_push_message"

  private const val FILE = "linger-push-state"
  private const val ASKED = "asked"

  /** The app's screen, while it has one: asking for permission needs it. */
  @Volatile var activity: WeakReference<Activity>? = null

  /** The app is on screen: a notification then would only repeat what it shows. */
  @Volatile var inFront = false

  /** The conversation the last tapped notification is about, until the page takes it. */
  @Volatile private var opened: JSONObject? = null

  @JvmStatic
  fun answer(context: Context, request: String): String = try {
    val asked = JSONObject(request)
    when (asked.getString("do")) {
      "permission" -> JSONObject().put("state", permission(context))
      "ask" -> JSONObject().put("state", ask(context))
      "address" -> address()
      "keys" -> keys(context, asked.getString("server"))
      "forget" -> forget(context, asked.getString("server"))
      "opened" -> opened.also { opened = null } ?: JSONObject()
      else -> JSONObject().put("error", "Linger asked for something this phone doesn't do.")
    }.toString()
  } catch (e: Exception) {
    JSONObject().put("error", "This phone couldn't do that.").toString()
  }

  /** `granted`, `denied`, or `ask` when the person hasn't been asked yet. */
  private fun permission(context: Context): String {
    val allowed = Build.VERSION.SDK_INT < 33 ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    if (allowed && NotificationManagerCompat.from(context).areNotificationsEnabled()) return "granted"
    if (Build.VERSION.SDK_INT < 33 || state(context).getBoolean(ASKED, false)) return "denied"
    return "ask"
  }

  /**
   * Ask once (Android 13 and later), when the person turns notifications on.
   * The answer reaches the page as `linger:push-permission` (MainActivity).
   */
  private fun ask(context: Context): String {
    val now = permission(context)
    if (now != "ask") return now
    val screen = activity?.get() ?: return "ask"
    state(context).edit().putBoolean(ASKED, true).apply()
    screen.runOnUiThread { screen.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), ASK) }
    return "asking"
  }

  private fun state(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  /** The phone's push address from Google. Never asked on the main thread: Rust calls this off it. */
  private fun address(): JSONObject = try {
    JSONObject().put("address", Tasks.await(FirebaseMessaging.getInstance().token, 20, TimeUnit.SECONDS))
  } catch (e: Exception) {
    JSONObject().put("error", "Google's push service didn't answer. Is Google Play services on this phone?")
  }

  private fun keys(context: Context, server: String): JSONObject {
    val keys = PushKeys.forServer(context, server)
    return JSONObject().put("public_key", PushKeys.encode(keys.public)).put("auth_secret", PushKeys.encode(keys.auth))
  }

  /** With no server left, the push address goes too: nothing should hold one for an app that wants nothing. */
  private fun forget(context: Context, server: String): JSONObject {
    if (!PushKeys.forget(context, server)) FirebaseMessaging.getInstance().deleteToken()
    return JSONObject()
  }

  /** A tapped notification opened the app (MainActivity): keep its conversation for the page. */
  fun tapped(intent: Intent?): Boolean {
    if (intent?.action != OPEN) return false
    val server = intent.getStringExtra(SERVER) ?: return false
    opened = JSONObject().put("server", server).apply {
      intent.getStringExtra(ROOM)?.let { put("room", it) }
      intent.getStringExtra(MESSAGE)?.let { put("message", it) }
    }
    return true
  }
}
