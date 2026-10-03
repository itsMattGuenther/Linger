package io.github.itsmattguenther.linger

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Sign-ins are kept in the Android Keystore (src-tauri/src/secrets.rs),
    // which needs the app's context first.
    Keyring.initializeNdkContext(applicationContext)
  }

  // Linger sizes its own text, lines and rows by the phone's Font size
  // (src-tauri/src/phone_text.rs, core/phone.ts). Left on, the web view would
  // enlarge fonts and line spacing by itself and nothing around them, and cut
  // the words in half.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.settings.textZoom = 100
  }
}
