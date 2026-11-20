package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test

class VoiceMeterTest {
  /** [BubblePolicy.level]'s 0..1 for a sound at [db] dBFS. */
  private fun loudness(db: Float) = ((db + 60f) / 40f).coerceIn(0f, 1f)
  private fun VoiceMeter.feed(db: Float, ms: Int): Float { var out = 0f; repeat(ms / 20) { out = update(loudness(db), 20f) }; return out }

  @Test fun aQuietRoomLeavesTheBarsResting() {
    val meter = VoiceMeter()
    assertEquals(0f, meter.feed(-62f, 2000), 0.001f)
  }

  @Test fun aSteadyHumStaysStillEvenWhenItIsLoud() {
    val meter = VoiceMeter()
    // A café or fan at -42 dBFS: a little movement while the meter learns it, then rest.
    meter.feed(-42f, 4000)
    assertTrue(meter.feed(-42f, 1000) < 0.05f)
  }

  @Test fun normalSpeechMovesTheBarsWellAndLoudSpeechFillsThem() {
    val meter = VoiceMeter()
    meter.feed(-55f, 500)
    val normal = meter.feed(-38f, 300)
    assertTrue("normal speech $normal", normal in 0.5f..0.9f)
    assertEquals(1f, VoiceMeter().also { it.feed(-55f, 500) }.feed(-22f, 300), 0.02f)
  }

  @Test fun speechStillShowsOverAHum() {
    val meter = VoiceMeter()
    meter.feed(-42f, 4000)
    assertTrue(meter.feed(-28f, 300) > 0.5f)
  }

  @Test fun aFirstWordRightAwayStillMovesTheBars() {
    assertTrue(VoiceMeter().feed(-38f, 100) > 0.4f)
  }

  @Test fun itRisesFastAndFallsBackGently() {
    val meter = VoiceMeter()
    meter.feed(-55f, 500)
    val up = meter.feed(-30f, 60)
    assertTrue("up after 60 ms $up", up > 0.6f)
    val peak = meter.feed(-30f, 300)
    val down = meter.feed(-55f, 60)
    assertTrue("down after 60 ms $down", down > 0.3f * peak && down < peak)
    assertTrue(meter.feed(-55f, 600) < 0.05f)
  }

  @Test fun sentencesAreNeverLearnedAsNoise() {
    // Speech rises and dips every syllable; three seconds of it still moves the bars on every peak.
    val meter = VoiceMeter()
    meter.feed(-55f, 500)
    repeat(15) { meter.feed(-32f, 100); meter.feed(-45f, 100) }
    assertTrue(meter.feed(-32f, 100) > 0.4f)
  }
}
