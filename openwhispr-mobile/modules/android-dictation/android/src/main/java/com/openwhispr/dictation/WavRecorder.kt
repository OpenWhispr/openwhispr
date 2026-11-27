package com.openwhispr.dictation

import android.content.Context
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

class WavRecorder internal constructor(
  private val cacheDirectory: File,
  private val sampleRate: Int = 16000,
  private val destinationFile: File? = null,
  private val maximumSeconds: Int = 300,
  private val onFrame: ((ByteArray, Long) -> Unit)? = null,
  private val onFailure: ((Exception) -> Unit)? = null,
  private val createInput: (Int) -> PcmInput,
  /** How much audio each read takes, so [onLevel] fires that often; null reads half the input's buffer. */
  private val readMillis: Int? = null,
  /** What [onLevel] reports for each read; [BubblePolicy.level] when null. */
  private val measure: ((ShortArray, Int) -> Float)? = null,
  /** Who holds the microphone while this records: `in_app`, `practice`, `bubble` or `meeting`. */
  private val owner: String = "in_app",
  /** The [AndroidDictationModule] instance that made it, so an earlier instance's recorder can be told apart. */
  private val module: Int? = null,
  private val run: String? = null,
) {
  constructor(
    context: Context,
    sampleRate: Int = 16000,
    destinationFile: File? = null,
    maximumSeconds: Int = 300,
    onFrame: ((ByteArray, Long) -> Unit)? = null,
    onFailure: ((Exception) -> Unit)? = null,
    readMillis: Int? = null,
    measure: ((ShortArray, Int) -> Float)? = null,
    owner: String = "in_app",
    module: Int? = null,
    run: String? = null,
  ) : this(context.cacheDir, sampleRate, destinationFile, maximumSeconds, onFrame, onFailure,
    { rate -> MicrophoneInput(rate) }, readMillis, measure, owner, module, run)

  /** Who holds the process-wide microphone lock, and since when. */
  data class MicLock(val owner: String, val module: Int?, val run: String?, val takenAtMs: Long) {
    fun heldMs(now: Long = clock()) = now - takenAtMs
  }

  /** The lock is taken: [holder] is who has it (null if it was freed in between). */
  class MicrophoneBusyException(val holder: MicLock?) : IllegalStateException("Finish your current recording first.")

  companion object {
    private val microphoneInUse = AtomicBoolean(false)
    /** The current holder, for the debug log, Sentry and the "a meeting is recording" copy. */
    @Volatile var holder: MicLock? = null
      private set
    /** Elapsed-realtime clock; a test can replace it. */
    internal var clock: () -> Long = { runCatching { android.os.SystemClock.elapsedRealtime() }.getOrDefault(System.nanoTime() / 1_000_000) }
  }
  private var takenAt = 0L
  private var ownsMicrophone = false
  /** Loudness from 0 to 1 for each buffer read, on the recording thread. */
  @Volatile var onLevel: ((Float) -> Unit)? = null
  private val executor = Executors.newSingleThreadExecutor()
  @Volatile private var recording = false
  private var recorder: PcmInput? = null
  private var task: Future<*>? = null
  private var file: File? = null
  private var peak = 0
  /** Loudness of the latest buffer, 0..1 ([measure], else -60..-20 dBFS), for an in-app meter. */
  @Volatile var level = 0f
    private set
  private var samples = 0L

  @Synchronized fun start() {
    if (recording) {
      DebugLog.event('W', "mic", "lock.refused", "requester" to owner, "reason" to "already_active", "run" to run)
      throw IllegalStateException("A recording is already active.")
    }
    if (!microphoneInUse.compareAndSet(false, true)) {
      val current = holder
      DebugLog.event('W', "mic", "lock.refused", "requester" to owner, "owner" to current?.owner,
        "module" to current?.module?.let { "m$it" }, "held_ms" to current?.let { clock() - it.takenAtMs }, "run" to run)
      throw MicrophoneBusyException(current)
    }
    ownsMicrophone = true
    takenAt = clock()
    holder = MicLock(owner, module, run, takenAt)
    DebugLog.event('I', "mic", "lock.taken", "run" to run, "owner" to owner, "module" to module?.let { "m$it" },
      "source" to "mic", "rate" to sampleRate)
    try {
    val audio = createInput(sampleRate)
    val size = audio.bufferSize
    if (!audio.initialized) {
      DebugLog.event('E', "mic", "init_failed", "run" to run, "owner" to owner, "rate" to sampleRate, "buffer" to size,
        "init_state" to "uninitialized")
      audio.release(); throw IllegalStateException("Microphone could not start.")
    }
    recorder = audio
    val destination = destinationFile ?: File(cacheDirectory, "dictation-${System.nanoTime()}.wav")
    check(!destination.exists()) { "Recording file already exists." }
    file = destination; peak = 0; samples = 0
    audio.start()
    if (!audio.recording) {
      DebugLog.event('E', "mic", "init_failed", "run" to run, "owner" to owner, "rate" to sampleRate, "buffer" to size,
        "init_state" to "not_recording")
      throw IllegalStateException("Microphone could not start.")
    }
    recording = true
    task = executor.submit {
      try {
        RandomAccessFile(destination, "rw").use { out ->
          fun updateHeader() {
            val dataSize = (samples * 2).toInt()
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray()).putInt(dataSize + 36).put("WAVEfmt ".toByteArray())
            header.putInt(16).putShort(1).putShort(1).putInt(sampleRate).putInt(sampleRate * 2).putShort(2).putShort(16)
            header.put("data".toByteArray()).putInt(dataSize)
            out.seek(0); out.write(header.array()); out.seek(44L + dataSize)
          }
          updateHeader()
          val buffer = ShortArray(readMillis?.let { (sampleRate * it / 1000).coerceIn(1, size / 2) } ?: (size / 2))
          try {
            while (recording && samples < sampleRate.toLong() * maximumSeconds) {
              val count = audio.read(buffer)
              if (count < 0 && !recording) break
              check(count >= 0) { "Microphone interrupted ($count)." }
              if (count == 0) continue
              val loudness = measure?.invoke(buffer, count) ?: BubblePolicy.level(buffer, count)
              level = loudness
              onLevel?.invoke(loudness)
              val bytes = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
              for (i in 0 until count) { bytes.putShort(buffer[i]); peak = maxOf(peak, abs(buffer[i].toInt())) }
              val data = bytes.array()
              out.write(data)
              val startedAt = samples * 1000 / sampleRate
              samples += count
              // Keep the WAV playable after process death, not just after Stop.
              if (destinationFile != null) updateHeader()
              onFrame?.invoke(data, startedAt)
            }
          } finally { updateHeader() }
          if (recording && onFailure != null) {
            DebugLog.event('W', "mic", "recording.cap", "run" to run, "owner" to owner, "seconds" to maximumSeconds)
            throw IllegalStateException("Recording reached its time limit.")
          }
        }
      } catch (error: Exception) {
        onFailure?.invoke(error)
        throw error
      }
    }
    } catch (error: Exception) { close(); throw error }
  }

  @Synchronized fun stop(cancel: Boolean): Map<String, Any> {
    check(recorder != null) { "No recording is active." }
    recording = false
    level = 0f
    try {
      recorder?.stop(); task?.get(5, TimeUnit.SECONDS)
      val durationMs = samples * 1000 / sampleRate
      val result = mapOf("uri" to "file://${file!!.absolutePath}", "durationMs" to durationMs,
        "noSpeech" to (samples < 4000 || peak < 180))
      DebugLog.event('I', "mic", "recording.stop", "run" to run, "owner" to owner, "audio_ms" to durationMs,
        "peak" to peak / 32768.0, "cap" to (samples >= sampleRate.toLong() * maximumSeconds), "cleared" to cancel)
      if (cancel) file?.delete()
      return result
    } catch (error: Exception) { if (destinationFile == null) file?.delete(); throw error }
    finally { recorder?.release(); recorder = null; task = null; file = null; freeMicrophone() }
  }

  private fun freeMicrophone() {
    if (!ownsMicrophone) return
    ownsMicrophone = false
    holder = null
    microphoneInUse.set(false)
    DebugLog.event('I', "mic", "lock.freed", "run" to run, "owner" to owner, "held_ms" to clock() - takenAt)
  }
  fun close() { if (recorder != null) runCatching { stop(true) }; freeMicrophone(); executor.shutdown() }
}
