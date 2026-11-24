package com.openwhispr.dictation

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.*
import android.os.SystemClock
import android.view.View
import android.view.ViewOutlineProvider
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
import androidx.core.graphics.PathParser
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.sin

/** The motion curves from the Variant 1 motion spec. */
object BubbleMotion {
  val standard = PathInterpolator(0.2f, 0f, 0f, 1f)
  val emphasizedDecelerate = PathInterpolator(0.05f, 0.7f, 0.1f, 1f)
  val emphasizedAccelerate = PathInterpolator(0.3f, 0f, 0.8f, 0.15f)
  val easeOut = PathInterpolator(0f, 0f, 0.2f, 1f)
  val easeIn = PathInterpolator(0.4f, 0f, 1f, 1f)
  /** "Remove animations" (animator duration scale 0): motion that only decorates is left out. */
  fun reduced(context: android.content.Context): Boolean =
    if (android.os.Build.VERSION.SDK_INT >= 26) !android.animation.ValueAnimator.areAnimatorsEnabled()
    else android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
}

/** The filled glyphs the menu and the mode badges use, from the V3 board (14 dp sparkle, 28 dp tiles). */
object BubbleGlyphs {
  private val sparkle = PathParser.createPathFromPathData(
    "M7 0C7.525 4.025 9.975 6.475 14 7C9.975 7.525 7.525 9.975 7 14C6.475 9.975 4.025 7.525 0 7C4.025 6.475 6.475 4.025 7 0Z")
  private val globe = PathParser.createPathFromPathData(
    "M7 0C10.8661 0 14 3.1339 14 7C14 10.8661 10.8661 14 7 14C3.1339 14 0 10.8661 0 7C0 3.1339 3.1339 0 7 0ZM7 0.6125C8.7397 0.6125 10.15 3.4722 10.15 7C10.15 10.5278 8.7397 13.3875 7 13.3875C5.2603 13.3875 3.85 10.5278 3.85 7C3.85 3.4722 5.2603 0.6125 7 0.6125ZM7 0.9625C8.0632 0.9625 8.925 3.6655 8.925 7C8.925 10.3345 8.0632 13.0375 7 13.0375C5.9368 13.0375 5.075 10.3345 5.075 7C5.075 3.6655 5.9368 0.9625 7 0.9625ZM0.525 6.3875H13.475V7.6125H0.525V6.3875Z"
  ).apply { fillType = Path.FillType.EVEN_ODD }
  private val pencil = PathParser.createPathFromPathData(
    "M9.2081 1.03356L12.9664 4.7919L4.3221 13.4362L0 14L0.56376 9.6779L9.2081 1.03356ZM10.2416 0L14 3.7584L13.3423 4.4161L9.5839 0.65772L10.2416 0Z")

  fun path(mode: BubbleMode): Path? = when (mode) {
    BubbleMode.ASSISTANT -> sparkle
    BubbleMode.TRANSLATE -> globe
    BubbleMode.EDIT -> pencil
    BubbleMode.DICTATE -> null
  }

  /** Draws [mode]'s glyph centred at ([cx], [cy]), [size] across. */
  fun draw(canvas: Canvas, mode: BubbleMode, cx: Float, cy: Float, size: Float, paint: Paint) {
    val glyph = path(mode) ?: return
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 14f, size / 14f)
    canvas.drawPath(glyph, paint)
    canvas.restore()
  }
}

/**
 * The bubble itself, at every state: the glossy app icon when ready; brand glass with bars that follow
 * the voice while listening; the bars folded into three rippling dots while writing; a drawn ✓ after a
 * paste. It never changes size, so the finger never loses it. Holding it fills a brand-blue ring.
 */
class BubbleFace(context: Context) : View(context) {
  enum class Look { ICON, LISTENING, WRITING, DONE }

  private val icon = BitmapFactory.decodeResource(resources, R.drawable.ow_bubble_icon)
  private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val solid = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.dot }
  private val glassPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val highlight = Paint(Paint.ANTI_ALIAS_FLAG)
  private val white = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val whiteStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  private val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.glassTop }
  private val ringTrack = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = BubbleColors.dot; alpha = 46 }
  private val ringArc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; color = BubbleColors.dot }
  private val badgeFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val badgeGlyph = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.dot }
  private val unseenPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val checkPath = Path()
  private val checkMeasure = PathMeasure()
  private val checkPart = Path()

  /** Fades the icon into a solid blue dot as the bubble shrinks to one. */
  var dot = 0f
    set(value) { if (field != value) { field = value; invalidate() } }
  /** The mode badge shown while listening or writing in a menu mode. */
  var badge: BubbleMode = BubbleMode.DICTATE
    set(value) { if (field != value) { field = value; invalidate() } }
  /** An amber dot while typing access is off, so nothing can paste (board state 11). */
  var warning = false
    set(value) { if (field != value) { field = value; invalidate() } }
  private val amber = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#F5A524") }
  /** A glass dot that stays until saved text is opened. */
  var unseen = false
    set(value) { if (field != value) { field = value; invalidate() } }

  var look = Look.ICON; private set
  private var glass = 0f
  private var fold = 0f
  private var check = 0f
  private var ring = 0f
  private var ringAlpha = 0f
  private var level = 0f
  private var target = 0f
  private var phase = 0f
  private var started = 0L
  private var animators = mutableListOf<ValueAnimator>()
  private var ringAnimator: ValueAnimator? = null
  private val ticker = ValueAnimator.ofFloat(0f, 1f).apply {
    duration = 1000; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
    addUpdateListener { level += (target - level) * 0.3f; phase += 0.18f; stepBars(); invalidate() }
  }
  /** Levels heard in the last 200 ms, so the side bars can follow what the middle did a moment ago. */
  private val heard = ArrayDeque<Pair<Long, Float>>()
  /** The three bars' drawn heights, in dp for a 52 dp bubble (left, middle, right). */
  private val barHeights = BubblePolicy.bars(0f, 0f, 0f)
  private var lastStep = 0L
  private var wave = 0f

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) }
    }
  }
  override fun getAccessibilityClassName(): CharSequence = android.widget.Button::class.java.name

  fun setLevel(value: Float) {
    target = value.coerceIn(0f, 1f)
    val now = SystemClock.uptimeMillis()
    heard.addLast(now to target)
    while (heard.size > 2 && heard.first().first < now - 200) heard.removeFirst()
  }
  /** The level as it was [lag] ms ago. */
  private fun heardAgo(lag: Long, now: Long): Float {
    var value = 0f
    for ((time, level) in heard) { if (time <= now - lag) value = level else break }
    return value
  }
  /**
   * Eases each bar toward where the voice and the wave put it, the middle in about 70 ms and the sides
   * gliding in about 160 ms, so a pause settles back to the logo's rest shape in about half a second. With animations off the bars hold that shape and only the halo moves.
   */
  private fun stepBars() {
    val now = SystemClock.uptimeMillis()
    val dt = if (lastStep == 0L) 16L else (now - lastStep).coerceIn(0L, 100L)
    lastStep = now
    wave = BubblePolicy.waveStep(wave, target, dt)
    val goal = if (look != Look.LISTENING || BubbleMotion.reduced(context)) BubblePolicy.bars(0f, 0f, 0f)
    else BubblePolicy.bars(target, heardAgo(BubblePolicy.SIDE_LAGS_MS[0], now), heardAgo(BubblePolicy.SIDE_LAGS_MS[1], now),
      wave, sin((System.currentTimeMillis() - started) * 2 * PI / BubblePolicy.BREATH_MS).toFloat())
    for (i in 0 until 3) {
      val tau = if (i == 1) BubblePolicy.MIDDLE_EASE_MS else BubblePolicy.SIDE_EASE_MS
      barHeights[i] += (goal[i] - barHeights[i]) * (1f - exp(-dt / tau))
    }
  }

  /** Moves to [next] with the board's timings; [animate] false jumps (Remove animations, a fresh window). */
  fun show(next: Look, animate: Boolean = true) {
    if (next == look && animate) return
    val previous = look
    look = next
    animators.forEach { it.cancel() }; animators.clear()
    if (next == Look.LISTENING) {
      started = System.currentTimeMillis(); target = 0f; level = 0f
      heard.clear(); lastStep = 0L; wave = 0f; BubblePolicy.bars(0f, 0f, 0f).copyInto(barHeights)
    }
    val glassTo = if (next == Look.ICON) 0f else 1f
    val foldTo = if (next == Look.WRITING) 1f else 0f
    val checkTo = if (next == Look.DONE) 1f else 0f
    if (!animate) {
      glass = glassTo; fold = foldTo; check = checkTo; syncTicker(); invalidate(); return
    }
    // Glass in 240 ms decelerating; back to the icon 300 ms (after a ✓) or 160 ms (cancel).
    tween(glass, glassTo, if (glassTo > glass) 240 else if (previous == Look.DONE) 300 else 160,
      if (glassTo > glass) BubbleMotion.emphasizedDecelerate else BubbleMotion.emphasizedAccelerate) { glass = it }
    tween(fold, foldTo, 160, BubbleMotion.emphasizedAccelerate) { fold = it }
    tween(check, checkTo, if (checkTo > check) 200 else 300, BubbleMotion.easeOut) { check = it }
    syncTicker()
  }

  private fun tween(from: Float, to: Float, ms: Long, curve: android.animation.TimeInterpolator, apply: (Float) -> Unit) {
    if (from == to) { apply(to); return }
    animators += ValueAnimator.ofFloat(from, to).apply {
      duration = ms; interpolator = curve
      addUpdateListener { apply(it.animatedValue as Float); invalidate() }
      addListener(object : AnimatorListenerAdapter() { override fun onAnimationEnd(animation: Animator) { syncTicker() } })
      start()
    }
  }

  private var pulseRing = -1f
  private val pulsePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BubbleColors.dot; style = Paint.Style.STROKE }
  /**
   * One soft ring pulse out from the bubble (300 ms), then [done]: the Dictionary's "Learned" tab
   * (C11) uses it on a bubble shrunk to a dot so the eye finds it. The bubble doesn't move or grow.
   */
  fun pulse(done: () -> Unit) {
    ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 300
      addUpdateListener { pulseRing = it.animatedValue as Float; invalidate() }
      addListener(object : AnimatorListenerAdapter() { override fun onAnimationEnd(animation: Animator) { pulseRing = -1f; invalidate(); done() } })
      start()
    }
  }

  /** Fills the hold ring linearly over [ms], or clears it. */
  fun holdRing(filling: Boolean, ms: Long = BubbleMenuPolicy.HOLD_MS) {
    ringAnimator?.cancel()
    if (!filling) {
      ringAnimator = ValueAnimator.ofFloat(ringAlpha, 0f).apply {
        duration = 100; addUpdateListener { ringAlpha = it.animatedValue as Float; invalidate() }
        addListener(object : AnimatorListenerAdapter() { override fun onAnimationEnd(animation: Animator) { ring = 0f } })
        start()
      }
      return
    }
    ring = 0f; ringAlpha = 1f
    ringAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = ms; interpolator = LinearInterpolator()
      addUpdateListener { ring = it.animatedValue as Float; invalidate() }
      start()
    }
  }

  private fun syncTicker() {
    val running = glass > 0f || look != Look.ICON
    if (running && isAttachedToWindow && !ticker.isStarted) ticker.start()
    if (!running && ticker.isStarted) ticker.cancel()
  }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); syncTicker() }
  override fun onDetachedFromWindow() {
    ticker.cancel(); animators.forEach { it.cancel() }; ringAnimator?.cancel(); super.onDetachedFromWindow()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    val shader = BitmapShader(icon, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
    shader.setLocalMatrix(Matrix().apply { setScale(w / icon.width.toFloat(), h / icon.height.toFloat()) })
    iconPaint.shader = shader
    glassPaint.shader = LinearGradient(0f, 0f, w.toFloat(), h.toFloat(), BubbleColors.glassTop, BubbleColors.glassBottom, Shader.TileMode.CLAMP)
    highlight.shader = LinearGradient(0f, 0f, 0f, h * 0.55f, Color.argb(70, 255, 255, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP)
    unseenPaint.shader = LinearGradient(0f, 0f, w * 0.25f, h * 0.25f, BubbleColors.glassTop, BubbleColors.glassBottom, Shader.TileMode.CLAMP)
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    val cx = w / 2; val cy = h / 2; val r = minOf(w, h) / 2
    // The voice halo breathes beyond the circle (the window's shadow room holds it).
    if (look == Look.LISTENING && glass > 0f) {
      halo.alpha = (0.16f * 255 * glass).toInt()
      canvas.drawCircle(cx, cy, r * (1f + 0.3f * level), halo)
    }
    if (glass < 1f) {
      iconPaint.alpha = ((1f - dot) * (1f - glass) * 255).toInt()
      solid.alpha = (dot * (1f - glass) * 255).toInt()
      if (dot < 1f) canvas.drawOval(0f, 0f, w, h, iconPaint)
      if (dot > 0f) canvas.drawOval(0f, 0f, w, h, solid)
    }
    if (glass > 0f) {
      val alpha = (glass * 255).toInt()
      glassPaint.alpha = alpha; highlight.alpha = alpha
      canvas.drawCircle(cx, cy, r, glassPaint)
      canvas.drawCircle(cx, cy, r, highlight)
      white.alpha = (alpha * (1f - check)).toInt()
      drawBarsAndDots(canvas, cx, cy, r)
      if (check > 0f) drawCheck(canvas, cx, cy, r, alpha)
    }
    if (ringAlpha > 0f) {
      val stroke = r * 3f / 26f
      ringTrack.strokeWidth = stroke; ringArc.strokeWidth = stroke
      ringTrack.alpha = (46 * ringAlpha).toInt(); ringArc.alpha = (255 * ringAlpha).toInt()
      val inset = -stroke * 1.4f
      canvas.drawOval(inset, inset, w - inset, h - inset, ringTrack)
      canvas.drawArc(inset, inset, w - inset, h - inset, -90f, 360f * ring, false, ringArc)
    }
    if (pulseRing >= 0f) {
      pulsePaint.strokeWidth = r / 4f
      pulsePaint.alpha = ((1f - pulseRing) * 160).toInt()
      canvas.drawCircle(cx, cy, r * (1f + pulseRing), pulsePaint)
    }
    if (badge != BubbleMode.DICTATE && look != Look.ICON) drawBadge(canvas, w, r)
    if ((unseen || warning) && look == Look.ICON && dot < 1f) {
      val dotR = r * 0.22f
      canvas.drawCircle(w - dotR * 1.2f, dotR * 1.2f, dotR + r * 0.06f, white.apply { alpha = 255 })
      canvas.drawCircle(w - dotR * 1.2f, dotR * 1.2f, dotR, if (unseen) unseenPaint else amber)
    }
  }

  /** The logo's three bars, following the voice, folding into three rippling dots (and a rim arc) while writing. */
  private fun drawBarsAndDots(canvas: Canvas, cx: Float, cy: Float, r: Float) {
    // The design's dp are for a 52 dp bubble; every size scales from the radius.
    val unit = r / 26f
    val barWidth = BubblePolicy.BAR_WIDTH * unit
    val dotSize = r * 0.138f
    for (i in 0 until 3) {
      val x = cx + (i - 1) * BubblePolicy.BAR_SPACING * unit
      val listening = barHeights[i] * unit
      val ripple = dotRipple(i)
      val height = listening + (dotSize - listening) * fold
      val dx = ((i - 1) * r * 0.32f - (i - 1) * BubblePolicy.BAR_SPACING * unit) * fold
      val y = cy - ripple * r * 0.12f * fold
      val half = barWidth / 2 + (dotSize - barWidth) / 2 * fold
      canvas.drawRoundRect(x + dx - half, y - height / 2, x + dx + half, y + height / 2, half, half, white)
    }
    if (fold > 0f && look == Look.WRITING) {
      whiteStroke.strokeWidth = r * 0.07f
      whiteStroke.alpha = (white.alpha * fold * 0.85f).toInt()
      val turn = ((System.currentTimeMillis() - started) % 1200L) / 1200f * 360f
      val inset = whiteStroke.strokeWidth
      canvas.drawArc(cx - r + inset, cy - r + inset, cx + r - inset, cy + r - inset, turn - 90f, 70f, false, whiteStroke)
    }
  }

  /** The dots ripple 900 ms per cycle, 120 ms apart. */
  private fun dotRipple(index: Int): Float {
    val t = ((System.currentTimeMillis() - index * 120L) % 900L) / 900f
    return max(0f, sin(t * 2 * PI).toFloat())
  }

  private fun drawCheck(canvas: Canvas, cx: Float, cy: Float, r: Float, alpha: Int) {
    checkPath.reset()
    checkPath.moveTo(cx - r * 0.32f, cy + r * 0.02f)
    checkPath.lineTo(cx - r * 0.08f, cy + r * 0.26f)
    checkPath.lineTo(cx + r * 0.34f, cy - r * 0.22f)
    checkMeasure.setPath(checkPath, false)
    checkPart.reset()
    checkMeasure.getSegment(0f, checkMeasure.length * check, checkPart, true)
    whiteStroke.strokeWidth = r * 0.13f
    whiteStroke.alpha = alpha
    canvas.drawPath(checkPart, whiteStroke)
  }

  private fun drawBadge(canvas: Canvas, w: Float, r: Float) {
    val br = r * 0.3f
    val bx = w - br * 0.85f; val by = br * 0.85f
    canvas.drawCircle(bx, by, br, badgeFill)
    BubbleGlyphs.draw(canvas, badge, bx, by, br * 1.15f, badgeGlyph)
  }

  /** The error nudge: three ±4 dp side-to-side cycles over 320 ms. Never red. */
  fun shake(distance: Float) {
    ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 320
      addUpdateListener { translationX = (sin(it.animatedFraction * 3 * 2 * PI) * distance).toFloat() }
      addListener(object : AnimatorListenerAdapter() { override fun onAnimationEnd(animation: Animator) { translationX = 0f } })
      start()
    }
  }
}
