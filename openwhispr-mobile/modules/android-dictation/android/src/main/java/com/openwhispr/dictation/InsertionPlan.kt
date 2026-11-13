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
    val words = if (start == end && needsLeadingSpace(text, start, dictated)) " $dictated" else dictated
    return Insertion(text.substring(0, start) + words + text.substring(end), start + words.length)
  }

  /**
   * Words dictated at a caret right after other text get a space in front, as the iOS keyboard does, so
   * "…Tishan." and "Oh," don't run together. Not at the start of a field or line, after a space or an opening
   * bracket or quote, or when the words start with punctuation or a space. A selection is replaced as it is.
   */
  private fun needsLeadingSpace(text: String, caret: Int, dictated: String): Boolean {
    if (caret == 0 || dictated.isEmpty()) return false
    val first = dictated[0]
    if (first.isWhitespace() || first in TRAILING_PUNCTUATION) return false
    val before = text[caret - 1]
    if (before.isWhitespace() || before in OPENERS) return false
    // A straight quote opens only when nothing is right before it: `said "` vs `said "hi"`.
    if (before in STRAIGHT_QUOTES) return caret >= 2 && !text[caret - 2].isWhitespace() && text[caret - 2] !in OPENERS
    return true
  }

  private const val TRAILING_PUNCTUATION = ".,;:!?)]}…%"
  private const val OPENERS = "([{“‘«¿¡"
  private const val STRAIGHT_QUOTES = "\"'"
}
