package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test

class DiarizationMemoryTest {
  private val mib = 1024L * 1024L

  @Test fun shortMeetingFitsWithHeadroom() {
    assertTrue(DiarizationMemory.fits(30L * 16000, 128 * mib, 1024 * mib, false))
  }

  @Test fun longMeetingMustAlsoFitThePairwiseSpeakerDistanceMatrix() {
    // Audio copies fit 1.25 GiB, but a one-hour worst-case clustering matrix does not.
    assertFalse(DiarizationMemory.fits(3600L * 16000, 512 * mib, 1280 * mib, false))
    assertTrue(DiarizationMemory.fits(3600L * 16000, 512 * mib, 2048 * mib, false))
  }

  @Test fun rejectsHeapPressureSystemPressureAndInvalidSizes() {
    assertFalse(DiarizationMemory.fits(30L * 16000, 64 * mib, 2048 * mib, false))
    assertFalse(DiarizationMemory.fits(30L * 16000, 512 * mib, 2048 * mib, true))
    assertFalse(DiarizationMemory.fits(0, 512 * mib, 2048 * mib, false))
    assertFalse(DiarizationMemory.fits(Long.MAX_VALUE, Long.MAX_VALUE, Long.MAX_VALUE, false))
  }
}
