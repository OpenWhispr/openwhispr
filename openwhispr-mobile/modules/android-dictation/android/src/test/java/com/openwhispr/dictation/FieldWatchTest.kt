package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test

class FieldWatchTest {
  private val text = "I'll ask Sinty for the March numbers today."

  @Test fun aFixInTheWatchedFieldIsReportedAgainstTheTextAfterTheDictation() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertTrue(watch.inWindow(1_000))
    val fixed = "I'll ask Synty for the March numbers today."
    assertEquals(text to fixed, watch.settled(fixed, isPassword = false))
  }

  @Test fun theSameTextIsReportedOnce() {
    val watch = FieldWatch()
    watch.start(text, 0)
    val fixed = "I'll ask Synty for the March numbers today."
    assertNotNull(watch.settled(fixed, false))
    assertNull(watch.settled(fixed, false))
    assertNull(FieldWatch().also { it.start(text, 0) }.settled(text, false))
  }

  @Test fun theWatchEndsAfterThirtySeconds() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertTrue(watch.inWindow(FieldWatch.WINDOW_MS))
    assertFalse(watch.inWindow(FieldWatch.WINDOW_MS + 1))
    assertFalse(watch.watching)
    assertNull(watch.settled("anything", false))
  }

  @Test fun aSentMessageThatEmptiedTheBoxIsNotAFix() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertNull(watch.settled("", false))
    assertNull(watch.settled("   ", false))
    assertTrue(watch.watching)
  }

  @Test fun aFieldThatBecamePasswordIsNeverReadAgain() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertNull(watch.settled("secret", isPassword = true))
    assertFalse(watch.watching)
  }

  @Test fun nothingIsWatchedBeforeADictation() {
    val watch = FieldWatch()
    assertFalse(watch.inWindow(0))
    assertNull(watch.settled(text, false))
  }
}
