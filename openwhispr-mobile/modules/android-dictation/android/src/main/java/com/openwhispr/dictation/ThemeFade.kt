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

/**
 * The light/dark crossfade (Android dark theme design §3b). [prepare] copies the window's last
 * frame and draws it over everything in the decor view's overlay, so React can repaint the whole
 * tree in the new palette underneath it without a mixed frame; [fade] then fades the copy out.
 * Nothing is removed, re-added or remounted: the overlay is a drawable, not a view or a window.
 * Main thread only.
 */
internal class ThemeFade {
  private val handler = Handler(Looper.getMainLooper())
  private var view: View? = null
  private var copy: BitmapDrawable? = null
  private var animator: ValueAnimator? = null
  /** If JavaScript never asks for the fade (it threw, the app went away), the copy still goes. */
  private val fallback = Runnable { fade(FALLBACK_FADE_MS) }

  fun prepare(activity: Activity?, done: (Boolean) -> Unit) {
    val window = activity?.window
    val decor = window?.decorView
    if (Build.VERSION.SDK_INT < 26 || window == null || decor == null || decor.width <= 0 || decor.height <= 0 || !decor.isAttachedToWindow) {
      done(false); return
    }
    animator?.cancel(); animator = null
    val bitmap = runCatching { Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888) }.getOrNull()
      ?: return done(false)
    try {
      // What's on screen now, the overlay included: a switch during a fade starts from what's seen.
      PixelCopy.request(window, bitmap, { result ->
        if (result != PixelCopy.SUCCESS || !decor.isAttachedToWindow) { bitmap.recycle(); done(false); return@request }
        clear()
        val drawable = BitmapDrawable(decor.resources, bitmap).apply { setBounds(0, 0, decor.width, decor.height) }
        decor.overlay.add(drawable)
        view = decor; copy = drawable
        handler.postDelayed(fallback, FALLBACK_AFTER_MS)
        done(true)
      }, handler)
    } catch (_: IllegalArgumentException) {
      // The window has no surface yet (or no longer).
      bitmap.recycle(); done(false)
    }
  }

  /** Fades the copy out over [durationMs], then removes it. With animations off it goes at once. */
  fun fade(durationMs: Long) {
    handler.removeCallbacks(fallback)
    val drawable = copy ?: return
    if (animator != null) return
    if (!ValueAnimator.areAnimatorsEnabled() || durationMs <= 0) { clear(); return }
    animator = ValueAnimator.ofInt(255, 0).apply {
      duration = durationMs
      interpolator = BubbleMotion.easeOut
      addUpdateListener { drawable.alpha = it.animatedValue as Int }
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
    val drawable = copy ?: return
    // Not recycled: the render thread may still hold the last frame that drew it.
    view?.overlay?.remove(drawable)
    copy = null; view = null
  }

  private companion object {
    const val FALLBACK_AFTER_MS = 1_000L
    const val FALLBACK_FADE_MS = 200L
  }
}
