package io.github.itsmattguenther.linger

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.IntentCompat
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.Executors

/**
 * Share to Linger (#785, SPEC §4.15): what another app's share sheet sent,
 * copied into the inbox the shell reads (`src-tauri/src/shared.rs`), each file
 * in a numbered folder of its own: `files/shared/0/Screenshot.png`.
 *
 * Copies go into `files/shared-incoming` and take the inbox's place with one
 * rename once every file is whole, so the page never reads half a file, and a
 * new share replaces the last. They run one at a time, off the main thread.
 *
 * Only files another app shares: a `file://` address, or one from Linger's own
 * FileProvider, is refused, since a share pointing back into Linger's own
 * storage would put Linger's private files in a message box. Nothing about the
 * app that shared is kept or sent (AGENTS.md hard rule 2).
 */
object SharedInbox {
  /** The inbox's name in the app's files folder, as `shared.rs` reads it. */
  private const val INBOX = "shared"
  private const val INCOMING = "shared-incoming"

  /** As many files as one message takes (`linger-core`, `MAX_ATTACHMENTS_PER_MESSAGE`). */
  private const val MOST_FILES = 10

  /** One byte past the 500 MB a file can be: the shell then says it's too big without the rest being copied. */
  private const val MOST_BYTES = 500L * 1024 * 1024 + 1

  /** The longest name a shared file is given, in characters, keeping a short extension. */
  private const val LONGEST_NAME = 120
  private const val LONGEST_EXTENSION = 16

  private val copying = Executors.newSingleThreadExecutor()

  /** Whether `intent` is a share to Linger. */
  fun isShare(intent: Intent?): Boolean =
    intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

  /**
   * Copy what `intent` shared into the inbox, then call `done` on the main
   * thread, which tells the page to look. Does nothing for an intent that
   * isn't a share.
   */
  fun take(context: Context, intent: Intent, done: () -> Unit) {
    if (!isShare(intent)) return
    val uris = streams(intent).filter { allowed(context, it) }.take(MOST_FILES)
    val app = context.applicationContext
    copying.execute {
      copyAll(app, uris)
      android.os.Handler(android.os.Looper.getMainLooper()).post(done)
    }
  }

  /** The files a share carries, by its extras, or its clip data when an app put them only there. */
  private fun streams(intent: Intent): List<Uri> {
    val listed = when (intent.action) {
      Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
      else -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
    }
    if (listed.isNotEmpty()) return listed
    val clip = intent.clipData ?: return emptyList()
    return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
  }

  /**
   * Another app's content, and never a way back into Linger's own files: no
   * `file://` address, and nothing from a provider of Linger's own (its
   * FileProvider is `<package>.fileprovider`).
   */
  private fun allowed(context: Context, uri: Uri): Boolean =
    uri.scheme == ContentResolver.SCHEME_CONTENT && !uri.authority.orEmpty().startsWith(context.packageName)

  private fun copyAll(context: Context, uris: List<Uri>) {
    val files = context.filesDir
    val incoming = File(files, INCOMING)
    val inbox = File(files, INBOX)
    incoming.deleteRecursively()
    incoming.mkdirs()
    uris.forEachIndexed { place, uri ->
      val folder = File(incoming, place.toString())
      folder.mkdirs()
      try {
        context.contentResolver.openInputStream(uri)?.use { input ->
          FileOutputStream(File(folder, nameOf(context, uri))).use { output -> copyAtMost(input, output) }
        }
      } catch (_: Exception) {
        // Unreadable, or gone before it could be read: left out, and the
        // rest of the share still arrives.
        folder.deleteRecursively()
      }
    }
    inbox.deleteRecursively()
    if (!incoming.renameTo(inbox)) incoming.deleteRecursively()
  }

  /** Copy up to `MOST_BYTES`, so a file too big to send stops there. */
  private fun copyAtMost(input: InputStream, output: FileOutputStream) {
    val buffer = ByteArray(64 * 1024)
    var copied = 0L
    while (copied < MOST_BYTES) {
      val read = input.read(buffer, 0, minOf(buffer.size.toLong(), MOST_BYTES - copied).toInt())
      if (read < 0) break
      output.write(buffer, 0, read)
      copied += read
    }
  }

  /** The file's own name as the sharing app gives it, made safe; or "file" with its type's extension. */
  private fun nameOf(context: Context, uri: Uri): String {
    val given = try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
      }
    } catch (_: Exception) {
      null
    }
    val safe = safeName(given.orEmpty())
    if (safe.isNotEmpty()) return safe
    val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(context.contentResolver.getType(uri))
    return if (extension.isNullOrEmpty()) "file" else "file.$extension"
  }

  /**
   * A name made safe to be one file in one folder, by the rules downloads on
   * an iPhone follow (`src-tauri/src/phone_save.rs`, `file_name`): only what's
   * after the last slash, no control characters, none that turn text around
   * (#488), no colon, no leading dots, and at most `LONGEST_NAME` characters
   * with a short extension kept whole. Empty when nothing usable is left.
   */
  internal fun safeName(name: String): String {
    val last = name.substringAfterLast('/').substringAfterLast('\\')
    val kept = last.filter { !it.isISOControl() && !changesDirection(it) && it != ':' }
    val trimmed = kept.trim().trimStart('.').trimStart()
    if (trimmed.length <= LONGEST_NAME) return trimmed
    val dot = trimmed.lastIndexOf('.')
    val extension = if (dot > 0 && trimmed.length - dot <= LONGEST_EXTENSION) trimmed.substring(dot) else ""
    val stem = trimmed.substring(0, if (extension.isEmpty()) trimmed.length else dot)
    return stem.take(LONGEST_NAME - extension.length).trimEnd() + extension
  }

  private fun changesDirection(c: Char): Boolean =
    c in '‪'..'‮' || c in '⁦'..'⁩' || c == '؜' || c == '‎' || c == '‏'
}
