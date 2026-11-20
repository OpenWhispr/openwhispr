package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test

class BubblePolicyTest {
  private fun visible(
    appVisible: Boolean = false, practice: Boolean = false, accessibility: Boolean = true,
    typing: Boolean = false, hidden: Boolean = false, busy: Boolean = false,
  ) = BubblePolicy.visible(appVisible, practice, accessibility, typing, hidden, busy)

  @Test fun showsOnlyWhileATextBoxIsFocusedInAnotherApp() {
    assertTrue(visible(typing = true))
    assertFalse(visible(typing = false))
    assertFalse(visible(appVisible = true, typing = true))
  }

  @Test fun practiceAlwaysShowsAndAnActiveDictationStaysOnScreen() {
    assertTrue(visible(appVisible = true, practice = true))
    assertTrue(visible(busy = true, typing = false))
    assertTrue(visible(busy = true, hidden = true))
    assertFalse(visible(appVisible = true, busy = true))
  }

  @Test fun hidingForAnHourWinsOverTyping() {
    assertFalse(visible(typing = true, hidden = true))
  }

  @Test fun withoutAccessibilityTheBubbleFallsBackToShowingInTheBackground() {
    assertTrue(visible(accessibility = false))
    assertFalse(visible(accessibility = false, hidden = true))
  }

  @Test fun passwordAndReadOnlyFieldsNeverTakeDictation() {
    assertTrue(BubblePolicy.canDictate(editable = true, password = false))
    assertFalse(BubblePolicy.canDictate(editable = true, password = true))
    assertFalse(BubblePolicy.canDictate(editable = false, password = false))
  }

  @Test fun releasedBubbleSettlesOnTheNearestEdge() {
    assertTrue(BubblePolicy.dockRight(700f, 1080))
    assertFalse(BubblePolicy.dockRight(300f, 1080))
  }

  @Test fun hideTargetCatchesOnlyANearbyBubble() {
    assertTrue(BubblePolicy.overTarget(540f, 1900f, 540f, 1950f, 120f))
    assertFalse(BubblePolicy.overTarget(540f, 1500f, 540f, 1950f, 120f))
  }

  @Test fun bubbleSitsAboveTheKeyboardAndNeverOverIt() {
    // Default: just above the keyboard.
    assertEquals(1200 - 40 - 150, BubblePolicy.bubbleTop(null, 1200, 2400, 150, 40, 100))
    // Where the user left it, when that is above the keyboard.
    assertEquals(600, BubblePolicy.bubbleTop(600, 1200, 2400, 150, 40, 100))
    // Pushed up when the keyboard would cover it.
    assertEquals(1010, BubblePolicy.bubbleTop(1500, 1200, 2400, 150, 40, 100))
    // Never under the status bar.
    assertEquals(100, BubblePolicy.bubbleTop(10, 1200, 2400, 150, 40, 100))
  }

  @Test fun levelFollowsLoudness() {
    assertEquals(0f, BubblePolicy.level(ShortArray(160), 160), 0f)
    val quiet = BubblePolicy.level(ShortArray(160) { 100 }, 160)
    val loud = BubblePolicy.level(ShortArray(160) { 12000 }, 160)
    assertTrue(loud > quiet)
    assertTrue(loud <= 1f)
  }

  @Test fun normalSpeechFillsAboutHalfTheBarAndRoomNoiseStaysFlat() {
    // 0.01 of full scale is -40 dBFS, about where normal speech lands on the speech-recognition microphone.
    val speech = BubblePolicy.level(ShortArray(160) { if (it % 2 == 0) 328 else -328 }, 160)
    assertEquals(0.5f, speech, 0.02f)
    val roomNoise = BubblePolicy.level(ShortArray(160) { if (it % 2 == 0) 20 else -20 }, 160)
    assertEquals(0f, roomNoise, 0f)
  }

  @Test fun waveformHasSevenBarsTallestInTheMiddleAndNeverFlat() {
    val bars = BubblePolicy.bars(1f, 0f)
    assertEquals(7, bars.size)
    assertTrue(BubblePolicy.bars(0f, 0f).all { it >= 0.15f })
    assertTrue(bars.all { it in 0.15f..1f })
  }

  @Test fun theReadyBubbleShrinksWhenIdleOrOverASearchFieldOnlyWhenThoseAreOn() {
    fun shrunk(ready: Boolean = true, idle: Boolean = false, whenIdle: Boolean = true, search: Boolean = false, inSearch: Boolean = false) =
      BubblePolicy.shrunk(ready, idle, whenIdle, search, inSearch)
    assertFalse(shrunk())
    assertTrue(shrunk(idle = true))
    assertFalse(shrunk(idle = true, whenIdle = false))
    assertTrue(shrunk(search = true, inSearch = true))
    assertFalse(shrunk(search = true))
    // Search-field shrinking is part of shrinking: with shrinking off, nothing shrinks.
    assertFalse(shrunk(search = true, inSearch = true, whenIdle = false))
    // Dictating, writing and results are always full size.
    assertFalse(shrunk(ready = false, idle = true, search = true, inSearch = true))
  }

  @Test fun searchFieldsAreFoundByIdHintDescriptionOrSearchView() {
    fun search(vararg labels: String?, classes: List<String?> = listOf("android.widget.EditText")) =
      BubblePolicy.searchField(labels.toList(), classes)
    assertTrue(search("com.app:id/search_src_text"))
    assertTrue(search("com.app:id/editSearch"))
    assertTrue(search("com.app:id/searchbox"))
    assertTrue(search(null, "Search contacts"))
    assertTrue(search("com.app:id/input", classes = listOf("android.widget.EditText", "androidx.appcompat.widget.SearchView")))
    assertFalse(search("com.app:id/research_notes"))
    assertFalse(search("com.app:id/message", "Type a message"))
    assertFalse(search())
  }

  @Test fun appearanceIsClampedToWhatTheBubbleCanShow() {
    assertEquals(0.8f, BubbleAppearance().alpha, 0f)
    assertEquals(1f, BubbleAppearance().scale, 0f)
    assertEquals(0.2f, BubbleAppearance(opacity = 0.05f).alpha, 0f)
    assertEquals(1f, BubbleAppearance(opacity = 3f).alpha, 0f)
    assertEquals(0.8f, BubbleAppearance(opacity = Float.NaN).alpha, 0f)
    assertEquals(48 / 64f, BubbleAppearance(size = 10).scale, 0f)
    assertEquals(88 / 64f, BubbleAppearance(size = 200).scale, 0f)
  }

  @Test fun restoresOnlyAChoiceTheUserLeftOnWithPermissionsStillGranted() {
    assertTrue(BubblePolicy.shouldRestore(wanted = true, sdk = 34, overlay = true, microphone = true))
    assertFalse(BubblePolicy.shouldRestore(wanted = false, sdk = 34, overlay = true, microphone = true))
    assertFalse(BubblePolicy.shouldRestore(wanted = true, sdk = 34, overlay = false, microphone = true))
    assertFalse(BubblePolicy.shouldRestore(wanted = true, sdk = 34, overlay = true, microphone = false))
    assertFalse(BubblePolicy.shouldRestore(wanted = true, sdk = 25, overlay = true, microphone = true))
  }

  @Test fun aSavedSizeOutsideTheBubbleRangeFallsBackToMedium() {
    assertEquals(48, BubblePolicy.restoredSize(48))
    assertEquals(80, BubblePolicy.restoredSize(80))
    assertEquals(64, BubblePolicy.restoredSize(0))
    assertEquals(64, BubblePolicy.restoredSize(200))
  }

  @Test fun keepsThePipelineAwakeOnlyWhileADictationIsInFlight() {
    assertTrue(BubblePolicy.keepsPipelineAwake(BubbleState.LISTENING, false))
    assertTrue(BubblePolicy.keepsPipelineAwake(BubbleState.PROCESSING, false))
    assertTrue(BubblePolicy.keepsPipelineAwake(BubbleState.READY, true))
    for (state in listOf(BubbleState.READY, BubbleState.RETRY, BubbleState.RECOVER))
      assertFalse(BubblePolicy.keepsPipelineAwake(state, false))
  }

  @Test fun theWindowFollowsSizeAndLookOpacityInEveryState() {
    // Josh, 20 Nov: listening and writing were solid; the bubble keeps its opacity throughout.
    val faint = BubbleAppearance(opacity = 0.5f).alpha
    assertEquals(0.5f, BubblePolicy.windowAlpha(faint, menuOpen = false), 0f)
    assertEquals(1f, BubblePolicy.windowAlpha(1f, menuOpen = false), 0f)
    // The open menu keeps its readability floor, and never goes below it.
    assertEquals(BubbleMenuPolicy.MENU_MIN_ALPHA, BubblePolicy.windowAlpha(faint, menuOpen = true), 0f)
    assertEquals(0.9f, BubblePolicy.windowAlpha(0.9f, menuOpen = true), 0f)
  }

  @Test fun theStatusTabFollowsOpacityButStaysReadable() {
    assertEquals(BubbleMenuPolicy.MENU_MIN_ALPHA, BubblePolicy.tabAlpha(0.3f), 0f)
    assertEquals(0.95f, BubblePolicy.tabAlpha(0.95f), 0f)
    assertEquals(1f, BubblePolicy.tabAlpha(1f), 0f)
  }
}
