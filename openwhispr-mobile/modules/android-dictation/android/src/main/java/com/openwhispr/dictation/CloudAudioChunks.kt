package com.openwhispr.dictation

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal object CloudAudioChunks {
  // AudioDecoder produces this canonical 16 kHz mono PCM layout. Copy bounded
  // blocks, not an entire recording, and leave the retained input untouched.
  fun split(input: File, destination: File, seconds: Int, cancelled: () -> Boolean): List<File> {
    require(seconds in 1..120) { "Invalid Cloud audio chunk duration." }
    require(destination.isDirectory) { "Missing Cloud audio directory." }
    val chunks = mutableListOf<File>()
    try {
      check(!cancelled()) { "Transcription cancelled." }
      RandomAccessFile(input, "r").use { source ->
        require(source.length() >= 44) { "Incomplete decoded audio." }
        val header = ByteArray(44).also { source.readFully(it) }
        val fields = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
        val payload = fields.getInt(40)
        require(String(header, 0, 4) == "RIFF" && String(header, 8, 8) == "WAVEfmt " &&
          String(header, 36, 4) == "data" && fields.getInt(16) == 16 &&
          fields.getShort(20).toInt() == 1 && fields.getShort(22).toInt() == 1 &&
          fields.getInt(24) == 16000 && fields.getInt(28) == 32000 &&
          fields.getShort(32).toInt() == 2 && fields.getShort(34).toInt() == 16 &&
          payload > 0 && payload % 2 == 0 && source.length() == payload.toLong() + 44 &&
          fields.getInt(4) == payload + 36) { "Invalid decoded audio." }
        var remaining = payload
        val buffer = ByteArray(64 * 1024)
        while (remaining > 0) {
          check(!cancelled()) { "Transcription cancelled." }
          val size = minOf(remaining, seconds * 32000)
          val chunk = File(destination, "chunk-${chunks.size}.wav")
          check(chunk.createNewFile()) { "Cloud audio chunk already exists." }
          chunks.add(chunk)
          chunk.outputStream().buffered().use { output ->
            fields.putInt(4, size + 36).putInt(40, size)
            output.write(header)
            var pending = size
            while (pending > 0) {
              check(!cancelled()) { "Transcription cancelled." }
              val count = minOf(pending, buffer.size)
              source.readFully(buffer, 0, count)
              output.write(buffer, 0, count)
              pending -= count
            }
          }
          remaining -= size
        }
      }
      check(!cancelled()) { "Transcription cancelled." }
      return chunks
    } catch (error: Exception) {
      chunks.forEach { it.delete() }
      throw error
    }
  }
}
