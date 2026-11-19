package com.openwhispr.dictation

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.*
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextUtils
import android.util.TypedValue
import android.view.*
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/** A small overlay window that never takes focus, so the text box keeps its caret and selection. */
internal fun overlayParams() = WindowManager.LayoutParams(
  WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
  WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
  WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
  PixelFormat.TRANSLUCENT,
).apply { gravity = Gravity.TOP or Gravity.START }

/** The three brand-blue bars at the start of the status tab. */
private class TabGlyph(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.brand }
  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
  override fun onDraw(canvas: Canvas) {
    val u = width / 14f
    val r = 1.1f * u
    canvas.drawRoundRect(2 * u, 5 * u, 4.2f * u, 9 * u, r, r, paint)
    canvas.drawRoundRect(6 * u, 2 * u, 8.2f * u, 12 * u, r, r, paint)
    canvas.drawRoundRect(10 * u, 5 * u, 12.2f * u, 9 * u, r, r, paint)
  }
}

/** What a status tab says: its words, and at most one brand-blue action. */
data class TabMessage(
  val label: CharSequence,
  val action: CharSequence? = null,
  val onAction: (() -> Unit)? = null,
  /** Tapping the words themselves (Saved opens the text from either). */
  val onLabel: (() -> Unit)? = null,
  /** Whether it leaves by itself after 4 s; "Still writing…" stays until the words land. */
  val leaves: Boolean = true,
  /** Grey words, for a settled state such as the Dictionary's "Won't learn “Synty”" after Undo. */
  val muted: Boolean = false,
  /** Another 14 dp glyph in place of the brand bars (the Dictionary's book). */
  val glyph: ((Context) -> View)? = null,
)

/**
 * The status tab beside the bubble (Variant 1, V1/Status tab): its own small white pill with the
 * glass edge, 40 dp tall at every bubble size, 8 dp from the bubble's edge, mirrored when docked left.
 * It slides 16 dp toward the middle of the screen and fades in (240 ms ease-out, a light tick), stays
 * 4 s (longer while a finger is on it), then slides back and fades (200 ms ease-in). It never touches
 * or resizes the bubble, and never takes focus.
 *
 * Shared by the dictation messages and the Dictionary's "Learned" tab: both call [show] with the
 * bubble's visible rectangle on screen.
 */
class StatusTab(private val context: Context, private val windows: WindowManager, private val font: Typeface) {
  private val handler = Handler(Looper.getMainLooper())
  private var window: FrameLayout? = null
  private var pill: LinearLayout? = null
  private var label: TextView? = null
  private var action: TextView? = null
  private val params = overlayParams()
  private var anchor = Rect()
  private var dockRight = true
  private var touching = false
  private var shownAt = 0L
  private var releasedAt: Long? = null
  private var message: TabMessage? = null
  private var onGone: (() -> Unit)? = null
  /** Leaving by itself (4 s untouched) is the only way [onGone] runs; an action or [hide] doesn't. */
  private val leave = Runnable { val gone = onGone; hide(); gone?.invoke() }

  val showing get() = message != null

  private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, context.resources.displayMetrics)
  private val room get() = dp(12f).toInt()

  /**
   * Slides the tab out beside [bubble] (screen coordinates of the bubble's visible circle). A tab
   * already out changes its words in place. [gone] runs only if it leaves by itself.
   */
  fun show(next: TabMessage, bubble: Rect, right: Boolean, gone: (() -> Unit)? = null) {
    val replacing = message != null && window?.isAttachedToWindow == true
    message = next; onGone = gone; anchor = Rect(bubble); dockRight = right
    if (!replacing) build()
    apply(next)
    place()
    shownAt = SystemClock.uptimeMillis(); releasedAt = null
    schedule()
    pill?.announceForAccessibility(listOfNotNull(next.label, next.action).joinToString(" · "))
    if (!replacing) slideIn()
  }

  /** Follows the bubble when it moves or shrinks. */
  fun follow(bubble: Rect, right: Boolean) {
    if (message == null) return
    anchor = Rect(bubble); dockRight = right
    place()
  }

  /** Slides the tab back and removes its window. */
  fun hide(animate: Boolean = true) {
    handler.removeCallbacks(leave)
    val view = window ?: return
    val content = pill
    message = null; onGone = null
    val remove = { runCatching { windows.removeView(view) }; if (window === view) { window = null; pill = null; label = null; action = null } }
    if (!animate || content == null || !view.isAttachedToWindow) remove()
    else content.animate().translationX(slideFrom()).alpha(0f).setDuration(200).setInterpolator(BubbleMotion.easeIn)
      .withEndAction(remove).start()
  }

  private fun slideFrom() = if (dockRight) dp(16f) else -dp(16f)

  @SuppressLint("ClickableViewAccessibility")
  private fun build() {
    val holder = FrameLayout(context).apply { setPadding(room, room, room, room); clipToPadding = false; clipChildren = false }
    val content = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      background = GradientDrawable().apply {
        setColor(Color.WHITE); cornerRadius = dp(20f); setStroke(dp(1f).toInt().coerceAtLeast(1), BubbleColors.hairline)
      }
      elevation = dp(3f)
      setPadding(dp(12f).toInt(), 0, dp(14f).toInt(), 0)
      // A finger on the tab keeps it out; it starts counting again when the finger lifts.
      setOnTouchListener { _, event ->
        when (event.actionMasked) {
          MotionEvent.ACTION_DOWN -> { touching = true; handler.removeCallbacks(leave) }
          MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { touching = false; releasedAt = SystemClock.uptimeMillis(); schedule() }
        }
        false
      }
    }
    content.addView(TabGlyph(context), LinearLayout.LayoutParams(dp(14f).toInt(), dp(14f).toInt()))
    val words = text(BubbleColors.ink)
    content.addView(words, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT).apply { marginStart = dp(8f).toInt() })
    val button = text(BubbleColors.brand)
    content.addView(button, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT).apply { marginStart = dp(8f).toInt() })
    holder.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(40f).toInt()))
    window = holder; pill = content; label = words; action = button
    windows.addView(holder, params)
  }

  private fun text(color: Int) = TextView(context).apply {
    typeface = font; setTextColor(color); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.CENTER_VERTICAL
    maxWidth = dp(200f).toInt()
  }

  private fun apply(next: TabMessage) {
    pill?.let { content ->
      val icon = next.glyph?.invoke(context) ?: TabGlyph(context)
      content.removeViewAt(0)
      content.addView(icon, 0, LinearLayout.LayoutParams(dp(14f).toInt(), dp(14f).toInt()))
    }
    label?.apply {
      setTextColor(if (next.muted) BubbleColors.secondary else BubbleColors.ink)
      text = next.label
      isClickable = next.onLabel != null
      setOnClickListener(next.onLabel?.let { run -> View.OnClickListener { run() } })
    }
    action?.apply {
      text = next.action ?: ""
      visibility = if (next.action == null) View.GONE else View.VISIBLE
      isClickable = next.onAction != null
      setOnClickListener(next.onAction?.let { run -> View.OnClickListener { run() } })
      // A tab action is a 40 dp target, not just its words.
      val pad = dp(6f).toInt(); setPadding(pad, 0, pad, 0)
    }
  }

  private fun place() {
    val view = window ?: return
    view.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    val gap = dp(8f).toInt()
    val tabWidth = view.measuredWidth - 2 * room
    params.x = if (dockRight) anchor.left - gap - tabWidth - room else anchor.right + gap - room
    params.y = anchor.centerY() - dp(20f).toInt() - room
    if (view.isAttachedToWindow) runCatching { windows.updateViewLayout(view, params) }
  }

  private fun slideIn() {
    val content = pill ?: return
    content.translationX = slideFrom(); content.alpha = 0f
    content.animate().translationX(0f).alpha(1f).setDuration(240).setInterpolator(BubbleMotion.easeOut).start()
    content.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
  }

  private fun schedule() {
    handler.removeCallbacks(leave)
    if (message?.leaves != true) return
    val at = BubbleMenuPolicy.tabLeavesAt(shownAt, releasedAt, touching) ?: return
    handler.postAtTime(leave, at)
  }
}

/**
 * The dark toast at the bottom ("Bubble hidden for 15 minutes · Undo", "Edited · selection replaced
 * · Undo"). It rises 200 ms, stays 4 s and sinks 200 ms; Undo runs its action and closes it.
 */
class BottomToast(private val context: Context, private val windows: WindowManager, private val font: Typeface) {
  private val handler = Handler(Looper.getMainLooper())
  private var window: FrameLayout? = null
  private val params = overlayParams().apply { gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL }
  private val leave = Runnable { hide() }
  private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, context.resources.displayMetrics)

  /** Shows [text] with an optional Undo, its bottom edge at [bottom] (screen y). */
  fun show(text: CharSequence, undo: CharSequence?, bottom: Int, onUndo: (() -> Unit)?) {
    hide(false)
    val room = dp(12f).toInt()
    val holder = FrameLayout(context).apply { setPadding(room, room, room, room); clipToPadding = false }
    val pill = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      background = GradientDrawable().apply { setColor(BubbleColors.toast); cornerRadius = dp(20f) }
      elevation = dp(6f)
      setPadding(dp(16f).toInt(), 0, dp(10f).toInt(), 0)
    }
    pill.addView(TextView(context).apply {
      this.text = text; typeface = font; setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.CENTER_VERTICAL
      maxWidth = dp(260f).toInt()
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
    if (undo != null && onUndo != null) pill.addView(TextView(context).apply {
      this.text = undo; typeface = font; setTextColor(BubbleColors.toastAction); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      gravity = Gravity.CENTER_VERTICAL; val pad = dp(8f).toInt(); setPadding(pad, 0, pad, 0)
      isClickable = true; setOnClickListener { hide(); onUndo() }
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT).apply { marginStart = dp(4f).toInt() })
    else pill.setPadding(dp(16f).toInt(), 0, dp(16f).toInt(), 0)
    holder.addView(pill, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(40f).toInt()))
    params.y = bottom - dp(40f).toInt() - room
    window = holder
    runCatching { windows.addView(holder, params) }.onFailure { window = null; return }
    pill.translationY = dp(16f); pill.alpha = 0f
    pill.animate().translationY(0f).alpha(1f).setDuration(200).setInterpolator(BubbleMotion.emphasizedDecelerate).start()
    pill.announceForAccessibility(listOfNotNull(text, undo).joinToString(" · "))
    handler.postDelayed(leave, BubbleMenuPolicy.TOAST_HOLD_MS)
  }

  fun hide(animate: Boolean = true) {
    handler.removeCallbacks(leave)
    val view = window ?: return
    window = null
    val pill = view.getChildAt(0)
    val remove = { runCatching { windows.removeView(view) }; Unit }
    if (!animate || pill == null || !view.isAttachedToWindow) remove()
    else pill.animate().translationY(dp(16f)).alpha(0f).setDuration(200).setInterpolator(BubbleMotion.emphasizedAccelerate).withEndAction(remove).start()
  }
}
