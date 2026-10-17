package com.openwhispr.dictation

import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.os.Build
import android.os.StatFs
import android.app.ActivityManager
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

class AndroidDictationModule : Module() {
  private var recorder: WavRecorder? = null
  private val sampleDecodes = ConcurrentHashMap<String, AtomicBoolean>()
  private val providerRuntime = lazy { ProviderTransport(context) }
  private val speechRuntime = lazy { ParakeetEngine(context) }
  private val moonshineRuntime = lazy { MoonshineEngine(context) }
  private val providers by providerRuntime
  private val parakeet by speechRuntime
  private val moonshine by moonshineRuntime
  private val context get() = requireNotNull(appContext.reactContext)
  private fun localFile(uri: String): File {
    val file = File(Uri.parse(uri).path ?: error("Invalid file URI")).canonicalFile
    require(listOf(context.filesDir, context.cacheDir).any { file.path.startsWith(it.canonicalPath + "/") }) { "File is outside app storage." }
    return file
  }
  override fun definition() = ModuleDefinition {
    Name("AndroidDictation")
    Events("onStart", "onRecording", "onError", "onCancel", "onOpenResult", "onStatusChange", "pcm-frame", "pcm-error", "pcm-stopped")
    OnCreate { DictationService.emit = { event, data -> sendEvent(event, data) } }
    OnActivityEntersForeground {
      DictationService.appVisible = true
      DictationService.instance?.updateVisibility()
    }
    OnActivityEntersBackground {
      DictationService.appVisible = false
      DictationService.instance?.updateVisibility()
    }
    OnDestroy {
      sampleDecodes.values.forEach { it.set(true) }
      sampleDecodes.clear()
      appContext.reactContext?.let {
        it.stopService(Intent(it, DictationService::class.java))
        it.stopService(Intent(it, MeetingCaptureService::class.java))
      }
      if (providerRuntime.isInitialized()) providers.close()
      if (speechRuntime.isInitialized()) parakeet.close()
      if (moonshineRuntime.isInitialized()) moonshine.close()
      recorder?.close(); DictationService.emit = null
    }
    AsyncFunction("startPCM") { sampleRate: Int, noteId: Int?, promise: Promise ->
      check(MeetingCaptureService.instance == null && MeetingCaptureService.pendingStart == null) { "A meeting is already recording." }
      MeetingCaptureService.pendingStart = { error ->
        if (error == null) promise.resolve(null) else promise.reject("MICROPHONE", error.message, error)
      }
      try {
        context.startForegroundService(Intent(context, MeetingCaptureService::class.java).putExtra("sampleRate", sampleRate).putExtra("noteId", noteId ?: 0))
      } catch (error: Exception) { MeetingCaptureService.pendingStart = null; promise.reject("MICROPHONE", error.message, error) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopPCM") { promise: Promise ->
      MeetingCaptureService.pendingStart?.invoke(IllegalStateException("Recording cancelled."))
      MeetingCaptureService.pendingStart = null
      val service = MeetingCaptureService.instance
      Thread {
        try {
          service?.stopCapture()
          service?.stopSelf()
          promise.resolve(null)
        } catch (error: Exception) { promise.reject("MICROPHONE", error.message, error) }
      }.start()
    }.runOnQueue(Queues.MAIN)
    Function("isPCMRecording") { MeetingCaptureService.instance != null }
    Function("getPCMRecordingUri") { MeetingCaptureService.lastUri ?: context.getSharedPreferences("meeting-capture", android.content.Context.MODE_PRIVATE).getString("lastUri", null) }
    AsyncFunction("transcribeParakeet") { uri: String, modelDirectory: String, promise: Promise ->
      parakeet.transcribe(localFile(uri), localFile(modelDirectory), promise)
    }
    Function("cancelParakeet") { if (speechRuntime.isInitialized()) parakeet.cancel() }
    AsyncFunction("releaseParakeet") { promise: Promise ->
      if (speechRuntime.isInitialized()) parakeet.release(promise) else promise.resolve(null)
    }
    AsyncFunction("transcribeMoonshine") { uri: String, modelDirectory: String, model: String, promise: Promise ->
      check(android.os.Build.VERSION.SDK_INT >= 26) { "Moonshine requires Android 8 or newer." }
      moonshine.transcribe(localFile(uri), localFile(modelDirectory), model, promise)
    }
    Function("cancelMoonshine") { if (moonshineRuntime.isInitialized()) moonshine.cancel() }
    AsyncFunction("releaseMoonshine") { promise: Promise ->
      if (moonshineRuntime.isInitialized()) moonshine.release(promise) else promise.resolve(null)
    }
    AsyncFunction("requestProvider") { options: Map<String, Any?> -> providers.request(options) }
    Function("cancelProviderRequest") { id: String -> providers.cancel(id) }
    Function("getLocale") { context.resources.configuration.locales[0].toLanguageTag() }
    Function("getDeviceProfile") {
      val manager = context.getSystemService(ActivityManager::class.java)
      val memory = ActivityManager.MemoryInfo()
      manager.getMemoryInfo(memory)
      val power = context.getSystemService(PowerManager::class.java)
      mapOf(
        "manufacturer" to Build.MANUFACTURER, "model" to Build.MODEL,
        "androidVersion" to Build.VERSION.RELEASE, "apiLevel" to Build.VERSION.SDK_INT,
        "totalMemoryBytes" to memory.totalMem.toDouble(), "availableMemoryBytes" to memory.availMem.toDouble(),
        "lowMemory" to memory.lowMemory, "lowRamDevice" to manager.isLowRamDevice,
        "freeStorageBytes" to StatFs(context.filesDir.path).availableBytes.toDouble(),
        "cpuCores" to Runtime.getRuntime().availableProcessors(),
        "thermalStatus" to if (Build.VERSION.SDK_INT >= 29) power.currentThermalStatus else null,
        "emulator" to (Build.FINGERPRINT.startsWith("generic") || Build.MODEL.contains("sdk_gphone") || Build.HARDWARE in listOf("goldfish", "ranchu"))
      )
    }
    Function("getStatus") {
      mapOf("overlay" to Settings.canDrawOverlays(context), "accessibility" to (InsertionService.instance != null),
        "enabled" to (DictationService.instance != null),
        "microphone" to (context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED),
        "batteryExempt" to (context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)))
    }
    Function("openSettings") { kind: String ->
      val intent = when(kind) {
        "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
        "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
      }
      // Settings may already have another page above the requested activity.
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
    }
    Function("setEnabled") { enabled: Boolean, size: Int ->
      if (enabled) {
        check(android.os.Build.VERSION.SDK_INT >= 26) { "The floating bubble needs Android 8 or newer." }
        check(Settings.canDrawOverlays(context)) { "Allow display over other apps first." }
        context.startForegroundService(Intent(context, DictationService::class.java).putExtra("size", size))
      } else context.stopService(Intent(context, DictationService::class.java))
    }
    AsyncFunction("setPractice") { visible: Boolean, mode: String ->
      DictationService.practiceVisible = visible
      DictationService.instance?.let { service ->
        if (visible) service.setPracticeMode(mode) else service.leavePractice()
        service.updateVisibility()
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setStatus") { value: String -> DictationService.instance?.status(value) }.runOnQueue(Queues.MAIN)
    AsyncFunction("setBubbleOptions") { options: Map<String, String> ->
      val editor = context.getSharedPreferences("bubble", android.content.Context.MODE_PRIVATE).edit()
      options.forEach { (key, value) -> if (key != "mode") editor.putString(key, value) }
      editor.apply()
      DictationService.instance?.refreshOptions()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("insert") { text: String, promise: Promise ->
      val service = InsertionService.instance
      if (service == null) promise.resolve(false) else service.insert(text) { promise.resolve(it) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("startRecording") {
      check(recorder == null) { "A recording is already active." }
      val next = WavRecorder(context)
      try { next.start(); recorder = next } catch (error: Exception) { next.close(); throw error }
    }
    AsyncFunction("stopRecording") { cancel: Boolean ->
      val active = recorder ?: error("No recording is active.")
      try { active.stop(cancel) } finally { active.close(); recorder = null }
    }
    AsyncFunction("decodeAudio") { uri: String -> AudioDecoder.decode(context, localFile(uri)) }
    Function("prepareSampleDecode") {
      val id = UUID.randomUUID().toString()
      sampleDecodes[id] = AtomicBoolean(false)
      id
    }
    Function("cancelSampleDecode") { id: String -> sampleDecodes[id]?.set(true) }
    AsyncFunction("decodeSampleAudio") { uri: String, id: String ->
      val cancelled = requireNotNull(sampleDecodes[id]) { "Sample cancelled." }
      try {
        check(!cancelled.get()) { "Sample cancelled." }
        AudioDecoder.decode(context, localFile(uri), maxDurationMs = 30000) { cancelled.get() }
      } finally { sampleDecodes.remove(id) }
    }
    AsyncFunction("sha256") { uri: String ->
      val digest = MessageDigest.getInstance("SHA-256")
      localFile(uri).inputStream().buffered().use { input ->
        val buffer = ByteArray(1024 * 1024)
        while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    }
  }
}
