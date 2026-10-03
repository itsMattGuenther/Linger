package io.crates.keyring

import android.content.Context

// The hook `android-native-keyring-store` exports (src-tauri/src/secrets.rs):
// it needs the app's context to reach the Android Keystore, and Tauri doesn't
// hand it over. The native side is linked into Linger's own library, which
// Tauri has loaded by the time MainActivity calls this.
class Keyring {
  companion object {
    external fun initializeNdkContext(context: Context)
  }
}
