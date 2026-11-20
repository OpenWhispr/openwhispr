package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

/** Levels below are speech-band dBFS per 20 ms window, as measured on the A73 (20 Nov). */
class VoiceMeterTest {
  private fun VoiceMeter.feed(db: Float, ms: Int): Float { var out = 0f; repeat(ms / 20) { out = update(db) }; return out }
  private fun VoiceMeter.peak(db: Float, ms: Int): Float { var out = 0f; repeat(ms / 20) { out = maxOf(out, update(db)) }; return out }

  @Test fun aQuietRoomLeavesTheBarsResting() {
    val meter = VoiceMeter()
    assertEquals(0f, meter.peak(-57f, 3000), 0.001f)
  }

  @Test fun theMicrophonesSilentFirstWindowDoesNotFoolIt() {
    val meter = VoiceMeter()
    meter.update(-90f)
    assertEquals(0f, meter.peak(-57f, 2000), 0.001f)
  }

  @Test fun speechMovesTheBarsNearlyFully() {
    val meter = VoiceMeter()
    meter.feed(-57f, 1000)
    assertTrue(meter.peak(-31f, 200) > 0.9f)
  }

  @Test fun aSteadyHumIsLearnedAndIgnoredEvenWhenItStartsMidTake() {
    val meter = VoiceMeter()
    meter.feed(-57f, 1000)
    meter.feed(-45f, 2000)
    assertEquals(0f, meter.peak(-45f, 2000), 0.02f)
  }

  @Test fun speechStillShowsOverTheHum() {
    val meter = VoiceMeter()
    meter.feed(-45f, 2000)
    assertTrue(meter.peak(-33f, 200) > 0.4f)
  }

  @Test fun itRisesFastAndFallsBackGently() {
    val meter = VoiceMeter()
    meter.feed(-57f, 1000)
    assertTrue(meter.feed(-31f, 60) > 0.75f)
    val down = meter.feed(-57f, 60)
    assertTrue("down after 60 ms $down", down in 0.4f..0.85f)
    assertTrue(meter.feed(-57f, 600) < 0.05f)
  }

  @Test fun sentencesAreNeverLearnedAsNoise() {
    val meter = VoiceMeter()
    meter.feed(-57f, 1000)
    repeat(20) { meter.feed(-31f, 160); meter.feed(-48f, 60) }
    assertTrue(meter.peak(-31f, 120) > 0.8f)
  }

  @Test fun theSpeechBandDropsMainsHumButKeepsTheVoice() {
    fun tone(hz: Double) = ShortArray(320) { (sin(2 * PI * hz * it / 16000) * 3000).toInt().toShort() }
    val hum = VoiceMeter().run { repeat(10) { measure(tone(50.0), 320) }; measure(tone(50.0), 320) }
    val voice = VoiceMeter().run { repeat(10) { measure(tone(1000.0), 320) }; measure(tone(1000.0), 320) }
    assertTrue("hum $hum voice $voice", voice - hum > 25f)
  }
}
