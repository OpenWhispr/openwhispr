package com.openwhispr.dictation

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import com.facebook.react.views.modal.ReactModalHostView

/**
 * The windows of React Native's open `<Modal>`s (bottom sheets, the language sheet, dialogs). Each
 * is a Dialog with a window of its own above the activity's, so the page's navigation-bar colour
 * and the light/dark crossfade, which act on the activity's window, have to reach them too.
 * Found through each modal's host view, which stays in the activity's view tree. Main thread.
 */
internal object ModalWindows {
  /** Every modal's window, including one created but not shown yet ([showing] false). */
  fun of(activity: Activity?, showing: Boolean = true): List<Window> {
    val decor = activity?.window?.decorView ?: return emptyList()
    val found = mutableListOf<Window>()
    collect(decor, showing, found)
    return found
  }

  private fun collect(view: View, showing: Boolean, found: MutableList<Window>) {
    if (view is ReactModalHostView) {
      val dialog = view.dialog
      val window = dialog?.takeIf { !showing || it.isShowing }?.window
      if (window != null && window !in found) found += window
    }
    if (view is ViewGroup) for (index in 0 until view.childCount) collect(view.getChildAt(index), showing, found)
  }
}
