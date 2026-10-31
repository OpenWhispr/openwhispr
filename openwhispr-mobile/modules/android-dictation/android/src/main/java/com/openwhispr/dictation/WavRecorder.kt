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
) {
  constructor(
    context: Context,
    sampleRate: Int = 16000,
    destinationFile: File? = null,
    maximumSeconds: Int = 300,
    onFrame: ((ByteArray, Long) -> Unit)? = null,
    onFailure: ((Exception) -> Unit)? = null,
  ) : this(context.cacheDir, sampleRate, destinationFile, maximumSeconds, onFrame, onFailure,
    { rate -> MicrophoneInput(rate) })

  companion object { private val microphoneInUse = AtomicBoolean(false) }
  private var ownsMicrophone = false
  private val executor = Executors.newSingleThreadExecutor()
  @Volatile private var recording = false
  private var recorder: PcmInput? = null
  private var task: Future<*>? = null
  private var file: File? = null
  private var peak = 0
  private var samples = 0L

  @Synchronized fun start() {
    check(!recording) { "A recording is already active." }
    check(microphoneInUse.compareAndSet(false, true)) { "Finish your current recording first." }
    ownsMicrophone = true
    try {
    val audio = createInput(sampleRate)
    val size = audio.bufferSize
    check(audio.initialized) { audio.release(); "Microphone could not start." }
    recorder = audio
    val destination = destinationFile ?: File(cacheDirectory, "dictation-${System.nanoTime()}.wav")
    check(!destination.exists()) { "Recording file already exists." }
    file = destination; peak = 0; samples = 0
    audio.start()
    check(audio.recording) { "Microphone could not start." }
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
          val buffer = ShortArray(size / 2)
          try {
            while (recording && samples < sampleRate.toLong() * maximumSeconds) {
              val count = audio.read(buffer)
              if (count < 0 && !recording) break
              check(count >= 0) { "Microphone interrupted ($count)." }
              if (count == 0) continue
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
          if (recording && onFailure != null) throw IllegalStateException("Recording reached its time limit.")
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
    try {
      recorder?.stop(); task?.get(5, TimeUnit.SECONDS)
      val result = mapOf("uri" to "file://${file!!.absolutePath}", "durationMs" to samples * 1000 / sampleRate,
        "noSpeech" to (samples < 4000 || peak < 180))
      if (cancel) file?.delete()
      return result
    } catch (error: Exception) { if (destinationFile == null) file?.delete(); throw error }
    finally { recorder?.release(); recorder = null; task = null; file = null; freeMicrophone() }
  }

  private fun freeMicrophone() { if (ownsMicrophone) { ownsMicrophone = false; microphoneInUse.set(false) } }
  fun close() { if (recorder != null) runCatching { stop(true) }; freeMicrophone(); executor.shutdown() }
}
