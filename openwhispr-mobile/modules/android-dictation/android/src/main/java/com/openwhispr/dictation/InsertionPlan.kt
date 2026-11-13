package com.openwhispr.dictation

/** What a finished dictation writes into the field it was started in. */
data class Insertion(val text: String, val cursor: Int)

/** Where dictated words go, kept free of Android so it can be unit tested. */
object InsertionPlan {
  /**
   * Words dictated over a selection replace exactly that selection, so they go in only while the field is
   * unchanged. Words dictated at a caret go in at the caret as it is now, as a paste would, so typing a space
   * or fixing a word while OpenWhispr listens doesn't push the dictation out to the app. Returns null when it
   * can't be placed safely, and the dictation is kept in OpenWhispr instead.
   */
  fun plan(
    capturedText: String, capturedStart: Int, capturedEnd: Int,
    currentText: String, currentStart: Int, currentEnd: Int,
    dictated: String,
  ): Insertion? {
    val unchanged = currentText == capturedText && currentStart == capturedStart && currentEnd == capturedEnd
    if (unchanged) return place(currentText, currentStart, currentEnd, dictated)
    // A selection made while listening may not be one the user wants replaced.
    if (capturedStart != capturedEnd || currentStart != currentEnd) return null
    return place(currentText, currentStart, currentEnd, dictated)
  }

  private fun place(text: String, start: Int, end: Int, dictated: String): Insertion? {
    if (start < 0 || end < start || end > text.length) return null
    return Insertion(text.substring(0, start) + dictated + text.substring(end), start + dictated.length)
  }
}
