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

  @Test fun anUnflaggedPlaceholderWithACaretReadsAsEmpty() {
    // WhatsApp's empty search box on a Galaxy A73: "Search…", unflagged, no hint, caret at 1.
    assertEquals(Field("", 0, 0), InsertionPlan.field("Search…", 1, 1, showingHint = false, hint = null))
    assertEquals(Field("", 0, 0), InsertionPlan.field("Search...", 0, 0, showingHint = false, hint = ""))
    val (text, start, end) = InsertionPlan.field("Search…", 1, 1, showingHint = false)
    assertEquals(Insertion("coffee at 6", 11), InsertionPlan.plan(text, start, end, text, start, end, "coffee at 6"))
  }

  @Test fun typedTextEndingInAnEllipsisIsKept() {
    // The caret past the start, a hint reported, or a selection: it's the user's text.
    assertEquals(Field("Wait…", 5, 5), InsertionPlan.field("Wait…", 5, 5, showingHint = false))
    assertEquals(Field("Search…", 1, 1), InsertionPlan.field("Search…", 1, 1, showingHint = false, hint = "Search…"))
    assertEquals(Field("Wait…", 0, 5), InsertionPlan.field("Wait…", 0, 5, showingHint = false))
    assertEquals(Field("Hi", 1, 1), InsertionPlan.field("Hi", 1, 1, showingHint = false))
  }

  @Test fun aFieldWithACaretKeepsItsText() {
    assertEquals(Field("Hi ", 3, 3), InsertionPlan.field("Hi ", 3, 3, showingHint = false))
    assertEquals(Field("Hi you", 3, 6), InsertionPlan.field("Hi you", 3, 6, showingHint = false))
  }

  @Test fun dictationReplacesAnUnflaggedPlaceholder() {
    val (text, start, end) = InsertionPlan.field("Message", -1, -1, showingHint = false)
    assertEquals(Insertion("Hello", 5), InsertionPlan.plan(text, start, end, text, start, end, "Hello"))
  }

  @Test fun wordsAfterTextAtACaretGetALeadingSpace() {
    // Seen on a Galaxy A73: "…Tishan." + "Oh," became "…Tishan.Oh,".
    assertEquals(Insertion("Tishan. Oh,", 11), InsertionPlan.plan("Tishan.", 7, 7, "Tishan.", 7, 7, "Oh,"))
    // Mid-text too: the space goes before the words, the caret after them.
    assertEquals(Insertion("Hi there!", 8), InsertionPlan.plan("Hi!", 2, 2, "Hi!", 2, 2, "there"))
    // After a closing quote.
    assertEquals(Insertion("said \"hi\" then", 14), InsertionPlan.plan("said \"hi\"", 9, 9, "said \"hi\"", 9, 9, "then"))
  }

  @Test fun noLeadingSpaceWhereNoneBelongs() {
    assertEquals(Insertion("Hi", 2), InsertionPlan.plan("", 0, 0, "", 0, 0, "Hi"))
    assertEquals(Insertion("One\nTwo", 7), InsertionPlan.plan("One\n", 4, 4, "One\n", 4, 4, "Two"))
    assertEquals(Insertion("Hi there", 8), InsertionPlan.plan("Hi ", 3, 3, "Hi ", 3, 3, "there"))
    assertEquals(Insertion("(note", 5), InsertionPlan.plan("(", 1, 1, "(", 1, 1, "note"))
    assertEquals(Insertion("said \"hi", 8), InsertionPlan.plan("said \"", 6, 6, "said \"", 6, 6, "hi"))
    assertEquals(Insertion("“hi", 3), InsertionPlan.plan("“", 1, 1, "“", 1, 1, "hi"))
    // Words that start with punctuation or a space.
    assertEquals(Insertion("Hi, there", 9), InsertionPlan.plan("Hi", 2, 2, "Hi", 2, 2, ", there"))
    assertEquals(Insertion("Done.", 5), InsertionPlan.plan("Done", 4, 4, "Done", 4, 4, "."))
    assertEquals(Insertion("Hi there", 8), InsertionPlan.plan("Hi", 2, 2, "Hi", 2, 2, " there"))
  }

  @Test fun aReplacedSelectionGetsNoLeadingSpace() {
    assertEquals(Insertion("Hifriend", 8), InsertionPlan.plan("Hiyou", 2, 5, "Hiyou", 2, 5, "friend"))
  }
}
