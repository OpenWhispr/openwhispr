package com.openwhispr.dictation

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout

/** The bubble's colours: Android's glossy white theme (src/android/theme.ts), light. */
object BubbleColors {
  val accent = Color.parseColor("#1555D4")
  val surface = Color.WHITE
  val fill = Color.parseColor("#E6E7EB")
  val ink = Color.parseColor("#21212B")
  val secondary = Color.parseColor("#66636E")
  val error = Color.parseColor("#D70015")
  val errorBackground = Color.parseColor("#FDECEC")
  /** The bubble shrunk to a dot: the one accent blue. */
  val dot = accent
  /** Brand glass, the listening and writing bubble: #5588F0 → #3466E2. */
  val glassTop = Color.parseColor("#5588F0")
  val glassBottom = Color.parseColor("#3466E2")
  /** The status tab's and menu's blue: the one accent (no second brand blue). */
  val brand = accent
  /** The menu's icon tiles. */
  val tile = Color.parseColor("#F1F2F4")
  /** The glass edge on white surfaces. */
  val hairline = Color.argb(15, 0, 0, 0)
  /** The bottom toast: rgba(29,29,36,.92), and its action word. */
  val toast = Color.argb(235, 29, 29, 36)
  val toastAction = Color.parseColor("#8FB2FF")
  /** A faint ring in the ink colour. */
  val inkRing = Color.argb(18, 33, 33, 43)
}

/**
 * The bubble window's root. A gesture that starts on the Ready bubble keeps reaching [gesture]
 * while the hold menu opens above it, so a finger can slide straight onto a row.
 */
class BubbleRoot(context: Context) : FrameLayout(context) {
  var startsGesture: (MotionEvent) -> Boolean = { false }
  var gesture: ((MotionEvent) -> Unit)? = null
  /** A touch outside the window (FLAG_WATCH_OUTSIDE_TOUCH); it still reaches the app below. */
  var outside: (() -> Unit)? = null
  private var tracking = false
  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_OUTSIDE) { outside?.invoke(); return false }
    if (event.actionMasked == MotionEvent.ACTION_DOWN) tracking = startsGesture(event)
    if (!tracking) return super.dispatchTouchEvent(event)
    gesture?.invoke(event)
    if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) tracking = false
    return true
  }
}

/** A round button with a drawn glyph, so the overlay needs no icon font. */
class GlyphButton(context: Context, private val glyph: Glyph, private val fill: Int, private val tint: Int) : View(context) {
  enum class Glyph { CLOSE, STOP, RETRY }
  private val background = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = fill }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = tint; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  private val solid = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = tint }
  private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.argb(15, 0, 0, 0) }
  private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.inkRing }
  init { isClickable = true; isFocusable = true }
  override fun getAccessibilityClassName(): CharSequence = android.widget.Button::class.java.name

  /** The soft grey ring drawn behind a selected button (48 dp on the listening ✕); 0 draws none. */
  var ringDiameter = 0f
  /** 0 at rest, 1 selected: the button grows to 1.125 (32 → 36 dp) and the ring fades in. Drawn, not a view scale, so it adds to the pop. */
  private var selection = 0f
  private var selecting: ValueAnimator? = null
  private var under = false
  /** Grows under a finger: 140 ms ease-out in with a light tick, 120 ms back. With animations off, only the ring shows. */
  var underFinger: Boolean
    get() = under
    set(value) {
      if (under == value) return
      under = value
      selecting?.cancel()
      if (value) performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
      selecting = ValueAnimator.ofFloat(selection, if (value) 1f else 0f).apply {
        duration = if (value) 140 else 120
        interpolator = if (value) BubbleMotion.easeOut else BubbleMotion.standard
        addUpdateListener { selection = it.animatedValue as Float; invalidate() }
        start()
      }
    }
  /** Back to rest at once, for a ✕ that is going away. */
  fun clearSelection() { selecting?.cancel(); selecting = null; under = false; selection = 0f; invalidate() }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f; val cy = height / 2f
    if (selection > 0f && ringDiameter > 0f) {
      // Drawn past the button's own bounds: its row doesn't clip children.
      ringPaint.alpha = (18 * selection).toInt()
      canvas.drawCircle(cx, cy, ringDiameter / 2, ringPaint)
    }
    val grow = if (BubbleMotion.reduced(context)) 1f else 1f + 0.125f * selection
    canvas.save()
    canvas.scale(grow, grow, cx, cy)
    drawButton(canvas, cx, cy)
    canvas.restore()
  }
  private fun drawButton(canvas: Canvas, cx: Float, cy: Float) {
    val size = minOf(width, height).toFloat()
    canvas.drawCircle(cx, cy, size / 2, background)
    val unit = size / 40f
    stroke.strokeWidth = 2f * unit
    when (glyph) {
      Glyph.CLOSE -> {
        // The listening ✕ (V1/Satellite · cancel), in proportion to Figma's 28 dp drawing: a 2.2 dp stroke
        // with arms 5.8 dp across, and a 6 % ink hairline edge.
        edge.strokeWidth = size / 28f
        canvas.drawCircle(cx, cy, size / 2 - edge.strokeWidth / 2, edge)
        stroke.strokeWidth = size * 2.2f / 28f
        val r = size * 2.9167f / 28f
        canvas.drawLine(cx - r, cy - r, cx + r, cy + r, stroke); canvas.drawLine(cx + r, cy - r, cx - r, cy + r, stroke)
      }
      Glyph.STOP -> { val r = 6f * unit; canvas.drawRoundRect(cx - r, cy - r, cx + r, cy + r, 2f * unit, 2f * unit, solid) }
      Glyph.RETRY -> {
        // A clockwise arc open at the top right, ending in a filled arrowhead that points along it.
        val r = 7f * unit
        val start = -30f; val sweep = 280f
        canvas.drawArc(cx - r, cy - r, cx + r, cy + r, start, sweep, false, stroke)
        val end = Math.toRadians((start + sweep).toDouble())
        val ox = kotlin.math.cos(end).toFloat(); val oy = kotlin.math.sin(end).toFloat() // outward from the centre
        val tx = -oy; val ty = ox // clockwise along the arc
        val px = cx + r * ox; val py = cy + r * oy
        val head = 3.6f * unit
        canvas.drawPath(android.graphics.Path().apply {
          moveTo(px + tx * head * 1.2f, py + ty * head * 1.2f)
          lineTo(px + ox * head, py + oy * head)
          lineTo(px - ox * head, py - oy * head)
          close()
        }, solid)
      }
    }
  }
}

/** The white glass "Hide for 15 minutes" target drawn while the bubble is dragged; it grows to pull the bubble in. */
class HideTargetView(context: Context) : View(context) {
  private val circle = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.hairline; style = Paint.Style.STROKE }
  private val cross = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.ink; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
  init { elevation = 8f * resources.displayMetrics.density }
  var active = false
    set(value) {
      if (field != value) {
        field = value
        animate().scaleX(if (value) 1.15f else 1f).scaleY(if (value) 1.15f else 1f).setDuration(120).start()
        if (value) performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
      }
    }
  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f; val cy = height / 2f
    val r = minOf(width, height) / 2f
    canvas.drawCircle(cx, cy, r, circle)
    edge.strokeWidth = resources.displayMetrics.density
    canvas.drawCircle(cx, cy, r - edge.strokeWidth / 2, edge)
    cross.strokeWidth = width / 28f
    val arm = width / 9f
    canvas.drawLine(cx - arm, cy - arm, cx + arm, cy + arm, cross); canvas.drawLine(cx + arm, cy - arm, cx - arm, cy + arm, cross)
  }
}
