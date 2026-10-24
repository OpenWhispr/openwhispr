package com.openwhispr.dictation

import android.app.ActivityManager
import android.content.Context
import com.k2fsa.sherpa.onnx.FastClusteringConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarization
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarizationConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationPyannoteModelConfig
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import expo.modules.kotlin.Promise
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/** CPU-only speaker separation. Cancellation invalidates results; only the owning worker
 * releases native memory, after inference returns. No networking or original-file mutation. */
class DiarizationEngine(private val context: Context) {
  private val worker = Executors.newSingleThreadExecutor()
  private val generation = AtomicLong()

  fun diarize(input: File, directory: File, numberOfSpeakers: Int, promise: Promise) {
    val job = generation.get()
    worker.execute {
      var converted: File? = null
      var engine: OfflineSpeakerDiarization? = null
      fun assertCurrent() = check(job == generation.get()) { "Meeting processing cancelled." }
      try {
        assertCurrent()
        require(numberOfSpeakers in 0..32) { "Invalid speaker count." }
        val segmentation = File(directory, "segmentation.int8.onnx")
        val embedding = File(directory, "nemo_en_titanet_small.onnx")
        require(segmentation.length() == 1540506L && embedding.length() == 40257283L) {
          "Download the meeting speaker models first."
        }
        val decoded = AudioDecoder.decode(context, input) { job != generation.get() }
        val pcm = File(android.net.Uri.parse(decoded["uri"] as String).path!!)
        converted = pcm
        val sampleCount = (pcm.length() - 44L) / 2L
        val runtime = Runtime.getRuntime()
        val heapAvailable = runtime.maxMemory() - (runtime.totalMemory() - runtime.freeMemory())
        val memory = ActivityManager.MemoryInfo()
        context.getSystemService(ActivityManager::class.java).getMemoryInfo(memory)
        // Reserve heap for the UI plus native space for both models, ORT and JNI copies.
        // A refusal retains the original recording for retry; it never uploads it.
        require(DiarizationMemory.fits(sampleCount, heapAvailable, memory.availMem, memory.lowMemory)) {
          "Not enough free memory to process this meeting. Your recording is saved; close other apps and retry."
        }
        val samples = FloatArray(sampleCount.toInt())
        RandomAccessFile(pcm, "r").use { wav ->
          wav.seek(44)
          val bytes = ByteArray(32768)
          var offset = 0
          while (offset < samples.size) {
            assertCurrent()
            val count = minOf(bytes.size / 2, samples.size - offset)
            wav.readFully(bytes, 0, count * 2)
            val buffer = ByteBuffer.wrap(bytes, 0, count * 2).order(ByteOrder.LITTLE_ENDIAN)
            repeat(count) { samples[offset++] = buffer.short.toFloat() / 32768f }
          }
        }
        assertCurrent()
        val active = OfflineSpeakerDiarization(config = OfflineSpeakerDiarizationConfig(
          segmentation = OfflineSpeakerSegmentationModelConfig(
            pyannote = OfflineSpeakerSegmentationPyannoteModelConfig(model = segmentation.path, windowShiftRatio = 0.1f),
            numThreads = 2, provider = "cpu"),
          embedding = SpeakerEmbeddingExtractorConfig(model = embedding.path, numThreads = 2, provider = "cpu"),
          clustering = FastClusteringConfig(numClusters = if (numberOfSpeakers == 0) -1 else numberOfSpeakers, threshold = 0.5f),
          minDurationOn = 0.3f, minDurationOff = 0.5f))
        engine = active
        check(active.sampleRate() == 16000) { "Unsupported speaker model sample rate." }
        assertCurrent()
        val segments = active.process(samples).sortedBy { it.start }
        assertCurrent()
        promise.resolve(mapOf(
          "speakerCount" to segments.map { it.speaker }.filter { it >= 0 }.distinct().size,
          "segments" to segments.map { mapOf("start" to it.start.toDouble(), "end" to it.end.toDouble(),
            "speakerId" to if (it.speaker >= 0) it.speaker else null) },
          // This API reports within-meeting labels, not cross-meeting voice identities.
          "embeddings" to emptyMap<String, Any>()))
      } catch (error: Exception) {
        promise.reject("ERR_DIARIZATION", error.message, error)
      } catch (error: OutOfMemoryError) {
        promise.reject("ERR_DIARIZATION_MEMORY", "Not enough memory. Your meeting recording is saved for retry.", error)
      } finally {
        engine?.release()
        converted?.delete()
      }
    }
  }

  fun cancel() { generation.incrementAndGet() }
  fun close() { cancel(); worker.shutdown() }
}
