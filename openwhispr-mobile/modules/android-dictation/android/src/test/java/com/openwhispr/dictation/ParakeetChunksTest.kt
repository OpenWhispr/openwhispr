package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile

class ParakeetChunksTest {
  @Test fun silentEdgesKeepContextAndOriginalTimeOffset() {
    val samples = FloatArray(16000 * 10)
    samples[16000 * 3] = 0.2f
    samples[16000 * 4] = -0.3f
    val trimmed = ParakeetChunks.trimSilence(samples)
    assertEquals(16000 * 3 - 3200, trimmed.offset)
    assertEquals(16000 + 6401, trimmed.samples.size)
    assertTrue(ParakeetChunks.trimSilence(FloatArray(16000)).samples.isEmpty())
  }
  @Test fun overlappingWindowsKeepEachBoundaryWordOnce() {
    val windows = ParakeetChunks.windows(55 * 16000)
    val words = listOf(
      ParakeetChunks.Token("▁first", 0.1, 0.5),
      ParakeetChunks.Token("▁bound", 24.8, 25.0),
      ParakeetChunks.Token("ary", 25.0, 25.2),
      ParakeetChunks.Token(",", 25.2, 25.2),
      ParakeetChunks.Token("▁last", 54.2, 54.7)
    )
    val retained = windows.flatMap { ParakeetChunks.ownedTokens(words, it) }
    assertEquals(words, retained)
    assertEquals("first boundary, last", ParakeetChunks.text(retained))
    assertTrue(windows.all { it.end - it.start <= 29 * 16000 })
  }

  @Test fun windowsCoverLongAudioAndKeepContextWithinFile() {
    val windows = ParakeetChunks.windows(60 * 60 * 16000)
    assertEquals(0, windows.first().start)
    assertEquals(60 * 60 * 16000, windows.last().end)
    windows.zipWithNext().forEach { (a, b) -> assertEquals(a.keepEnd, b.keepStart) }
    assertTrue(ParakeetChunks.windows(0).isEmpty())
  }

  @Test fun pcmReadSkipsHeaderAndReadsOnlyTheRequestedWindow() {
    val file = File.createTempFile("parakeet-pcm", ".wav")
    try {
      RandomAccessFile(file, "rw").use { wav ->
        wav.write(ByteArray(44))
        wav.write(byteArrayOf(0, 0, 0, -128, -1, 127))
        val samples = ParakeetChunks.read(wav, ParakeetChunks.Window(1, 3, 1, 3))
        assertArrayEquals(floatArrayOf(-1f, 32767f / 32768f), samples, 0.00001f)
      }
    } finally { file.delete() }
  }
}
