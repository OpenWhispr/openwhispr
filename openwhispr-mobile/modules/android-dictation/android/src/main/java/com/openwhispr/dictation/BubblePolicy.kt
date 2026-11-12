package com.openwhispr.dictation

import kotlin.math.log10
import kotlin.math.sqrt

/** What the floating bubble shows. Every state but [READY] is a pill. */
enum class BubbleState { READY, LISTENING, PROCESSING, RETRY, RECOVER }

/** Decisions behind the floating bubble, kept free of Android views so they can be unit tested. */
object BubblePolicy {
  const val HIDE_FOR_MS = 60 * 60 * 1000L

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

  /** Microphone loudness from 0 (silence) to 1 (loud speech), on a decibel scale like the iOS meter. */
  fun level(samples: ShortArray, count: Int): Float {
    if (count <= 0) return 0f
    var sum = 0.0
    for (i in 0 until count) { val value = samples[i] / 32768.0; sum += value * value }
    val rms = sqrt(sum / count)
    if (rms <= 0.0) return 0f
    return ((20 * log10(rms) + 50) / 40).toFloat().coerceIn(0f, 1f)
  }

  private val barShape = floatArrayOf(0.45f, 0.7f, 0.9f, 1f, 0.9f, 0.7f, 0.45f)
  const val BARS = 7

  /** Bar heights from 0 to 1 for the short listening waveform: tallest in the middle, never flat. */
  fun bars(level: Float, phase: Float): FloatArray = FloatArray(BARS) { index ->
    val wobble = 0.75f + 0.25f * kotlin.math.sin(phase + index * 1.3f)
    (0.15f + 0.85f * level.coerceIn(0f, 1f) * barShape[index] * wobble).coerceIn(0.15f, 1f)
  }
}
