package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test

class BubbleModesTest {
  @Test fun `modes travel to the pipeline by their JS names`() {
    assertEquals("dictate", BubbleMode.DICTATE.wire)
    assertEquals("write", BubbleMode.ASSISTANT.wire)
    assertEquals("translate", BubbleMode.TRANSLATE.wire)
    assertEquals("edit", BubbleMode.EDIT.wire)
    assertEquals(BubbleMode.ASSISTANT, BubbleMode.fromWire("write"))
    assertEquals(BubbleMode.DICTATE, BubbleMode.fromWire(null))
    assertEquals(BubbleMode.DICTATE, BubbleMode.fromWire("nonsense"))
  }

  @Test fun `every message the app sends has its own tab, and only Still writing has no action`() {
    for (wire in listOf("no-speech", "offline", "out-of-words", "sign-in", "model-needed", "failed"))
      assertTrue(wire, StatusMessage.fromWire(wire)!!.hasAction)
    assertFalse(StatusMessage.STILL_WRITING.hasAction)
    assertNull(StatusMessage.fromWire("unknown"))
  }

  @Test fun `the menu offers Edit selection only with text selected`() {
    assertEquals(listOf(BubbleMode.ASSISTANT, BubbleMode.TRANSLATE), BubbleMenuPolicy.rows(false, false).map { it.mode })
    assertEquals(listOf(BubbleMode.ASSISTANT, BubbleMode.TRANSLATE, BubbleMode.EDIT), BubbleMenuPolicy.rows(true, false).map { it.mode })
  }

  @Test fun `without the assistant every row stays in the menu, greyed`() {
    val rows = BubbleMenuPolicy.rows(true, assistantBlocked = true)
    assertEquals(listOf(BubbleMode.ASSISTANT, BubbleMode.TRANSLATE, BubbleMode.EDIT), rows.map { it.mode })
    assertTrue(rows.none { it.enabled })
    assertTrue(BubbleMenuPolicy.rows(true, assistantBlocked = false).all { it.enabled })
  }

  @Test fun `a failed take's tab stays 7 s, the others 4 s`() {
    for (message in listOf(StatusMessage.NO_SPEECH, StatusMessage.OFFLINE, StatusMessage.FAILED, StatusMessage.OUT_OF_WORDS, StatusMessage.MIC_OFF))
      assertEquals(message.name, 7000L, BubbleMenuPolicy.holdFor(message))
    assertEquals(4000L, BubbleMenuPolicy.holdFor(StatusMessage.SAVED))
    assertEquals(4000L, BubbleMenuPolicy.holdFor(StatusMessage.COPIED))
    assertEquals(7000L, BubbleMenuPolicy.tabLeavesAt(0L, null, touching = false, holdMs = 7000L))
  }

  @Test fun `the first-time hint shows three times, until the menu is used or turned off`() {
    assertTrue(BubbleMenuPolicy.showsHint(null, menuUsed = false, timesShown = 0))
    assertTrue(BubbleMenuPolicy.showsHint("menu", menuUsed = false, timesShown = 2))
    assertFalse(BubbleMenuPolicy.showsHint("menu", menuUsed = false, timesShown = 3))
    assertFalse(BubbleMenuPolicy.showsHint("menu", menuUsed = true, timesShown = 0))
    assertFalse(BubbleMenuPolicy.showsHint("nothing", menuUsed = false, timesShown = 0))
  }

  @Test fun `a finger finds the row under it, not the gaps or the edges`() {
    val rows = BubbleMenuPolicy.rows(true, false)
    // 6 padding, 44 rows, 2 gaps: rows at 6–50, 52–96, 98–142.
    assertNull(BubbleMenuPolicy.rowAt(3f, 50f, 208f, rows, 6f, 44f, 2f))
    assertEquals(0, BubbleMenuPolicy.rowAt(20f, 50f, 208f, rows, 6f, 44f, 2f))
    assertNull(BubbleMenuPolicy.rowAt(51f, 50f, 208f, rows, 6f, 44f, 2f))
    assertEquals(1, BubbleMenuPolicy.rowAt(60f, 50f, 208f, rows, 6f, 44f, 2f))
    assertEquals(2, BubbleMenuPolicy.rowAt(140f, 50f, 208f, rows, 6f, 44f, 2f))
    assertNull(BubbleMenuPolicy.rowAt(150f, 50f, 208f, rows, 6f, 44f, 2f))
    assertNull(BubbleMenuPolicy.rowAt(20f, -1f, 208f, rows, 6f, 44f, 2f))
    assertNull(BubbleMenuPolicy.rowAt(20f, 209f, 208f, rows, 6f, 44f, 2f))
  }

  @Test fun `holding shows the menu unless Settings says Nothing`() {
    assertTrue(BubbleMenuPolicy.holdOpensMenu(null))
    assertTrue(BubbleMenuPolicy.holdOpensMenu("menu"))
    assertFalse(BubbleMenuPolicy.holdOpensMenu("nothing"))
  }

  @Test fun `the tab stays while touched and leaves 4 s after it came out or was let go`() {
    assertEquals(4000L, BubbleMenuPolicy.tabLeavesAt(0L, null, touching = false))
    assertNull(BubbleMenuPolicy.tabLeavesAt(0L, null, touching = true))
    assertEquals(13000L, BubbleMenuPolicy.tabLeavesAt(0L, 9000L, touching = false))
  }

  @Test fun `Translate names its target, Spanish when nothing is saved`() {
    assertEquals("French", BubbleMenuPolicy.translateTarget("French"))
    assertEquals("Spanish", BubbleMenuPolicy.translateTarget(null))
    assertEquals("Spanish", BubbleMenuPolicy.translateTarget("  "))
  }

  @Test fun `hiding lasts 15 minutes`() {
    assertEquals(15 * 60 * 1000L, BubblePolicy.HIDE_FOR_MS)
  }
}
