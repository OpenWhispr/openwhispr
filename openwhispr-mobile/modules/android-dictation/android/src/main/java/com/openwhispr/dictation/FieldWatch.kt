package com.openwhispr.dictation

/**
 * After the bubble types into a field, OpenWhispr reads that one field again for a short while so a
 * word the person fixes there can be learned (Dictionary's C11). Kept free of Android so it can be
 * unit tested: it decides which text changes count and when to report them.
 */
class FieldWatch(private val windowMs: Long = WINDOW_MS, private val settleMs: Long = SETTLE_MS) {
  /** The text the field held right after the dictation went in. */
  var baseline: String? = null; private set
  private var startedAt = 0L
  private var lastReported: String? = null

  val watching get() = baseline != null

  fun start(text: String, now: Long) { baseline = text; startedAt = now; lastReported = text }
  fun stop() { baseline = null; lastReported = null }

  /** Whether a change still falls in the window; false once it has passed (the watch then stops). */
  fun inWindow(now: Long): Boolean {
    if (baseline == null) return false
    if (now - startedAt > windowMs) { stop(); return false }
    return true
  }

  /**
   * The edit to report once the field has been still for [settleMs]: the text right after the
   * dictation and the text now. Nothing when the text is the same as last time, and nothing for a
   * password field or an emptied field (a sent message clears its box: that is not a fix).
   */
  fun settled(current: String, isPassword: Boolean): Pair<String, String>? {
    val before = baseline ?: return null
    if (isPassword) { stop(); return null }
    if (current.isBlank() || current == lastReported) return null
    lastReported = current
    return before to current
  }

  companion object {
    const val WINDOW_MS = 30_000L
    const val SETTLE_MS = 1_500L
  }
}
