package com.openwhispr.dictation

import android.animation.ValueAnimator
import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.*
import android.text.TextUtils
import android.util.TypedValue
import android.view.*
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs

/**
 * The floating dictation bubble: a round app icon that shows while a text box is focused, grows
 * into a listening bar, writes the words up, and settles back. Dictation only; talking over
 * highlighted text replaces it.
 */
class DictationService : Service() {
  companion object {
    var instance: DictationService? = null; private set
    var emit: ((String, Map<String, Any>) -> Unit)? = null
    var appVisible = true
    var practiceVisible = false
    private const val PREFERENCES = "bubble"
    private const val ERROR_TIMEOUT_MS = 15000L
  }
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var windows: WindowManager
  private val preferences by lazy { getSharedPreferences(PREFERENCES, MODE_PRIVATE) }
  private val font by lazy { runCatching { resources.getFont(R.font.ow_space_grotesk_medium) }.getOrDefault(Typeface.DEFAULT) }

  private var root: BubbleRoot? = null
  private var layout: WindowManager.LayoutParams? = null
  private var target: FrameLayout? = null
  private var targetCircle: HideTargetView? = null
  private var targetLayout: WindowManager.LayoutParams? = null
  private var waveform: WaveformView? = null
  private var snap: ValueAnimator? = null
  private var scale = 1f

  private var state = BubbleState.READY
  private var recorder: WavRecorder? = null
  private var stopping = false
  private var held = false
  private var dragging = false
  private var retryKept = false
  private var typing = false
  private var keyboardTop: Int? = null
  private var dockRight = true
  private var savedTop: Int? = null
  private var hiddenUntil = 0L
  private val hidden get() = System.currentTimeMillis() < hiddenUntil

  private val maximumRecording = Runnable { if (state == BubbleState.LISTENING) finish(false) }
  private val dismissError = Runnable { dismiss() }
  private val unhide = Runnable { unhide() }

  override fun onBind(intent: Intent?) = null
  override fun onCreate() {
    super.onCreate(); instance = this
    windows = getSystemService(WINDOW_SERVICE) as WindowManager
    dockRight = preferences.getBoolean("dockRight", true)
    savedTop = preferences.getInt("top", -1).takeIf { it >= 0 }
    hiddenUntil = preferences.getLong("hiddenUntil", 0L)
    if (hidden) handler.postDelayed(unhide, hiddenUntil - System.currentTimeMillis())
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(NotificationChannel("dictation", getString(R.string.ow_bubble_channel), NotificationManager.IMPORTANCE_LOW))
    foreground(false)
  }
  private fun foreground(recording: Boolean) {
    val asleep = hidden && !recording
    val pending = if (asleep)
      PendingIntent.getService(this, 1, Intent(this, DictationService::class.java).setAction("show"),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    else PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName)!!,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification = Notification.Builder(this, "dictation")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(getString(when {
        recording -> R.string.ow_bubble_recording
        asleep -> R.string.ow_bubble_hidden
        else -> R.string.ow_bubble_ready
      }))
      .setContentText(getString(if (asleep) R.string.ow_bubble_hidden_notice else R.string.ow_bubble_notice))
      .setContentIntent(pending).setOngoing(true).build()
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    if (Build.VERSION.SDK_INT >= 29) startForeground(472, notification, type or if (recording) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
    else startForeground(472, notification)
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      "stop" -> { stopSelf(); return START_NOT_STICKY }
      "show" -> unhide()
      else -> {
        val size = intent?.getIntExtra("size", 64) ?: 64
        scale = size.coerceIn(48, 88) / 64f
        if (root == null) createWindow() else render()
      }
    }
    InsertionService.instance?.refreshTyping()
    updateVisibility()
    emit?.invoke("onStatusChange", emptyMap())
    return START_NOT_STICKY
  }
  override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); place() }

  // Visibility -------------------------------------------------------------------------------

  /** Called by the accessibility service when a text box gains or loses focus, or the keyboard moves. */
  fun onTyping(value: Boolean, top: Int?) {
    typing = value; keyboardTop = top
    if (state == BubbleState.READY && !dragging) place()
    updateVisibility()
  }
  fun updateVisibility() {
    val busy = state != BubbleState.READY || stopping
    if (appVisible && !practiceVisible) {
      if (state == BubbleState.LISTENING) finish(true)
      if (state == BubbleState.PROCESSING) { emit?.invoke("onCancel", emptyMap()); setState(BubbleState.READY) }
      if (state == BubbleState.RETRY || state == BubbleState.RECOVER) setState(BubbleState.READY)
    }
    val visible = BubblePolicy.visible(appVisible, practiceVisible, InsertionService.instance != null, typing, hidden, busy)
    if (!visible && dragging) endDrag()
    root?.visibility = if (visible) View.VISIBLE else View.GONE
  }
  fun leavePractice() {
    if (state == BubbleState.LISTENING) finish(true)
    if (state == BubbleState.PROCESSING) { emit?.invoke("onCancel", emptyMap()); setState(BubbleState.READY) }
  }
  /** Opening OpenWhispr brings a hidden bubble back. */
  fun unhide() {
    if (hiddenUntil == 0L) return
    hiddenUntil = 0L; preferences.edit().remove("hiddenUntil").apply()
    handler.removeCallbacks(unhide)
    foreground(state == BubbleState.LISTENING)
    updateVisibility()
  }
  private fun hideForAnHour() {
    hiddenUntil = System.currentTimeMillis() + BubblePolicy.HIDE_FOR_MS
    preferences.edit().putLong("hiddenUntil", hiddenUntil).apply()
    handler.removeCallbacks(unhide); handler.postDelayed(unhide, BubblePolicy.HIDE_FOR_MS)
    foreground(false)
    place()
    updateVisibility()
  }

  // Layout -----------------------------------------------------------------------------------

  private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)
  private fun px(value: Float) = (dp(value) * scale).toInt()
  private val shadowRoom get() = dp(14f).toInt()
  private val edge get() = dp(12f).toInt()
  private val size get() = px(56f)
  private fun screen(): Pair<Int, Int> =
    if (Build.VERSION.SDK_INT >= 30) windows.currentWindowMetrics.bounds.let { it.width() to it.height() }
    else resources.displayMetrics.let { it.widthPixels to it.heightPixels }

  private fun createWindow() {
    val view = BubbleRoot(this).apply {
      setPadding(shadowRoom, shadowRoom, shadowRoom, shadowRoom); clipToPadding = false; clipChildren = false
      startsGesture = { state == BubbleState.READY && !stopping }
      gesture = ::onGesture
    }
    val params = WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.START }
    createTarget()
    root = view; layout = params
    render()
    windows.addView(view, params)
  }

  /** Puts the current state's content in the window and moves it so its outer edge stays put. */
  private fun render() {
    val view = root ?: return
    view.removeAllViews(); waveform = null
    // The round bubble has a fixed size; a plain View asked to wrap its content would fill the window.
    val width = if (state == BubbleState.READY) size else FrameLayout.LayoutParams.WRAP_CONTENT
    view.addView(content(state), FrameLayout.LayoutParams(width, size))
    place()
  }
  private fun place() {
    val view = root ?: return
    val params = layout ?: return
    snap?.cancel()
    val (width, height) = screen()
    view.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    val visibleWidth = view.measuredWidth - 2 * shadowRoom
    params.x = if (dockRight) width - edge - visibleWidth - shadowRoom else edge - shadowRoom
    params.y = BubblePolicy.bubbleTop(savedTop, keyboardTop, height, size, dp(16f).toInt(), dp(48f).toInt()) - shadowRoom
    if (view.isAttachedToWindow) windows.updateViewLayout(view, params)
  }

  private fun label(text: Int, color: Int) = TextView(this).apply {
    setText(text); typeface = font; setTextColor(color); setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f * scale)
    maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.CENTER_VERTICAL
  }
  private fun button(glyph: GlyphButton.Glyph, fill: Int, tint: Int, description: Int, action: () -> Unit) =
    GlyphButton(this, glyph, fill, tint).apply { contentDescription = getString(description); setOnClickListener { action() } }

  private fun pill(background: Int, vararg parts: Pair<View, Int>): View = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
    this.background = GradientDrawable().apply { setColor(background); cornerRadius = size / 2f }
    elevation = dp(8f)
    val inset = px(8f)
    setPadding(inset, 0, inset, 0)
    parts.forEachIndexed { index, (child, width) ->
      addView(child, LinearLayout.LayoutParams(width, if (child is TextView) LinearLayout.LayoutParams.MATCH_PARENT else width).apply {
        if (index > 0) marginStart = px(8f)
      })
    }
  }

  private fun content(value: BubbleState): View {
    val round = px(40f)
    return when (value) {
      BubbleState.READY -> IconBubble(this).apply {
        contentDescription = getString(R.string.ow_bubble_talk); elevation = dp(8f)
      }
      BubbleState.LISTENING -> {
        val wave = WaveformView(this).also { waveform = it }
        val parts = listOf(
          button(GlyphButton.Glyph.CLOSE, BubbleColors.fill, BubbleColors.ink, R.string.ow_bubble_cancel) { finish(true) } to round,
          wave to px(48f),
          button(GlyphButton.Glyph.STOP, BubbleColors.accent, Color.WHITE, R.string.ow_bubble_stop) { finish(false) } to round,
        )
        // The stop button sits where the bubble was, so it grows away from the edge it is docked to.
        pill(BubbleColors.surface, *(if (dockRight) parts else parts.reversed()).toTypedArray()).also {
          (wave.layoutParams as LinearLayout.LayoutParams).height = px(24f)
        }
      }
      BubbleState.PROCESSING -> pill(BubbleColors.surface,
        SpinnerView(this) to px(20f),
        label(R.string.ow_bubble_writing, BubbleColors.ink).apply { setPadding(0, 0, px(8f), 0) } to LinearLayout.LayoutParams.WRAP_CONTENT,
      ).apply { contentDescription = getString(R.string.ow_bubble_writing) }
      BubbleState.RETRY -> pill(BubbleColors.errorBackground,
        label(R.string.ow_bubble_failed, BubbleColors.error).apply { setPadding(px(8f), 0, 0, 0) } to LinearLayout.LayoutParams.WRAP_CONTENT,
        button(GlyphButton.Glyph.RETRY, BubbleColors.surface, BubbleColors.ink, R.string.ow_bubble_retry) { retry() } to px(36f),
        button(GlyphButton.Glyph.CLOSE, BubbleColors.surface, BubbleColors.ink, R.string.ow_bubble_dismiss) { dismiss() } to px(36f),
      )
      BubbleState.RECOVER -> pill(BubbleColors.surface,
        label(R.string.ow_bubble_saved, BubbleColors.accent).apply {
          setPadding(px(8f), 0, px(4f), 0); contentDescription = getString(R.string.ow_bubble_open)
          isClickable = true; setOnClickListener { openResult() }
        } to LinearLayout.LayoutParams.WRAP_CONTENT,
        button(GlyphButton.Glyph.CLOSE, BubbleColors.fill, BubbleColors.ink, R.string.ow_bubble_dismiss) { dismiss() } to px(36f),
      )
    }
  }

  private fun setState(value: BubbleState) {
    handler.removeCallbacks(dismissError)
    if (value == BubbleState.RETRY || value == BubbleState.RECOVER) handler.postDelayed(dismissError, ERROR_TIMEOUT_MS)
    if (value != state) {
      state = value; render()
      val announcement = when (value) {
        BubbleState.LISTENING -> R.string.ow_bubble_listening
        BubbleState.PROCESSING -> R.string.ow_bubble_writing
        BubbleState.RETRY -> R.string.ow_bubble_failed
        BubbleState.RECOVER -> R.string.ow_bubble_saved
        BubbleState.READY -> null
      }
      announcement?.let { root?.announceForAccessibility(getString(it)) }
    }
    updateVisibility()
  }

  // Gestures ---------------------------------------------------------------------------------

  private var downX = 0f; private var downY = 0f; private var startX = 0; private var startY = 0
  private var moved = false
  private val hold = Runnable { if (!moved && state == BubbleState.READY && !stopping) { held = true; begin() } }

  private fun onGesture(event: MotionEvent) {
    val params = layout ?: return
    val view = root ?: return
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.rawX; downY = event.rawY; startX = params.x; startY = params.y
        moved = false; held = false; snap?.cancel()
        handler.postDelayed(hold, 300)
      }
      MotionEvent.ACTION_MOVE -> {
        if (!moved && !held && abs(event.rawX - downX) + abs(event.rawY - downY) > dp(12f)) {
          moved = true; handler.removeCallbacks(hold); startDrag()
        }
        if (moved) {
          val (width, height) = screen()
          params.x = (startX + event.rawX - downX).toInt().coerceIn(-shadowRoom, width - view.width + shadowRoom)
          params.y = (startY + event.rawY - downY).toInt().coerceIn(-shadowRoom, height - view.height + shadowRoom)
          windows.updateViewLayout(view, params)
          targetCircle?.active = overTarget()
        }
      }
      MotionEvent.ACTION_UP -> {
        handler.removeCallbacks(hold)
        when {
          moved -> { val hide = overTarget(); endDrag(); if (hide) hideForAnHour() else settle() }
          held -> finish(false)
          else -> { view.performClick(); begin() }
        }
        held = false
      }
      MotionEvent.ACTION_CANCEL -> {
        handler.removeCallbacks(hold)
        if (moved) { endDrag(); place() }
        if (held) finish(true)
        held = false
      }
    }
  }
  private fun bubbleCenter(): Pair<Float, Float> {
    val params = layout!!
    return (params.x + shadowRoom + size / 2f) to (params.y + shadowRoom + size / 2f)
  }
  private fun targetCenter(): Pair<Float, Float> {
    val (width, height) = screen()
    return width / 2f to height - dp(150f)
  }
  private fun overTarget(): Boolean {
    val (bx, by) = bubbleCenter(); val (tx, ty) = targetCenter()
    return BubblePolicy.overTarget(bx, by, tx, ty, dp(64f))
  }
  /** The bubble settles on the nearest edge and remembers where it was left. */
  private fun settle() {
    val params = layout ?: return
    val view = root ?: return
    val (width, height) = screen()
    dockRight = BubblePolicy.dockRight(bubbleCenter().first, width)
    savedTop = (params.y + shadowRoom).coerceIn(0, height - size)
    preferences.edit().putBoolean("dockRight", dockRight).putInt("top", savedTop!!).apply()
    val destination = if (dockRight) width - edge - size - shadowRoom else edge - shadowRoom
    snap = ValueAnimator.ofInt(params.x, destination).apply {
      duration = 180
      addUpdateListener { params.x = it.animatedValue as Int; if (view.isAttachedToWindow) windows.updateViewLayout(view, params) }
      start()
    }
  }
  /** Added before the bubble's window so a dragged bubble stays drawn above it. */
  private fun createTarget() {
    val circle = HideTargetView(this)
    val caption = TextView(this).apply {
      setText(R.string.ow_bubble_hide_target); typeface = font; setTextColor(BubbleColors.ink)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f); gravity = Gravity.CENTER
      val pad = dp(10f).toInt(); setPadding(pad, dp(4f).toInt(), pad, dp(4f).toInt())
      background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(12f) }
      elevation = dp(2f)
    }
    val holder = FrameLayout(this).apply {
      clipChildren = false; visibility = View.GONE
      val column = LinearLayout(this@DictationService).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; clipChildren = false
        val pad = dp(12f).toInt(); setPadding(0, pad, 0, pad)
        addView(circle, LinearLayout.LayoutParams(dp(64f).toInt(), dp(64f).toInt()))
        addView(caption, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f).toInt() })
      }
      addView(column, FrameLayout.LayoutParams(dp(200f).toInt(), FrameLayout.LayoutParams.WRAP_CONTENT))
    }
    val params = WindowManager.LayoutParams(dp(200f).toInt(), WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT).apply {
      gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; y = (targetCenter().second - dp(44f)).toInt()
    }
    windows.addView(holder, params); target = holder; targetCircle = circle; targetLayout = params
  }
  private fun startDrag() {
    dragging = true
    val holder = target ?: return
    val params = targetLayout ?: return
    params.y = (targetCenter().second - dp(44f)).toInt()
    runCatching { windows.updateViewLayout(holder, params) }
    targetCircle?.active = false
    holder.alpha = 0f; holder.visibility = View.VISIBLE; holder.animate().alpha(1f).setDuration(150).start()
  }
  private fun endDrag() {
    dragging = false
    target?.visibility = View.GONE
  }

  // Dictation --------------------------------------------------------------------------------

  private fun begin() {
    if (state != BubbleState.READY || stopping) return
    retryKept = false
    try {
      check(emit != null) { "Open OpenWhispr before dictating." }
      val selected = InsertionService.instance?.captureTarget().orEmpty()
      foreground(true)
      recorder = WavRecorder(this).also { recording ->
        recording.onLevel = { level -> handler.post { waveform?.setLevel(level) } }
        recording.start()
      }
      setState(BubbleState.LISTENING)
      emit?.invoke("onStart", mapOf("selection" to selected, "mode" to "dictate"))
      handler.postDelayed(maximumRecording, 300000)
    } catch (error: Exception) {
      recorder?.close(); recorder = null; foreground(false)
      emit?.invoke("onError", mapOf("message" to (error.message ?: "Microphone could not start.")))
      setState(BubbleState.RETRY)
    }
  }
  private fun finish(cancel: Boolean) {
    if (state != BubbleState.LISTENING) return
    handler.removeCallbacks(maximumRecording); held = false
    val active = recorder; recorder = null
    stopping = true
    setState(if (cancel) BubbleState.READY else BubbleState.PROCESSING)
    Thread {
      try {
        val result = active?.stop(cancel)
        handler.post {
          stopping = false; foreground(false)
          if (cancel || result == null) { InsertionService.instance?.clearTarget(); emit?.invoke("onCancel", emptyMap()) }
          else emit?.invoke("onRecording", result)
          updateVisibility()
        }
      } catch (error: Exception) {
        handler.post {
          stopping = false; foreground(false); setState(BubbleState.RETRY)
          emit?.invoke("onError", mapOf("message" to (error.message ?: "Recording failed.")))
        }
      } finally { active?.close() }
    }.start()
  }
  /** Retry reprocesses the recording OpenWhispr kept when there is one, otherwise it listens again. */
  private fun retry() {
    if (state != BubbleState.RETRY) return
    if (retryKept && emit != null) {
      retryKept = false
      val selected = InsertionService.instance?.captureTarget().orEmpty()
      setState(BubbleState.PROCESSING)
      emit?.invoke("onRetry", mapOf("selection" to selected))
    } else { setState(BubbleState.READY); begin() }
  }
  private fun dismiss() {
    if (state != BubbleState.RETRY && state != BubbleState.RECOVER) return
    retryKept = false
    InsertionService.instance?.clearTarget()
    emit?.invoke("onDismiss", emptyMap())
    setState(BubbleState.READY)
  }
  private fun openResult() {
    emit?.invoke("onOpenResult", emptyMap())
    packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    setState(BubbleState.READY)
  }
  /** Set by the app: processing, success, retry (nothing kept), retry-kept (recording kept) or recover (text kept in the app). */
  fun status(value: String) {
    if (state == BubbleState.LISTENING) return
    retryKept = value == "retry-kept"
    setState(when (value) {
      "processing" -> BubbleState.PROCESSING
      "retry", "retry-kept", "error" -> BubbleState.RETRY
      "recover" -> BubbleState.RECOVER
      else -> BubbleState.READY
    })
  }
  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null); snap?.cancel(); recorder?.close(); recorder = null
    target?.let { runCatching { windows.removeView(it) } }; target = null; targetCircle = null
    root?.let { runCatching { windows.removeView(it) } }; root = null; waveform = null
    InsertionService.instance?.clearTarget(); emit?.invoke("onCancel", emptyMap())
    instance = null; emit?.invoke("onStatusChange", emptyMap()); super.onDestroy()
  }
}
