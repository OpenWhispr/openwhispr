package com.openwhispr.dictation

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import expo.modules.kotlin.Promise
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Offline synthetic fixtures in the separate test application's files/fixtures/diarization.
 * Does not access production app data, microphone, network, or UI. */
@RunWith(AndroidJUnit4::class)
class DiarizationRuntimeTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private val fixtures get() = File(context.filesDir, "fixtures/diarization")

  @Test fun separatesRepeatedVoicesWithAutomaticSpeakerCount() {
    val audio = File(fixtures, "two-voices.wav")
    val original = audio.readBytes()
    val hash = java.security.MessageDigest.getInstance("SHA-256")
      .digest(original).joinToString("") { "%02x".format(it) }
    assertEquals("9e5ad636d568a769daf6b8221806fbcf7043fd5d97f7bc73fc0480eb5f287ae4", hash)
    val result = run(audio, 0)
    assertEquals(2, result["speakerCount"])
    val segments = result["segments"] as List<*>
    // Each midpoint lies well inside a different synthetic turn: Samantha, Daniel, Samantha, Daniel.
    val labels = listOf(3.0, 10.0, 18.0, 26.0).map { time ->
      val matches = segments.map { it as Map<*, *> }.filter {
        (it["start"] as Number).toDouble() <= time && (it["end"] as Number).toDouble() >= time
      }
      assertEquals("Expected one speaker at $time seconds", 1, matches.size)
      matches.single()["speakerId"]
    }
    assertNotEquals(labels[0], labels[1])
    assertEquals(labels[0], labels[2])
    assertEquals(labels[1], labels[3])
    assertArrayEquals("Original audio must survive processing", original, audio.readBytes())
  }

  @Test fun silenceDoesNotInventSpeakers() {
    val result = run(File(fixtures, "silence.wav"), 0)
    assertEquals(0, result["speakerCount"])
    assertTrue((result["segments"] as List<*>).isEmpty())
  }

  @Test fun missingModelLeavesOriginalAudioIntact() {
    val audio = File(fixtures, "two-voices.wav")
    val original = audio.readBytes()
    val engine = DiarizationEngine(context)
    try {
      val result = Result()
      engine.diarize(audio, File(fixtures, "not-downloaded"), 0, result)
      result.waitForCompletion()
      assertNotNull(result.error)
      assertArrayEquals(original, audio.readBytes())
    } finally { engine.close() }
  }

  private fun run(audio: File, count: Int): Map<*, *> {
    val engine = DiarizationEngine(context)
    try {
      val result = Result()
      engine.diarize(audio, fixtures, count, result)
      result.waitForCompletion()
      result.error?.let { throw it }
      return result.value as Map<*, *>
    } finally { engine.close() }
  }

  private class Result : Promise {
    val done = CountDownLatch(1)
    var value: Any? = null
    var error: Throwable? = null
    override fun resolve(value: Any?) { this.value = value; done.countDown() }
    override fun reject(code: String, message: String?, cause: Throwable?) {
      error = IllegalStateException("$code: $message", cause); done.countDown()
    }
    fun waitForCompletion() { check(done.await(180, TimeUnit.SECONDS)) { "Diarization timed out" } }
  }
}
