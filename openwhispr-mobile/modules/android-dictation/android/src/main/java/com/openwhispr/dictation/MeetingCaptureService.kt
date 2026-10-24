package com.openwhispr.dictation

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.*
import android.util.Base64
import java.io.File

/** Foreground capture. Local Mode never emits PCM frames to streaming consumers. */
class MeetingCaptureService : Service() {
  companion object {
    var instance: MeetingCaptureService? = null; private set
    var pendingStart: ((Exception?) -> Unit)? = null
    internal var pendingRoute: MeetingCaptureRoute? = null
    var pendingToken: String? = null
    fun finishStart(error: Exception?) {
      val callback = pendingStart
      pendingStart = null; pendingRoute = null; pendingToken = null
      callback?.invoke(error)
    }
  }
  internal var route: MeetingCaptureRoute? = null; private set
  private var captureToken: String? = null
  private var recorder: WavRecorder? = null
  private val handler = Handler(Looper.getMainLooper())
  override fun onBind(intent: Intent?) = null
  @Synchronized override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "stop") {
      if (intent.getStringExtra("captureToken") != captureToken || captureToken == null) {
        if (recorder == null && pendingStart == null) stopSelf()
        return START_NOT_STICKY
      }
      Thread {
        runCatching { stopCapture() }
          .onSuccess { route?.let { DictationService.emit?.invoke(it.stopEvent, eventIdentity()) } }
          .onFailure { error -> emitError(error) }
        stopSelf()
      }.start()
      return START_NOT_STICKY
    }
    // An intent queued before cancellation must not claim a newer pending request.
    if (pendingStart == null || intent?.getStringExtra("captureToken") != pendingToken) {
      if (recorder == null && pendingStart == null) stopSelf()
      return START_NOT_STICKY
    }
    if (recorder != null) { finishStart(IllegalStateException("A recording is already active.")); return START_NOT_STICKY }
    val captureRoute = requireNotNull(pendingRoute)
    route = captureRoute
    captureToken = pendingToken
    instance = this
    try {
      val sampleRate = intent?.getIntExtra("sampleRate", 24000) ?: 24000
      require(sampleRate == 24000) { "Meetings require 24 kHz audio." }
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel("meeting", getString(R.string.ow_bubble_recording), NotificationManager.IMPORTANCE_LOW))
      val stopIntent = Intent(this, MeetingCaptureService::class.java).setAction("stop")
        .setData(android.net.Uri.parse("openwhispr://meeting-stop/$captureToken"))
        .putExtra("captureToken", captureToken)
      val stop = PendingIntent.getService(this, 0, stopIntent, PendingIntent.FLAG_IMMUTABLE)
      val launch = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
      val notification = Notification.Builder(this, "meeting").setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle(getString(R.string.ow_bubble_recording)).setContentText(getString(R.string.ow_meeting_notice))
        .setContentIntent(launch).setOngoing(true).addAction(Notification.Action.Builder(null, getString(R.string.ow_meeting_stop), stop).build()).build()
      if (Build.VERSION.SDK_INT >= 29) startForeground(473, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) else startForeground(473, notification)
      val noteId = captureRoute.noteId
      val directory = if (captureRoute.recordingDirectory.isEmpty()) filesDir else File(filesDir, captureRoute.recordingDirectory)
      check(directory.isDirectory || directory.mkdirs()) { "Unable to open meeting audio storage." }
      val destination = File(directory, if (noteId > 0) "meeting-$noteId.wav" else "meeting-capture-${System.currentTimeMillis()}.wav")
      var frameNumber = 0
      recorder = WavRecorder(this, sampleRate, destination, captureRoute.maximumSeconds,
        onFrame = captureRoute.frameListener { bytes, timestamp -> DictationService.emit?.invoke("pcm-frame", mapOf("audio" to Base64.encodeToString(bytes, Base64.NO_WRAP), "frameNumber" to frameNumber++, "timestampMs" to timestamp)) },
        onFailure = { error -> handler.post {
          emitError(error)
          Thread { runCatching { stopCapture() }; stopSelf() }.start()
        } })
      recorder!!.start()
      finishStart(null)
    } catch (error: Exception) {
      finishStart(error)
      recorder?.close(); recorder = null; stopSelf()
    }
    return START_NOT_STICKY
  }
  private fun eventIdentity(): Map<String, Any> =
    route?.takeIf { it.localOnly }?.let { mapOf("noteId" to it.noteId, "captureId" to requireNotNull(it.captureId)) } ?: emptyMap()
  private fun emitError(error: Throwable) {
    route?.let { DictationService.emit?.invoke(it.errorEvent,
      eventIdentity() + ("message" to (error.message ?: getString(R.string.ow_meeting_stopped)))) }
  }
  @Synchronized fun stopCapture() {
    val active = recorder ?: return
    recorder = null
    try { active.stop(false) } finally { active.close(); stopForeground(STOP_FOREGROUND_REMOVE) }
  }
  override fun onDestroy() {
    instance = null
    Thread { runCatching { stopCapture() } }.start()
    finishStart(IllegalStateException("Recording interrupted."))
    super.onDestroy()
  }
}
