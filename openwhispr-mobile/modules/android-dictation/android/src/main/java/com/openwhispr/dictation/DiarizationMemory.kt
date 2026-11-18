package com.openwhispr.dictation

internal object DiarizationMemory {
  fun fits(samples: Long, heapAvailable: Long, availableMemory: Long, lowMemory: Boolean): Boolean {
    if (samples !in 1..Int.MAX_VALUE.toLong() || lowMemory) return false
    // Pinned segmentation model: 10-second windows, 0.1 shift ratio, at most
    // three speaker embeddings per window. Round upward and include an extra
    // window. Fast clustering allocates one double per pair of embeddings.
    val rows = 3L * ((samples + 15999L) / 16000L + 1L)
    val distances = rows * (rows - 1L) / 2L * 8L
    return samples * 4L <= heapAvailable - 64L * 1024 * 1024 &&
      samples * 12L + distances <= availableMemory - 512L * 1024 * 1024
  }
}
