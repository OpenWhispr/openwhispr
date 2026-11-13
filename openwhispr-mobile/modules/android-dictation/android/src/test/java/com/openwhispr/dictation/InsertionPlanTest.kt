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
