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
  /** A failed take's tab stays longer: its recording, kept for Retry, goes when the tab does. */
  const val FAILURE_TAB_HOLD_MS = 7000L
  /** The first-time hint ("Tap to dictate · Hold for more") tucks back after 3 s. */
  const val HINT_HOLD_MS = 3000L
  /** The hint shows the first three times the bubble appears, until the menu has been opened once. */
  const val HINT_TIMES = 3
  /** "Still writing…" only appears when writing is slow. */
  const val STILL_WRITING_AFTER_MS = 3000L
  /** How long the bottom toast ("Bubble hidden for 15 minutes · Undo") stays up. */
  const val TOAST_HOLD_MS = 4000L
  /** How long edited words stay highlighted (selected) before the caret moves after them. */
  const val EDIT_HIGHLIGHT_MS = 1200L

  /**
   * Assistant and Translate always; Edit selection only when text is selected. All three run on the
   * assistant, so when it isn't available (signed out, plan, policy) every row is greyed and says why.
   */
  fun rows(hasSelection: Boolean, assistantBlocked: Boolean): List<MenuRow> = buildList {
    add(MenuRow(BubbleMode.ASSISTANT, !assistantBlocked))
    add(MenuRow(BubbleMode.TRANSLATE, !assistantBlocked))
    if (hasSelection) add(MenuRow(BubbleMode.EDIT, !assistantBlocked))
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

  /**
   * After a light/dark switch the keyboard and the app below redraw in their new colours, and for a
   * moment the keyboard's top or the focused field's identity can read as changed. The hold menu
   * stays open through that ([THEME_SETTLE_MS]); only the keyboard actually going away closes it.
   */
  const val THEME_SETTLE_MS = 1500L

  /**
   * Whether a keyboard report closes the open hold menu: any change does ([wasTyping] → [typing],
   * a new keyboard top or a new field), except a moved top or a new field id while still typing,
   * within [THEME_SETTLE_MS] of a light/dark switch ([sinceThemeSwitchMs], null when none).
   */
  fun keyboardClosesMenu(
    wasTyping: Boolean,
    typing: Boolean,
    topChanged: Boolean,
    fieldChanged: Boolean,
    sinceThemeSwitchMs: Long?,
  ): Boolean {
    if (wasTyping != typing) return true
    if (!topChanged && !fieldChanged) return false
    val settling = sinceThemeSwitchMs != null && sinceThemeSwitchMs in 0 until THEME_SETTLE_MS
    return !(settling && typing)
  }

  /** How long a press on the bubble with the Assistant off waits before it starts hold-to-talk. */
  const val TALK_HOLD_MS = 300L

  /**
   * Whether the bubble's hold opens the menu (Settings › Bubble › Assistant on). With the Assistant
   * off ("talk", or "nothing" from builds before the switch) a hold is hold-to-talk instead.
   */
  fun holdOpensMenu(setting: String?) = setting != "talk" && setting != "nothing"

  /**
   * The menu follows Size & look's size like the bubble, kept between 87.5 % and 125 % so its
   * 12 sp second lines stay readable on the smallest bubble.
   */
  fun menuScale(bubbleScale: Float) = if (bubbleScale.isNaN()) 1f else bubbleScale.coerceIn(0.875f, 1.25f)

  /** The least see-through the open menu gets, so its rows stay readable over any app (Josh, 20 Nov). */
  const val MENU_MIN_ALPHA = 0.85f

  /** The open menu follows Size & look's see-through like the bubble, but never below [MENU_MIN_ALPHA]. */
  fun menuAlpha(bubbleAlpha: Float) = if (bubbleAlpha.isNaN()) 1f else bubbleAlpha.coerceIn(MENU_MIN_ALPHA, 1f)

  /** Whether a hold records while the finger is down and pastes on release (the Assistant is off). */
  fun holdToTalk(setting: String?) = !holdOpensMenu(setting)

  /** A tab touched by a finger stays; otherwise it leaves [holdMs] after it last came out or was let go. */
  fun tabLeavesAt(shownAt: Long, releasedAt: Long?, touching: Boolean, holdMs: Long = TAB_HOLD_MS): Long? =
    if (touching) null else maxOf(shownAt, releasedAt ?: 0L) + holdMs

  /** How long a message's tab stays out: failures 7 s, the first-time hint 3 s, the rest 4 s. */
  fun holdFor(message: StatusMessage): Long = when (message) {
    StatusMessage.SAVED, StatusMessage.COPIED, StatusMessage.STILL_WRITING -> TAB_HOLD_MS
    else -> FAILURE_TAB_HOLD_MS
  }

  /** Whether the first-time hint shows now: the menu is on and hasn't been opened, and it has shown fewer than 3 times. */
  fun showsHint(holdAction: String?, menuUsed: Boolean, timesShown: Int) =
    holdOpensMenu(holdAction) && !menuUsed && timesShown < HINT_TIMES

  /**
   * Translate offers its target in the second line ("Into Spanish"). The target is the label saved in
   * Settings › Bubble › Assistant › Translate; nothing saved reads as Spanish, the pipeline's own default.
   */
  fun translateTarget(saved: String?) = saved?.trim()?.takeIf { it.isNotEmpty() } ?: "Spanish"
}
