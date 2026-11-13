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
}
