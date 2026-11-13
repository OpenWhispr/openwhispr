package com.openwhispr.dictation

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
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
  private fun fieldText(node: AccessibilityNodeInfo): String =
    if (node.isShowingHintText) "" else node.text?.toString().orEmpty()
  private fun selection(node: AccessibilityNodeInfo, text: String): Pair<Int, Int> {
    val start = node.textSelectionStart
    val end = node.textSelectionEnd
    // Android reports -1 for both selection bounds on an empty EditText showing a hint.
    return if (text.isEmpty() && start == -1 && end == -1) 0 to 0 else start to end
  }

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
    field?.recycle()
    service.onTyping(typing, top)
  }
  override fun onInterrupt() { clearTarget() }
  override fun onDestroy() { handler.removeCallbacks(typingCheck); clearTarget(); instance = null; DictationService.instance?.onTyping(false, null); DictationService.emit?.invoke("onStatusChange", emptyMap()); super.onDestroy() }
  fun clearTarget() { target?.node?.recycle(); target = null }
  private fun focusedField(): AccessibilityNodeInfo? {
    val root = rootInActiveWindow ?: return null
    return try { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } finally { root.recycle() }
  }
  fun captureTarget(): String {
    clearTarget()
    val node = focusedField() ?: return ""
    if (!node.isEditable || node.isPassword) { node.recycle(); return "" }
    val text = fieldText(node)
    val (start, end) = selection(node, text)
    if (start < 0 || end < start || end > text.length) {
      node.recycle(); return ""
    }
    target = Target(node, text, start, end)
    return text.substring(start, end)
  }
  fun insert(text: String, complete: (Boolean) -> Unit) {
    val captured = target ?: return complete(false)
    val current = focusedField()
    if (current == null) { clearTarget(); return complete(false) }
    if (!current.isEditable || current.isPassword) { current.recycle(); clearTarget(); return complete(false) }
    val currentText = fieldText(current)
    val (start, end) = selection(current, currentText)
    val plan = if (current != captured.node) null
      else InsertionPlan.plan(captured.text, captured.start, captured.end, currentText, start, end, text)
    if (plan == null) { current.recycle(); clearTarget(); return complete(false) }
    val result = plan.text
    val inserted = current.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, result)
    })
    if (inserted) current.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, plan.cursor)
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, plan.cursor)
    })
    clearTarget()
    if (!inserted) { current.recycle(); return complete(false) }
    // Some editors acknowledge an action without applying it. Verify the result;
    // never retry a write because that can duplicate text in another application.
    handler.postDelayed({
      val verified = runCatching { current.refresh() && fieldText(current) == result }.getOrDefault(false)
      current.recycle(); complete(verified)
    }, 150)
  }
}
