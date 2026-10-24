package com.openwhispr.dictation

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

object AudioDecoder {
  fun decode(context: Context, input: File, maxDurationMs: Long? = null, cancelled: () -> Boolean = { false }): Map<String, Any> {
    val output = File(context.cacheDir, "decoded-${System.nanoTime()}.wav")
    val extractor = MediaExtractor()
    var decoder: MediaCodec? = null
    try {
      try {
        extractor.setDataSource(input.path)
      } catch (error: Exception) {
        throw IllegalArgumentException(context.getString(R.string.ow_audio_unreadable), error)
      }
      val track = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: error(context.getString(R.string.ow_audio_unreadable))
      extractor.selectTrack(track)
      val format = extractor.getTrackFormat(track)
      if (maxDurationMs != null && format.containsKey(MediaFormat.KEY_DURATION)) {
        require(format.getLong(MediaFormat.KEY_DURATION) <= maxDurationMs * 1000) { "SAMPLE_TOO_LONG" }
      }
      var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
      decoder = codec; codec.configure(format, null, null, 0); codec.start()
      var inputEnded = false; var outputEnded = false; var inputFrames = 0L; var outputFrames = 0L
      val info = MediaCodec.BufferInfo()
      val deadline = System.currentTimeMillis() + 300000
      RandomAccessFile(output, "rw").use { wav ->
        wav.write(ByteArray(44))
        while (!outputEnded) {
          check(!cancelled()) { "Dictation cancelled." }
          check(System.currentTimeMillis() < deadline) { "Audio conversion timed out." }
          if (!inputEnded) {
            val slot = codec.dequeueInputBuffer(10000)
            if (slot >= 0) {
              val buffer = codec.getInputBuffer(slot)!!
              val size = extractor.readSampleData(buffer, 0)
              if (size < 0) { codec.queueInputBuffer(slot, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnded = true }
              else { codec.queueInputBuffer(slot, 0, size, extractor.sampleTime, 0); extractor.advance() }
            }
          }
          val slot = codec.dequeueOutputBuffer(info, 10000)
          if (slot == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            val decoded = codec.outputFormat
            rate = decoded.getInteger(MediaFormat.KEY_SAMPLE_RATE); channels = decoded.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            check(!decoded.containsKey(MediaFormat.KEY_PCM_ENCODING) || decoded.getInteger(MediaFormat.KEY_PCM_ENCODING) == 2) { "This audio encoding is not supported." }
          } else if (slot >= 0) {
            val buffer = codec.getOutputBuffer(slot)!!.order(ByteOrder.LITTLE_ENDIAN)
            buffer.position(info.offset); buffer.limit(info.offset + info.size)
            check(rate in 4000..384000 && channels in 1..32) { "Unsupported audio format." }
            val frames = info.size / (channels * 2)
            val capacity = ((frames.toLong() * 16000 + rate - 1) / rate + 2) * 2
            val bytes = ByteBuffer.allocate(capacity.toInt()).order(ByteOrder.LITTLE_ENDIAN)
            while (buffer.remaining() >= channels * 2) {
              var sum = 0
              repeat(channels) { sum += buffer.short.toInt() }
              inputFrames++
              while (outputFrames * rate < inputFrames * 16000) {
                bytes.putShort((sum / channels).toShort()); outputFrames++
              }
            }
            wav.write(bytes.array(), 0, bytes.position())
            if (maxDurationMs != null) require(outputFrames * 1000 / 16000 <= maxDurationMs) { "SAMPLE_TOO_LONG" }
            outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            codec.releaseOutputBuffer(slot, false)
            check(outputFrames < 16000L * 3600) { "Audio uploads must be shorter than one hour." }
          }
        }
        val dataSize = (outputFrames * 2).toInt()
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(dataSize + 36).put("WAVEfmt ".toByteArray())
        header.putInt(16).putShort(1).putShort(1).putInt(16000).putInt(32000).putShort(2).putShort(16).put("data".toByteArray()).putInt(dataSize)
        wav.seek(0); wav.write(header.array())
      }
      return mapOf("uri" to "file://${output.path}", "durationMs" to outputFrames * 1000 / 16000, "noSpeech" to (outputFrames < 4000))
    } catch (error: Exception) { output.delete(); throw error }
    finally { runCatching { decoder?.stop() }; decoder?.release(); extractor.release() }
  }
}
