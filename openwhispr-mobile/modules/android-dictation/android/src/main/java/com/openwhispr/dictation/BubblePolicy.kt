package com.openwhispr.dictation

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin
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

  /**
   * Whether a finger at ([x], [y]) is on the listening ✕: a square target [half] from the ✕'s centre each
   * way (48 dp across, though the ✕ draws 32 dp). The bubble wins where the two overlap, so a small
   * bubble's tap still stops rather than cancels.
   */
  fun overCancel(x: Float, y: Float, cancelX: Float, cancelY: Float, half: Float, onBubble: Boolean) =
    !onBubble && abs(x - cancelX) <= half && abs(y - cancelY) <= half

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

  /**
   * The listening bubble's three bars, in the logo's proportions (section 7, Josh 20 Nov), in dp for a
   * 52 dp bubble: 5 wide, 10 apart, resting 9 / 20 / 9. They move like a waveform (Josh 22 Nov), not as
   * one block: each bar rides its own phase of one wave ([wave]), and the sides hear the voice
   * [SIDE_LAGS_MS] after the middle, so a loud syllable ripples outwards. The wave turns faster the louder
   * the voice ([waveStep]), so soft speech sways and loud speech dances; in silence it all settles to the
   * logo and breathes ±1 dp on a 1.6 s cycle ([breath], -1..1). A side can rise past the middle.
   */
  const val BAR_WIDTH = 5f
  const val BAR_SPACING = 10f
  const val MIDDLE_REST = 20f
  const val SIDE_REST = 9f
  const val MIDDLE_GROW = 10f
  const val SIDE_GROW = 15f
  const val BREATH_MS = 1600L
  /** How long after the middle the left and right bars hear the voice. */
  val SIDE_LAGS_MS = longArrayOf(110L, 60L)
  /** Each bar's place on the wave (left, middle, right), in radians. */
  private val WAVE_PHASES = floatArrayOf(2.2f, 0f, 4.3f)
  /** How much of a bar's growth the wave takes away at its trough (middle, sides). */
  private const val MIDDLE_SWAY = 0.3f
  private const val SIDE_SWAY = 0.45f
  /** How long a bar takes to ease toward its height (middle, sides): the sides glide (Josh 22 Nov: slower). */
  const val MIDDLE_EASE_MS = 70f
  const val SIDE_EASE_MS = 160f
  private const val WAVE_REST_HZ = 0.35f
  private const val WAVE_VOICE_HZ = 1.1f

  /** Heights for left, middle and right from each bar's level (0..1) and where the wave is. */
  fun bars(middle: Float, left: Float, right: Float, wave: Float = 0f, breath: Float = 0f): FloatArray {
    val levels = floatArrayOf(left.coerceIn(0f, 1f), middle.coerceIn(0f, 1f), right.coerceIn(0f, 1f))
    val b = breath.coerceIn(-1f, 1f) * (1f - levels.max())
    return FloatArray(3) { i ->
      val sway = if (i == 1) MIDDLE_SWAY else SIDE_SWAY
      val shape = 1f - sway * (1f - sin(wave + WAVE_PHASES[i])) / 2f
      (if (i == 1) MIDDLE_REST + MIDDLE_GROW * levels[i] * shape else SIDE_REST + SIDE_GROW * levels[i] * shape) + b
    }
  }

  /** Moves the wave on by [dtMs], faster the louder [voice] (0..1). */
  fun waveStep(wave: Float, voice: Float, dtMs: Long): Float =
    ((wave + dtMs / 1000f * 2f * PI.toFloat() * (WAVE_REST_HZ + WAVE_VOICE_HZ * voice.coerceIn(0f, 1f))) % (2f * PI.toFloat()))
}
