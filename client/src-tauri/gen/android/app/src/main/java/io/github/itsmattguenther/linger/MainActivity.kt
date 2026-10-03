package io.github.itsmattguenther.linger

import android.os.Bundle
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
}
