package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test

class BubbleEventQueueTest {
  private fun start(selection: String = "") = "onStart" to mapOf<String, Any>("selection" to selection, "mode" to "dictate")
  private fun recording(uri: String) = "onRecording" to mapOf<String, Any>("uri" to uri)
  private fun BubbleEventQueue.accept(event: BubbleEvent, ready: Boolean) = accept(event.first, event.second, ready)

  @Test fun eventsWaitInOrderUntilReady() {
    val queue = BubbleEventQueue()
    assertTrue(queue.accept(start(), false).emit.isEmpty())
    assertTrue(queue.accept(recording("a"), false).emit.isEmpty())
    assertTrue(queue.holdsRecording)
    assertEquals(listOf(start(), recording("a")), queue.ready())
    assertTrue(queue.ready().isEmpty())
    assertFalse(queue.holdsRecording)
  }

  @Test fun readyEventsPassStraightThrough() {
    val queue = BubbleEventQueue()
    assertEquals(listOf(start()), queue.accept(start(), true).emit)
    assertEquals(listOf(recording("a")), queue.accept(recording("a"), true).emit)
    assertTrue(queue.ready().isEmpty())
  }

  @Test fun aNewStartReplacesWhateverWaitedBeforeIt() {
    val queue = BubbleEventQueue()
    queue.accept(start("old"), false)
    queue.accept(recording("a"), false)
    val accepted = queue.accept(start("new"), false)
    assertEquals(listOf("a"), accepted.dropped)
    assertTrue(accepted.emit.isEmpty())
    assertEquals(listOf(start("new")), queue.ready())
  }

  @Test fun cancelDropsWaitingEventsAndReturnsTheHeldRecording() {
    for (event in listOf("onCancel", "onDismiss")) {
      for (ready in listOf(false, true)) {
        val queue = BubbleEventQueue()
        queue.accept(start(), false)
        queue.accept(recording("a"), false)
        val accepted = queue.accept(event, emptyMap(), ready)
        assertEquals(listOf("a"), accepted.dropped)
        assertEquals(if (ready) listOf(event to emptyMap<String, Any>()) else emptyList<BubbleEvent>(), accepted.emit)
        assertTrue(queue.ready().isEmpty())
        assertFalse(queue.holdsRecording)
      }
    }
  }

  @Test fun aParkedQueueReleasesNothingUntilRetry() {
    val queue = BubbleEventQueue()
    queue.accept(start("old"), false)
    queue.accept(recording("a"), false)
    queue.park()
    assertTrue(queue.parked)
    assertTrue(queue.ready().isEmpty())
    assertTrue(queue.accept("onError", mapOf("message" to "x"), true).emit.isEmpty())
    assertTrue(queue.retryHeld("new"))
    assertFalse(queue.parked)
    assertEquals(listOf(start("new"), recording("a")), queue.ready())
  }

  @Test fun retryWithoutAHeldRecordingDoesNothing() {
    val queue = BubbleEventQueue()
    assertFalse(queue.retryHeld("x"))
    queue.accept(start(), false)
    assertFalse(queue.retryHeld("x"))
  }
}
