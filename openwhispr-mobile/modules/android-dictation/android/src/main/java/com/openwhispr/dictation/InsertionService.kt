package com.openwhispr.dictation

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

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

  override fun onServiceConnected() { instance = this; DictationService.emit?.invoke("onStatusChange", emptyMap()) }
  override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* Read only on explicit dictation. */ }
  override fun onInterrupt() { clearTarget() }
  override fun onDestroy() { clearTarget(); instance = null; DictationService.emit?.invoke("onStatusChange", emptyMap()); super.onDestroy() }
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
    if (current != captured.node ||
      currentText != captured.text || start != captured.start || end != captured.end) {
      current.recycle(); clearTarget(); return complete(false)
    }
    val result = captured.text.substring(0, captured.start) + text + captured.text.substring(captured.end)
    val inserted = current.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, result)
    })
    if (inserted) current.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, captured.start + text.length)
      putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, captured.start + text.length)
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
