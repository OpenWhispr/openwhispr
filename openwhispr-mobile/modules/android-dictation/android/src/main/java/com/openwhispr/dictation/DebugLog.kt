package com.openwhispr.dictation

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The opt-in debug log (Settings › Analytics › Debug logging). It lives on this phone and leaves
 * only when the user taps Share logs. The bubble, the insertion service and the meeting service log
 * here directly; JS lines arrive through [AndroidDictationModule]'s `debugLog`.
 *
 * What may be written is decided by [DebugLogFormat]: ids, codes, counts and durations, never what
 * anyone said, wrote or recorded.
 */
object DebugLog {
  const val TAG = "OpenWhisprDebug"
  private const val PREFERENCES = "openwhispr_debug_log"
  private const val ENABLED = "enabled"
  private const val ENABLED_SINCE = "enabled_since"

  @Volatile var enabled = false
    private set
  @Volatile var enabledSince = 0L
    private set
  /** Whether the switch was already on when this process started. */
  @Volatile var onAtLaunch = false
    private set
  private var files: DebugLogFiles? = null
  private var cache: File? = null
  private val started = AtomicBoolean(false)
  private val queue = LinkedBlockingQueue<String>()
  private val writer = Executors.newSingleThreadScheduledExecutor { Thread(it, "openwhispr-debug-log").apply { isDaemon = true } }

  /** Milliseconds since this process started. */
  fun processAgeMs(): Long = SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()

  /** Safe to call from every entry point; only the first call does anything. */
  fun init(context: Context) {
    if (!started.compareAndSet(false, true)) return
    val app = context.applicationContext
    val preferences = app.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    enabled = preferences.getBoolean(ENABLED, false)
    enabledSince = preferences.getLong(ENABLED_SINCE, 0L)
    onAtLaunch = enabled
    // no_backup: Auto Backup never copies it, so the log only leaves through Share logs.
    files = DebugLogFiles(File(app.noBackupFilesDir, "debug-log"))
    cache = app.cacheDir
    writer.scheduleWithFixedDelay({ drain() }, 500, 500, TimeUnit.MILLISECONDS)
    app.registerComponentCallbacks(object : ComponentCallbacks2 {
      override fun onTrimMemory(level: Int) { event('W', "app", "trim_memory", "level" to level) }
      override fun onConfigurationChanged(newConfig: Configuration) {}
      @Deprecated("Still delivered on older releases") override fun onLowMemory() { event('W', "app", "low_memory") }
    })
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      runCatching {
        event('E', "err", "native_crash", "class" to error.javaClass.simpleName, "error" to DebugLogFormat.error(error),
          "fatal" to true, "task" to thread.name.take(32))
        drain()
      }
      previous?.uncaughtException(thread, error)
    }
    event('I', "app", "launch", "since_ms" to processAgeMs(), "enabled" to enabled)
    writer.execute { removeOldShares() }
  }

  fun setEnabled(context: Context, on: Boolean) {
    init(context)
    if (on == enabled) return
    if (!on) event('I', "app", "debug_logging", "enabled" to false)
    enabled = on
    if (on) enabledSince = System.currentTimeMillis()
    context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
      .putBoolean(ENABLED, on).putLong(ENABLED_SINCE, if (on) enabledSince else 0L).apply()
    if (on) event('I', "app", "debug_logging", "enabled" to true)
    writer.execute { drain() }
  }

  /** One event. Does nothing, and formats nothing, while the switch is off. */
  fun event(level: Char, area: String, name: String, vararg fields: Pair<String, Any?>) {
    if (!enabled) return
    val line = DebugLogFormat.line(System.currentTimeMillis(), level, area, name, linkedMapOf(*fields))
    queue.offer(line)
    when (level) {
      'E' -> Log.e(TAG, line)
      'W' -> Log.w(TAG, line)
      else -> Log.i(TAG, line)
    }
  }

  /** Lines JS formatted with the same rules. */
  fun js(lines: List<String>) {
    if (!enabled) return
    lines.forEach { queue.offer(DebugLogFormat.jsLine(it)) }
  }

  /**
   * The existing logcat lines (`OpenWhisprBubble`, `OpenWhisprLearn`): still printed as before, and
   * copied into the file while the switch is on. Their text is written by our code, never user text.
   */
  fun logcat(tag: String, message: String, error: Throwable? = null, warn: Boolean = false) {
    if (warn || error != null) Log.w(tag, message, error) else Log.i(tag, message)
    if (!enabled) return
    queue.offer(DebugLogFormat.line(System.currentTimeMillis(), if (warn || error != null) 'W' else 'I', "logcat", tag,
      linkedMapOf("error" to error?.let(DebugLogFormat::error))) + " | " + DebugLogFormat.jsLine(message).take(200))
  }

  private val reports = java.util.concurrent.ConcurrentLinkedQueue<Map<String, String>>()

  /**
   * An error worth a Sentry report (a refused microphone, a pipeline timeout), kept whether or not the
   * debug log is on. JS takes them with `takeErrorReports` and sends them only with Usage analytics on;
   * they carry tags, never a log line. At most 20 wait.
   */
  fun report(kind: String, vararg tags: Pair<String, String>) {
    if (reports.size >= 20) return
    reports.offer(linkedMapOf("kind" to kind, *tags))
    DictationService.emit?.invoke("onErrorReport", emptyMap())
  }

  fun takeReports(): List<Map<String, String>> {
    val out = mutableListOf<Map<String, String>>()
    while (true) out += reports.poll() ?: break
    return out
  }

  fun hasLog(): Boolean { drain(); return files?.hasLog() == true }

  fun clear() = writer.submit { queue.clear(); files?.clear() }.get(5, TimeUnit.SECONDS)

  /** The file Share logs sends: [header], then the log, oldest line first. */
  fun export(header: String): File = writer.submit<File> {
    drain()
    removeOldShares()
    val stamp = SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(Date())
    val out = File(requireNotNull(cache) { "Debug log not started." }, "debug-log-share/openwhispr-debug-$stamp.txt")
    out.parentFile?.mkdirs()
    out.outputStream().use { stream ->
      stream.write(header.toByteArray())
      stream.write("\n".toByteArray())
      files?.copyTo(stream)
    }
    out
  }.get(10, TimeUnit.SECONDS)

  @Synchronized private fun drain() {
    if (queue.isEmpty()) return
    val lines = ArrayList<String>(queue.size)
    queue.drainTo(lines)
    runCatching { files?.append(lines) }.onFailure { Log.w(TAG, "Debug log write failed", it) }
  }

  private fun removeOldShares() { cache?.let { File(it, "debug-log-share").deleteRecursively() } }
}
