# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# The call bar (#429): Rust calls VoiceCallService.update by its Java name,
# through JNI (src-tauri/src/phone_call.rs). Without this the release build
# removed it, and the call bar never showed (#834). scripts/android-jni.mjs
# checks a release build keeps it, and that every class Rust names has a
# rule here.
-keep class io.github.itsmattguenther.linger.VoiceCallService { *; }
-keep class io.github.itsmattguenther.linger.VoiceCallService$Companion { *; }

# Phone notifications (#830): Rust calls PushBridge.answer by its Java name,
# through JNI (src-tauri/src/phone_push.rs). scripts/android-jni.mjs checks a
# release build keeps it.
-keep class io.github.itsmattguenther.linger.PushBridge { *; }
