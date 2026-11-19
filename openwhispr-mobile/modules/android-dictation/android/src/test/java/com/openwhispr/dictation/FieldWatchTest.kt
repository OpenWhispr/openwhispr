package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test

class FieldWatchTest {
  private val text = "I'll ask Cynthia for the March numbers today."
  private val fixed = "I'll ask Synthea for the March numbers today."
  private val settle = FieldWatch.SETTLE_MS

  @Test fun aFixIsReportedOnceTheFieldHasBeenStill() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertNull(watch.sample(text, false, 700))
    assertNull(watch.sample(fixed, false, 1_400))
    assertNull(watch.sample(fixed, false, 1_400 + settle - 1))
    assertEquals(text to fixed, watch.sample(fixed, false, 1_400 + settle))
  }

  @Test fun theSameTextIsReportedOnce() {
    val watch = FieldWatch()
    watch.start(text, 0)
    watch.sample(fixed, false, 1_000)
    assertNotNull(watch.sample(fixed, false, 1_000 + settle))
    assertNull(watch.sample(fixed, false, 2_000 + settle))
  }

  @Test fun anUnchangedFieldReportsNothing() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertNull(watch.sample(text, false, 10_000))
  }

  @Test fun aChangeAfterTheWindowIsIgnoredAndEndsTheWatch() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertNull(watch.sample(fixed, false, FieldWatch.WINDOW_MS + 1))
    assertFalse(watch.watching)
  }

  @Test fun aChangeMadeJustBeforeTheWindowEndsStillSettles() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertNull(watch.sample(fixed, false, FieldWatch.WINDOW_MS - 100))
    assertEquals(text to fixed, watch.sample(fixed, false, FieldWatch.WINDOW_MS - 100 + settle))
  }

  @Test fun theWatchEndsAfterTheWindow() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertTrue(watch.active(FieldWatch.WINDOW_MS + settle))
    assertFalse(watch.active(FieldWatch.WINDOW_MS + settle + 1))
    assertFalse(watch.watching)
  }

  @Test fun aSentMessageThatEmptiedTheBoxIsNotAFix() {
    val watch = FieldWatch()
    watch.start(text, 0)
    watch.sample("", false, 1_000)
    assertNull(watch.sample("", false, 1_000 + settle))
    assertTrue(watch.watching)
  }

  @Test fun aFieldThatBecamePasswordIsNeverReadAgain() {
    val watch = FieldWatch()
    watch.start(text, 0)
    assertNull(watch.sample("secret", true, 500))
    assertFalse(watch.watching)
  }

  @Test fun nothingIsWatchedBeforeADictation() {
    val watch = FieldWatch()
    assertFalse(watch.active(0))
    assertNull(watch.sample(text, false, 0))
  }
}
