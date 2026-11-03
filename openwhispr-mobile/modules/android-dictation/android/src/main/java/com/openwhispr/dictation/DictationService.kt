package com.openwhispr.dictation

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.*
import android.view.*
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs

class DictationService : Service() {
  companion object {
    var instance: DictationService? = null; private set
    var emit: ((String, Map<String, Any>) -> Unit)? = null
    var appVisible = true
    var practiceVisible = false
  }
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var windows: WindowManager
  private var panel: LinearLayout? = null
  private var label: TextView? = null
  private var actionMenu: LinearLayout? = null
  private var windowLayout: WindowManager.LayoutParams? = null
  private var collapsedWidth = 0
  private val preferences by lazy { getSharedPreferences("bubble", MODE_PRIVATE) }
  private var mode = "dictate"
  private var modeBeforePractice: String? = null
  private var recorder: WavRecorder? = null
  private var capturing = false
  private var processing = false
  private var held = false
  private var failed = false
  private val maximumRecording = Runnable { if (capturing) finish(false) }

  override fun onBind(intent: Intent?) = null
  override fun onCreate() {
    super.onCreate(); instance = this
    mode = preferences.getString("mode", "dictate") ?: "dictate"
    windows = getSystemService(WINDOW_SERVICE) as WindowManager
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(NotificationChannel("dictation", getString(R.string.ow_bubble_channel), NotificationManager.IMPORTANCE_LOW))
    foreground(false)
  }
  private fun foreground(recording: Boolean) {
    val launch = packageManager.getLaunchIntentForPackage(packageName)!!
    val pending = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification = Notification.Builder(this, "dictation")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(getString(if (recording) R.string.ow_bubble_recording else R.string.ow_bubble_ready))
      .setContentText(getString(R.string.ow_bubble_notice)).setContentIntent(pending).setOngoing(true).build()
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    if (Build.VERSION.SDK_INT >= 29) startForeground(472, notification, type or if (recording) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
    else startForeground(472, notification)
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "stop") { stopSelf(); return START_NOT_STICKY }
    val size = intent?.getIntExtra("size", 64) ?: 64
    if (panel == null) showBubble(size) else resize(size)
    updateVisibility()
    emit?.invoke("onStatusChange", emptyMap())
    return START_NOT_STICKY
  }
  fun updateVisibility() {
    val visible = !appVisible || practiceVisible
    if (!visible) {
      if (capturing) finish(true)
      if (processing) { emit?.invoke("onCancel", emptyMap()); status("ready") }
      showActions(false)
    }
    panel?.visibility = if (visible) View.VISIBLE else View.GONE
  }
  fun setPracticeMode(value: String) {
    if (capturing || processing) return
    if (value in listOf("dictate", "translate", "write", "edit")) {
      if (modeBeforePractice == null) modeBeforePractice = mode
      mode = value
      refreshOptions()
    }
  }
  fun leavePractice() {
    if (capturing) finish(true)
    if (processing) { emit?.invoke("onCancel", emptyMap()); status("ready") }
    mode = modeBeforePractice ?: mode
    modeBeforePractice = null
    refreshOptions()
  }
  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
  private fun resize(size: Int) {
    val height = dp(size.coerceIn(48, 88))
    val toolbar = panel?.getChildAt(0) as? LinearLayout ?: return
    for (i in 0 until toolbar.childCount) {
      val child = toolbar.getChildAt(i)
      child.layoutParams = LinearLayout.LayoutParams(if (i == 0) height else dp(44), height)
    }
    collapsedWidth = height + dp(88)
    showActions(actionMenu?.visibility == View.VISIBLE)
  }
  private fun copy(key: String, fallback: String) = preferences.getString(key, fallback) ?: fallback
  private fun showActions(visible: Boolean) {
    actionMenu?.visibility = if (visible) View.VISIBLE else View.GONE
    val layout = windowLayout ?: return
    layout.width = if (visible) maxOf(collapsedWidth, dp(240)) else collapsedWidth
    layout.x = layout.x.coerceIn(0, maxOf(0, resources.displayMetrics.widthPixels - layout.width))
    panel?.let { windows.updateViewLayout(it, layout) }
  }
  fun refreshOptions() {
    val menu = actionMenu ?: return
    menu.removeAllViews()
    listOf("dictate", "translate", "write", "edit").forEach { value ->
      val option = TextView(this).apply {
        text = (if (mode == value) "✓  " else "") + copy(value, value.replaceFirstChar { it.uppercase() })
        textSize = 15f; setTextColor(Color.WHITE); gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(16), 0, dp(16), 0)
        contentDescription = text
        setOnClickListener {
          mode = value; preferences.edit().putString("mode", value).apply()
          refreshOptions(); showActions(false)
        }
      }
      menu.addView(option, LinearLayout.LayoutParams(-1, dp(48)))
    }
  }
  private fun showBubble(size: Int) {
    val bubbleSize = dp(size.coerceIn(48, 88))
    val view = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
      background = GradientDrawable().apply { setColor(Color.rgb(29, 72, 166)); cornerRadius = dp(28).toFloat() }
      elevation = dp(8).toFloat()
    }
    val text = BrandButton(this).apply {
      this.text = ""; textSize = 28f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
      contentDescription = copy("hold", "OpenWhispr: tap or hold to dictate")
      setOnClickListener {
        if (failed) {
          emit?.invoke("onOpenResult", emptyMap())
          packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
          status("ready")
        } else if (capturing) finish(false) else if (!processing) begin()
      }
    }
    val toolbar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
    val actions = TextView(this).apply {
      this.text = "⋯"; textSize = 24f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
      contentDescription = copy("chooseAction", "Choose dictation action")
      setOnClickListener { if (!capturing && !processing) showActions(actionMenu?.visibility != View.VISIBLE) }
    }
    val cancel = TextView(this).apply {
      this.text = "×"; textSize = 24f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
      contentDescription = copy("cancelOrClose", "Cancel dictation or close the bubble")
      setOnClickListener {
        if (capturing) finish(true)
        else if (processing) {
          processing = false; InsertionService.instance?.clearTarget()
          emit?.invoke("onCancel", emptyMap()); status("ready")
        } else stopSelf()
      }
    }
    toolbar.addView(text, LinearLayout.LayoutParams(bubbleSize, bubbleSize))
    toolbar.addView(actions, LinearLayout.LayoutParams(dp(44), bubbleSize))
    toolbar.addView(cancel, LinearLayout.LayoutParams(dp(44), bubbleSize))
    view.addView(toolbar)
    actionMenu = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
    view.addView(actionMenu, LinearLayout.LayoutParams(-1, -2))
    collapsedWidth = bubbleSize + dp(88)
    val layout = WindowManager.LayoutParams(collapsedWidth, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT).apply {
      gravity = Gravity.TOP or Gravity.START; x = maxOf(0, resources.displayMetrics.widthPixels - collapsedWidth - dp(16)); y = dp(360)
    }
    var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var moved = false; var wasCapturing = false
    val hold = Runnable { if (!moved && !capturing && !processing) { held = true; begin() } }
    text.setOnTouchListener { _, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX; downY = event.rawY; startX = layout.x; startY = layout.y
          moved = false; held = false; wasCapturing = capturing
          handler.postDelayed(hold, 300)
        }
        MotionEvent.ACTION_MOVE -> {
          if (abs(event.rawX - downX) + abs(event.rawY - downY) > dp(12) && !held) {
            moved = true; handler.removeCallbacks(hold)
            layout.x = (startX + event.rawX - downX).toInt().coerceIn(0, maxOf(0, resources.displayMetrics.widthPixels - view.width))
            layout.y = (startY + event.rawY - downY).toInt().coerceIn(0, maxOf(0, resources.displayMetrics.heightPixels - view.height))
            windows.updateViewLayout(view, layout)
          }
        }
        MotionEvent.ACTION_UP -> {
          handler.removeCallbacks(hold)
          if (!moved) {
            if (held || wasCapturing) finish(false) else text.performClick()
          }
        }
        MotionEvent.ACTION_CANCEL -> { handler.removeCallbacks(hold); if (held && capturing) finish(true) }
      }
      true
    }
    windows.addView(view, layout); panel = view; label = text; windowLayout = layout
    refreshOptions()
  }
  private fun begin() {
    try {
      check(emit != null) { "Open OpenWhispr before dictating." }
      failed = false
      showActions(false)
      val selected = InsertionService.instance?.captureTarget().orEmpty()
      check(mode != "edit" || selected.isNotEmpty()) { copy("selectToEdit", "Select some text before using Edit.") }
      foreground(true)
      recorder = WavRecorder(this).also { it.start() }; capturing = true
      label?.text = "●"; emit?.invoke("onStart", mapOf("selection" to selected,
        "mode" to if (mode == "dictate" && selected.isNotEmpty()) "edit" else mode))
      handler.postDelayed(maximumRecording, 300000)
    } catch (error: Exception) {
      recorder?.close(); recorder = null; capturing = false; foreground(false)
      emit?.invoke("onError", mapOf("message" to (error.message ?: "Microphone could not start.")))
      status("error")
    }
  }
  private fun finish(cancel: Boolean) {
    if (!capturing) return
    capturing = false; handler.removeCallbacks(maximumRecording); processing = true
    label?.text = if (cancel) "" else "…"
    val active = recorder; recorder = null
    Thread {
      try {
        val result = active?.stop(cancel) ?: return@Thread
        handler.post {
          foreground(false)
          if (cancel) { InsertionService.instance?.clearTarget(); emit?.invoke("onCancel", emptyMap()); status("ready") }
          else emit?.invoke("onRecording", result)
        }
      } catch (error: Exception) {
        handler.post { foreground(false); status("error"); emit?.invoke("onError", mapOf("message" to (error.message ?: "Recording failed."))) }
      } finally { active?.close() }
    }.start()
  }
  fun status(value: String) {
    processing = value == "processing"
    failed = value == "error"
    label?.contentDescription = when(value) {
      "error" -> copy("recover", "Open OpenWhispr to recover your dictation")
      "processing" -> copy("processing", "Processing dictation")
      "success" -> copy("success", "Dictation inserted")
      else -> copy("hold", "OpenWhispr: tap or hold to dictate")
    }
    label?.text = when (value) { "processing" -> "…"; "error" -> "!"; "success" -> "✓"; else -> "" }
  }
  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null); recorder?.close(); recorder = null
    panel?.let { runCatching { windows.removeView(it) } }; panel = null; label = null
    InsertionService.instance?.clearTarget(); emit?.invoke("onCancel", emptyMap())
    instance = null; emit?.invoke("onStatusChange", emptyMap()); super.onDestroy()
  }
}
