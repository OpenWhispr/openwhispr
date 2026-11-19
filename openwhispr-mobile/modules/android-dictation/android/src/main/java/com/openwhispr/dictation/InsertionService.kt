package com.openwhispr.dictation

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo

class InsertionService : AccessibilityService() {
  companion object { var instance: InsertionService? = null; private set }
  private data class Target(val node: AccessibilityNodeInfo, val text: String, val start: Int, val end: Int)
  private var target: Target? = null
  private val handler = Handler(Looper.getMainLooper())
  private fun readField(node: AccessibilityNodeInfo): Field =
    InsertionPlan.field(node.text?.toString().orEmpty(), node.textSelectionStart, node.textSelectionEnd, node.isShowingHintText)

  override fun onServiceConnected() { instance = this; refreshTyping(); DictationService.emit?.invoke("onStatusChange", emptyMap()) }
  // Focus and window changes only decide whether the bubble shows. They check whether the focused
  // field takes text and isn't a password; the field's text is read only when dictation starts.
  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    handler.removeCallbacks(typingCheck); handler.postDelayed(typingCheck, 120)
  }
  private val typingCheck = Runnable { refreshTyping() }
  fun refreshTyping() {
    val service = DictationService.instance ?: return
    val keyboard = runCatching { windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } }.getOrNull()
    val top = keyboard?.let { Rect().also(it::getBoundsInScreen).top }
    val field = if (keyboard == null) null else runCatching { focusedField() }.getOrNull()
    val typing = field != null && BubblePolicy.canDictate(field.isEditable, field.isPassword)
    // The focused node's identity (window and source id) tells a newly focused field from typing in the same one.
    val key = field?.hashCode()
    val search = typing && runCatching { searchField(field!!) }.getOrDefault(false)
    field?.recycle()
    service.onTyping(typing, top, key, search)
  }
  /** Reads the field's id, hint and description, and its nearest ancestors' ids and classes. */
  private fun searchField(field: AccessibilityNodeInfo): Boolean {
    val labels = mutableListOf<CharSequence?>(field.viewIdResourceName, field.contentDescription)
    if (Build.VERSION.SDK_INT >= 26) { labels += field.hintText; if (field.isShowingHintText) labels += field.text }
    val classes = mutableListOf<CharSequence?>(field.className)
    var parent = field.parent
    repeat(3) {
      val node = parent ?: return@repeat
      labels += node.viewIdResourceName; classes += node.className
      parent = node.parent; node.recycle()
    }
    parent?.recycle()
    return BubblePolicy.searchField(labels, classes)
  }
  override fun onInterrupt() { clearTarget() }
  override fun onDestroy() { handler.removeCallbacks(typingCheck); clearTarget(); dropUndo(); instance = null; DictationService.instance?.onTyping(false, null); DictationService.emit?.invoke("onStatusChange", emptyMap()); super.onDestroy() }
  /** Moves the caret after edited words still highlighted from [insert], unless the user moved on. */
  private fun settleHighlight(start: Int, end: Int) {
    val node = focusedField() ?: return
    try {
      val field = readField(node)
      if (field.start == start && field.end == end) select(node, end, end)
    } finally { node.recycle() }
  }
  fun clearTarget() { target?.node?.recycle(); target = null }
  private fun focusedField(): AccessibilityNodeInfo? {
    val root = rootInActiveWindow ?: return null
    return try { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } finally { root.recycle() }
  }
  fun captureTarget(): String {
    clearTarget()
    val node = focusedField() ?: return ""
    if (!node.isEditable || node.isPassword) { node.recycle(); return "" }
    val (text, start, end) = readField(node)
    if (start < 0 || end < start || end > text.length) {
      node.recycle(); return ""
    }
    target = Target(node, text, start, end)
    return text.substring(start, end)
  }
  /**
   * Whether the focused field has text selected, so the hold menu offers Edit selection. Reads only the
   * selection bounds of the focused field, and only when the user holds the bubble.
   */
  fun hasSelection(): Boolean {
    val node = focusedField() ?: return false
    return try {
      if (!node.isEditable || node.isPassword) false
      else readField(node).let { it.end > it.start && it.start >= 0 }
    } finally { node.recycle() }
  }

  /** What the last paste changed, so Undo can put the field back exactly as it was. */
  private data class Undo(val node: AccessibilityNodeInfo, val before: Field, val after: String)
  private var lastUndo: Undo? = null
  private fun dropUndo() { lastUndo?.node?.recycle(); lastUndo = null }

  /**
   * Puts the field back as it was before the last paste: its text and its caret or selection. Only
   * while the same field is focused and still holds exactly what the paste left; anything typed since
   * would be lost, so then nothing changes and this returns false.
   */
  fun undo(): Boolean {
    val record = lastUndo ?: return false
    lastUndo = null
    val current = focusedField()
    try {
      if (current == null || current != record.node || !current.isEditable) return false
      if (readField(current).text != record.after) return false
      val restored = current.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, record.before.text)
      })
      if (restored) select(current, record.before.start, record.before.end)
      return restored
    } finally { current?.recycle(); record.node.recycle() }
  }

  private fun select(node: AccessibilityNodeInfo, start: Int, end: Int) =
    node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end)
    })

  /**
   * Writes [text] where the dictation started. With [highlight] (Edit selection), the new words stay
   * selected for 1.2 s, the field's own highlight showing what changed, then the caret moves after them.
   */
  fun insert(text: String, highlight: Boolean = false, complete: (Boolean) -> Unit) {
    dropUndo()
    val captured = target ?: return complete(false)
    val current = focusedField()
    if (current == null) { clearTarget(); return complete(false) }
    if (!current.isEditable || current.isPassword) { current.recycle(); clearTarget(); return complete(false) }
    val (currentText, start, end) = readField(current)
    val plan = if (current != captured.node) null
      else InsertionPlan.plan(captured.text, captured.start, captured.end, currentText, start, end, text)
    if (plan == null) { current.recycle(); clearTarget(); return complete(false) }
    val result = plan.text
    val inserted = current.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, result)
    })
    val wordsStart = plan.cursor - (result.length - (currentText.length - (end - start)))
    if (inserted) {
      if (highlight && wordsStart in 0..plan.cursor) select(current, wordsStart, plan.cursor) else select(current, plan.cursor, plan.cursor)
    }
    clearTarget()
    if (!inserted) { current.recycle(); return complete(false) }
    // Some editors acknowledge an action without applying it. Verify the result;
    // never retry a write because that can duplicate text in another application.
    handler.postDelayed({
      val after = runCatching { if (current.refresh()) readField(current).text else null }.getOrNull()
      val verified = after != null && InsertionPlan.landed(currentText, after, text)
      if (verified) {
        @Suppress("DEPRECATION")
        lastUndo = Undo(AccessibilityNodeInfo.obtain(current), Field(currentText, start, end), after!!)
        if (highlight && wordsStart >= 0) handler.postDelayed({ settleHighlight(wordsStart, plan.cursor) }, BubbleMenuPolicy.EDIT_HIGHLIGHT_MS)
      }
      current.recycle(); complete(verified)
    }, 150)
  }
}
