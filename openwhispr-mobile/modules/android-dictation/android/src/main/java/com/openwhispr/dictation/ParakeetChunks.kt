package com.openwhispr.dictation

import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs

/** AudioDecoder writes a 44-byte header followed by 16 kHz mono PCM16. */
object ParakeetChunks {
  const val RATE = 16000
  private const val CORE = 25 * RATE
  private const val CONTEXT = 2 * RATE
  data class Window(val start: Int, val end: Int, val keepStart: Int, val keepEnd: Int)
  data class Token(val text: String, val start: Double, val end: Double)
  data class Audio(val samples: FloatArray, val offset: Int)

  fun windows(samples: Int): List<Window> = (0 until samples step CORE).map { start ->
    val end = minOf(samples, start + CORE)
    Window(maxOf(0, start - CONTEXT), minOf(samples, end + CONTEXT), start, end)
  }

  fun read(file: RandomAccessFile, window: Window): FloatArray {
    val data = ByteArray((window.end - window.start) * 2)
    file.seek(44L + window.start * 2L)
    file.readFully(data)
    val buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
    return FloatArray(data.size / 2) { buffer.short.toFloat() / 32768f }
  }

  fun trimSilence(samples: FloatArray): Audio {
    // Trim only near-digital silence, retaining 200 ms of context around speech.
    val first = samples.indexOfFirst { abs(it) > 8f / 32768f }
    if (first < 0) return Audio(floatArrayOf(), 0)
    val last = samples.indexOfLast { abs(it) > 8f / 32768f }
    val start = maxOf(0, first - RATE / 5)
    val end = minOf(samples.size, last + 1 + RATE / 5)
    return Audio(samples.copyOfRange(start, end), start)
  }

  fun ownedTokens(tokens: List<Token>, window: Window): List<Token> {
    val words = mutableListOf<MutableList<Token>>()
    for (token in tokens) {
      if (words.isEmpty() || token.text.startsWith("▁") || token.text.startsWith(" ")) words.add(mutableListOf())
      words.last().add(token)
    }
    return words.filter { word ->
      val midpoint = (word.first().start + word.maxOf { it.end }) / 2 * RATE
      midpoint >= window.keepStart && midpoint < window.keepEnd
    }.flatten()
  }

  fun text(tokens: List<Token>): String = tokens.joinToString("") { it.text }.replace('▁', ' ').trim()
}
