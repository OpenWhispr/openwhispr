package com.openwhispr.dictation

import android.animation.ValueAnimator
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import android.view.Window

/**
 * The light/dark crossfade (Android dark theme design §3b). [prepare] copies each window's last
 * frame (the activity's and any open sheet's or dialog's) and draws it over everything in that
 * window's decor overlay, so React can repaint the whole tree in the new palette underneath them
 * without a mixed frame; [fade] then fades the copies out.
 * Nothing is removed, re-added or remounted: the overlay is a drawable, not a view or a window.
 * Main thread only.
 */
internal class ThemeFade {
  private val handler = Handler(Looper.getMainLooper())
  /** Each window's decor view with the copy over it: the activity's, then any open modal's. */
  private val copies = mutableListOf<Pair<View, BitmapDrawable>>()
  private var animator: ValueAnimator? = null
  /** If JavaScript never asks for the fade (it threw, the app went away), the copy still goes. */
  private val fallback = Runnable { fade(FALLBACK_FADE_MS) }

  /**
   * Copies the activity's window and every open `<Modal>`'s (sheets and dialogs are windows of their
   * own above it), so they all change in the one crossfade. [done] gets true once the activity's copy
   * is up; a modal whose copy fails just switches without a fade.
   */
  fun prepare(activity: Activity?, done: (Boolean) -> Unit) {
    val window = activity?.window
    if (Build.VERSION.SDK_INT < 26 || window == null || !drawable(window)) {
      done(false); return
    }
    animator?.cancel(); animator = null
    val windows = listOf(window) + ModalWindows.of(activity).filter(::drawable)
    val taken = arrayOfNulls<Pair<View, BitmapDrawable>>(windows.size)
    var pending = windows.size
    windows.forEachIndexed { index, each ->
      copy(each) { result ->
        taken[index] = result
        pending -= 1
        if (pending > 0) return@copy
        // The activity's copy decides: without it there's nothing to fade from.
        if (taken[0] == null) { taken.forEach { it?.second?.bitmap?.recycle() }; done(false); return@copy }
        clear()
        taken.filterNotNull().forEach { (decor, drawable) -> decor.overlay.add(drawable); copies += decor to drawable }
        handler.postDelayed(fallback, FALLBACK_AFTER_MS)
        done(true)
      }
    }
  }

  private fun drawable(window: Window): Boolean {
    val decor = window.peekDecorView() ?: return false
    return decor.width > 0 && decor.height > 0 && decor.isAttachedToWindow
  }

  /** What's on [window] now, the overlay included: a switch during a fade starts from what's seen. */
  private fun copy(window: Window, done: (Pair<View, BitmapDrawable>?) -> Unit) {
    val decor = window.decorView
    val bitmap = runCatching { Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888) }.getOrNull()
      ?: return done(null)
    try {
      PixelCopy.request(window, bitmap, { result ->
        if (result != PixelCopy.SUCCESS || !decor.isAttachedToWindow) { bitmap.recycle(); done(null); return@request }
        done(decor to BitmapDrawable(decor.resources, bitmap).apply { setBounds(0, 0, decor.width, decor.height) })
      }, handler)
    } catch (_: IllegalArgumentException) {
      // The window has no surface yet (or no longer).
      bitmap.recycle(); done(null)
    }
  }

  /** Fades the copies out over [durationMs], then removes them. With animations off they go at once. */
  fun fade(durationMs: Long) {
    handler.removeCallbacks(fallback)
    if (copies.isEmpty()) return
    if (animator != null) return
    if (!ValueAnimator.areAnimatorsEnabled() || durationMs <= 0) { clear(); return }
    val fading = copies.map { it.second }
    animator = ValueAnimator.ofInt(255, 0).apply {
      duration = durationMs
      interpolator = BubbleMotion.easeOut
      addUpdateListener { update -> fading.forEach { it.alpha = update.animatedValue as Int } }
      addListener(object : android.animation.AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: android.animation.Animator) {
          if (animator === animation) { animator = null; clear() }
        }
      })
      start()
    }
  }

  /** Removes any copy straight away. */
  fun clear() {
    handler.removeCallbacks(fallback)
    animator?.let { animator = null; it.cancel() }
    // Not recycled: the render thread may still hold the last frame that drew them.
    copies.forEach { (decor, drawable) -> decor.overlay.remove(drawable) }
    copies.clear()
  }

  private companion object {
    const val FALLBACK_AFTER_MS = 1_000L
    const val FALLBACK_FADE_MS = 200L
  }
}
