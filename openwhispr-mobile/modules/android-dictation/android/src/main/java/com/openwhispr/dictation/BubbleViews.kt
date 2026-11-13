package com.openwhispr.dictation

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import android.view.animation.LinearInterpolator
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
}

/**
 * The bubble window's root. A gesture that starts on the Ready bubble keeps reaching [gesture]
 * after the content switches to the listening pill, so holding to talk survives the switch.
 */
class BubbleRoot(context: Context) : FrameLayout(context) {
  var startsGesture: () -> Boolean = { false }
  var gesture: ((MotionEvent) -> Unit)? = null
  private var tracking = false
  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) tracking = startsGesture()
    if (!tracking) return super.dispatchTouchEvent(event)
    gesture?.invoke(event)
    if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) tracking = false
    return true
  }
}

/** The glossy app icon, cropped to a circle. */
class IconBubble(context: Context) : View(context) {
  private val bitmap = BitmapFactory.decodeResource(resources, R.drawable.ow_bubble_icon)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    outlineProvider = object : android.view.ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) }
    }
  }
  override fun getAccessibilityClassName(): CharSequence = android.widget.Button::class.java.name
  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    val shader = BitmapShader(bitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
    shader.setLocalMatrix(Matrix().apply { setScale(w / bitmap.width.toFloat(), h / bitmap.height.toFloat()) })
    paint.shader = shader
  }
  override fun onDraw(canvas: Canvas) { canvas.drawOval(0f, 0f, width.toFloat(), height.toFloat(), paint) }
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

/** Seven accent bars that follow the microphone level. */
class WaveformView(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.accent }
  private var target = 0f
  private var level = 0f
  private var phase = 0f
  private val ticker = ValueAnimator.ofFloat(0f, 1f).apply {
    duration = 1000; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
    addUpdateListener { level += (target - level) * 0.35f; phase += 0.18f; invalidate() }
  }
  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
  fun setLevel(value: Float) { target = value }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); level = 0f; target = 0f; ticker.start() }
  override fun onDetachedFromWindow() { ticker.cancel(); super.onDetachedFromWindow() }
  override fun onDraw(canvas: Canvas) {
    val bars = BubblePolicy.bars(level, phase)
    val gap = width / (bars.size * 2f - 1)
    for (i in bars.indices) {
      val h = bars[i] * height
      val left = i * gap * 2
      canvas.drawRoundRect(left, (height - h) / 2, left + gap, (height + h) / 2, gap / 2, gap / 2, paint)
    }
  }
}

/** An accent arc that spins while the words are written up. */
class SpinnerView(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = BubbleColors.accent; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND
  }
  private var angle = 0f
  private val ticker = ValueAnimator.ofFloat(0f, 360f).apply {
    duration = 900; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
    addUpdateListener { angle = it.animatedValue as Float; invalidate() }
  }
  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); ticker.start() }
  override fun onDetachedFromWindow() { ticker.cancel(); super.onDetachedFromWindow() }
  override fun onDraw(canvas: Canvas) {
    paint.strokeWidth = width / 9f
    val inset = paint.strokeWidth / 2
    canvas.drawArc(inset, inset, width - inset, height - inset, angle - 90f, 270f, false, paint)
  }
}

/** The dark round "Hide for 1 hour" target drawn while the bubble is dragged. */
class HideTargetView(context: Context) : View(context) {
  private val circle = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.ink }
  private val cross = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
  var active = false
    set(value) { if (field != value) { field = value; animate().scaleX(if (value) 1.18f else 1f).scaleY(if (value) 1.18f else 1f).setDuration(120).start() } }
  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f; val cy = height / 2f
    canvas.drawCircle(cx, cy, minOf(width, height) / 2f, circle)
    cross.strokeWidth = width / 28f
    val r = width / 9f
    canvas.drawLine(cx - r, cy - r, cx + r, cy + r, cross); canvas.drawLine(cx + r, cy - r, cx - r, cy + r, cross)
  }
}
