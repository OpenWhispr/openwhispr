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

  @Test fun anOutOfRangeCaretIsRefused() {
    assertNull(InsertionPlan.plan("Hi", 2, 2, "Hi", 5, 5, "there"))
  }
}
