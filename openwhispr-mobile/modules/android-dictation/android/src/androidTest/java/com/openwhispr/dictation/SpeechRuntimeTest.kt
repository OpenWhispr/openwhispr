package com.openwhispr.dictation

import android.util.Log
import ai.moonshine.voice.JNI
import ai.moonshine.voice.Transcriber
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import expo.modules.kotlin.Promise
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Run explicitly with verified models + sample.wav in the test application's files/fixtures.
 * No download/network dependency, real-user recordings, or production-only test entry point. */
@RunWith(AndroidJUnit4::class)
class SpeechRuntimeTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private val fixtures get() = File(context.filesDir, "fixtures")

  @Test fun tinyPreservesFinalWordsWithoutTrailingSilence() {
    assertFinalWords("moonshine-tiny")
  }

  @Test fun smallPreservesFinalWordsWithoutTrailingSilence() {
    assertFinalWords("moonshine-small")
  }

  private fun assertFinalWords(model: String) {
    // Synthetic 4.51675s fixture: "The quick brown fox jumps over the lazy dog.
    // Please send the meeting notes tomorrow." Do not pad its ending with silence.
    val audio = File(fixtures, "sample.wav")
    val hash = java.security.MessageDigest.getInstance("SHA-256")
      .digest(audio.readBytes()).joinToString("") { "%02x".format(it) }
    assertEquals("Use the unpadded synthetic regression fixture",
      "a4d2467bf3207a02ecdb6e2d6968022c95ef415f95c0ed638fed63f437c411c7", hash)
    val engine = MoonshineEngine(context)
    try {
      val result = Result()
      engine.transcribe(audio, File(fixtures, model), model, result)
      val output = result.await()
      val text = (output["text"] as String).lowercase().replace(Regex("[^a-z ]"), "").trim()
      Log.i("OWSpeechTest", "$model finalWords=$text")
      assertTrue("$model lost the final words: $text", text.endsWith("meeting notes tomorrow"))
      assertEquals(4.51675, (output["duration"] as Number).toDouble(), 0.00001)
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
    fun await(): Map<*, *> {
      check(done.await(180, TimeUnit.SECONDS)) { "Native inference timed out" }
      error?.let { throw it }
      return value as Map<*, *>
    }
  }

  @Test fun parakeetAndBothMoonshineModelsShareTheRuntime() {
    val audio = File(fixtures, "sample.wav")
    assertTrue("Provide the documented speech fixtures before running this device test", audio.isFile)
    val expected = InstrumentationRegistry.getArguments().getString("expectedWords")
      ?: error("Pass -e expectedWords with comma-separated words from sample.wav")
    val parakeet = ParakeetEngine(context)
    val moonshine = MoonshineEngine(context)
    try {
      // Repeat Tiny after Small to catch retained stream/line state across jobs.
      for (model in listOf("parakeet-v3", "moonshine-tiny", "moonshine-small", "moonshine-tiny")) {
        val result = Result()
        if (model == "parakeet-v3") parakeet.transcribe(audio, File(fixtures, model), result)
        else moonshine.transcribe(audio, File(fixtures, model), model, result)
        val output = result.await()
        val text = (output["text"] as String).lowercase()
        expected.split(',').forEach { word -> assertTrue("$model omitted $word: $text", text.contains(word.lowercase())) }
        assertTrue((output["duration"] as Number).toDouble() > 0)
        assertTrue((output["processingMs"] as Number).toLong() > 0)
        Log.i("OWSpeechTest", "$model duration=${output["duration"]} processingMs=${output["processingMs"]} text=$text")
        if (model != "parakeet-v3" && InstrumentationRegistry.getArguments().getString("compareBatch") == "true") {
          val decoded = AudioDecoder.decode(context, audio)
          val pcm = File(android.net.Uri.parse(decoded["uri"] as String).path!!)
          val reference = Transcriber()
          try {
            val count = ((pcm.length() - 44) / 2).toInt()
            check(count <= 30 * 16000) { "Batch comparison is only for short test fixtures" }
            reference.loadFromFiles(File(fixtures, model).path,
              if (model == "moonshine-tiny") JNI.MOONSHINE_MODEL_ARCH_TINY_STREAMING else JNI.MOONSHINE_MODEL_ARCH_SMALL_STREAMING)
            val samples = RandomAccessFile(pcm, "r").use { ParakeetChunks.read(it, ParakeetChunks.Window(0, count, 0, count)) }
            val batch = reference.transcribeWithoutStreaming(samples, 16000).text()
            Log.i("OWSpeechTest", "$model batchReference=$batch")
          } finally { reference.close(); pcm.delete() }
        }
      }
    } finally { moonshine.close(); parakeet.close() }
  }
}
