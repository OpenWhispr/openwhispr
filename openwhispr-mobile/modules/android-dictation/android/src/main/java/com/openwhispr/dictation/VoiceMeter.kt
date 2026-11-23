package com.openwhispr.dictation

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Turns the microphone into how much the listening bubble moves (0 to 1), so it answers the voice and
 * not the room (Josh, 20 Nov: "it needs to feel natural"). Tuned on the A73 against a quiet room, pink
 * and brown noise, and speech over both.
 *
 * - [measure] hears only the speech band: a high-pass at [HIGH_PASS_HZ] drops the rumble of fans,
 *   traffic and air conditioning before the loudness is taken.
 * - The room's noise is a low percentile of the last [NOISE_WINDOW_MS]. Speech dips between syllables
 *   and words, so a hum (even one that starts mid-take) is learned in about a second and a voice never is. Until it has
 *   heard [WARM_UP_MS] of the room the bars rest.
 * - Only sound clearly above that noise moves the bars, on a gentle curve, rising in about 30 ms and
 *   falling back in about 120 ms (so syllables stay apart), like a needle rather than a flicker.
 */
class VoiceMeter(private val sampleRate: Int = 16000, private val windowMs: Int = 20) {
  // RBJ high-pass biquad, Q 0.707.
  private val b0: Float; private val b1: Float; private val b2: Float; private val a1: Float; private val a2: Float
  init {
    val w = 2 * PI * HIGH_PASS_HZ / sampleRate
    val alpha = sin(w) / (2 * 0.7071)
    val a0 = 1 + alpha
    b0 = ((1 + cos(w)) / 2 / a0).toFloat(); b1 = (-(1 + cos(w)) / a0).toFloat(); b2 = b0
    a1 = (-2 * cos(w) / a0).toFloat(); a2 = ((1 - alpha) / a0).toFloat()
  }
  private var x1 = 0f; private var x2 = 0f; private var y1 = 0f; private var y2 = 0f

  private val recent = ArrayDeque<Float>()
  private var envelope = 0f

  /** The speech-band loudness of [count] samples, in dBFS. Call once per window, in order. */
  fun measure(samples: ShortArray, count: Int): Float {
    if (count <= 0) return SILENCE_DB
    var sum = 0.0
    for (i in 0 until count) {
      val x = samples[i] / 32768f
      val y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1; x1 = x; y2 = y1; y1 = y
      sum += (y * y).toDouble()
    }
    val rms = sqrt(sum / count)
    return if (rms <= 0.0) SILENCE_DB else (20 * log10(rms)).toFloat().coerceAtLeast(SILENCE_DB)
  }

  /** How much the bars move for a window at [db] dBFS. */
  fun update(db: Float): Float {
    if (db > GATE_DB) {
      recent.addLast(db)
      while (recent.size > NOISE_WINDOW_MS / windowMs) recent.removeFirst()
    }
    val goal = if (db <= GATE_DB || recent.size < WARM_UP_MS / windowMs) 0f else {
      val room = recent.sorted()[((recent.size - 1) * NOISE_PERCENTILE).toInt()]
      ((db - room - MARGIN_DB) / RANGE_DB).coerceIn(0f, 1f).pow(CURVE)
    }
    val tau = if (goal > envelope) ATTACK_MS else RELEASE_MS
    envelope += (goal - envelope) * (1f - exp(-windowMs / tau))
    return envelope
  }

  /** [measure] then [update]. */
  fun level(samples: ShortArray, count: Int): Float = update(measure(samples, count))

  companion object {
    const val HIGH_PASS_HZ = 250.0
    const val SILENCE_DB = -90f
    /** Quieter than this is silence, whatever the room (the microphone's first window reads as silence). */
    const val GATE_DB = -62f
    const val NOISE_WINDOW_MS = 1200
    const val NOISE_PERCENTILE = 0.15f
    const val WARM_UP_MS = 300
    /** How far above the room a sound must be before the bars move. */
    const val MARGIN_DB = 5f
    /** Above the margin, this many dB fills the bars. */
    const val RANGE_DB = 11f
    /** Below 1 lifts quieter speech, so a normal voice moves the bars well. */
    const val CURVE = 0.7f
    const val ATTACK_MS = 30f
    const val RELEASE_MS = 120f
  }
}
