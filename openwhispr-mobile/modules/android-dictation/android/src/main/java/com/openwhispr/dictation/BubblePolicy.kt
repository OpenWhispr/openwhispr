package com.openwhispr.dictation

import kotlin.math.log10
import kotlin.math.sqrt

/**
 * What the floating bubble is doing. [RETRY] and [RECOVER] look like [READY] (the app icon); the status
 * tab beside it says what went wrong or where the words went.
 */
enum class BubbleState { READY, LISTENING, PROCESSING, RETRY, RECOVER }

/** How the Ready bubble looks (Settings › Size & look). Out-of-range values are clamped, not rejected. */
data class BubbleAppearance(
  val size: Int = 64,
  val opacity: Float = 0.8f,
  val shrinkWhenIdle: Boolean = true,
  val shrinkToDot: Boolean = false,
  val shrinkInSearch: Boolean = false,
) {
  val scale get() = size.coerceIn(48, 88) / 64f
  val alpha get() = if (opacity.isNaN()) 0.8f else opacity.coerceIn(0.2f, 1f)
}

/** Decisions behind the floating bubble, kept free of Android views so they can be unit tested. */
object BubblePolicy {
  /** Dragging the bubble onto ✕ hides it for 15 minutes. */
  const val HIDE_FOR_MS = 15 * 60 * 1000L
  const val IDLE_SHRINK_MS = 5000L

  /**
   * How see-through the bubble's window is: Size & look's opacity in every state, listening and writing
   * included (Josh, 20 Nov), so its ✕, badges and hold ring follow it too. An open menu keeps its floor.
   */
  fun windowAlpha(alpha: Float, menuOpen: Boolean) = if (menuOpen) BubbleMenuPolicy.menuAlpha(alpha) else alpha

  /** The status tab's words follow the same setting, with the menu's floor so they stay readable. */
  fun tabAlpha(alpha: Float) = BubbleMenuPolicy.menuAlpha(alpha)

  /**
   * With shrinking on, the Ready bubble shrinks once it has sat idle, or straight away over a search
   * field (when that's on too) so it doesn't cover the results. Search-field shrinking is part of
   * shrinking, as Settings shows it. Dictating always shows the bubble full size.
   */
  fun shrunk(ready: Boolean, idle: Boolean, shrinkWhenIdle: Boolean, searchField: Boolean, shrinkInSearch: Boolean) =
    ready && shrinkWhenIdle && (idle || (shrinkInSearch && searchField))

  /**
   * Whether a focused field looks like a search box: a SearchView (the field or a near ancestor), or a
   * word starting with "search" in its id, hint or description. "searchBox", "edit_search" and "Search
   * contacts" count; "research_notes" doesn't.
   */
  fun searchField(labels: List<CharSequence?>, classes: List<CharSequence?>): Boolean =
    classes.any { it?.contains("SearchView") == true } || labels.any { it != null && hasSearchWord(it) }

  private fun hasSearchWord(text: CharSequence): Boolean {
    var from = 0
    while (true) {
      val index = text.indexOf("search", from, ignoreCase = true)
      if (index < 0) return false
      val before = text.getOrNull(index - 1)
      if (before == null || !before.isLetter() || text[index].isUpperCase()) return true
      from = index + 1
    }
  }

  /**
   * The bubble shows over other apps only while someone is typing in a text box, and always on
   * the in-app practice screen. A dictation in progress stays on screen until it settles. Without
   * the accessibility service there is no focus signal, so the bubble shows whenever OpenWhispr
   * is in the background, as it did before focus tracking.
   */
  fun visible(
    appVisible: Boolean,
    practiceVisible: Boolean,
    accessibilityOn: Boolean,
    typing: Boolean,
    hidden: Boolean,
    busy: Boolean,
  ): Boolean {
    if (appVisible && !practiceVisible) return false
    if (practiceVisible || busy) return true
    return !hidden && (!accessibilityOn || typing)
  }

  const val DEFAULT_SIZE = 64

  /**
   * Whether to bring the bubble back on launch, after an update or after a restart: only when the
   * user left it on and the overlay and microphone permissions are still granted.
   */
  fun shouldRestore(wanted: Boolean, sdk: Int, overlay: Boolean, microphone: Boolean) =
    wanted && sdk >= 26 && overlay && microphone

  /** A saved bubble size, or the default when it is missing or out of range. */
  fun restoredSize(saved: Int) = if (saved in 48..88) saved else DEFAULT_SIZE

  /** How long, after a recording ends, the bubble waits for the JS pipeline before offering Retry. */
  const val PIPELINE_READY_TIMEOUT_MS = 20_000L

  /** The JS pipeline runs as a headless task only while a dictation is in flight. */
  fun keepsPipelineAwake(state: BubbleState, stopping: Boolean) =
    stopping || state == BubbleState.LISTENING || state == BubbleState.PROCESSING

  /** Only a focused, editable field that isn't a password can take dictation. */
  fun canDictate(editable: Boolean, password: Boolean) = editable && !password

  /** A released bubble settles on the edge its centre is nearest to. */
  fun dockRight(centerX: Float, screenWidth: Int) = centerX >= screenWidth / 2f

  /** Whether the bubble's centre is close enough to the hide target to hide on release. */
  fun overTarget(bubbleX: Float, bubbleY: Float, targetX: Float, targetY: Float, radius: Float): Boolean {
    val dx = bubbleX - targetX
    val dy = bubbleY - targetY
    return dx * dx + dy * dy <= radius * radius
  }

  /** Where the bubble's top sits: where the user left it, but never over the keyboard. */
  fun bubbleTop(savedTop: Int?, keyboardTop: Int?, screenHeight: Int, height: Int, gap: Int, minTop: Int): Int {
    val floor = (keyboardTop ?: (screenHeight - screenHeight / 3)) - gap - height
    val top = savedTop?.coerceAtMost(floor) ?: floor
    return top.coerceIn(minTop, maxOf(minTop, screenHeight - height))
  }

  /**
   * Microphone loudness from 0 (silence) to 1 (loud speech), on a decibel scale like the iOS meter. The
   * speech-recognition microphone has no automatic gain, so normal speech sits around -40 dBFS: that fills
   * about half the bar, -20 dBFS fills it, and room noise below -60 dBFS stays flat.
   */
  fun level(samples: ShortArray, count: Int): Float {
    if (count <= 0) return 0f
    var sum = 0.0
    for (i in 0 until count) { val value = samples[i] / 32768.0; sum += value * value }
    val rms = sqrt(sum / count)
    if (rms <= 0.0) return 0f
    return ((20 * log10(rms) - FLOOR_DB) / (CEILING_DB - FLOOR_DB)).toFloat().coerceIn(0f, 1f)
  }
  private const val FLOOR_DB = -60.0
  private const val CEILING_DB = -20.0

  private val barShape = floatArrayOf(0.45f, 0.7f, 0.9f, 1f, 0.9f, 0.7f, 0.45f)
  const val BARS = 7

  /** Bar heights from 0 to 1 for the short listening waveform: tallest in the middle, never flat. */
  fun bars(level: Float, phase: Float): FloatArray = FloatArray(BARS) { index ->
    val wobble = 0.75f + 0.25f * kotlin.math.sin(phase + index * 1.3f)
    (0.15f + 0.85f * level.coerceIn(0f, 1f) * barShape[index] * wobble).coerceIn(0.15f, 1f)
  }
}
