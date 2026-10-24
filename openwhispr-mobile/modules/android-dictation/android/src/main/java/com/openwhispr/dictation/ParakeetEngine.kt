package com.openwhispr.dictation

import android.content.Context
import android.os.SystemClock
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import expo.modules.kotlin.Promise
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/** Owns the CPU runtime on one worker. Cancellation discards results; it never frees an
 * ONNX session while native inference is using it. Model downloads are verified by the caller. */
class ParakeetEngine(private val context: Context) {
  private val worker = Executors.newSingleThreadExecutor()
  private val generation = AtomicLong()
  private var recognizer: OfflineRecognizer? = null
  private var loadedDirectory: String? = null

  fun transcribe(input: File, directory: File, promise: Promise) {
    val job = generation.get()
    worker.execute {
      var converted: File? = null
      try {
        check(job == generation.get()) { "Dictation cancelled." }
        val started = SystemClock.elapsedRealtime()
        val decoded = AudioDecoder.decode(context, input) { job != generation.get() }
        converted = File(android.net.Uri.parse(decoded["uri"] as String).path!!)
        check(job == generation.get()) { "Dictation cancelled." }
        if (recognizer == null || loadedDirectory != directory.path) {
          releaseNow()
          val expected = mapOf("encoder.int8.onnx" to 652184281L, "decoder.int8.onnx" to 11845275L,
            "joiner.int8.onnx" to 6355277L, "tokens.txt" to 93939L)
          expected.forEach { (name, size) -> require(File(directory, name).length() == size) {
            "Parakeet model is not available. Please download it first from Models."
          } }
          recognizer = OfflineRecognizer(config = OfflineRecognizerConfig(modelConfig = OfflineModelConfig(
            transducer = OfflineTransducerModelConfig(
              encoder = File(directory, "encoder.int8.onnx").path,
              decoder = File(directory, "decoder.int8.onnx").path,
              joiner = File(directory, "joiner.int8.onnx").path),
            tokens = File(directory, "tokens.txt").path,
            modelType = "nemo_transducer", numThreads = 4, provider = "cpu")))
          loadedDirectory = directory.path
        }
        check(job == generation.get()) { "Dictation cancelled." }
        val engine = requireNotNull(recognizer)
        val sampleCount = ((converted.length() - 44) / 2).toInt()
        val windows = ParakeetChunks.windows(sampleCount)
        val tokens = mutableListOf<ParakeetChunks.Token>()
        val texts = mutableListOf<String>()
        RandomAccessFile(converted, "r").use { wav ->
          for (window in windows) {
            check(job == generation.get()) { "Dictation cancelled." }
            val audio = ParakeetChunks.trimSilence(ParakeetChunks.read(wav, window))
            if (audio.samples.isEmpty()) continue
            val stream = engine.createStream()
            try {
              stream.acceptWaveform(audio.samples, ParakeetChunks.RATE)
              engine.decode(stream)
              check(job == generation.get()) { "Dictation cancelled." }
              val result = engine.getResult(stream)
              check(result.timestamps.size == result.tokens.size) { "Parakeet returned incomplete word timing. Please try again." }
              val offset = (window.start + audio.offset).toDouble() / ParakeetChunks.RATE
              val chunkTokens = result.tokens.indices.map { i ->
                val start = offset + result.timestamps[i]
                ParakeetChunks.Token(result.tokens[i], start, start + result.durations.getOrElse(i) { 0f })
              }
              val owned = if (windows.size == 1) chunkTokens else ParakeetChunks.ownedTokens(chunkTokens, window)
              tokens.addAll(owned)
              texts.add(if (windows.size == 1) result.text.trim() else ParakeetChunks.text(owned))
            } finally { stream.release() }
          }
        }
        promise.resolve(mapOf("text" to texts.filter { it.isNotBlank() }.joinToString(" "),
          "duration" to sampleCount.toDouble() / ParakeetChunks.RATE,
          "processingMs" to SystemClock.elapsedRealtime() - started,
          "tokenTimings" to tokens.map { mapOf("token" to it.text, "startTime" to it.start, "endTime" to it.end) }))
      } catch (error: Exception) { promise.reject("ERR_PARAKEET", error.message, error) }
      finally { converted?.delete() }
    }
  }

  fun cancel() { generation.incrementAndGet() }
  fun release(promise: Promise) { worker.execute { releaseNow(); promise.resolve(null) } }
  private fun releaseNow() { recognizer?.release(); recognizer = null; loadedDirectory = null }
  fun close() { cancel(); worker.execute { releaseNow() }; worker.shutdown() }
}
