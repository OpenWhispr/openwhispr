package com.openwhispr.dictation

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.*
import android.util.Base64
import java.io.File

/** Explicitly started, foreground microphone capture. Audio remains local until JS sends frames. */
class MeetingCaptureService : Service() {
  companion object {
    var instance: MeetingCaptureService? = null; private set
    var pendingStart: ((Exception?) -> Unit)? = null
    var lastUri: String? = null; private set
  }
  private var recorder: WavRecorder? = null
  private val handler = Handler(Looper.getMainLooper())
  override fun onBind(intent: Intent?) = null
  @Synchronized override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "stop") {
      Thread {
        runCatching { stopCapture() }
          .onSuccess { DictationService.emit?.invoke("pcm-stopped", emptyMap()) }
          .onFailure { error -> DictationService.emit?.invoke("pcm-error", mapOf("message" to (error.message ?: getString(R.string.ow_meeting_stopped)))) }
        stopSelf()
      }.start()
      return START_NOT_STICKY
    }
    if (pendingStart == null) { stopSelf(); return START_NOT_STICKY }
    if (recorder != null) { pendingStart?.invoke(IllegalStateException("A recording is already active.")); pendingStart = null; return START_NOT_STICKY }
    instance = this
    try {
      val sampleRate = intent?.getIntExtra("sampleRate", 24000) ?: 24000
      require(sampleRate == 24000) { "Meetings require 24 kHz audio." }
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel("meeting", getString(R.string.ow_bubble_recording), NotificationManager.IMPORTANCE_LOW))
      val stop = PendingIntent.getService(this, 0, Intent(this, MeetingCaptureService::class.java).setAction("stop"), PendingIntent.FLAG_IMMUTABLE)
      val launch = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
      val notification = Notification.Builder(this, "meeting").setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle(getString(R.string.ow_bubble_recording)).setContentText(getString(R.string.ow_meeting_notice))
        .setContentIntent(launch).setOngoing(true).addAction(Notification.Action.Builder(null, getString(R.string.ow_meeting_stop), stop).build()).build()
      if (Build.VERSION.SDK_INT >= 29) startForeground(473, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) else startForeground(473, notification)
      val noteId = intent?.getIntExtra("noteId", 0) ?: 0
      val destination = File(filesDir, if (noteId > 0) "meeting-$noteId.wav" else "meeting-capture-${System.currentTimeMillis()}.wav")
      lastUri = "file://${destination.absolutePath}"
      getSharedPreferences("meeting-capture", MODE_PRIVATE).edit().putString("lastUri", lastUri).apply()
      var frameNumber = 0
      recorder = WavRecorder(this, sampleRate, destination, 7200,
        onFrame = { bytes, timestamp -> DictationService.emit?.invoke("pcm-frame", mapOf("audio" to Base64.encodeToString(bytes, Base64.NO_WRAP), "frameNumber" to frameNumber++, "timestampMs" to timestamp)) },
        onFailure = { error -> handler.post {
          DictationService.emit?.invoke("pcm-error", mapOf("message" to (error.message ?: getString(R.string.ow_meeting_stopped))))
          Thread { runCatching { stopCapture() }; stopSelf() }.start()
        } })
      recorder!!.start()
      pendingStart?.invoke(null); pendingStart = null
    } catch (error: Exception) {
      pendingStart?.invoke(error); pendingStart = null
      recorder?.close(); recorder = null; stopSelf()
    }
    return START_NOT_STICKY
  }
  @Synchronized fun stopCapture() {
    val active = recorder ?: return
    recorder = null
    try { active.stop(false) } finally { active.close(); stopForeground(STOP_FOREGROUND_REMOVE) }
  }
  override fun onDestroy() {
    instance = null
    Thread { runCatching { stopCapture() } }.start()
    pendingStart?.invoke(IllegalStateException("Recording interrupted.")); pendingStart = null
    super.onDestroy()
  }
}
