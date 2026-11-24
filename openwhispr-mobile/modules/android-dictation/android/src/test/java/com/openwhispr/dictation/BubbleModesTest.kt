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
    assertFalse(BubbleMenuPolicy.showsHint("talk", menuUsed = false, timesShown = 0))
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

  @Test fun `holding shows the menu while the Assistant is on`() {
    assertTrue(BubbleMenuPolicy.holdOpensMenu(null))
    assertTrue(BubbleMenuPolicy.holdOpensMenu("menu"))
    assertFalse(BubbleMenuPolicy.holdOpensMenu("talk"))
    assertFalse(BubbleMenuPolicy.holdOpensMenu("nothing"))
  }

  @Test fun `with the Assistant off a hold is hold to talk`() {
    assertTrue(BubbleMenuPolicy.holdToTalk("talk"))
    // Builds before the Assistant switch saved "Nothing"; that now means off too.
    assertTrue(BubbleMenuPolicy.holdToTalk("nothing"))
    assertFalse(BubbleMenuPolicy.holdToTalk("menu"))
    assertFalse(BubbleMenuPolicy.holdToTalk(null))
    assertTrue(BubbleMenuPolicy.TALK_HOLD_MS < BubbleMenuPolicy.HOLD_MS)
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

  @Test fun `the menu follows the bubble's size, within readable bounds`() {
    assertEquals(1f, BubbleMenuPolicy.menuScale(1f), 0f)
    assertEquals(1.125f, BubbleMenuPolicy.menuScale(1.125f), 0f)
    assertEquals(0.875f, BubbleMenuPolicy.menuScale(0.75f), 0f)
    assertEquals(1.25f, BubbleMenuPolicy.menuScale(1.375f), 0f)
    assertEquals(1f, BubbleMenuPolicy.menuScale(Float.NaN), 0f)
  }

  @Test fun `the open menu follows the bubble's see-through, never below 85 %`() {
    assertEquals(0.85f, BubbleMenuPolicy.menuAlpha(0.5f), 0f)
    assertEquals(0.85f, BubbleMenuPolicy.menuAlpha(0.2f), 0f)
    assertEquals(0.9f, BubbleMenuPolicy.menuAlpha(0.9f), 0f)
    assertEquals(1f, BubbleMenuPolicy.menuAlpha(1f), 0f)
    assertEquals(1f, BubbleMenuPolicy.menuAlpha(Float.NaN), 0f)
  }

  @Test fun `the keyboard redrawing after a light-dark switch keeps the hold menu open`() {
    // Any change closes it with no switch, as before.
    assertTrue(BubbleMenuPolicy.keyboardClosesMenu(true, true, topChanged = true, fieldChanged = false, sinceThemeSwitchMs = null))
    assertTrue(BubbleMenuPolicy.keyboardClosesMenu(true, true, topChanged = false, fieldChanged = true, sinceThemeSwitchMs = 5000))
    // Within the settle window a moved top or a new field id while still typing keeps it.
    assertFalse(BubbleMenuPolicy.keyboardClosesMenu(true, true, topChanged = true, fieldChanged = false, sinceThemeSwitchMs = 300))
    assertFalse(BubbleMenuPolicy.keyboardClosesMenu(true, true, topChanged = true, fieldChanged = true, sinceThemeSwitchMs = 0))
    // The keyboard going away always closes it.
    assertTrue(BubbleMenuPolicy.keyboardClosesMenu(true, false, topChanged = true, fieldChanged = true, sinceThemeSwitchMs = 300))
    // Nothing changed: nothing to close.
    assertFalse(BubbleMenuPolicy.keyboardClosesMenu(true, true, topChanged = false, fieldChanged = false, sinceThemeSwitchMs = null))
    assertTrue(BubbleMenuPolicy.keyboardClosesMenu(true, true, topChanged = true, fieldChanged = false, sinceThemeSwitchMs = BubbleMenuPolicy.THEME_SETTLE_MS))
  }

  @Test fun `a keyboard gone right after a light-dark switch is checked again before the menu closes`() {
    assertTrue(BubbleMenuPolicy.holdsKeyboardLoss(wasTyping = true, typing = false, sinceThemeSwitchMs = 900))
    assertFalse(BubbleMenuPolicy.holdsKeyboardLoss(wasTyping = true, typing = false, sinceThemeSwitchMs = null))
    assertFalse(BubbleMenuPolicy.holdsKeyboardLoss(wasTyping = true, typing = false, sinceThemeSwitchMs = BubbleMenuPolicy.THEME_SETTLE_MS))
    assertFalse(BubbleMenuPolicy.holdsKeyboardLoss(wasTyping = true, typing = true, sinceThemeSwitchMs = 900))
    assertFalse(BubbleMenuPolicy.holdsKeyboardLoss(wasTyping = false, typing = false, sinceThemeSwitchMs = 900))
  }
}
