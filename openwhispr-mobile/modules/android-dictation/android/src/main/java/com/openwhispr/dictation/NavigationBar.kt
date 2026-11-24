package com.openwhispr.dictation

import android.app.Activity
import android.os.Build
import android.view.ViewTreeObserver
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Gesture navigation or buttons, from the bottom tappable-element inset: 0 with gestures, about
 * 48 dp with two or three buttons. Never reads Settings.Secure navigation_mode, which is
 * undocumented and differs on Samsung. A global-layout listener reports a switch made in Android
 * Settings without replacing React Native's own insets listener.
 */
internal class NavigationBar(private val emit: (Map<String, Any>) -> Unit) {
  private data class Look(val color: Int, val contrastEnforced: Boolean, val darkIcons: Boolean)

  private var activity: Activity? = null
  private var lastBottom = -1
  private var saved: Look? = null
  /** The page's bar as last asked for (colour, dark icons); null while the window's own is back. */
  private var page: Pair<Int, Boolean>? = null
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())
  private val repaintModals = Runnable { paintModals() }
  private val layout = ViewTreeObserver.OnGlobalLayoutListener {
    publish()
    // A <Modal> that just opened has a window of its own with the system's light bar: give it the
    // page's. Coalesced into one pass per frame.
    if (page != null) { handler.removeCallbacks(repaintModals); handler.post(repaintModals) }
  }

  /** Main thread. */
  fun attach(activity: Activity?) {
    if (activity === this.activity) return
    detach()
    this.activity = activity
    activity?.window?.decorView?.viewTreeObserver?.addOnGlobalLayoutListener(layout)
  }

  /** Main thread. */
  fun detach() {
    handler.removeCallbacks(repaintModals)
    activity?.window?.decorView?.viewTreeObserver?.removeOnGlobalLayoutListener(layout)
    activity = null
    lastBottom = -1
  }

  /** `bottom` is in dp; `known` is false before the window has insets. */
  fun state(): Map<String, Any> {
    val view = activity?.window?.decorView
    val insets = view?.let { ViewCompat.getRootWindowInsets(it) }
      ?: return mapOf("known" to false, "buttons" to false, "bottom" to 0.0)
    val px = insets.getInsets(WindowInsetsCompat.Type.tappableElement()).bottom
    return mapOf(
      "known" to true,
      "buttons" to (px > 0),
      "bottom" to px / view.resources.displayMetrics.density.toDouble(),
    )
  }

  private fun publish() {
    val view = activity?.window?.decorView ?: return
    val px = ViewCompat.getRootWindowInsets(view)
      ?.getInsets(WindowInsetsCompat.Type.tappableElement())?.bottom ?: return
    if (px == lastBottom) return
    lastBottom = px
    emit(state())
  }

  /**
   * Main thread. A colour paints the bar as part of the page (no contrast scrim), with dark icons
   * on a light page and light icons on a dark one ([darkIcons]); null puts back what the window
   * had before.
   */
  fun style(color: Int?, darkIcons: Boolean = true) {
    val window = activity?.window ?: return
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    if (color == null) {
      page = null
      val look = saved ?: return
      saved = null
      @Suppress("DEPRECATION")
      window.navigationBarColor = look.color
      if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = look.contrastEnforced
      controller.isAppearanceLightNavigationBars = look.darkIcons
      return
    }
    if (saved == null) {
      @Suppress("DEPRECATION")
      saved = Look(
        window.navigationBarColor,
        Build.VERSION.SDK_INT >= 29 && window.isNavigationBarContrastEnforced,
        controller.isAppearanceLightNavigationBars,
      )
    }
    // Ignored from Android 15, where the app draws behind the bar: the page paints it instead.
    @Suppress("DEPRECATION")
    window.navigationBarColor = color
    if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    controller.isAppearanceLightNavigationBars = darkIcons
    page = color to darkIcons
    paintModals()
  }

  /**
   * Main thread. Open sheets and dialogs (React Native `<Modal>`s, each a window of its own) get
   * the page's bar too, so a sheet over a dark page never shows a light bar, and a light/dark switch
   * with one open repaints it with the page.
   */
  fun paintModals() {
    val (color, darkIcons) = page ?: return
    for (window in ModalWindows.of(activity, showing = false)) {
      @Suppress("DEPRECATION")
      window.navigationBarColor = color
      if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
      WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightNavigationBars = darkIcons
    }
  }
}
