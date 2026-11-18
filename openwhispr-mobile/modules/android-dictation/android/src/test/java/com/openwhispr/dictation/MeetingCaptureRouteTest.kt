package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test

class MeetingCaptureRouteTest {
  @Test fun localAndCloudMeetingsUseTheirAccountAudioDirectory() {
    val owner = "a1234567-1234-1234-1234-123456789012"
    for (local in listOf(true, false)) {
      assertEquals("account-audio/$owner", MeetingCaptureRoute(7, local, "capture", owner).recordingDirectory)
    }
    assertEquals("", MeetingCaptureRoute(7, true, "capture").recordingDirectory)
  }
  @Test fun accountAudioCannotEscapeAppStorage() {
    for (namespace in listOf("../other-account", "/tmp/audio", "account/id", "not-a-uuid")) {
      assertThrows(IllegalArgumentException::class.java) { MeetingCaptureRoute(7, true, "capture", namespace) }
    }
  }
  @Test fun localCaptureNeverDeliversFramesToAStreamingListener() {
    var delivered = 0
    val listener = MeetingCaptureRoute(7, true, "owner").frameListener { _, _ -> delivered++ }
    listener?.invoke(byteArrayOf(1, 2), 0)
    assertEquals(0, delivered)
  }
  @Test fun cloudCaptureRetainsItsExistingFrameAndEventContract() {
    var received: ByteArray? = null
    val route = MeetingCaptureRoute(7, false)
    route.frameListener { bytes, _ -> received = bytes }!!.invoke(byteArrayOf(1, 2), 0)
    assertArrayEquals(byteArrayOf(1, 2), received)
    assertEquals("pcm-stopped", route.stopEvent)
    assertEquals("pcm-error", route.errorEvent)
    assertTrue(route.acceptsStop(null))
    assertFalse(route.acceptsStop(7))
  }
  @Test fun staleCloudOrOtherNoteStopsCannotStopTheLocalOwner() {
    val route = MeetingCaptureRoute(7, true, "owner")
    assertFalse(route.acceptsStop(null))
    assertFalse(route.acceptsStop(8))
    assertTrue(route.acceptsStop(7, "owner"))
    assertEquals("local-meeting-stopped", route.stopEvent)
    assertEquals("local-meeting-error", route.errorEvent)
  }
  @Test fun aLocalRecordingMustHaveADurableNoteIdentity() {
    assertThrows(IllegalArgumentException::class.java) { MeetingCaptureRoute(0, true) }
    assertThrows(IllegalArgumentException::class.java) { MeetingCaptureRoute(-1, false) }
  }
  @Test fun aNewAttemptForTheSameNoteCannotStopItsExistingOwner() {
    val route = MeetingCaptureRoute(7, true, "owner")
    assertFalse(route.acceptsStop(7)) // A note ID alone does not identify a capture attempt.
    assertFalse(route.acceptsStop(7, "other-attempt"))
    assertTrue(route.acceptsStop(7, "owner"))
  }
  @Test fun localCaptureStopsBeforeTheDecoderOneHourLimit() {
    assertEquals(3540, MeetingCaptureRoute(7, true, "owner").maximumSeconds)
    assertEquals(7200, MeetingCaptureRoute(7, false).maximumSeconds)
  }
}
