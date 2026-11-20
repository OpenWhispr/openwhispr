package com.openwhispr.dictation

import kotlin.math.exp
import kotlin.math.pow

/**
 * Turns the microphone's loudness into how much the listening bubble moves (0 to 1), so it answers the
 * voice and not the room (Josh, 20 Nov: "it needs to feel natural").
 *
 * - The room's noise is the quietest moment of the last 1.2 s. Speech always dips between syllables
 *   and words, so a steady hum (a fan, a café, a car) is learned within about a second and a voice is
 *   never mistaken for it.
 * - Only sound clearly above that noise moves the bars, on a gentle curve, so ordinary speech fills
 *   most of the range while the hum leaves them resting.
 * - It rises fast with a syllable and falls back more slowly, like a needle, rather than flickering.
 *
 * [update] takes [BubblePolicy.level]'s 0..1 loudness (-60 to -20 dBFS) for each window of audio.
 */
class VoiceMeter {
  private val recent = ArrayDeque<Float>()
  private var floor = Float.NaN
  private var envelope = 0f

  fun update(loudness: Float, windowMs: Float): Float {
    val db = FLOOR_DB + (CEILING_DB - FLOOR_DB) * loudness.coerceIn(0f, 1f)
    val heard = (NOISE_WINDOW_MS / windowMs).toInt().coerceAtLeast(1)
    recent.addLast(db)
    while (recent.size > heard) recent.removeFirst()
    val quietest = recent.min()
    floor = when {
      // Until it has heard the room for a full window, assume a quiet one, so a first word moves the bars at once.
      floor.isNaN() || recent.size < heard -> minOf(quietest, START_FLOOR_DB)
      quietest < floor -> quietest
      else -> floor + (quietest - floor) * smoothing(windowMs, FLOOR_RISE_MS)
    }
    val above = db - (floor + MARGIN_DB)
    val goal = if (db <= GATE_DB) 0f else (above / RANGE_DB).coerceIn(0f, 1f).pow(CURVE)
    envelope += (goal - envelope) * smoothing(windowMs, if (goal > envelope) ATTACK_MS else RELEASE_MS)
    return envelope
  }

  private fun smoothing(windowMs: Float, tau: Float) = 1f - exp(-windowMs / tau)

  companion object {
    private const val FLOOR_DB = -60f
    private const val CEILING_DB = -20f
    /** Quieter than this is silence, whatever the room. */
    const val GATE_DB = -58f
    /** How far above the room's noise a sound must be before the bars move. */
    const val MARGIN_DB = 5f
    /** Above the margin, this many dB fills the bars. */
    const val RANGE_DB = 18f
    /** Below 1 lifts quiet speech, so a normal voice moves the bars well. */
    const val CURVE = 0.7f
    const val ATTACK_MS = 30f
    const val RELEASE_MS = 160f
    const val NOISE_WINDOW_MS = 1200f
    const val FLOOR_RISE_MS = 300f
    const val START_FLOOR_DB = -50f
  }
}
