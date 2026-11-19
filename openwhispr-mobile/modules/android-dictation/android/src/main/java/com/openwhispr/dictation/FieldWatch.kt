package com.openwhispr.dictation

/**
 * After the bubble types into a field, OpenWhispr reads that one field again for a short while so a
 * word the person fixes there can be learned (Dictionary's C11). The service samples the field every
 * [POLL_MS] rather than listening for text events, which editors like Chrome's address bar don't send,
 * and which would arrive from every app. Kept free of Android so it can be unit tested: it decides
 * which samples count and when an edit is ready to report.
 */
class FieldWatch(private val windowMs: Long = WINDOW_MS, private val settleMs: Long = SETTLE_MS) {
  /** The text the field held right after the dictation went in. */
  var baseline: String? = null; private set
  private var startedAt = 0L
  private var lastSeen = ""
  private var changedAt = 0L
  private var lastReported: String? = null

  val watching get() = baseline != null

  fun start(text: String, now: Long) {
    baseline = text; startedAt = now; lastSeen = text; changedAt = now; lastReported = text
  }
  fun stop() { baseline = null; lastReported = null }

  /**
   * One reading of the field. Returns the edit to report (the text right after the dictation, and the
   * text now) once the field has been still for [settleMs]; null otherwise. A change has to start
   * within the window; a change still settling when the window ends is reported, anything later isn't.
   * Nothing for the same text twice, for an emptied field (a sent message clears its box: that is not
   * a fix), or for a password field, which ends the watch.
   */
  fun sample(text: String, isPassword: Boolean, now: Long): Pair<String, String>? {
    val before = baseline ?: return null
    if (isPassword) { stop(); return null }
    if (text != lastSeen) {
      if (now - startedAt > windowMs) { stop(); return null }
      lastSeen = text; changedAt = now
      return null
    }
    if (now - changedAt < settleMs) return null
    if (now - startedAt > windowMs + settleMs) stop()
    if (text.isBlank() || text == lastReported) return null
    lastReported = text
    return before to text
  }

  /** Whether the service should keep sampling. */
  fun active(now: Long): Boolean {
    if (baseline == null) return false
    if (now - startedAt > windowMs + settleMs) { stop(); return false }
    return true
  }

  companion object {
    const val WINDOW_MS = 45_000L
    const val SETTLE_MS = 1_500L
    const val POLL_MS = 700L
  }
}
