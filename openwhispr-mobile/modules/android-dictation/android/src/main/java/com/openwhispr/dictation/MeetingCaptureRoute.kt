package com.openwhispr.dictation

internal data class MeetingCaptureRoute(val noteId: Int, val localOnly: Boolean, val captureId: String? = null, val audioNamespace: String = "") {
  init {
    require(noteId >= 0 && (!localOnly || noteId > 0)) { "Invalid meeting note." }
    require(audioNamespace.isEmpty() || Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(audioNamespace)) { "Invalid account audio directory." }
  }
  val recordingDirectory: String get() = if (audioNamespace.isEmpty()) "" else "account-audio/$audioNamespace"
  fun acceptsStop(localNoteId: Int?, requestedCaptureId: String? = null): Boolean =
    if (localOnly) localNoteId == noteId && requestedCaptureId != null && requestedCaptureId == captureId
    else localNoteId == null && requestedCaptureId == null
  fun frameListener(listener: (ByteArray, Long) -> Unit): ((ByteArray, Long) -> Unit)? = if (localOnly) null else listener
  val maximumSeconds: Int get() = if (localOnly) 3540 else 7200
  val stopEvent: String get() = if (localOnly) "local-meeting-stopped" else "pcm-stopped"
  val errorEvent: String get() = if (localOnly) "local-meeting-error" else "pcm-error"
}
