package com.openwhispr.dictation

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * Keeps the floating bubble on across app updates, phone restarts and launches. The user's choice
 * and bubble size live in the bubble's preferences, so the bubble can come back without the app.
 */
object BubbleRestore {
  private const val TAG = "OpenWhisprBubble"
  private const val WANTED = "wanted"
  private const val SIZE = "size"

  /** Whether the running bubble was started without the app on screen (a restart or an update). */
  @Volatile private var startedInBackground = false

  fun remember(context: Context, enabled: Boolean, size: Int) {
    preferences(context).edit().putBoolean(WANTED, enabled).putInt(SIZE, size).apply()
  }

  /**
   * Starts the bubble when the user left it on and Android still lets it run. From the app, a
   * bubble started in the background is started again, so it runs as started by the app. Returns
   * whether a start was sent.
   */
  fun restore(context: Context, fromApp: Boolean): Boolean {
    val preferences = preferences(context)
    val running = DictationService.instance != null
    if (running && (!fromApp || !startedInBackground)) return false
    val start = BubblePolicy.shouldRestore(
      wanted = preferences.getBoolean(WANTED, false),
      sdk = Build.VERSION.SDK_INT,
      overlay = Settings.canDrawOverlays(context),
      microphone = context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
    )
    if (!start) return false
    return try {
      val size = BubblePolicy.restoredSize(preferences.getInt(SIZE, BubblePolicy.DEFAULT_SIZE))
      context.startForegroundService(Intent(context, DictationService::class.java).putExtra("size", size))
      startedInBackground = !fromApp
      true
    } catch (error: RuntimeException) {
      // Android 12+ refuses some background starts (ForegroundServiceStartNotAllowedException). The
      // choice stays saved, so the bubble comes back the next time OpenWhispr opens.
      Log.w(TAG, "Bubble restore was refused", error)
      false
    }
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(DictationService.PREFERENCES, Context.MODE_PRIVATE)
}

/** Brings the bubble back after an app update or a phone restart. */
class BubbleRestoreReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    BubbleRestore.restore(context.applicationContext, fromApp = false)
  }
}
