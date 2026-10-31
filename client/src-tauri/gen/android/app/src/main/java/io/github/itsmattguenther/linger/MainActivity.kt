package io.github.itsmattguenther.linger

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import io.crates.keyring.Keyring
import java.lang.ref.WeakReference

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  // The call bar's Mute, Unmute and Leave (#429, VoiceCallService): to the
  // page, which acts on them as on its own buttons (app/list/ListWindow.tsx).
  private val callBar = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val what = when (intent.action) {
        VoiceCallService.MUTE -> "mute"
        VoiceCallService.UNMUTE -> "unmute"
        VoiceCallService.LEAVE -> "leave"
        else -> return
      }
      webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('linger:callbar', { detail: '$what' }))", null)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Sign-ins are kept in the Android Keystore (src-tauri/src/secrets.rs),
    // which needs the app's context first.
    Keyring.initializeNdkContext(applicationContext)
    VoiceCallService.activity = WeakReference(this)
    val actions = IntentFilter().apply {
      addAction(VoiceCallService.MUTE)
      addAction(VoiceCallService.UNMUTE)
      addAction(VoiceCallService.LEAVE)
    }
    ContextCompat.registerReceiver(this, callBar, actions, ContextCompat.RECEIVER_NOT_EXPORTED)
    // A share that started Linger (#785). Not again when Android rebuilds the
    // screen (a turn of the phone), which hands back the same intent.
    if (savedInstanceState == null) takeShare(intent)
  }

  // A share to Linger while it's running (#785): the activity is `singleTask`,
  // so the share comes here instead of starting another copy of the app.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    takeShare(intent)
  }

  // Into the inbox (SharedInbox), then the page is told to look
  // (core/shareInbox.ts, ANDROID_SHARED). A page still loading looks when it
  // starts, so nothing is lost if this arrives first.
  private fun takeShare(intent: Intent?) {
    if (intent == null || !SharedInbox.isShare(intent)) return
    SharedInbox.take(this, intent) {
      webView?.evaluateJavascript("window.dispatchEvent(new Event('linger:shared'))", null)
    }
  }

  // Linger sizes its own text, lines and rows by the phone's Font size
  // (src-tauri/src/phone_text.rs, core/phone.ts). Left on, the web view would
  // enlarge fonts and line spacing by itself and nothing around them, and cut
  // the words in half. Pinch and double-tap zoom are off too (#689): a zoomed
  // screen is wider than the phone and drags sideways. next.html's viewport
  // says the same; this holds whatever the web view makes of the viewport.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.settings.textZoom = 100
    webView.settings.setSupportZoom(false)
    this.webView = webView
  }

  // The page, and any call in it, ends with the app's one screen: the bar
  // goes too.
  override fun onDestroy() {
    unregisterReceiver(callBar)
    VoiceCallService.update(applicationContext, null, false, false)
    webView = null
    super.onDestroy()
  }
}
