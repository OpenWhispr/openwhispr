package com.openwhispr.dictation

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
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
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/** What JS asks the tab to say; the words come back on Undo. Strings arrive already translated. */
data class LearnedTabText(val words: List<String>, val message: String, val undo: String, val undone: String)

/**
 * Dictionary's C11: after a word is learned from a fix in another app, a pill grows out of the bubble
 * and settles beside it as its own thing ("Learned “Synty”" · Undo), holds, and shrinks back into
 * the bubble. Always full size whatever the bubble's size; never takes focus; the bubble never moves
 * or grows. Its window is added before the bubble's, so while it grows it comes out from under it.
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
  private var icon: PillGlyph? = null
  private var label: TextView? = null
  private var undo: TextView? = null
  private var motion: Animator? = null
  private var text: LearnedTabText? = null
  private var bubble = Rect()
  private var dockRight = true
  private var paused = false
  var showing = false; private set

  private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, context.resources.displayMetrics)
  private val pillHeight get() = dp(44f).toInt()
  private val gap get() = dp(10f).toInt()
  /** Room around the pill for its shadow. */
  private val margin get() = dp(12f).toInt()

  private val hideLater = Runnable { hide() }

  /** Adds the (empty, hidden) window. Call before the bubble's window is added. */
  fun create() {
    if (window != null) return
    val view = FrameLayout(context).apply { visibility = View.GONE; clipChildren = false; clipToPadding = false }
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
    handler.removeCallbacksAndMessages(null); motion?.cancel()
    window?.let { runCatching { windows.removeView(it) } }
    window = null; params = null; showing = false
  }

  /**
   * Shows the pill beside the bubble, or updates it in place when it is already out ("Learned 2
   * words"). [bubbleRect] is the bubble's visible circle on screen. [dot] is unused for size now
   * (the pill keeps one size); the dot's ring pulse happens before this is called.
   */
  @Suppress("UNUSED_PARAMETER")
  fun show(value: LearnedTabText, bubbleRect: Rect, right: Boolean, dot: Boolean) {
    val root = window ?: return
    text = value
    if (showing && pill != null) {
      label?.text = value.message; label?.setTextColor(BubbleColors.ink)
      undo?.visibility = View.VISIBLE; icon?.kind = PillGlyph.Kind.BOOK
      layout(bubbleRect, right); hold(); return
    }
    bubble = Rect(bubbleRect); dockRight = right
    root.removeAllViews()
    root.addView(build(value))
    root.visibility = View.VISIBLE
    layout(bubbleRect, right)
    showing = true
    root.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    grow(out = true) { hold() }
  }

  /** Keeps the pill beside the bubble when the bubble moves (the keyboard opened or closed). */
  fun follow(bubbleRect: Rect, right: Boolean) { if (showing) layout(bubbleRect, right) }

  fun hide(animate: Boolean = true) {
    if (!showing) return
    handler.removeCallbacksAndMessages(null)
    val done = { window?.visibility = View.GONE; showing = false; text = null }
    if (!animate) { motion?.cancel(); done(); return }
    grow(out = false) { done() }
  }

  private fun build(value: LearnedTabText): View {
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      background = GradientDrawable().apply {
        setColor(BubbleColors.surface); cornerRadius = pillHeight / 2f
        setStroke(maxOf(1, dp(1f).toInt()), Color.argb(15, 0, 0, 0))
      }
      elevation = dp(6f)
      outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
      setPadding(dp(16f).toInt(), 0, dp(18f).toInt(), 0)
      // Touching the pill keeps it out; letting go lets the hold run on.
      setOnTouchListener { _, event ->
        when (event.actionMasked) {
          MotionEvent.ACTION_DOWN -> { paused = true; handler.removeCallbacks(hideLater) }
          MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { paused = false; if (undo?.visibility == View.VISIBLE) hold() }
        }
        false
      }
    }
    val book = PillGlyph(context)
    val message = TextView(context).apply {
      text = value.message; typeface = font; setTextColor(BubbleColors.ink)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f); maxLines = 1; ellipsize = TextUtils.TruncateAt.END
      gravity = Gravity.CENTER_VERTICAL
      // Tapping the words opens the Dictionary.
      setOnClickListener { onOpen(); hide() }
    }
    val action = TextView(context).apply {
      text = value.undo; typeface = Typeface.create(font, Typeface.BOLD); setTextColor(BubbleColors.accent)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f); gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(12f).toInt(), 0, 0, 0)
      contentDescription = "${value.undo}, ${value.message}"
      setOnClickListener { undone() }
    }
    val glyph = dp(16f).toInt()
    row.addView(book, LinearLayout.LayoutParams(glyph, glyph).apply { marginEnd = dp(8f).toInt() })
    row.addView(message, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
    row.addView(action, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
    pill = row; icon = book; label = message; undo = action
    // The window leaves room for the shadow, and reaches to the bubble's centre so the pill can
    // start under the bubble and grow out of it.
    return FrameLayout(context).apply {
      clipChildren = false; clipToPadding = false
      addView(row, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, pillHeight, Gravity.CENTER_VERTICAL))
    }
  }

  private fun layout(bubbleRect: Rect, right: Boolean) {
    val root = window ?: return
    val layout = params ?: return
    val content = root.getChildAt(0) as? FrameLayout ?: return
    val row = pill ?: return
    bubble = Rect(bubbleRect); dockRight = right
    row.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.makeMeasureSpec(pillHeight, View.MeasureSpec.EXACTLY))
    val reach = gap + bubble.width() / 2
    content.setPadding(if (right) margin else reach, margin, if (right) reach else margin, margin)
    root.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    // The pill's inner end sits [gap] from the bubble, its middle level with the bubble's.
    layout.x = if (right) bubble.left - gap - row.measuredWidth - margin else bubble.centerX()
    layout.y = bubble.centerY() - pillHeight / 2 - margin
    row.pivotX = if (right) row.measuredWidth.toFloat() else 0f
    row.pivotY = pillHeight / 2f
    runCatching { windows.updateViewLayout(root, layout) }
      .onFailure { android.util.Log.w("OpenWhisprLearn", "Pill layout failed", it) }
    android.util.Log.i("OpenWhisprLearn", "Pill window at ${layout.x},${layout.y} size ${root.measuredWidth}x${root.measuredHeight} pill ${row.measuredWidth} bubble $bubble attached=${root.isAttachedToWindow} visible=${root.visibility}")
  }

  /** Grows the pill out of the bubble (or back into it): from the bubble's middle, small and clear. */
  private fun grow(out: Boolean, end: () -> Unit) {
    val row = pill ?: return end()
    motion?.cancel()
    val toBubble = (if (dockRight) 1 else -1) * (gap + bubble.width() / 2f)
    val small = 0.2f
    if (out) { row.translationX = toBubble; row.scaleX = small; row.scaleY = small; row.alpha = 0f }
    val set = AnimatorSet().apply {
      playTogether(
        ObjectAnimator.ofFloat(row, View.TRANSLATION_X, row.translationX, if (out) 0f else toBubble),
        ObjectAnimator.ofFloat(row, View.SCALE_X, row.scaleX, if (out) 1f else small),
        ObjectAnimator.ofFloat(row, View.SCALE_Y, row.scaleY, if (out) 1f else small),
        ObjectAnimator.ofFloat(row, View.ALPHA, row.alpha, if (out) 1f else 0f),
      )
      duration = if (out) GROW_MS else SHRINK_MS
      interpolator = if (out) OvershootInterpolator(1.1f) else AccelerateInterpolator(1.4f)
      addListener(object : AnimatorListenerAdapter() {
        private var cancelled = false
        override fun onAnimationCancel(animation: Animator) { cancelled = true }
        override fun onAnimationEnd(animation: Animator) {
          android.util.Log.i("OpenWhisprLearn", "Pill ${if (out) "grew" else "shrank"} cancelled=$cancelled alpha=${row.alpha} scale=${row.scaleX} shown=${row.isShown} w=${row.width}")
          if (!cancelled) end()
        }
      })
    }
    motion = set
    set.start()
  }

  private fun hold() {
    handler.removeCallbacks(hideLater)
    if (!paused) handler.postDelayed(hideLater, HOLD_MS)
  }

  /** Undo: the words go, the pill says so in grey for 1.2 s and goes back. The fixed text stays. */
  private fun undone() {
    val value = text ?: return
    handler.removeCallbacks(hideLater)
    onUndo(value.words)
    // Same size and colours as "Learned", with the undo arrow where the book was.
    label?.text = value.undone; label?.setOnClickListener(null)
    undo?.visibility = View.GONE; icon?.kind = PillGlyph.Kind.UNDO
    layout(bubble, dockRight)
    handler.postDelayed(hideLater, UNDONE_MS)
  }

  private companion object {
    const val GROW_MS = 520L
    const val SHRINK_MS = 300L
    const val HOLD_MS = 5000L
    const val UNDONE_MS = 1200L
  }
}

/** The pill's icon, drawn so the overlay needs no icon font: a closed book, or the undo arrow. */
class PillGlyph(context: Context) : View(context) {
  enum class Kind { BOOK, UNDO }
  var kind = Kind.BOOK
    set(value) { if (field != value) { field = value; invalidate() } }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = BubbleColors.accent; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.accent; style = Paint.Style.FILL }
  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    stroke.strokeWidth = w / 10f
    val inset = stroke.strokeWidth
    when (kind) {
      Kind.BOOK -> {
        canvas.drawRoundRect(inset + w * 0.12f, inset, w - inset - w * 0.12f, h - inset, w / 8f, w / 8f, stroke)
        canvas.drawLine(inset + w * 0.3f, inset, inset + w * 0.3f, h - inset, stroke)
      }
      Kind.UNDO -> {
        // A circle open at the top left, its arrowhead pointing on round anticlockwise.
        val r = w / 2f - inset * 1.6f
        val cx = w / 2f; val cy = h / 2f
        canvas.drawArc(cx - r, cy - r, cx + r, cy + r, 250f, 250f, false, stroke)
        val a = Math.toRadians(250.0)
        val px = cx + r * Math.cos(a).toFloat(); val py = cy + r * Math.sin(a).toFloat()
        val dx = Math.sin(a).toFloat(); val dy = -Math.cos(a).toFloat()
        val nx = -dy; val ny = dx
        val head = android.graphics.Path().apply {
          moveTo(px + dx * w * 0.24f, py + dy * w * 0.24f)
          lineTo(px + nx * w * 0.15f, py + ny * w * 0.15f)
          lineTo(px - nx * w * 0.15f, py - ny * w * 0.15f)
          close()
        }
        canvas.drawPath(head, fill)
      }
    }
  }
}
