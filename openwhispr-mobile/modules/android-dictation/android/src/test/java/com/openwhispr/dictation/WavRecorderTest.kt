package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class WavRecorderTest {
  @get:Rule val temporary = TemporaryFolder()

  private class Input : PcmInput {
    override val bufferSize = 4096
    override var initialized = true
    override var recording = false
    val reads = LinkedBlockingQueue<ShortArray>()
    val enteredRead = CountDownLatch(1)
    val released = AtomicInteger()
    var startFailure: Exception? = null
    var failRead = false
    var stopReadError = false
    var finalFrame = shortArrayOf()
    override fun start() {
      startFailure?.let { throw it }
      recording = true
    }
    override fun read(buffer: ShortArray): Int {
      enteredRead.countDown()
      val next = reads.poll(5, TimeUnit.SECONDS) ?: error("Test input did not unblock")
      if (failRead) return -6
      next.copyInto(buffer)
      return next.size
    }
    override fun stop() {
      recording = false
      if (stopReadError) failRead = true
      reads.offer(finalFrame)
    }
    override fun release() { released.incrementAndGet() }
  }

  private fun await(latch: CountDownLatch) =
    assertTrue("Recorder worker did not reach the expected boundary", latch.await(5, TimeUnit.SECONDS))

  private fun assertWav(file: File, rate: Int, pcm: ByteArray) {
    val bytes = file.readBytes()
    assertEquals(44 + pcm.size, bytes.size)
    val header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    assertEquals("RIFF", bytes.copyOfRange(0, 4).toString(Charsets.US_ASCII))
    assertEquals(pcm.size + 36, header.getInt(4))
    assertEquals("WAVEfmt ", bytes.copyOfRange(8, 16).toString(Charsets.US_ASCII))
    assertEquals(1, header.getShort(20).toInt())
    assertEquals(1, header.getShort(22).toInt())
    assertEquals(rate, header.getInt(24))
    assertEquals(rate * 2, header.getInt(28))
    assertEquals(16, header.getShort(34).toInt())
    assertEquals("data", bytes.copyOfRange(36, 40).toString(Charsets.US_ASCII))
    assertEquals(pcm.size, header.getInt(40))
    assertArrayEquals(pcm, bytes.copyOfRange(44, bytes.size))
  }

  @Test fun existingDestinationReleasesInputWithoutChangingTheOriginalFile() {
    val destination = temporary.newFile("existing.wav")
    val original = byteArrayOf(1, 2, 3, 4)
    destination.writeBytes(original)
    val input = Input()
    val recorder = WavRecorder(temporary.root, destinationFile = destination, createInput = { input })
    try {
      assertThrows(IllegalStateException::class.java) { recorder.start() }
      assertEquals(1, input.released.get())
      assertArrayEquals(original, destination.readBytes())
    } finally { recorder.close() }
  }

  @Test fun streamsPcmInOrderAndKeepsTheRecoveryHeaderCurrentBeforeStop() {
    val destination = File(temporary.root, "meeting.wav")
    val input = Input()
    val frames = mutableListOf<Pair<ByteArray, Long>>()
    val delivered = CountDownLatch(2)
    val recorder = WavRecorder(temporary.root, sampleRate = 24000, destinationFile = destination,
      onFrame = { bytes, time -> frames.add(bytes to time); delivered.countDown() }, createInput = { input })
    val first = ShortArray(240) { if (it % 2 == 0) 1000 else -1000 }
    val second = shortArrayOf(Short.MIN_VALUE, Short.MAX_VALUE)
    val pcm = ByteBuffer.allocate((first.size + second.size) * 2).order(ByteOrder.LITTLE_ENDIAN)
    (first + second).forEach { pcm.putShort(it) }
    try {
      input.reads.offer(first); input.reads.offer(second)
      recorder.start()
      await(delivered)
      assertEquals(listOf(0L, 10L), frames.map { it.second })
      assertArrayEquals(pcm.array(), frames.flatMap { it.first.toList() }.toByteArray())
      assertWav(destination, 24000, pcm.array())
      val result = recorder.stop(false)
      assertEquals("file://${destination.absolutePath}", result["uri"])
      assertEquals(10L, result["durationMs"])
      assertEquals(true, result["noSpeech"])
      assertWav(destination, 24000, pcm.array())
      assertEquals(1, input.released.get())
    } finally { recorder.close() }
  }

  @Test fun cancellingUnblocksReadDeletesOwnedAudioAndReleasesTheMicrophone() {
    val input = Input()
    val recorder = WavRecorder(temporary.root, createInput = { input })
    try {
      recorder.start(); await(input.enteredRead)
      val result = recorder.stop(true)
      assertFalse(File(java.net.URI(result["uri"] as String)).exists())
      assertEquals(1, input.released.get())
      assertEquals(0L, result["durationMs"])
    } finally { recorder.close() }
    val nextInput = Input()
    val next = WavRecorder(temporary.root, createInput = { nextInput })
    try { next.start(); next.stop(true) } finally { next.close() }
    assertEquals(1, nextInput.released.get())
  }

  @Test fun interruptedMeetingPreservesThePlayableRecoveryFileAndReportsFailure() {
    val destination = File(temporary.root, "interrupted.wav")
    val input = Input()
    val delivered = CountDownLatch(1)
    val failed = CountDownLatch(1)
    val recorder = WavRecorder(temporary.root, destinationFile = destination,
      onFrame = { _, _ -> delivered.countDown() }, onFailure = { failed.countDown() }, createInput = { input })
    try {
      input.reads.offer(shortArrayOf(1000))
      recorder.start(); await(delivered)
      input.failRead = true
      input.reads.offer(shortArrayOf())
      await(failed)
      assertThrows(Exception::class.java) { recorder.stop(false) }
      assertWav(destination, 16000, byteArrayOf(-24, 3))
      assertEquals(1, input.released.get())
    } finally { recorder.close() }
  }

  @Test fun failedStartReleasesItsInputAndDoesNotBlockTheNextRecorder() {
    val input = Input().apply { startFailure = IllegalStateException("Permission revoked") }
    val recorder = WavRecorder(temporary.root, createInput = { input })
    try {
      assertThrows(IllegalStateException::class.java) { recorder.start() }
      assertEquals(1, input.released.get())
    } finally { recorder.close() }
    val nextInput = Input()
    val next = WavRecorder(temporary.root, createInput = { nextInput })
    try { next.start(); next.stop(true) } finally { next.close() }
  }

  @Test fun aSecondRecorderCannotTakeTheMicrophoneOrReleaseItsOwner() {
    val input = Input()
    val first = WavRecorder(temporary.root, createInput = { input })
    val allocations = AtomicInteger()
    val second = WavRecorder(temporary.root, createInput = { allocations.incrementAndGet(); Input() })
    val third = WavRecorder(temporary.root, createInput = { allocations.incrementAndGet(); Input() })
    try {
      first.start(); await(input.enteredRead)
      assertThrows(IllegalStateException::class.java) { second.start() }
      second.close()
      assertThrows(IllegalStateException::class.java) { third.start() }
      assertEquals(0, allocations.get())
      assertTrue(input.recording)
      assertEquals(0, input.released.get())
      first.stop(true)
    } finally { third.close(); second.close(); first.close() }
  }

  @Test fun stopWaitsForTheFinalInFlightFrameBeforeReturningTheWav() {
    val destination = File(temporary.root, "final-frame.wav")
    val input = Input().apply { finalFrame = shortArrayOf(-1000, 1000) }
    val frames = mutableListOf<ByteArray>()
    val recorder = WavRecorder(temporary.root, destinationFile = destination,
      onFrame = { bytes, _ -> frames.add(bytes) }, createInput = { input })
    try {
      recorder.start(); await(input.enteredRead)
      recorder.stop(false)
      val expected = byteArrayOf(24, -4, -24, 3)
      assertWav(destination, 16000, expected)
      assertEquals(1, frames.size)
      assertArrayEquals(expected, frames.single())
    } finally { recorder.close() }
  }

  @Test fun negativeReadCausedByStopDoesNotReportAnInterruption() {
    val input = Input().apply { stopReadError = true }
    val failures = AtomicInteger()
    val recorder = WavRecorder(temporary.root, onFailure = { failures.incrementAndGet() }, createInput = { input })
    try {
      recorder.start(); await(input.enteredRead)
      recorder.stop(true)
      assertEquals(0, failures.get())
    } finally { recorder.close() }
    assertEquals(1, input.released.get())
  }

  @Test fun fullScaleNegativePcmIsSpeechAndDurationUsesTheConfiguredRate() {
    val input = Input()
    val delivered = CountDownLatch(3)
    val recorder = WavRecorder(temporary.root, sampleRate = 24000,
      onFrame = { _, _ -> delivered.countDown() }, createInput = { input })
    try {
      repeat(3) { input.reads.offer(ShortArray(2000) { Short.MIN_VALUE }) }
      recorder.start(); await(delivered)
      val result = recorder.stop(true)
      assertEquals(250L, result["durationMs"])
      assertEquals(false, result["noSpeech"])
    } finally { recorder.close() }
  }

  @Test fun interruptedTransientRecordingDeletesItsTemporaryAudio() {
    val input = Input()
    val failed = CountDownLatch(1)
    val recorder = WavRecorder(temporary.root, onFailure = { failed.countDown() }, createInput = { input })
    try {
      recorder.start(); await(input.enteredRead)
      input.failRead = true
      input.reads.offer(shortArrayOf())
      await(failed)
      assertThrows(Exception::class.java) { recorder.stop(false) }
      assertTrue(temporary.root.listFiles()!!.isEmpty())
      assertEquals(1, input.released.get())
    } finally { recorder.close() }
  }

  @Test fun timeLimitReportsFailureButRetainsCapturedMeetingAudio() {
    val destination = File(temporary.root, "limited.wav")
    val input = Input()
    val failed = CountDownLatch(1)
    var failure: Exception? = null
    val recorder = WavRecorder(temporary.root, destinationFile = destination, maximumSeconds = 1,
      onFailure = { failure = it; failed.countDown() }, createInput = { input })
    try {
      repeat(8) { input.reads.offer(ShortArray(2000)) }
      recorder.start(); await(failed)
      assertTrue(failure is IllegalStateException)
      assertEquals("Recording reached its time limit.", failure?.message)
      assertThrows(Exception::class.java) { recorder.stop(false) }
      assertWav(destination, 16000, ByteArray(32000))
      assertEquals(1, input.released.get())
    } finally { recorder.close() }
  }

  @Test fun uninitializedInputIsReleasedOnceAndNeverStartsRecording() {
    val input = Input().apply { initialized = false }
    val recorder = WavRecorder(temporary.root, createInput = { input })
    try {
      assertThrows(IllegalStateException::class.java) { recorder.start() }
      assertFalse(input.recording)
    } finally { recorder.close() }
    assertEquals(1, input.released.get())
    assertTrue(temporary.root.listFiles()!!.isEmpty())
  }
}
