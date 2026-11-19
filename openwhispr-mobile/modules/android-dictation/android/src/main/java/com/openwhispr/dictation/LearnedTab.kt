package com.openwhispr.dictation

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/** What JS asks the tab to say; the words come back on Undo. Strings arrive already translated. */
data class LearnedTabText(val words: List<String>, val message: String, val undo: String, val undone: String)

/**
 * Dictionary's C11: after a word is learned from a fix in another app, a slim tab slides out from
 * behind the bubble toward the middle of the screen ("Learned “Synty”" · Undo), holds 4 s with a
 * hairline timer (paused while touched), and slides back under. It never takes focus and the bubble
 * never moves or grows. Its window is added before the bubble's, so it sits underneath it.
 */
class LearnedTab(
  private val context: Context,
  private val windows: WindowManager,
  private val font: Typeface,
  private val onUndo: (List<String>) -> Unit,
  private val onOpen: () -> Unit,
) {
  private val handler = Handler(Looper.getMainLooper())
  private var window: FrameLayout? = null
  private var params: WindowManager.LayoutParams? = null
  private var pill: LinearLayout? = null
  private var label: TextView? = null
  private var undo: TextView? = null
  private var timer: View? = null
  private var hold: ValueAnimator? = null
  private var slide: ValueAnimator? = null
  private var text: LearnedTabText? = null
  private var bubble = Rect()
  private var dockRight = true
  private var tabHeight = 0
  var showing = false; private set

  private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, context.resources.displayMetrics)

  /** Adds the (empty, hidden) window. Call before the bubble's window is added. */
  fun create() {
    if (window != null) return
    val view = FrameLayout(context).apply { visibility = View.GONE; clipChildren = true; clipToPadding = true }
    val layout = WindowManager.LayoutParams(
      WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    ).apply { gravity = Gravity.TOP or Gravity.START }
    window = view; params = layout
    windows.addView(view, layout)
  }

  fun destroy() {
    handler.removeCallbacksAndMessages(null); hold?.cancel(); slide?.cancel()
    window?.let { runCatching { windows.removeView(it) } }
    window = null; params = null; showing = false
  }

  /**
   * Shows the tab beside the bubble (or updates it in place when it is already out: "Learned 2
   * words"). [bubbleRect] is the bubble's visible circle on screen.
   */
  fun show(value: LearnedTabText, bubbleRect: Rect, right: Boolean, dot: Boolean) {
    val root = window ?: return
    if (showing && text != null && pill != null) {
      text = value; label?.text = value.message; undo?.visibility = View.VISIBLE
      label?.setTextColor(BubbleColors.ink)
      layout(bubbleRect, right); startHold(); return
    }
    text = value; bubble = Rect(bubbleRect); dockRight = right
    // As tall as the bubble, never more than 40; the dot gets a 28 tab.
    tabHeight = if (dot) dp(28f).toInt() else minOf(bubble.height(), dp(40f).toInt())
    root.removeAllViews()
    root.addView(build(value), FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, tabHeight + 2 * dp(4f).toInt()))
    root.visibility = View.VISIBLE
    layout(bubbleRect, right)
    showing = true
    root.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    slideTo(out = true) { startHold() }
  }

  /** Keeps the tab beside the bubble when the bubble moves (the keyboard opened or closed). */
  fun follow(bubbleRect: Rect, right: Boolean) { if (showing) layout(bubbleRect, right) }

  fun hide(animate: Boolean = true) {
    if (!showing) return
    handler.removeCallbacksAndMessages(null); hold?.cancel()
    val done = { window?.visibility = View.GONE; showing = false; text = null }
    if (!animate) { slide?.cancel(); done(); return }
    slideTo(out = false) { done() }
  }

  private fun build(value: LearnedTabText): View {
    val radius = tabHeight / 2f
    // The text clears the bubble, which covers the tab's inner end.
    val inner = bubble.width() / 2 + dp(8f).toInt()
    val outer = dp(12f).toInt()
    val textSize = if (tabHeight < dp(32f)) 12f else 13f
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      background = GradientDrawable().apply {
        setColor(BubbleColors.surface); cornerRadius = radius
        setStroke(1, Color.argb(15, 0, 0, 0))
      }
      elevation = dp(3f)
      if (dockRight) setPadding(outer, 0, inner, 0) else setPadding(inner, 0, outer, 0)
      // Touching the tab pauses its timer; letting go lets it run on.
      setOnTouchListener { _, event ->
        when (event.actionMasked) {
          MotionEvent.ACTION_DOWN -> hold?.pause()
          MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> hold?.resume()
        }
        false
      }
    }
    val book = BookGlyph(context)
    val message = TextView(context).apply {
      text = value.message; typeface = font; setTextColor(BubbleColors.ink)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, textSize); maxLines = 1; ellipsize = TextUtils.TruncateAt.END
      // Tapping the words opens the Dictionary.
      setOnClickListener { onOpen(); hide() }
    }
    val action = TextView(context).apply {
      text = value.undo; typeface = Typeface.create(font, Typeface.BOLD); setTextColor(BubbleColors.accent)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, textSize)
      setPadding(dp(8f).toInt(), 0, 0, 0); gravity = Gravity.CENTER_VERTICAL
      contentDescription = "${value.undo}, ${value.message}"
      setOnClickListener { undone() }
    }
    val glyph = dp(12f).toInt()
    row.addView(book, LinearLayout.LayoutParams(glyph, glyph).apply { marginEnd = dp(6f).toInt() })
    row.addView(message, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
    row.addView(action, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
    message.gravity = Gravity.CENTER_VERTICAL
    // The hairline timer drains along the bottom of the tab.
    val line = View(context).apply { setBackgroundColor(BubbleColors.accent); pivotX = 0f; alpha = 0.6f }
    val frame = FrameLayout(context).apply { clipChildren = true; clipToOutline = true; outlineProvider = android.view.ViewOutlineProvider.BACKGROUND }
    frame.background = row.background
    row.background = null
    frame.elevation = row.elevation; row.elevation = 0f
    frame.addView(row, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, tabHeight))
    frame.addView(line, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(1.5f).toInt(), Gravity.BOTTOM).apply {
      if (dockRight) { leftMargin = outer; rightMargin = inner } else { leftMargin = inner; rightMargin = outer }
    })
    pill = row; label = message; undo = action; timer = line
    return FrameLayout(context).apply {
      setPadding(0, dp(4f).toInt(), 0, dp(4f).toInt()); clipToPadding = false; clipChildren = false
      addView(frame, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, tabHeight))
    }
  }

  private fun layout(bubbleRect: Rect, right: Boolean) {
    val root = window ?: return
    val layout = params ?: return
    bubble = Rect(bubbleRect); dockRight = right
    root.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    // The window ends at the bubble's centre, so the tab is clipped there: it slides out from under it.
    layout.x = if (right) bubble.centerX() - root.measuredWidth else bubble.centerX()
    layout.y = bubble.centerY() - root.measuredHeight / 2
    runCatching { windows.updateViewLayout(root, layout) }
  }

  private fun slideTo(out: Boolean, end: () -> Unit) {
    val content = window?.getChildAt(0) ?: return end()
    slide?.cancel()
    content.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    val away = (if (dockRight) 1 else -1) * content.measuredWidth.toFloat()
    val from = if (out) away else content.translationX
    val to = if (out) 0f else away
    content.translationX = from
    slide = ValueAnimator.ofFloat(from, to).apply {
      duration = if (out) 240 else 200
      interpolator = if (out) DecelerateInterpolator() else AccelerateInterpolator()
      addUpdateListener { content.translationX = it.animatedValue as Float }
      addListener(object : AnimatorListenerAdapter() {
        private var cancelled = false
        override fun onAnimationCancel(animation: Animator) { cancelled = true }
        override fun onAnimationEnd(animation: Animator) { if (!cancelled) end() }
      })
      start()
    }
  }

  private fun startHold() {
    hold?.cancel()
    val line = timer ?: return
    line.visibility = View.VISIBLE; line.scaleX = 1f
    hold = ValueAnimator.ofFloat(1f, 0f).apply {
      duration = HOLD_MS; interpolator = LinearInterpolator()
      addUpdateListener { line.scaleX = it.animatedValue as Float }
      addListener(object : AnimatorListenerAdapter() {
        private var cancelled = false
        override fun onAnimationCancel(animation: Animator) { cancelled = true }
        override fun onAnimationEnd(animation: Animator) { if (!cancelled) hide() }
      })
      start()
    }
  }

  /** Undo: the words go, the tab says so in grey for 1.2 s and slides back. The fixed text stays. */
  private fun undone() {
    val value = text ?: return
    hold?.cancel()
    onUndo(value.words)
    label?.text = "↺  ${value.undone}"; label?.setTextColor(BubbleColors.secondary); label?.setOnClickListener(null)
    undo?.visibility = View.GONE; timer?.visibility = View.INVISIBLE
    window?.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    layout(bubble, dockRight)
    handler.postDelayed({ hide() }, UNDONE_MS)
  }

  private companion object {
    const val HOLD_MS = 4000L
    const val UNDONE_MS = 1200L
  }
}

/** A small open book in the accent colour, drawn so the overlay needs no icon font. */
class BookGlyph(context: Context) : View(context) {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = BubbleColors.accent; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    stroke.strokeWidth = w / 10f
    val inset = stroke.strokeWidth
    canvas.drawRoundRect(inset, inset, w - inset, h - inset, w / 8f, w / 8f, stroke)
    canvas.drawLine(w / 2f, inset, w / 2f, h - inset, stroke)
  }
}
