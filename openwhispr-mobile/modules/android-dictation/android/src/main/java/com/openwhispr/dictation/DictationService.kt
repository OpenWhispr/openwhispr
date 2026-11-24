package com.openwhispr.dictation

import android.animation.ValueAnimator
import android.app.*
import android.content.Intent
import android.net.Uri
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.*
import android.provider.Settings
import android.util.TypedValue
import android.view.*
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import kotlin.math.abs

/**
 * The floating dictation bubble (Variant 1 with Variant 3's hold menu). A tap dictates: listening and
 * writing happen inside the bubble's own circle, and the words are pasted at the caret. Holding the
 * bubble opens a menu (Assistant, Translate, Edit selection) drawn in the bubble's own window, which
 * never takes focus, so the text box keeps its caret and selection. Anything the bubble has to say
 * shows in a separate status tab beside it.
 */
class DictationService : Service() {
  companion object {
    var instance: DictationService? = null; private set
    var emit: ((String, Map<String, Any>) -> Unit)? = null
    /** Whether one of OpenWhispr's own screens is in front. A process restarted without one has none. */
    var appVisible = false
    var practiceVisible = false
    const val PREFERENCES = "bubble"
    /** How often the listening bubble hears the microphone's level. */
    const val LEVEL_WINDOW_MS = 20

    fun readAppearance(preferences: android.content.SharedPreferences) = BubbleAppearance(
      size = preferences.getInt("size", 64), opacity = preferences.getFloat("opacity", 0.8f),
      shrinkWhenIdle = preferences.getBoolean("shrinkWhenIdle", true), shrinkToDot = preferences.getBoolean("shrinkToDot", false),
      shrinkInSearch = preferences.getBoolean("shrinkInSearch", false))
    fun writeAppearance(preferences: android.content.SharedPreferences, value: BubbleAppearance) {
      preferences.edit().putInt("size", value.size).putFloat("opacity", value.alpha).putBoolean("shrinkWhenIdle", value.shrinkWhenIdle)
        .putBoolean("shrinkToDot", value.shrinkToDot).putBoolean("shrinkInSearch", value.shrinkInSearch).apply()
    }
  }
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var windows: WindowManager
  private val preferences by lazy { getSharedPreferences(PREFERENCES, MODE_PRIVATE) }
  private val font by lazy { runCatching { resources.getFont(R.font.ow_space_grotesk_medium) }.getOrDefault(Typeface.DEFAULT) }
  private val regular by lazy { runCatching { resources.getFont(R.font.ow_space_grotesk_regular) }.getOrDefault(Typeface.DEFAULT) }
  private val tab by lazy { StatusTab(this, windows, font) }
  private val toast by lazy { BottomToast(this, windows, font) }

  private var root: BubbleRoot? = null
  /** Dictionary's C11: "Learned “Synty”" · Undo, sliding out from behind the bubble. */
  private var learnedTab: LearnedTab? = null
  private var layout: WindowManager.LayoutParams? = null
  private var face: BubbleFace? = null
  private var cancelButton: GlyphButton? = null
  private var menu: HoldMenuView? = null
  private var column: LinearLayout? = null
  private var builtForRight: Boolean? = null
  private var target: FrameLayout? = null
  private var targetCircle: HideTargetView? = null
  private var targetLayout: WindowManager.LayoutParams? = null
  private var snap: ValueAnimator? = null
  private var appearance = BubbleAppearance()
  private val scale get() = appearance.scale
  /** 0 is full size, 1 fully shrunk; only the Ready bubble shrinks. */
  private var shrink = 0f
  private var shrinking: ValueAnimator? = null
  private var idle = false
  private var touched = false
  private var searchField = false
  private var focusedField: Int? = null

  private var state = BubbleState.READY
  private var mode = BubbleMode.DICTATE
  private var recorder: WavRecorder? = null
  private var stopping = false
  private var dragging = false
  private var retryKept = false
  /** Saved text the user hasn't opened yet: a glass dot on the bubble. */
  private var unseen = false
  private var typing = false
  private var keyboardTop: Int? = null
  private var dockRight = true
  private var savedTop: Int? = null
  private var hiddenUntil = 0L
  private val hidden get() = System.currentTimeMillis() < hiddenUntil

  private val maximumRecording = Runnable { if (state == BubbleState.LISTENING) finish(false) }
  private val unhide = Runnable { unhide() }
  private val idleShrink = Runnable { idle = true; updateShrink() }
  private val stillWriting = Runnable { if (state == BubbleState.PROCESSING) showTab(StatusMessage.STILL_WRITING) }
  /** The tick has eased back to the icon: only now may the Ready bubble shrink (Josh, 20 Nov). */
  private val settleDone = Runnable { if (state == BubbleState.READY) { face?.show(BubbleFace.Look.ICON); updateShrink() } }
  /** Events waiting for the JS pipeline, which may still be starting when a dictation ends. */
  private val pending = BubbleEventQueue()
  private val pipelineTimeout = Runnable {
    if (HeadlessPipeline.ready || !pending.holdsRecording) return@Runnable
    pending.park(); retryKept = true; fail(StatusMessage.FAILED)
  }
  private val screens = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityResumed(activity: Activity) { appVisible = true; updateVisibility() }
    override fun onActivityPaused(activity: Activity) { appVisible = false; updateVisibility() }
    override fun onActivityCreated(activity: Activity, state: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
  }

  override fun onBind(intent: Intent?) = null
  override fun onCreate() {
    super.onCreate(); instance = this
    BubbleColors.read(resources.configuration)
    shownConfig = Configuration(resources.configuration)
    application.registerActivityLifecycleCallbacks(screens)
    windows = getSystemService(WINDOW_SERVICE) as WindowManager
    dockRight = preferences.getBoolean("dockRight", true)
    savedTop = preferences.getInt("top", -1).takeIf { it >= 0 }
    hiddenUntil = preferences.getLong("hiddenUntil", 0L)
    appearance = readAppearance(preferences)
    tab.opacity = BubblePolicy.tabAlpha(appearance.alpha)
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
        // setEnabled's size wins over a stored one and is kept, so a restart comes back the same.
        val stored = readAppearance(preferences)
        appearance = if (intent?.hasExtra("size") == true) stored.copy(size = BubblePolicy.restoredSize(intent.getIntExtra("size", BubblePolicy.DEFAULT_SIZE))).also { writeAppearance(preferences, it) } else stored
        tab.opacity = BubblePolicy.tabAlpha(appearance.alpha)
        if (root == null) createWindow() else render()
        wake()
      }
    }
    InsertionService.instance?.refreshTyping()
    updateVisibility()
    emit?.invoke("onStatusChange", emptyMap())
    return START_NOT_STICKY
  }
  /** The configuration the overlays were last laid out for. */
  private var shownConfig: Configuration? = null
  /** When the last light/dark switch landed (uptime), so the keyboard's redraw doesn't close the menu. */
  private var themeSwitchedAt: Long? = null
  private val recheckKeyboard = Runnable { InsertionService.instance?.refreshTyping() ?: onTyping(false, null) }
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    val changes = shownConfig?.diff(newConfig) ?: -1
    shownConfig = Configuration(newConfig)
    // Light ↔ dark (K7, §3b): repaint in place. The windows, the open menu, the tabs, the bubble's
    // place and state and the recording all stay as they are.
    if (BubbleColors.follow(newConfig)) themeSwitchedAt = SystemClock.uptimeMillis()
    val layout = ActivityInfo.CONFIG_ORIENTATION or ActivityInfo.CONFIG_SCREEN_SIZE or ActivityInfo.CONFIG_SCREEN_LAYOUT or
      ActivityInfo.CONFIG_SMALLEST_SCREEN_SIZE or ActivityInfo.CONFIG_DENSITY or ActivityInfo.CONFIG_FONT_SCALE
    if (changes and layout == 0) return
    closeMenu(); place()
  }

  // Visibility -------------------------------------------------------------------------------

  /** Called by the accessibility service when a text box gains or loses focus, or the keyboard moves. */
  fun onTyping(value: Boolean, top: Int?, field: Int? = null, search: Boolean = false) {
    // Focusing a field (another one, or one after none) wakes a shrunk bubble; typing in it doesn't.
    val focused = value && (!typing || field != focusedField)
    // Back closes the keyboard (or leaves the field): the menu closes with it. The menu's window
    // never takes focus, so this is how Back reaches it.
    val changed = value != typing || top != keyboardTop || field != focusedField
    val sinceSwitch = themeSwitchedAt?.let { SystemClock.uptimeMillis() - it }
    // The keyboard restarting after a light/dark switch reports itself gone for a moment: with the
    // menu open (a finger may be on it), wait out the settle time and look again before acting.
    if (menu != null && BubbleMenuPolicy.holdsKeyboardLoss(typing, value, sinceSwitch)) {
      android.util.Log.i("OpenWhisprBubble", "Keyboard gone ${sinceSwitch} ms after a theme switch with the menu open: checking again")
      handler.removeCallbacks(recheckKeyboard)
      handler.postDelayed(recheckKeyboard, BubbleMenuPolicy.THEME_SETTLE_MS - (sinceSwitch ?: 0) + 50)
      return
    }
    // A light/dark switch redraws the keyboard and the app below; the menu (and the finger on it) stays.
    val keepMenu = menu != null && changed &&
      !BubbleMenuPolicy.keyboardClosesMenu(typing, value, top != keyboardTop, field != focusedField, sinceSwitch)
    if (menu != null && changed) android.util.Log.i(
      "OpenWhisprBubble",
      "Keyboard changed with the menu open (typing $typing→$value, top $keyboardTop→$top, " +
        "field ${if (field != focusedField) "changed" else "same"}, ${sinceSwitch ?: "-"} ms after a theme switch): " +
        if (keepMenu) "kept" else "closed",
    )
    if (menu != null && changed && !keepMenu) closeMenu()
    typing = value; keyboardTop = top; focusedField = if (value) field else null; searchField = value && search
    // The menu kept open stays where the finger is; closing it places the bubble again.
    if (state == BubbleState.READY && !dragging && !keepMenu) place()
    if (focused) wake() else updateShrink()
    updateVisibility()
    face?.warning = InsertionService.instance == null
    if (focused) showHint()
  }

  // First-time hint ----------------------------------------------------------------------------

  private var hint: String? = null
  /**
   * The first three times the bubble appears for a text box, a chip slides out once: "Tap to dictate ·
   * Hold for more". It tucks back after 3 s or at the first touch, and stops for good once the menu has
   * been opened.
   */
  private fun showHint() {
    val shown = preferences.getInt("hintShown", 0)
    if (!BubbleMenuPolicy.showsHint(preferences.getString("holdAction", null), preferences.getBoolean("menuUsed", false), shown)) return
    if (state != BubbleState.READY || root?.visibility != View.VISIBLE || tab.showing || dragging) return
    preferences.edit().putInt("hintShown", shown + 1).apply()
    val words = getString(R.string.ow_bubble_hint)
    hint = words
    // Laid out first, so the tab sits beside the bubble where it settled for this field.
    handler.post {
      if (hint != words || state != BubbleState.READY) return@post
      tab.show(TabMessage(words, plain = true, holdMs = BubbleMenuPolicy.HINT_HOLD_MS), bubbleRect(), dockRight) { hint = null }
    }
  }
  private fun hideHint() {
    val words = hint ?: return
    hint = null
    if (tab.currentLabel == words) tab.hide()
  }
  fun updateVisibility() {
    val busy = state != BubbleState.READY || stopping
    if (appVisible && !practiceVisible) {
      closeMenu()
      if (state == BubbleState.LISTENING) finish(true)
      if (state == BubbleState.PROCESSING) { deliver("onCancel"); setState(BubbleState.READY) }
      // Dismiss, so a recording the bubble parked for Retry is deleted rather than left behind.
      if (state == BubbleState.RETRY) dismiss()
      if (state == BubbleState.RECOVER) setState(BubbleState.READY)
      // Home shows the saved text, so it has been seen.
      if (unseen) { unseen = false; face?.unseen = false }
      tab.hide(false)
    }
    val visible = BubblePolicy.visible(appVisible, practiceVisible, InsertionService.instance != null, typing, hidden, busy)
    if (!visible && dragging) endDrag()
    if (!visible) { closeMenu(); if (tab.showing) tab.hide(false); learnedTab?.hide(false) }
    root?.visibility = if (visible) View.VISIBLE else View.GONE
  }
  fun leavePractice() {
    closeMenu()
    if (state == BubbleState.LISTENING) finish(true)
    if (state == BubbleState.PROCESSING) { deliver("onCancel"); setState(BubbleState.READY) }
  }
  /** Opening OpenWhispr brings a hidden bubble back. */
  fun unhide() {
    if (hiddenUntil == 0L) return
    hiddenUntil = 0L; preferences.edit().remove("hiddenUntil").apply()
    handler.removeCallbacks(unhide)
    foreground(state == BubbleState.LISTENING)
    updateVisibility()
  }
  private fun hideForAWhile() {
    hiddenUntil = System.currentTimeMillis() + BubblePolicy.HIDE_FOR_MS
    preferences.edit().putLong("hiddenUntil", hiddenUntil).apply()
    handler.removeCallbacks(unhide); handler.postDelayed(unhide, BubblePolicy.HIDE_FOR_MS)
    foreground(false)
    place()
    updateVisibility()
    // A mistaken drop costs nothing: Undo brings it straight back.
    toast.show(getString(R.string.ow_bubble_hidden_toast), getString(R.string.ow_bubble_undo), toastBottom()) { unhide(); wake() }
  }

  // Appearance -------------------------------------------------------------------------------

  /** Applies Settings › Size & look to the running bubble without recreating its window. */
  fun applyAppearance(value: BubbleAppearance) {
    val resized = value.scale != appearance.scale || value.shrinkToDot != appearance.shrinkToDot
    appearance = value
    tab.opacity = BubblePolicy.tabAlpha(value.alpha)
    if (resized) render() else applyAlpha()
    wake()
  }
  /** Brings a shrunk bubble back to full size and restarts the idle countdown. */
  private fun wake(animate: Boolean = true) {
    idle = false
    handler.removeCallbacks(idleShrink)
    if (appearance.shrinkWhenIdle && state == BubbleState.READY) handler.postDelayed(idleShrink, BubblePolicy.IDLE_SHRINK_MS)
    updateShrink(animate)
  }
  /** ValueAnimator follows the system animator scale, so "Remove animations" makes this a jump. */
  private fun updateShrink(animate: Boolean = true) {
    // Listening, writing and the tick are one dictation, all at full size: no shrinking until the tick settles.
    val settling = face?.look == BubbleFace.Look.DONE
    val goal = if (BubblePolicy.shrunk(state == BubbleState.READY && !touched && menu == null && !settling, idle, appearance.shrinkWhenIdle, searchField, appearance.shrinkInSearch)) 1f else 0f
    shrinking?.cancel(); shrinking = null
    if (shrink == goal) return
    if (!animate || root?.isShown != true) { shrink = goal; resizeFace(); return }
    shrinking = ValueAnimator.ofFloat(shrink, goal).apply {
      duration = 240; interpolator = BubbleMotion.emphasizedDecelerate
      addUpdateListener { shrink = it.animatedValue as Float; resizeFace() }
      start()
    }
  }
  private fun resizeFace() {
    val bubble = face ?: return
    bubble.dot = if (appearance.shrinkToDot) shrink else 0f
    bubble.layoutParams = bubble.layoutParams.apply { width = shown; height = shown }
    if (!dragging) place()
  }

  // Layout -----------------------------------------------------------------------------------

  private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)
  private fun px(value: Float) = (dp(value) * scale).toInt()
  private val shadowRoom get() = dp(14f).toInt()
  private val edge get() = dp(12f).toInt()
  private val size get() = px(56f)
  private val shrunkSize get() = if (appearance.shrinkToDot) dp(16f).toInt() else px(34f)
  /** The bubble's visible diameter: smaller while the Ready bubble is shrunk. */
  private val shown get() = if (state == BubbleState.READY) (size + (shrunkSize - size) * shrink).toInt() else size
  private fun screen(): Pair<Int, Int> =
    if (Build.VERSION.SDK_INT >= 30) windows.currentWindowMetrics.bounds.let { it.width() to it.height() }
    else resources.displayMetrics.let { it.widthPixels to it.heightPixels }

  private fun createWindow() {
    val view = BubbleRoot(this).apply {
      setPadding(shadowRoom, shadowRoom, shadowRoom, shadowRoom); clipToPadding = false; clipChildren = false
      startsGesture = { event -> canStartGesture() || startsOnCancel(event) }
      gesture = ::onGesture
      outside = { closeMenu() }
    }
    // FLAG_WATCH_OUTSIDE_TOUCH: a tap elsewhere closes the menu and still reaches the app below.
    val params = WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
      PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.START }.withoutMoveAnimation()
    createTarget()
    // Added before the bubble, so the tab slides out from underneath it.
    learnedTab = LearnedTab(this, windows, font,
      onUndo = { words -> emit?.invoke("onLearnedUndo", mapOf("words" to words)) },
      onRedo = { words -> emit?.invoke("onLearnedRedo", mapOf("words" to words)) },
      onOpen = ::openDictionary).also { it.create() }
    root = view; layout = params
    render()
    windows.addView(view, params)
  }

  /**
   * Builds the window's content once per docked side: the menu (when open) above the bubble, and the
   * listening ✕ on the bubble's inner side. The bubble view itself survives every state change, so its
   * glass, bars, dots and ✓ animate rather than cut.
   */
  private fun render() {
    val view = root ?: return
    val bubble = face ?: BubbleFace(this).apply {
      elevation = dp(8f)
      setOnClickListener { if (state == BubbleState.LISTENING) finish(false) }
    }.also { face = it }
    val cancel = cancelButton ?: GlyphButton(this, GlyphButton.Glyph.CLOSE, { BubbleColors.surface }, { BubbleColors.ink }).apply {
      contentDescription = getString(R.string.ow_bubble_cancel); elevation = dp(4f)
      setOnClickListener { finish(true) }
    }.also { cancelButton = it }
    if (builtForRight != dockRight || column == null) {
      view.removeAllViews()
      (bubble.parent as? ViewGroup)?.removeView(bubble); (cancel.parent as? ViewGroup)?.removeView(cancel)
      val row = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; clipChildren = false; clipToPadding = false
      }
      // The ✕ sits on the side facing the middle of the screen.
      // 32 dp, 10 dp from the bubble (Josh, 20 Nov); it grows to 36 dp under the thumb.
      val cancelParams = LinearLayout.LayoutParams(px(32f), px(32f))
      if (dockRight) {
        row.addView(cancel, cancelParams.apply { marginEnd = px(10f) }); row.addView(bubble, LinearLayout.LayoutParams(shown, shown))
      } else {
        row.addView(bubble, LinearLayout.LayoutParams(shown, shown)); row.addView(cancel, cancelParams.apply { marginStart = px(10f) })
      }
      column = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; clipChildren = false; clipToPadding = false
        gravity = if (dockRight) Gravity.END else Gravity.START
        addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
      }
      view.addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))
      builtForRight = dockRight
    }
    if (state != BubbleState.READY) { shrinking?.cancel(); shrink = 0f }
    bubble.layoutParams = bubble.layoutParams.apply { width = shown; height = shown }
    bubble.dot = if (appearance.shrinkToDot) shrink else 0f
    cancel.visibility = if (state == BubbleState.LISTENING) View.VISIBLE else View.GONE
    cancel.ringDiameter = px(48f).toFloat()
    if (state != BubbleState.LISTENING) { cancelTouch = false; cancel.clearSelection() }
    bubble.contentDescription = getString(if (state == BubbleState.LISTENING) R.string.ow_bubble_stop else R.string.ow_bubble_talk)
    applyAlpha()
    place()
  }
  /** Size & look's see-through, in every state; its open menu at least 85 %. */
  private fun applyAlpha() { root?.alpha = BubblePolicy.windowAlpha(appearance.alpha, menu != null) }

  private fun place() {
    val view = root ?: return
    val params = layout ?: return
    snap?.cancel()
    val (width, height) = screen()
    view.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    val visibleWidth = view.measuredWidth - 2 * shadowRoom
    params.x = if (dockRight) width - edge - visibleWidth - shadowRoom else edge - shadowRoom
    // A shrunk bubble keeps the full bubble's centre, so it grows back in place. An open menu sits
    // above it, so the window grows upward and the bubble stays put.
    val above = menuAboveHeight()
    params.y = BubblePolicy.bubbleTop(savedTop, keyboardTop, height, size, dp(16f).toInt(), dp(48f).toInt()) - shadowRoom + (size - shown) / 2 - above
    if (view.isAttachedToWindow) windows.updateViewLayout(view, params)
    tab.follow(bubbleRect(), dockRight)
    learnedTab?.follow(bubbleRect(), dockRight)
  }

  /**
   * Shows the learned tab beside the Ready bubble while it is on screen. A bubble shrunk to a dot
   * first gives one ring pulse, so the eye finds it. Returns whether it showed.
   */
  fun showLearnedTab(text: LearnedTabText): Boolean {
    val learned = learnedTab ?: return false
    // Never over a status tab or an open menu: the bubble's own message comes first.
    if (state != BubbleState.READY || root?.isShown != true || dragging || tab.showing || menu != null) {
      android.util.Log.i("OpenWhisprLearn", "Learned pill not shown: state=$state shown=${root?.isShown} dragging=$dragging")
      return false
    }
    android.util.Log.i("OpenWhisprLearn", "Learned pill shown (${text.words.size} words)")
    val dot = appearance.shrinkToDot && shrink >= 1f
    if (dot && !learned.showing) {
      face?.pulse { learned.show(text, bubbleRect(), dockRight, true) }
    } else learned.show(text, bubbleRect(), dockRight, dot)
    return true
  }
  private fun openDictionary() {
    emit?.invoke("onOpenDictionary", emptyMap())
    packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
  }
  private fun menuAboveHeight(): Int {
    val open = menu ?: return 0
    if (open.measuredHeight == 0) open.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
    return open.measuredHeight + dp(8f).toInt()
  }
  /** The bubble's visible circle on screen, which the status tab sits beside. */
  private fun bubbleRect(): Rect {
    val params = layout ?: return Rect()
    val (width, height) = screen()
    val top = BubblePolicy.bubbleTop(savedTop, keyboardTop, height, size, dp(16f).toInt(), dp(48f).toInt()) + (size - shown) / 2
    val left = if (dockRight) width - edge - shown else edge
    return if (dragging) Rect(params.x + shadowRoom, params.y + shadowRoom, params.x + shadowRoom + shown, params.y + shadowRoom + shown)
    else Rect(left, top, left + shown, top + shown)
  }
  /** Where the bottom toast's lower edge sits: just above the keyboard, or near the bottom of the screen. */
  private fun toastBottom(): Int {
    val (_, height) = screen()
    return (keyboardTop ?: (height - dp(72f).toInt())) - dp(16f).toInt()
  }

  private fun setState(value: BubbleState) {
    handler.removeCallbacks(stillWriting)
    if (value == state) { updateVisibility(); syncPipeline(); return }
    val previous = state
    // A new dictation takes the bubble's place; the learned tab goes at once.
    if (value != BubbleState.READY) learnedTab?.hide(false)
    state = value
    if (value != BubbleState.PROCESSING && tab.showing && previous == BubbleState.PROCESSING && !offering(value)) tab.hide()
    when (value) {
      BubbleState.LISTENING -> { tab.hide(); face?.badge = mode; face?.show(BubbleFace.Look.LISTENING); popCancel() }
      BubbleState.PROCESSING -> {
        face?.badge = mode; face?.show(BubbleFace.Look.WRITING)
        handler.postDelayed(stillWriting, BubbleMenuPolicy.STILL_WRITING_AFTER_MS)
      }
      BubbleState.READY, BubbleState.RETRY, BubbleState.RECOVER -> if (face?.look != BubbleFace.Look.DONE) { face?.badge = BubbleMode.DICTATE; face?.show(BubbleFace.Look.ICON) }
    }
    render(); wake()
    val announcement = when (value) {
      BubbleState.LISTENING -> R.string.ow_bubble_listening
      BubbleState.PROCESSING -> R.string.ow_bubble_writing
      else -> null
    }
    announcement?.let { root?.announceForAccessibility(getString(it)) }
    updateVisibility(); syncPipeline()
  }
  private fun offering(value: BubbleState) = value == BubbleState.RETRY || value == BubbleState.RECOVER
  /** The ✕ pops out on the inner side: scale 0.6 → 1, a short spring, 160 ms after the tap. */
  private fun popCancel() {
    val cancel = cancelButton ?: return
    cancel.scaleX = 0.6f; cancel.scaleY = 0.6f; cancel.alpha = 0f
    cancel.animate().scaleX(1f).scaleY(1f).alpha(1f).setStartDelay(160).setDuration(200)
      .setInterpolator(android.view.animation.OvershootInterpolator(1.4f)).start()
  }

  // Status tab -------------------------------------------------------------------------------

  private fun showTab(message: StatusMessage) {
    val (label, action) = words(message)
    val run: (() -> Unit)? = if (action == null) null else ({ act(message) })
    tab.show(TabMessage(label, action, run, onLabel = if (message == StatusMessage.SAVED) run else null,
      leaves = message != StatusMessage.STILL_WRITING, holdMs = BubbleMenuPolicy.holdFor(message)),
      bubbleRect(), dockRight) { tabGone(message) }
  }
  private fun words(message: StatusMessage): Pair<String, String?> = when (message) {
    StatusMessage.STILL_WRITING -> getString(R.string.ow_status_still_writing) to null
    StatusMessage.SAVED -> getString(R.string.ow_status_saved) to getString(R.string.ow_status_open)
    StatusMessage.NO_SPEECH -> getString(R.string.ow_status_no_speech) to getString(R.string.ow_bubble_retry)
    StatusMessage.OFFLINE -> getString(R.string.ow_status_offline) to getString(R.string.ow_status_retry)
    StatusMessage.OUT_OF_WORDS -> getString(R.string.ow_status_out_of_words) to getString(R.string.ow_status_see_plans)
    StatusMessage.MIC_OFF -> getString(R.string.ow_status_mic_off) to getString(R.string.ow_status_allow)
    StatusMessage.COPIED -> getString(R.string.ow_status_copied) to getString(R.string.ow_status_turn_on_typing)
    StatusMessage.SIGN_IN -> getString(R.string.ow_status_signed_out) to getString(R.string.ow_status_sign_in)
    StatusMessage.MODEL_NEEDED -> getString(R.string.ow_status_model_needed) to getString(R.string.ow_status_download)
    StatusMessage.FAILED -> getString(R.string.ow_status_failed) to getString(R.string.ow_bubble_retry)
  }
  private fun act(message: StatusMessage) {
    when (message) {
      StatusMessage.STILL_WRITING -> Unit
      StatusMessage.SAVED -> openResult()
      // Nothing worth sending again: listen again at once, in the same mode.
      StatusMessage.NO_SPEECH -> { val again = mode; tab.hide(); dismiss(); begin(again) }
      StatusMessage.OFFLINE, StatusMessage.FAILED -> { tab.hide(); retry() }
      StatusMessage.OUT_OF_WORDS -> { tab.hide(); dismiss(); openApp("onOpenPlans") }
      StatusMessage.SIGN_IN -> { tab.hide(); dismiss(); openApp("onOpenSignIn") }
      StatusMessage.MODEL_NEEDED -> { tab.hide(); dismiss(); openApp("onOpenModels") }
      StatusMessage.MIC_OFF -> {
        tab.hide(); dismiss()
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      StatusMessage.COPIED -> {
        tab.hide(); dismiss()
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
      }
    }
  }
  /** The tab left by itself: a failed take's offer goes with it; saved text keeps its dot. */
  private fun tabGone(message: StatusMessage) {
    if (message == StatusMessage.STILL_WRITING) return
    if (state == BubbleState.RETRY) dismiss()
    else if (state == BubbleState.RECOVER) setState(BubbleState.READY)
  }
  private fun openApp(event: String) {
    emit?.invoke(event, emptyMap())
    packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
  }

  /** Errors get a short shake and two ticks, never red; then the tab says what happened. */
  private fun fail(message: StatusMessage) {
    setState(BubbleState.RETRY)
    face?.shake(dp(4f))
    face?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    handler.postDelayed({ face?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) }, 90)
    // The tab slides out once the shake has started (board D: 200 ms in).
    handler.postDelayed({ if (state == BubbleState.RETRY) showTab(message) }, 200)
  }

  // Gestures ---------------------------------------------------------------------------------

  private var downX = 0f; private var downY = 0f; private var startX = 0; private var startY = 0
  private var moved = false
  /** The menu opened during this touch, so lifting on a row picks it. */
  private var menuThisTouch = false
  /** A touch that started on an open menu or its bubble. */
  private var menuTouch = false
  private val holdForMenu = Runnable {
    if (moved || stopping || !canStartGesture()) return@Runnable
    menuThisTouch = true
    openMenu()
  }
  /** With the Assistant off, a hold is hold-to-talk: it records while held and pastes on release. */
  private var talking = false
  private val holdToTalk = Runnable {
    if (moved || stopping || !canStartGesture()) return@Runnable
    face?.let { release(it) }
    face?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    tapToDictate()
    talking = state == BubbleState.LISTENING
  }

  private fun canStartGesture() =
    !stopping && (state == BubbleState.READY || state == BubbleState.RETRY || state == BubbleState.RECOVER)

  /** A touch that started on the listening ✕ (tap mode): it grows under the finger and cancels on a lift there. */
  private var cancelTouch = false
  private fun startsOnCancel(event: MotionEvent) =
    state == BubbleState.LISTENING && !stopping && event.actionMasked == MotionEvent.ACTION_DOWN && overCancel(event)
  /** Whether the finger is on the ✕'s 48 dp target, which is wider than the 32 dp ✕ it draws. */
  private fun overCancel(event: MotionEvent): Boolean {
    val cancel = cancelButton ?: return false
    if (state != BubbleState.LISTENING || !cancel.isShown) return false
    val at = IntArray(2); cancel.getLocationOnScreen(at)
    // getLocationOnScreen maps through the pop's scale, which pivots on the centre.
    val cx = at[0] + cancel.width * cancel.scaleX / 2f; val cy = at[1] + cancel.height * cancel.scaleY / 2f
    return BubblePolicy.overCancel(event.rawX, event.rawY, cx, cy, dp(24f), onBubble(event))
  }
  private fun onCancelGesture(event: MotionEvent) {
    val cancel = cancelButton
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> cancel?.underFinger = true
      MotionEvent.ACTION_MOVE -> cancel?.underFinger = overCancel(event)
      MotionEvent.ACTION_UP -> {
        cancelTouch = false
        // Lifting on the ✕ cancels, as its tap always did; sliding off first keeps recording.
        if (overCancel(event)) { cancel?.performClick() } else cancel?.underFinger = false
      }
      MotionEvent.ACTION_CANCEL -> { cancelTouch = false; cancel?.underFinger = false }
    }
  }

  private fun onGesture(event: MotionEvent) {
    val params = layout ?: return
    val view = root ?: return
    val bubble = face ?: return
    val open = menu
    if (event.actionMasked == MotionEvent.ACTION_DOWN) cancelTouch = startsOnCancel(event)
    if (cancelTouch) { onCancelGesture(event); return }
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.rawX; downY = event.rawY; startX = params.x; startY = params.y
        moved = false; menuThisTouch = false; snap?.cancel()
        menuTouch = open != null
        hideHint()
        if (open != null) { open.highlighted = open.rowAtScreen(event.rawX, event.rawY); return }
        // A touch brings a shrunk bubble straight back, so the drag and the tap work on the full bubble.
        touched = true; wake(animate = false); handler.removeCallbacks(idleShrink)
        bubble.animate().scaleX(0.94f).scaleY(0.94f).setDuration(80).setInterpolator(BubbleMotion.easeOut).start()
        talking = false
        val holdAction = preferences.getString("holdAction", null)
        if (BubbleMenuPolicy.holdOpensMenu(holdAction)) {
          bubble.holdRing(true)
          handler.postDelayed(holdForMenu, BubbleMenuPolicy.HOLD_MS)
        } else handler.postDelayed(holdToTalk, BubbleMenuPolicy.TALK_HOLD_MS)
      }
      MotionEvent.ACTION_MOVE -> {
        if (open != null) { open.highlighted = open.rowAtScreen(event.rawX, event.rawY); return }
        // A finger that drifts while talking keeps talking and the bubble stays where it is; on the ✕
        // it grows, ready to cancel.
        if (talking) { cancelButton?.underFinger = overCancel(event); return }
        if (!moved && abs(event.rawX - downX) + abs(event.rawY - downY) > dp(12f)) {
          moved = true; handler.removeCallbacks(holdForMenu); handler.removeCallbacks(holdToTalk)
          bubble.holdRing(false); release(bubble); startDrag()
        }
        if (moved) {
          val (width, height) = screen()
          params.x = (startX + event.rawX - downX).toInt().coerceIn(-shadowRoom, width - view.width + shadowRoom)
          params.y = (startY + event.rawY - downY).toInt().coerceIn(-shadowRoom, height - view.height + shadowRoom)
          windows.updateViewLayout(view, params)
          targetCircle?.active = overTarget()
          tab.follow(bubbleRect(), dockRight)
        }
      }
      MotionEvent.ACTION_UP -> {
        handler.removeCallbacks(holdForMenu); handler.removeCallbacks(holdToTalk); touched = false
        // Released on the ✕: the take is thrown away. Anywhere else pastes.
        if (talking) { talking = false; finish(overCancel(event)); return }
        if (open != null) {
          val row = open.rowAtScreen(event.rawX, event.rawY)
          when {
            row != null -> pick(row)
            // Lifting where the menu opened leaves it open, to tap a row; a tap on the bubble closes it.
            menuThisTouch -> open.highlighted = null
            menuTouch && onBubble(event) -> closeMenu()
            else -> open.highlighted = null
          }
          menuThisTouch = false; menuTouch = false
          return
        }
        bubble.holdRing(false); release(bubble)
        when {
          // A settled bubble starts counting down once it reaches the edge.
          moved -> { val hide = overTarget(); endDrag(); if (hide) { hideForAWhile(); wake() } else settle() }
          // A tap dictates, starting on the lift.
          else -> { view.performClick(); bubble.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK); tapToDictate() }
        }
      }
      MotionEvent.ACTION_CANCEL -> {
        handler.removeCallbacks(holdForMenu); handler.removeCallbacks(holdToTalk); touched = false
        // The system took the touch: a hold-to-talk take is discarded, as before the menu.
        if (talking) { talking = false; finish(true) }
        bubble.holdRing(false); release(bubble)
        if (moved) { endDrag(); place() }
        menuThisTouch = false; menuTouch = false
        wake()
      }
    }
  }
  private fun release(bubble: View) {
    bubble.animate().scaleX(1f).scaleY(1f).setDuration(120).setInterpolator(BubbleMotion.standard).start()
  }
  private fun onBubble(event: MotionEvent): Boolean {
    val bubble = face ?: return false
    val at = IntArray(2); bubble.getLocationOnScreen(at)
    return event.rawX >= at[0] && event.rawX <= at[0] + bubble.width && event.rawY >= at[1] && event.rawY <= at[1] + bubble.height
  }
  /** A tap clears whatever the tab offered and dictates. */
  private fun tapToDictate() {
    if (state == BubbleState.RETRY) dismiss()
    else if (state == BubbleState.RECOVER) setState(BubbleState.READY)
    tab.hide()
    begin(BubbleMode.DICTATE)
  }

  // Hold menu --------------------------------------------------------------------------------

  private fun openMenu() {
    val holder = column ?: return
    val bubble = face ?: return
    bubble.holdRing(false)
    bubble.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    preferences.edit().putBoolean("menuUsed", true).apply()
    hideHint()
    if (state == BubbleState.RETRY) dismiss() else if (state == BubbleState.RECOVER) setState(BubbleState.READY)
    tab.hide()
    val selected = InsertionService.instance?.hasSelection() == true
    val block = AssistantBlock.fromWire(preferences.getString("assistantBlock", null))
    val target = BubbleMenuPolicy.translateTarget(preferences.getString("translateTarget", null))
    val copy = MenuCopy(
      title = { getString(when (it) {
        BubbleMode.ASSISTANT -> R.string.ow_menu_assistant
        BubbleMode.TRANSLATE -> R.string.ow_menu_translate
        else -> R.string.ow_menu_edit
      }) },
      subtitle = { when (it) {
        BubbleMode.ASSISTANT -> getString(R.string.ow_menu_assistant_body)
        BubbleMode.TRANSLATE -> getString(R.string.ow_menu_translate_body, target)
        else -> getString(R.string.ow_menu_edit_body)
      } },
      blockedReason = getString(if (block == AssistantBlock.SIGN_IN) R.string.ow_menu_sign_in_to_use else R.string.ow_menu_unavailable),
    )
    val view = HoldMenuView(this, regular, font, BubbleMenuPolicy.rows(selected, block != null), copy, BubbleMenuPolicy.menuScale(scale))
    view.onPick = { pick(it) }
    menu = view
    holder.addView(view, 0, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8f).toInt() })
    // The menu follows Size & look's see-through like the bubble it opens from (Josh, 19 Nov), with
    // a floor so it stays readable (Josh, 20 Nov).
    applyAlpha()
    handler.removeCallbacks(idleShrink)
    place()
    view.grow(dockRight)
    root?.announceForAccessibility(getString(R.string.ow_menu_opened))
  }
  private fun closeMenu() {
    val open = menu ?: return
    menu = null
    (open.parent as? ViewGroup)?.removeView(open)
    applyAlpha()
    face?.let { release(it) }
    place(); wake()
  }
  private fun pick(index: Int) {
    val open = menu ?: return
    val row = open.rows.getOrNull(index) ?: return
    closeMenu()
    if (!row.enabled) {
      // The assistant isn't available: picking any of its rows opens the app (sign-in) instead of recording.
      val block = AssistantBlock.fromWire(preferences.getString("assistantBlock", null))
      openApp(if (block == AssistantBlock.SIGN_IN) "onOpenSignIn" else "onOpenModels")
      return
    }
    face?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    begin(row.mode)
  }

  // Dragging ---------------------------------------------------------------------------------

  private fun bubbleCenter(): Pair<Float, Float> {
    // Only the Ready bubble is dragged, with no menu or ✕ beside it, so the window is just the bubble.
    val params = layout!!
    return (params.x + shadowRoom + shown / 2f) to (params.y + shadowRoom + shown / 2f)
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
    val right = BubblePolicy.dockRight(bubbleCenter().first, width)
    savedTop = (params.y + shadowRoom).coerceIn(0, height - size)
    preferences.edit().putBoolean("dockRight", right).putInt("top", savedTop!!).apply()
    if (right != dockRight) { dockRight = right; render() }
    val destination = if (dockRight) width - edge - (view.measuredWidth - 2 * shadowRoom) - shadowRoom else edge - shadowRoom
    snap = ValueAnimator.ofInt(params.x, destination).apply {
      duration = 180
      addUpdateListener { params.x = it.animatedValue as Int; if (view.isAttachedToWindow) windows.updateViewLayout(view, params) }
      addListener(object : android.animation.AnimatorListenerAdapter() {
        private var cancelled = false
        override fun onAnimationCancel(animation: android.animation.Animator) { cancelled = true }
        override fun onAnimationEnd(animation: android.animation.Animator) { if (!cancelled) { tab.follow(bubbleRect(), dockRight); wake() } }
      })
      start()
    }
  }
  /** Added before the bubble's window so a dragged bubble stays drawn above it. */
  private fun createTarget() {
    val circle = HideTargetView(this)
    val caption = TextView(this).apply {
      setText(R.string.ow_bubble_hide_target); typeface = font
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f); gravity = Gravity.CENTER
      val pad = dp(10f).toInt(); setPadding(pad, dp(4f).toInt(), pad, dp(4f).toInt())
      BubbleColors.themed(this) {
        setTextColor(BubbleColors.ink)
        background = GradientDrawable().apply { setColor(BubbleColors.surface); cornerRadius = dp(12f); setStroke(dp(1f).toInt().coerceAtLeast(1), BubbleColors.hairline) }
      }
      elevation = dp(2f)
    }
    val holder = FrameLayout(this).apply {
      clipChildren = false; visibility = View.GONE
      val column = LinearLayout(this@DictationService).apply {
        // The circle grows under the bubble, into this padding, so the padding must not clip it.
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; clipChildren = false; clipToPadding = false
        val pad = dp(12f).toInt(); setPadding(0, pad, 0, pad)
        addView(circle, LinearLayout.LayoutParams(dp(64f).toInt(), dp(64f).toInt()))
        addView(caption, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f).toInt() })
      }
      addView(column, FrameLayout.LayoutParams(dp(200f).toInt(), FrameLayout.LayoutParams.WRAP_CONTENT))
    }
    // Not FLAG_NOT_TOUCHABLE: Android caps such overlays at 80% opacity, which left the target see-through over
    // the keyboard. It takes no touches anyway: it has no size while hidden and only shows during a drag, whose
    // touches stay with the bubble's window.
    val params = WindowManager.LayoutParams(dp(200f).toInt(), WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT).apply {
      gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; y = (targetCenter().second - dp(44f)).toInt()
    }
    windows.addView(holder, params); target = holder; targetCircle = circle; targetLayout = params
  }
  private fun startDrag() {
    dragging = true
    closeMenu()
    learnedTab?.hide(false)
    val holder = target ?: return
    val params = targetLayout ?: return
    params.y = (targetCenter().second - dp(44f)).toInt()
    runCatching { windows.updateViewLayout(holder, params) }
    targetCircle?.active = false
    // The target rises 24 dp and fades in.
    holder.alpha = 0f; holder.translationY = dp(24f); holder.visibility = View.VISIBLE
    holder.animate().alpha(1f).translationY(0f).setDuration(180).setInterpolator(BubbleMotion.emphasizedDecelerate).start()
  }
  private fun endDrag() {
    dragging = false
    target?.visibility = View.GONE
  }

  // Dictation --------------------------------------------------------------------------------

  private fun begin(next: BubbleMode) {
    if (state != BubbleState.READY || stopping) return
    retryKept = false
    if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      mode = next; fail(StatusMessage.MIC_OFF); return
    }
    try {
      val selected = InsertionService.instance?.captureTarget().orEmpty()
      mode = next
      foreground(true)
      // 20 ms reads, so the bars follow every syllable; the meter keeps them still for room noise.
      val meter = VoiceMeter(windowMs = LEVEL_WINDOW_MS)
      recorder = WavRecorder(this, readMillis = LEVEL_WINDOW_MS, measure = meter::level).also { recording ->
        recording.onLevel = { voice -> handler.post { face?.setLevel(voice) } }
        recording.start()
      }
      setState(BubbleState.LISTENING)
      deliver("onStart", mapOf("selection" to selected, "mode" to next.wire, "app" to targetApp()))
      handler.postDelayed(maximumRecording, 300000)
    } catch (error: Exception) {
      recorder?.close(); recorder = null; foreground(false)
      deliver("onError", mapOf("message" to (error.message ?: "Microphone could not start.")))
      fail(if (error is SecurityException) StatusMessage.MIC_OFF else StatusMessage.FAILED)
    }
  }
  private fun finish(cancel: Boolean) {
    if (state != BubbleState.LISTENING) return
    handler.removeCallbacks(maximumRecording)
    val active = recorder; recorder = null
    stopping = true
    if (cancel) mode = BubbleMode.DICTATE
    setState(if (cancel) BubbleState.READY else BubbleState.PROCESSING)
    Thread {
      try {
        val result = active?.stop(cancel)
        handler.post {
          stopping = false; foreground(false)
          if (cancel || result == null) { InsertionService.instance?.clearTarget(); deliver("onCancel") }
          else deliver("onRecording", result)
          updateVisibility(); syncPipeline()
        }
      } catch (error: Exception) {
        handler.post {
          stopping = false; foreground(false)
          deliver("onError", mapOf("message" to (error.message ?: "Recording failed.")))
          fail(StatusMessage.FAILED)
        }
      } finally { active?.close() }
    }.start()
  }
  /** Retry reprocesses the recording OpenWhispr kept when there is one, otherwise it listens again. */
  private fun retry() {
    if (state != BubbleState.RETRY) return
    if (pending.parked) {
      retryKept = false
      pending.retryHeld(InsertionService.instance?.captureTarget().orEmpty())
      setState(BubbleState.PROCESSING)
      if (HeadlessPipeline.ready && emit != null) pipelineReady()
      else handler.postDelayed(pipelineTimeout, BubblePolicy.PIPELINE_READY_TIMEOUT_MS)
    } else if (retryKept && HeadlessPipeline.ready && emit != null) {
      retryKept = false
      val selected = InsertionService.instance?.captureTarget().orEmpty()
      setState(BubbleState.PROCESSING)
      deliver("onRetry", mapOf("selection" to selected, "app" to targetApp()))
    } else { val again = mode; setState(BubbleState.READY); begin(again) }
  }
  /** The package of the app whose field was captured last, for Tone & Style. */
  private fun targetApp(): String = InsertionService.instance?.targetApp.orEmpty()
  private fun dismiss() {
    if (state != BubbleState.RETRY && state != BubbleState.RECOVER) return
    retryKept = false
    InsertionService.instance?.clearTarget()
    deliver("onDismiss")
    setState(BubbleState.READY)
  }
  private fun openResult() {
    unseen = false; face?.unseen = false
    tab.hide()
    emit?.invoke("onOpenResult", emptyMap())
    packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    setState(BubbleState.READY)
  }
  /**
   * Sends a bubble event to the JS pipeline, or holds it until the pipeline listens. A finished
   * recording that waits too long is parked behind Retry rather than inserted late.
   */
  private fun deliver(event: String, data: Map<String, Any> = emptyMap()) {
    val listening = HeadlessPipeline.ready && emit != null
    // A new dictation, cancel or dismiss replaces whatever waited, and with it the wait's timeout.
    if (event in setOf("onStart", "onRetry", "onCancel", "onDismiss")) handler.removeCallbacks(pipelineTimeout)
    val accepted = pending.accept(event, data, listening)
    accepted.emit.forEach { (name, payload) -> emit?.invoke(name, payload) }
    accepted.dropped.forEach { uri -> Uri.parse(uri).path?.let { File(it).delete() } }
    if (event == "onRecording" && accepted.emit.isEmpty())
      handler.postDelayed(pipelineTimeout, BubblePolicy.PIPELINE_READY_TIMEOUT_MS)
  }
  /** The JS pipeline listens: send whatever waited for it. */
  fun pipelineReady() {
    handler.removeCallbacks(pipelineTimeout)
    pending.ready().forEach { (name, payload) -> emit?.invoke(name, payload) }
  }
  /** JS timers run only while the pipeline's task runs, so it runs exactly while a dictation is in flight. */
  private fun syncPipeline() {
    if (BubblePolicy.keepsPipelineAwake(state, stopping)) HeadlessPipeline.start(this) else HeadlessPipeline.stop(this)
  }

  /**
   * Set by the app: processing; success (the ✓);
   * retry / retry-kept with the reason the tab names; recover (the text is kept in the app);
   * copied (typing access is off, the words are on the clipboard).
   */
  fun status(value: String, options: Map<String, Any?> = emptyMap()) {
    if (state == BubbleState.LISTENING) return
    retryKept = value == "retry-kept"
    when (value) {
      "processing" -> setState(BubbleState.PROCESSING)
      "success" -> succeed()
      "retry", "retry-kept", "error" -> fail(StatusMessage.fromWire(options["message"] as? String) ?: StatusMessage.FAILED)
      "recover", "copied" -> {
        setState(BubbleState.RECOVER)
        unseen = true; face?.unseen = true
        face?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        handler.postDelayed({ face?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) }, 90)
        showTab(if (value == "copied") StatusMessage.COPIED else StatusMessage.SAVED)
      }
      else -> setState(BubbleState.READY)
    }
  }
  /**
   * Paste first: the ✓ draws once the words are in the field, then the glass eases back to the icon.
   * Every mode ends this way; the menu modes show no toast (Josh, 19 Nov: they got in the way).
   */
  private fun succeed() {
    tab.hide()
    face?.show(BubbleFace.Look.DONE)
    face?.performHapticFeedback(HapticFeedbackConstants.CONFIRM.takeIf { Build.VERSION.SDK_INT >= 30 } ?: HapticFeedbackConstants.CLOCK_TICK)
    mode = BubbleMode.DICTATE
    setState(BubbleState.READY)
    handler.removeCallbacks(settleDone); handler.postDelayed(settleDone, 400)
  }
  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null); snap?.cancel(); shrinking?.cancel(); recorder?.close(); recorder = null
    tab.hide(false); toast.hide(false)
    target?.let { runCatching { windows.removeView(it) } }; target = null; targetCircle = null
    learnedTab?.destroy(); learnedTab = null
    root?.let { runCatching { windows.removeView(it) } }; root = null; face = null; menu = null; column = null; cancelButton = null
    InsertionService.instance?.clearTarget(); deliver("onCancel")
    application.unregisterActivityLifecycleCallbacks(screens); HeadlessPipeline.stop(this)
    instance = null; emit?.invoke("onStatusChange", emptyMap()); super.onDestroy()
  }
}
