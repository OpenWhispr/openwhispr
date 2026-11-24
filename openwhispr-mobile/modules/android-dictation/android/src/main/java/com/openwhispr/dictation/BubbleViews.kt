package com.openwhispr.dictation

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.Configuration
import android.graphics.*
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout

/**
 * The bubble's colours: Android's glossy white theme (src/android/theme.ts), light and dark. The
 * dark set follows the phone's dark theme (decision K7): the tabs, the hold menu, the ✕, the hide
 * target and the toast change; the bubble's glass, its dot and its icon stay as they are.
 *
 * A view that uses a colour registers how to apply it with [themed]; [follow] switches the set in
 * place from a configuration change, repainting every such view in its own window with a short
 * crossfade. Nothing is removed or re-added, so the bubble's place, state and audio carry on.
 */
object BubbleColors {
  /** The phone is in dark theme. Main thread. */
  var dark = false
    private set
  private fun pick(light: Int, dark: Int) = if (this.dark) dark else light

  val accent get() = pick(Color.parseColor("#1555D4"), Color.parseColor("#6E9BFF"))
  val surface get() = pick(Color.WHITE, Color.parseColor("#1F2026"))
  val fill get() = pick(Color.parseColor("#E6E7EB"), Color.parseColor("#2C2D36"))
  val ink get() = pick(Color.parseColor("#21212B"), Color.parseColor("#F2F2F5"))
  val secondary get() = pick(Color.parseColor("#66636E"), Color.parseColor("#A2A2AD"))
  val error get() = pick(Color.parseColor("#D70015"), Color.parseColor("#FF6B61"))
  val errorBackground get() = pick(Color.parseColor("#FDECEC"), Color.parseColor("#3A2326"))
  /** The bubble shrunk to a dot: the bubble itself, so the light theme's one blue in both. */
  val dot = Color.parseColor("#1555D4")
  /** Brand glass, the listening and writing bubble: #5588F0 → #3466E2, in both themes. */
  val glassTop = Color.parseColor("#5588F0")
  val glassBottom = Color.parseColor("#3466E2")
  /** The status tab's and menu's blue: the one accent (no second brand blue). */
  val brand get() = accent
  /** The menu's icon tiles. */
  val tile get() = pick(Color.parseColor("#F1F2F4"), Color.parseColor("#25262E"))
  /** The glass edge on the cards: black 6% on white, white 8% on dark. */
  val hairline get() = pick(Color.argb(15, 0, 0, 0), Color.argb(20, 255, 255, 255))
  /** The bottom toast: rgba(29,29,36,.92) in light, a lifted rgba(44,45,54,.96) in dark (K6). */
  val toast get() = pick(Color.argb(235, 29, 29, 36), Color.argb(245, 44, 45, 54))
  val toastAction = Color.parseColor("#8FB2FF")
  /** A faint ring in the ink colour. */
  val inkRing get() = pick(Color.argb(18, 33, 33, 43), Color.argb(26, 242, 242, 245))

  private val views = java.util.WeakHashMap<View, Unit>()

  /** Applies [apply] now and again on every switch. The action lives on [view] itself (a tag), so nothing outlives it. */
  fun <T : View> themed(view: T, apply: T.() -> Unit): T {
    view.setTag(R.id.ow_bubble_theme, Runnable { view.apply() })
    views[view] = Unit
    view.apply()
    return view
  }

  private fun night(config: Configuration) =
    (config.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  /** Takes [config]'s set without repainting anything, before any view exists. */
  fun read(config: Configuration) { dark = night(config) }

  /**
   * Main thread. Switches to [config]'s set and repaints every registered view in place: each
   * window showing one gets a copy of its last frame over it, faded out over 200 ms, so its colours
   * change in one crossfade rather than view by view. With animations off they change at once.
   * Returns false when the set was already [config]'s.
   */
  fun follow(config: Configuration): Boolean {
    val next = night(config)
    if (next == dark) return false
    val live = views.keys.filter { it.isAttachedToWindow }
    val roots = live.map { it.rootView }.distinct().filter { it.width > 0 && it.height > 0 && it.visibility == View.VISIBLE }
    val copies = if (ValueAnimator.areAnimatorsEnabled()) roots.mapNotNull { root -> snapshot(root)?.let { root to it } } else emptyList()
    dark = next
    views.keys.toList().forEach { view -> (view.getTag(R.id.ow_bubble_theme) as? Runnable)?.run(); view.invalidate() }
    roots.forEach { invalidateAll(it) }
    copies.forEach { (root, copy) ->
      root.overlay.add(copy)
      ValueAnimator.ofInt(255, 0).apply {
        duration = 200; interpolator = BubbleMotion.easeOut
        addUpdateListener { copy.alpha = it.animatedValue as Int }
        addListener(object : android.animation.AnimatorListenerAdapter() {
          override fun onAnimationEnd(animation: android.animation.Animator) { root.overlay.remove(copy) }
        })
        start()
      }
    }
    return true
  }

  /** A software copy of [root] as drawn now; null if it can't be drawn that way. */
  private fun snapshot(root: View): android.graphics.drawable.BitmapDrawable? = runCatching {
    val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
    root.draw(Canvas(bitmap))
    android.graphics.drawable.BitmapDrawable(root.resources, bitmap).apply { setBounds(0, 0, root.width, root.height) }
  }.getOrNull()

  private fun invalidateAll(view: View) {
    view.invalidate()
    if (view is android.view.ViewGroup) for (index in 0 until view.childCount) invalidateAll(view.getChildAt(index))
  }
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
class GlyphButton(context: Context, private val glyph: Glyph, private val fill: () -> Int, private val tint: () -> Int) : View(context) {
  enum class Glyph { CLOSE, STOP, RETRY }
  private val background = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  private val solid = Paint(Paint.ANTI_ALIAS_FLAG)
  private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  init {
    isClickable = true; isFocusable = true
    BubbleColors.themed(this) {
      background.color = fill(); stroke.color = tint(); solid.color = tint()
      edge.color = BubbleColors.hairline; ringPaint.color = BubbleColors.inkRing
    }
  }
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
  private val circle = Paint(Paint.ANTI_ALIAS_FLAG)
  private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val cross = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
  init {
    elevation = 8f * resources.displayMetrics.density
    BubbleColors.themed(this) { circle.color = BubbleColors.surface; edge.color = BubbleColors.hairline; cross.color = BubbleColors.ink }
  }
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
