package com.openwhispr.dictation

typealias BubbleEvent = Pair<String, Map<String, Any>>

/** What to send to JS now, and the URIs of held recordings that will never be sent and can be deleted. */
data class Accepted(val emit: List<BubbleEvent>, val dropped: List<String>)

/**
 * Bubble events waiting for the JS pipeline. The bubble records natively the moment it is tapped, so
 * after a restart its first dictation can finish before JS is listening; the events wait here, in
 * order, and are sent once it is. A parked queue (JS took too long) holds its recording until Retry,
 * so nothing is ever inserted late into whatever field has focus by then.
 */
class BubbleEventQueue {
  private val waiting = mutableListOf<BubbleEvent>()
  var parked = false; private set
  val holdsRecording get() = waiting.any { it.first == RECORDING }

  fun accept(event: String, data: Map<String, Any>, ready: Boolean): Accepted {
    val entry = event to data
    return when (event) {
      "onCancel", "onDismiss" -> Accepted(if (ready) listOf(entry) else emptyList(), clear())
      "onStart", "onRetry" -> {
        val dropped = clear()
        if (ready) Accepted(listOf(entry), dropped) else { waiting += entry; Accepted(emptyList(), dropped) }
      }
      else -> if (ready && !parked) Accepted(listOf(entry), emptyList()) else { waiting += entry; Accepted(emptyList(), emptyList()) }
    }
  }

  /** Everything that waited, once JS listens. Nothing while parked. */
  fun ready(): List<BubbleEvent> {
    if (parked) return emptyList()
    return waiting.toList().also { waiting.clear() }
  }

  fun park() { if (holdsRecording) parked = true }

  /** Retry of a parked recording: it is sent again with the target captured now. */
  fun retryHeld(selection: String): Boolean {
    if (!holdsRecording) return false
    parked = false
    val index = waiting.indexOfFirst { it.first == "onStart" }
    if (index >= 0) waiting[index] = "onStart" to (waiting[index].second + ("selection" to selection))
    // Anything that arrived while parked (an error) belonged to the abandoned attempt.
    waiting.retainAll { it.first == "onStart" || it.first == RECORDING }
    return true
  }

  private fun clear(): List<String> {
    val uris = waiting.filter { it.first == RECORDING }.mapNotNull { it.second["uri"] as? String }
    waiting.clear(); parked = false
    return uris
  }

  private companion object { const val RECORDING = "onRecording" }
}
