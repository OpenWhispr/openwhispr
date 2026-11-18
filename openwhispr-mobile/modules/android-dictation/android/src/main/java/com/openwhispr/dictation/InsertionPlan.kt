package com.openwhispr.dictation

/** What a finished dictation writes into the field it was started in. */
data class Insertion(val text: String, val cursor: Int)

/** A field's own text and selection, with any placeholder it shows read as empty. */
data class Field(val text: String, val start: Int, val end: Int)

/** Where dictated words go, kept free of Android so it can be unit tested. */
object InsertionPlan {
  /**
   * Reads a field as accessibility reports it. A field showing its placeholder holds nothing, whether it flags the
   * placeholder as a hint or not: WhatsApp's empty message box reports "Message" as its text, unflagged, with no
   * caret. A focused field with text in it always has a caret, so no caret (-1) means the field is empty.
   */
  fun field(text: String, start: Int, end: Int, showingHint: Boolean): Field =
    if (showingHint || (start == -1 && end == -1)) Field("", 0, 0) else Field(text, start, end)

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

  /**
   * Whether the dictated words are now in the field. Editors tidy what they're given (Chrome's address bar
   * drops a leading space and adds its own suggestion), so this looks for the words, ignoring spacing, in a
   * field that changed, rather than for the exact text written.
   */
  fun landed(before: String, after: String, dictated: String): Boolean {
    val words = squash(dictated)
    if (words.isEmpty()) return after == before
    return after != before && squash(after).contains(words)
  }

  private fun squash(text: String) = text.filterNot { it.isWhitespace() }

  private fun place(text: String, start: Int, end: Int, dictated: String): Insertion? {
    if (start < 0 || end < start || end > text.length) return null
    return Insertion(text.substring(0, start) + dictated + text.substring(end), start + dictated.length)
  }
}
