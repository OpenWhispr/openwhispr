package com.openwhispr.dictation

import android.content.Context
import android.os.Build
import android.os.SystemClock
import ai.moonshine.voice.JNI
import ai.moonshine.voice.Transcriber
import ai.moonshine.voice.TranscriptEvent
import expo.modules.kotlin.Promise
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/** Decode and feed bounded audio blocks on one worker; cancellation never frees live JNI state. */
class MoonshineEngine(private val context: Context) {
  private val worker = Executors.newSingleThreadExecutor()
  private val generation = AtomicLong()

  fun transcribe(input: File, directory: File, model: String, promise: Promise) {
    val job = generation.get()
    worker.execute {
      var converted: File? = null
      var engine: Transcriber? = null
      try {
        check(Build.VERSION.SDK_INT >= 26) { "Moonshine requires Android 8 or newer." }
        check(job == generation.get()) { "Dictation cancelled." }
        val architecture = when (model) {
          "moonshine-tiny" -> JNI.MOONSHINE_MODEL_ARCH_TINY_STREAMING
          "moonshine-small" -> JNI.MOONSHINE_MODEL_ARCH_SMALL_STREAMING
          else -> error("Unknown Moonshine model.")
        }
        val started = SystemClock.elapsedRealtime()
        val decoded = AudioDecoder.decode(context, input) { job != generation.get() }
        converted = File(android.net.Uri.parse(decoded["uri"] as String).path!!)
        check(job == generation.get()) { "Dictation cancelled." }
        val transcriber = Transcriber()
        engine = transcriber
        transcriber.loadFromFiles(directory.path, architecture)
        val lines = linkedMapOf<Long, String>()
        transcriber.addListener { event ->
          when (event) {
            is TranscriptEvent.LineCompleted -> lines[event.line.id] = event.line.text.trim()
            is TranscriptEvent.Error -> throw IllegalStateException("Moonshine transcription failed.", event.cause)
          }
        }
        transcriber.start()
        val sampleCount = (converted.length() - 44) / 2
        RandomAccessFile(converted, "r").use { wav ->
          wav.seek(44)
          var remaining = sampleCount
          while (remaining > 0) {
            check(job == generation.get()) { "Dictation cancelled." }
            val count = minOf(remaining, 16000L).toInt()
            val bytes = ByteArray(count * 2)
            wav.readFully(bytes)
            val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            // Keep the final block pending for stop() to decode with a completed VAD segment.
            // Moonshine 0.1.5 otherwise marks cached partial text complete when no audio remains,
            // skipping the streaming encoder's final lookahead frames. Earlier blocks still stream.
            if (remaining == count.toLong()) transcriber.setUpdateInterval(Double.POSITIVE_INFINITY)
            transcriber.addAudio(FloatArray(count) { buffer.short.toFloat() / 32768f }, 16000)
            remaining -= count
          }
        }
        check(job == generation.get()) { "Dictation cancelled." }
        transcriber.stop()
        check(job == generation.get()) { "Dictation cancelled." }
        promise.resolve(mapOf("text" to lines.values.filter { it.isNotBlank() }.joinToString(" "),
          "duration" to sampleCount.toDouble() / 16000,
          "processingMs" to SystemClock.elapsedRealtime() - started))
      } catch (error: Exception) { promise.reject("ERR_MOONSHINE", error.message, error) }
      finally {
        // A fresh transcriber also clears upstream's completed-line IDs between recordings.
        engine?.close()
        converted?.delete()
      }
    }
  }

  fun cancel() { generation.incrementAndGet() }
  fun release(promise: Promise) { worker.execute { promise.resolve(null) } }
  fun close() { cancel(); worker.shutdown() }
}
