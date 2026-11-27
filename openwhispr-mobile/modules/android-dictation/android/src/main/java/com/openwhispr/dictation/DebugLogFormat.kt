package com.openwhispr.dictation

import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The debug log's line format and its privacy rule, free of Android so it runs in unit tests.
 *
 * A line is `time level area event key=value…`. Fields are numbers, booleans, or short strings
 * under a key in [KEYS]; a string under any other key is written as `<n chars>`, so free text
 * (a transcript, a prompt, a note) can't reach the file by mistake. Keep [KEYS] in step with
 * `src/android/lib/debugLogKeys.ts`: a jest test compares the two.
 */
object DebugLogFormat {
  const val MAX_FILE_BYTES = 1_000_000L
  const val MAX_STRING = 64
  const val MAX_ERROR = 160
  const val MAX_JS_LINE = 1_000

  /** Keys whose string values are identifiers or codes, never user content. */
  val KEYS: Set<String> = setOf(
    // debug-log-keys:start
    "accepted", "action", "attempt", "audio_ms", "background", "battery", "buffer", "bytes", "cap", "card",
    "category", "chars", "checksum", "class", "cleared", "close_code", "cloud", "code", "cold", "count",
    "dict_accepted", "dict_refused", "dict_sent", "dict_total", "dropped", "duration_ms", "enabled", "error",
    "ext", "failed", "fatal", "field", "found", "from", "has_context", "has_react", "hash", "held_ms",
    "in_chars", "init_state", "job", "keyboard", "kind", "lang", "level", "local", "method",
    "mime", "mode", "model", "module", "ms", "n", "new_mode", "new_model", "new_provider", "new_tier",
    "offline", "ok", "old_mode", "old_model", "old_provider", "old_tier", "out_chars", "outcome", "owner",
    "parked", "peak", "percent", "pkg", "placement", "plan", "provider", "pulled", "pushed", "rate",
    "ready", "reason", "recovered", "req", "requester", "result", "retry", "revision", "route", "run",
    "saved", "scope", "seconds", "segments", "service", "signed_in", "since_ms",
    "size", "source", "source_lang", "state", "status", "streaming", "surface", "table",
    "target_lang", "task", "to", "tone", "tool", "type", "visible", "wait_ms", "why", 
    // debug-log-keys:end
  )

  private val random = SecureRandom()
  private const val ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

  /** A short id for one attempt: `d-7k2q` (d dictation, a assistant, t translation, m meeting, u upload). */
  fun runId(kind: Char): String = buildString {
    append(kind); append('-')
    repeat(4) { append(ALPHABET[random.nextInt(ALPHABET.length)]) }
  }

  /** First 8 hex of SHA-256, for "was it the same text?" without the text. */
  fun hash(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).take(4).joinToString("") { "%02x".format(it) }

  fun timestamp(ms: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US).format(Date(ms))

  /** One line with no newline; [fields] in their given order, nulls left out. */
  fun line(ms: Long, level: Char, area: String, event: String, fields: Map<String, Any?>): String = buildString {
    append(timestamp(ms)); append(' '); append(level); append(' ')
    append(token(area, 8).padEnd(6)); append(' ')
    append(token(event, 40))
    for ((key, value) in fields) {
      if (value == null) continue
      append(' '); append(token(key, 24)); append('='); append(value(key, value))
    }
  }

  /** A field's value as written. */
  fun value(key: String, value: Any?): String = when (value) {
    null -> ""
    is Boolean -> value.toString()
    is Int, is Long, is Short -> value.toString()
    is Float -> number(value.toDouble())
    is Double -> number(value)
    is Enum<*> -> safe(value.name.lowercase(Locale.US), MAX_STRING)
    is CharSequence -> {
      val text = value.toString()
      when {
        key == "error" -> quote(safe(text, MAX_ERROR))
        key in KEYS -> quote(safe(text, MAX_STRING))
        else -> "<${text.length} chars>"
      }
    }
    else -> "<${value.javaClass.simpleName}>"
  }

  /** An error as class and message, cut short. Provider bodies never go through here. */
  fun error(error: Throwable): String = "${error.javaClass.simpleName}: ${error.message.orEmpty()}"

  /**
   * A line JS already formatted through the same rules: kept to one line and [MAX_JS_LINE] chars.
   * JS can't add a field the native rules would drop, because its formatter applies the same key list.
   */
  fun jsLine(text: String): String = text.replace(Regex("[\\r\\n\\u2028\\u2029]+"), " ").take(MAX_JS_LINE)

  private fun number(value: Double): String =
    if (value == Math.floor(value) && !value.isInfinite() && kotlin.math.abs(value) < 1e15) value.toLong().toString()
    else String.format(Locale.US, "%.2f", value)

  private fun token(text: String, max: Int) = text.replace(Regex("[^A-Za-z0-9_.:/-]"), "_").take(max)

  private fun safe(text: String, max: Int): String {
    val clean = text.replace(Regex("[\\p{Cntrl}\\u2028\\u2029]+"), " ").trim()
    return if (clean.length > max) clean.take(max - 1) + "…" else clean
  }

  private fun quote(text: String) =
    if (text.isNotEmpty() && text.none { it == ' ' || it == '"' || it == '=' }) text
    else "\"" + text.replace("\"", "'") + "\""
}

/**
 * Two files, newest last: [current] grows to [maxBytes], then becomes [previous]. So the log
 * keeps the newest one to two files' worth and never more.
 */
class DebugLogFiles(private val directory: File, private val maxBytes: Long = DebugLogFormat.MAX_FILE_BYTES) {
  val current get() = File(directory, "log.0")
  val previous get() = File(directory, "log.1")

  fun append(lines: List<String>) {
    if (lines.isEmpty()) return
    directory.mkdirs()
    val text = lines.joinToString("\n", postfix = "\n")
    if (current.exists() && current.length() + text.length > maxBytes) rotate()
    current.appendText(text)
  }

  fun rotate() {
    previous.delete()
    if (current.exists()) current.renameTo(previous)
  }

  fun clear() { previous.delete(); current.delete() }

  fun hasLog() = current.exists() || previous.exists()

  /**
   * The whole log, oldest line first. JS lines arrive in batches, so the file can hold them a moment
   * after native lines written later; every line starts with the same timestamp format, so a stable
   * sort on it puts them back in order.
   */
  fun copyTo(out: java.io.OutputStream) {
    val lines = listOf(previous, current).filter { it.exists() }.flatMap { it.readLines() }.filter { it.isNotEmpty() }
    val writer = out.bufferedWriter()
    lines.sortedBy { it.take(28) }.forEach { writer.write(it); writer.write("\n") }
    writer.flush()
  }
}
