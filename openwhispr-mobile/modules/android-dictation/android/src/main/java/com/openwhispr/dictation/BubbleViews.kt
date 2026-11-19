package com.openwhispr.dictation

import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout

/** Colours from the iOS design system's Theme variables (light). */
object BubbleColors {
  val accent = Color.parseColor("#1555D4")
  val surface = Color.WHITE
  val fill = Color.parseColor("#E8E7E4")
  val ink = Color.parseColor("#181714")
  val secondary = Color.parseColor("#6E6D69")
  val error = Color.parseColor("#D70015")
  val errorBackground = Color.parseColor("#FDECEC")
  /** The icon's blue, for the bubble shrunk to a dot. */
  val dot = Color.parseColor("#2457C5")
  /** Brand glass, the listening and writing bubble: #5588F0 → #3466E2. */
  val glassTop = Color.parseColor("#5588F0")
  val glassBottom = Color.parseColor("#3466E2")
  /** The status tab's and menu's brand blue. */
  val brand = Color.parseColor("#154BD4")
  /** The menu's icon tiles. */
  val tile = Color.parseColor("#F2F1EF")
  /** The glass edge on white surfaces. */
  val hairline = Color.argb(15, 0, 0, 0)
  /** The bottom toast. */
  val toast = Color.argb(240, 24, 23, 20)
  val toastAction = Color.parseColor("#8FB0FF")
}

/**
 * The bubble window's root. A gesture that starts on the Ready bubble keeps reaching [gesture]
 * while the hold menu opens above it, so a finger can slide straight onto a row.
 */
class BubbleRoot(context: Context) : FrameLayout(context) {
  var startsGesture: () -> Boolean = { false }
  var gesture: ((MotionEvent) -> Unit)? = null
  /** A touch outside the window (FLAG_WATCH_OUTSIDE_TOUCH); it still reaches the app below. */
  var outside: (() -> Unit)? = null
  private var tracking = false
  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_OUTSIDE) { outside?.invoke(); return false }
    if (event.actionMasked == MotionEvent.ACTION_DOWN) tracking = startsGesture()
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
  init { isClickable = true; isFocusable = true }
  override fun getAccessibilityClassName(): CharSequence = android.widget.Button::class.java.name
  override fun onDraw(canvas: Canvas) {
    val size = minOf(width, height).toFloat()
    val cx = width / 2f; val cy = height / 2f
    canvas.drawCircle(cx, cy, size / 2, background)
    val unit = size / 40f
    stroke.strokeWidth = 2f * unit
    when (glyph) {
      Glyph.CLOSE -> {
        val r = 5.5f * unit
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
