package com.openwhispr.dictation

import org.junit.Assert.*
import org.junit.Test

class InsertionPlanTest {
  @Test fun unchangedFieldGetsTheWordsAtTheCaret() {
    assertEquals(Insertion("Hi there", 8), InsertionPlan.plan("Hi ", 3, 3, "Hi ", 3, 3, "there"))
  }

  @Test fun selectionIsReplacedWhileTheFieldIsUnchanged() {
    assertEquals(Insertion("Hi friend", 9), InsertionPlan.plan("Hi you", 3, 6, "Hi you", 3, 6, "friend"))
  }

  @Test fun typingWhileListeningStillInsertsAtTheCurrentCaret() {
    // A space typed after "Hello there." while OpenWhispr listened.
    assertEquals(
      Insertion("Hello there. One two", 20),
      InsertionPlan.plan("Hello there.", 12, 12, "Hello there. ", 13, 13, "One two"),
    )
  }

  @Test fun aChangedSelectionIsNeverReplaced() {
    assertNull(InsertionPlan.plan("Hi you", 3, 6, "Hi you!", 3, 6, "friend"))
    assertNull(InsertionPlan.plan("Hi ", 3, 3, "Hi you", 3, 6, "friend"))
  }

  @Test fun wordsCountAsLandedWhenTheEditorTidiesSpacing() {
    // Chrome's address bar drops the leading space typed while listening.
    assertTrue(InsertionPlan.landed(" ", "One, two, three.", "One, two, three."))
    // ...or adds its own suggestion after the words.
    assertTrue(InsertionPlan.landed("", "One two.com", "One two"))
  }

  @Test fun wordsAlreadyThereOrMissingDoNotCountAsLanded() {
    assertFalse(InsertionPlan.landed("Hello", "Hello", "Hello"))
    assertFalse(InsertionPlan.landed("Hi ", "Hi ", "there"))
    assertFalse(InsertionPlan.landed("Hi ", "Hi you", "there"))
  }

  @Test fun anOutOfRangeCaretIsRefused() {
    assertNull(InsertionPlan.plan("Hi", 2, 2, "Hi", 5, 5, "there"))
  }

  @Test fun aPlaceholderReadsAsAnEmptyField() {
    // WhatsApp's empty message box: its placeholder as the text, unflagged, with no caret.
    assertEquals(Field("", 0, 0), InsertionPlan.field("Message", -1, -1, showingHint = false))
    assertEquals(Field("", 0, 0), InsertionPlan.field("Search", 0, 0, showingHint = true))
    assertEquals(Field("", 0, 0), InsertionPlan.field("", -1, -1, showingHint = false))
  }

  @Test fun aFieldWithACaretKeepsItsText() {
    assertEquals(Field("Hi ", 3, 3), InsertionPlan.field("Hi ", 3, 3, showingHint = false))
    assertEquals(Field("Hi you", 3, 6), InsertionPlan.field("Hi you", 3, 6, showingHint = false))
  }

  @Test fun dictationReplacesAnUnflaggedPlaceholder() {
    val (text, start, end) = InsertionPlan.field("Message", -1, -1, showingHint = false)
    assertEquals(Insertion("Hello", 5), InsertionPlan.plan(text, start, end, text, start, end, "Hello"))
  }
}
