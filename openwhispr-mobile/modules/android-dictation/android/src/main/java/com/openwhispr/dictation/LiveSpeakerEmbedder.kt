package com.openwhispr.dictation

import android.os.Process
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import expo.modules.kotlin.Promise
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * Voiceprints for live meeting lines, read from the meeting WAV while it is still being written.
 * Runs on its own low-priority thread, outside the shared inference queue, so a voiceprint never
 * waits on or holds up dictation. Only this worker creates or releases the extractor.
 */
class LiveSpeakerEmbedder {
  private val worker = Executors.newSingleThreadExecutor { task ->
    Thread({ Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); task.run() }, "live-speakers")
  }
  private val generation = AtomicLong()
  private var extractor: SpeakerEmbeddingExtractor? = null
  private var extractorModel: String? = null

  fun embed(wav: File, modelDirectory: File, startMs: Double, endMs: Double, promise: Promise) {
    val job = generation.get()
    worker.execute {
      try {
        check(job == generation.get()) { "Speaker labels stopped." }
        val model = File(modelDirectory, "nemo_en_titanet_small.onnx")
        require(model.length() == 40257283L) { "Download the meeting speaker models first." }
        val samples = LiveSpeakerAudio.read(wav, startMs, endMs)
        require(samples.size >= LiveSpeakerAudio.MIN_SAMPLES) { "Not enough speech for a voiceprint." }
        val active = extractorFor(model)
        val stream = active.createStream()
        try {
          stream.acceptWaveform(samples, LiveSpeakerAudio.MODEL_RATE)
          stream.inputFinished()
          check(active.isReady(stream)) { "Not enough speech for a voiceprint." }
          val embedding = active.compute(stream)
          check(job == generation.get()) { "Speaker labels stopped." }
          promise.resolve(embedding.map { it.toDouble() })
        } finally { stream.release() }
      } catch (error: Exception) {
        promise.reject("ERR_SPEAKER_EMBEDDING", error.message, error)
      } catch (error: OutOfMemoryError) {
        release()
        promise.reject("ERR_SPEAKER_EMBEDDING_MEMORY", "Not enough memory for speaker labels.", error)
      }
    }
  }

  private fun extractorFor(model: File): SpeakerEmbeddingExtractor {
    extractor?.takeIf { extractorModel == model.path }?.let { return it }
    release()
    return SpeakerEmbeddingExtractor(null, SpeakerEmbeddingExtractorConfig(model = model.path, numThreads = 2, provider = "cpu"))
      .also { extractor = it; extractorModel = model.path }
  }

  private fun release() {
    extractor?.release()
    extractor = null
    extractorModel = null
  }

  /** Drops queued voiceprints and frees the model once the worker reaches this point. */
  fun stop() {
    generation.incrementAndGet()
    worker.execute { release() }
  }

  fun close() { stop(); worker.shutdown() }
}

/** Reads a span of a 16-bit mono WAV (any rate) as 16 kHz floats for the speaker model. */
internal object LiveSpeakerAudio {
  const val MODEL_RATE = 16000
  /** A voiceprint takes at most this much speech: the middle of a longer line. */
  const val MAX_SECONDS = 10.0
  const val MIN_SAMPLES = MODEL_RATE / 2

  fun read(wav: File, startMs: Double, endMs: Double): FloatArray =
    RandomAccessFile(wav, "r").use { file ->
      val header = ByteArray(44)
      file.readFully(header)
      val buffer = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
      require(String(header, 0, 4) == "RIFF" && String(header, 8, 4) == "WAVE") { "Not a WAV file." }
      val rate = buffer.getInt(24)
      require(buffer.getShort(22).toInt() == 1 && buffer.getShort(34).toInt() == 16 && rate > 0) { "Unsupported WAV." }
      // The capture rewrites the header as it goes; the file length is the safer bound.
      val available = (file.length() - 44L) / 2L
      var start = (startMs.coerceAtLeast(0.0) * rate / 1000.0).toLong()
      var end = minOf((endMs * rate / 1000.0).toLong(), available)
      val longest = (MAX_SECONDS * rate).toLong()
      if (end - start > longest) { start += (end - start - longest) / 2; end = start + longest }
      if (end <= start) return@use FloatArray(0)
      val count = (end - start).toInt()
      val bytes = ByteArray(count * 2)
      file.seek(44L + start * 2L)
      file.readFully(bytes)
      val shorts = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
      val input = FloatArray(count) { shorts.get(it) / 32768f }
      resample(input, rate, MODEL_RATE)
    }

  /** Windowed-sinc resampling, low-passed below the output's Nyquist so voices don't alias. */
  fun resample(input: FloatArray, from: Int, to: Int): FloatArray {
    if (from == to) return input
    val ratio = from.toDouble() / to
    val cutoff = 0.45 / maxOf(1.0, ratio) // cycles per input sample
    val half = 16
    val output = FloatArray((input.size / ratio).toInt())
    for (n in output.indices) {
      val center = n * ratio
      val first = maxOf(0, kotlin.math.ceil(center - half).toInt())
      val last = minOf(input.size - 1, kotlin.math.floor(center + half).toInt())
      var sum = 0.0
      var weight = 0.0
      for (k in first..last) {
        val x = k - center
        val sinc = if (x == 0.0) 1.0 else kotlin.math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x * 2 * cutoff)
        val window = 0.5 + 0.5 * kotlin.math.cos(Math.PI * x / (half + 1))
        val h = sinc * window
        sum += input[k] * h
        weight += h
      }
      output[n] = if (weight == 0.0) 0f else (sum / weight).toFloat()
    }
    return output
  }
}
