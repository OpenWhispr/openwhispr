package com.openwhispr.dictation

/**
 * What a recording is for. A tap dictates; the hold menu picks the others. [wire] is the JS
 * pipeline's DictationMode (src/android/pipeline.ts).
 */
enum class BubbleMode(val wire: String) {
  DICTATE("dictate"), ASSISTANT("write"), TRANSLATE("translate"), EDIT("edit");

  companion object {
    fun fromWire(value: String?) = entries.firstOrNull { it.wire == value } ?: DICTATE
  }
}

/** The messages the status tab beside the bubble can show. Each has its own words and at most one action. */
enum class StatusMessage(val wire: String, val hasAction: Boolean) {
  STILL_WRITING("still-writing", false),
  SAVED("saved", true),
  NO_SPEECH("no-speech", true),
  OFFLINE("offline", true),
  OUT_OF_WORDS("out-of-words", true),
  MIC_OFF("mic-off", true),
  COPIED("copied", true),
  SIGN_IN("sign-in", true),
  MODEL_NEEDED("model-needed", true),
  FAILED("failed", true);

  companion object {
    fun fromWire(value: String?) = entries.firstOrNull { it.wire == value }
  }
}

/** Why the Assistant row is greyed out. */
enum class AssistantBlock(val wire: String) {
  SIGN_IN("sign-in"), UNAVAILABLE("unavailable");

  companion object {
    fun fromWire(value: String?) = entries.firstOrNull { it.wire == value }
  }
}

/** One row of the hold menu. */
data class MenuRow(val mode: BubbleMode, val enabled: Boolean)

/** Decisions behind the hold menu and the status tab, kept free of Android views so they can be unit tested. */
object BubbleMenuPolicy {
  /** How long a finger stays down before the menu opens. Lifting earlier is a tap, which dictates. */
  const val HOLD_MS = 400L
  /** How long the status tab stays out when nothing touches it. */
  const val TAB_HOLD_MS = 4000L
  /** "Still writing…" only appears when writing is slow. */
  const val STILL_WRITING_AFTER_MS = 3000L
  /** How long the bottom toast stays up. */
  const val TOAST_HOLD_MS = 4000L
  /** How long edited words stay highlighted before the Undo toast rises. */
  const val EDIT_HIGHLIGHT_MS = 1200L

  /** Assistant and Translate always; Edit selection only when text is selected. */
  fun rows(hasSelection: Boolean, assistantBlocked: Boolean): List<MenuRow> = buildList {
    add(MenuRow(BubbleMode.ASSISTANT, !assistantBlocked))
    add(MenuRow(BubbleMode.TRANSLATE, true))
    if (hasSelection) add(MenuRow(BubbleMode.EDIT, true))
  }

  /**
   * The row under a finger at [y] (relative to the menu's top), given the menu's inner padding,
   * the row height and the gap between rows. Null between rows' edges, outside, or on a greyed row.
   */
  fun rowAt(y: Float, x: Float, width: Float, rows: List<MenuRow>, padding: Float, rowHeight: Float, gap: Float): Int? {
    if (x < 0 || x > width) return null
    val offset = y - padding
    if (offset < 0) return null
    val index = (offset / (rowHeight + gap)).toInt()
    if (index !in rows.indices) return null
    if (offset - index * (rowHeight + gap) > rowHeight) return null
    return index
  }

  /** Whether the bubble's hold opens the menu (Settings › Bubble › Hold the bubble). */
  fun holdOpensMenu(setting: String?) = setting != "nothing"

  /** A tab touched by a finger stays; otherwise it leaves [TAB_HOLD_MS] after it last came out or was let go. */
  fun tabLeavesAt(shownAt: Long, releasedAt: Long?, touching: Boolean): Long? =
    if (touching) null else maxOf(shownAt, releasedAt ?: 0L) + TAB_HOLD_MS

  /**
   * Translate offers its target in the second line ("Into Spanish"). The target is the label saved in
   * Settings › Translation; nothing saved reads as Spanish, the pipeline's own default.
   */
  fun translateTarget(saved: String?) = saved?.trim()?.takeIf { it.isNotEmpty() } ?: "Spanish"
}
