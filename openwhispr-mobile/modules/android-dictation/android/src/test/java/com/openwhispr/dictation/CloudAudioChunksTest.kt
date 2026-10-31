package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files

class CloudAudioChunksTest {
  private fun fixture(directory: File, seconds: Int): File {
    val payload = ByteArray(seconds * 32000) { (it % 251).toByte() }
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      .put("RIFF".toByteArray()).putInt(payload.size + 36).put("WAVEfmt ".toByteArray())
      .putInt(16).putShort(1).putShort(1).putInt(16000).putInt(32000)
      .putShort(2).putShort(16).put("data".toByteArray()).putInt(payload.size).array()
    return File(directory, "source.wav").apply { writeBytes(header + payload) }
  }

  @Test fun chunksPreserveEverySampleInOrderAndHaveIndependentWavHeaders() {
    val root = Files.createTempDirectory("cloud-chunks-test").toFile()
    try {
      val input = fixture(root, 241)
      val destination = File(root, "chunks").apply { mkdir() }
      val chunks = CloudAudioChunks.split(input, destination, 120) { false }
      assertEquals(listOf(3840044L, 3840044L, 32044L), chunks.map { it.length() })
      val payload = chunks.flatMap { chunk ->
        val bytes = chunk.readBytes()
        val header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(bytes, 0, 4))
        assertEquals("WAVEfmt ", String(bytes, 8, 8))
        assertEquals(bytes.size - 8, header.getInt(4))
        assertEquals(16000, header.getInt(24))
        assertEquals(bytes.size - 44, header.getInt(40))
        bytes.drop(44)
      }.toByteArray()
      assertArrayEquals(input.readBytes().drop(44).toByteArray(), payload)
      assertTrue(input.exists())
    } finally { root.deleteRecursively() }
  }

  @Test fun cancellationRemovesOnlyThisAttemptsPartialChunks() {
    val root = Files.createTempDirectory("cloud-chunks-cancel").toFile()
    try {
      val input = fixture(root, 3)
      val destination = File(root, "chunks").apply { mkdir() }
      val other = File(root, "other.wav").apply { writeText("retain me") }
      assertThrows(IllegalStateException::class.java) {
        CloudAudioChunks.split(input, destination, 1) {
          (destination.listFiles()?.size ?: 0) >= 2
        }
      }
      assertEquals(0, destination.listFiles()!!.size)
      assertEquals("retain me", other.readText())
      assertEquals(96044L, input.length())
    } finally { root.deleteRecursively() }
  }

  @Test fun refusesTruncatedOrNonCanonicalInputWithoutCreatingChunks() {
    val root = Files.createTempDirectory("cloud-chunks-invalid").toFile()
    try {
      val input = fixture(root, 1)
      val destination = File(root, "chunks").apply { mkdir() }
      val original = input.readBytes()
      for (invalid in listOf(original.copyOf(100), original.copyOf().apply { this[22] = 2 })) {
        input.writeBytes(invalid)
        assertThrows(IllegalArgumentException::class.java) {
          CloudAudioChunks.split(input, destination, 120) { false }
        }
        assertEquals(0, destination.listFiles()!!.size)
      }
    } finally { root.deleteRecursively() }
  }

  @Test fun alreadyCancelledInputProducesNoOutput() {
    val root = Files.createTempDirectory("cloud-chunks-pre-cancel").toFile()
    try {
      val input = fixture(root, 1)
      val destination = File(root, "chunks").apply { mkdir() }
      assertThrows(IllegalStateException::class.java) {
        CloudAudioChunks.split(input, destination, 120) { true }
      }
      assertEquals(0, destination.listFiles()!!.size)
      assertTrue(input.exists())
    } finally { root.deleteRecursively() }
  }
}
