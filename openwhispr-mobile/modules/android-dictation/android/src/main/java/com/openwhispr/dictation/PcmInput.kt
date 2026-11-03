package com.openwhispr.dictation

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder

/** The microphone boundary; WavRecorder owns framing, persistence and lifecycle. */
internal interface PcmInput {
  val bufferSize: Int
  val initialized: Boolean
  val recording: Boolean
  fun start()
  fun read(buffer: ShortArray): Int
  fun stop()
  fun release()
}

internal class MicrophoneInput(sampleRate: Int) : PcmInput {
  override val bufferSize = maxOf(4096, AudioRecord.getMinBufferSize(sampleRate,
    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT))
  private val audio = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, sampleRate,
    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)
  override val initialized get() = audio.state == AudioRecord.STATE_INITIALIZED
  override val recording get() = audio.recordingState == AudioRecord.RECORDSTATE_RECORDING
  override fun start() = audio.startRecording()
  override fun read(buffer: ShortArray) = audio.read(buffer, 0, buffer.size)
  override fun stop() = audio.stop()
  override fun release() = audio.release()
}
