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
  private val cloudAudioJobs = ConcurrentHashMap<String, AtomicBoolean>()
  private val providerRuntime = lazy { ProviderTransport(context) }
  private val speechRuntime = lazy { ParakeetEngine(context) }
  private val moonshineRuntime = lazy { MoonshineEngine(context) }
  private val diarizationRuntime = lazy { DiarizationEngine(context) }
  private val providers by providerRuntime
  private val parakeet by speechRuntime
  private val moonshine by moonshineRuntime
  private val context get() = requireNotNull(appContext.reactContext)
  private fun localFile(uri: String): File {
    val file = File(Uri.parse(uri).path ?: error("Invalid file URI")).canonicalFile
    require(listOf(context.filesDir, context.cacheDir).any { file.path.startsWith(it.canonicalPath + "/") }) { "File is outside app storage." }
    return file
  }
  private fun startMeetingCapture(sampleRate: Int, noteId: Int, localOnly: Boolean, captureId: String?, audioNamespace: String, promise: Promise) {
    check(MeetingCaptureService.instance == null && MeetingCaptureService.pendingStart == null) { "A meeting is already recording." }
    require(!localOnly || !captureId.isNullOrBlank()) { "Invalid recording attempt." }
    val token = captureId ?: UUID.randomUUID().toString()
    val route = MeetingCaptureRoute(noteId, localOnly, token, audioNamespace)
    MeetingCaptureService.pendingRoute = route
    MeetingCaptureService.pendingToken = token
    MeetingCaptureService.pendingStart = { error ->
      if (error == null) promise.resolve(null) else promise.reject("MICROPHONE", error.message, error)
    }
    try {
      context.startForegroundService(Intent(context, MeetingCaptureService::class.java)
        .putExtra("sampleRate", sampleRate).putExtra("captureToken", token))
    } catch (error: Exception) { MeetingCaptureService.finishStart(error) }
  }
  private fun stopMeetingCapture(localNoteId: Int?, captureId: String?, promise: Promise) {
    if (MeetingCaptureService.pendingRoute?.acceptsStop(localNoteId, captureId) == true)
      MeetingCaptureService.finishStart(IllegalStateException("Recording cancelled."))
    val service = MeetingCaptureService.instance?.takeIf { it.route?.acceptsStop(localNoteId, captureId) == true }
    Thread {
      try {
        service?.stopCapture()
        service?.stopSelf()
        promise.resolve(null)
      } catch (error: Exception) { promise.reject("MICROPHONE", error.message, error) }
    }.start()
  }
  private val navigationBar = NavigationBar { sendEvent("onNavigationBarChange", it) }
  override fun definition() = ModuleDefinition {
    Name("AndroidDictation")
    Events("onStart", "onRecording", "onRetry", "onDismiss", "onError", "onCancel", "onOpenResult", "onOpenPlans", "onOpenSignIn", "onOpenModels", "onStatusChange", "pcm-frame", "pcm-error", "pcm-stopped", "local-meeting-stopped", "local-meeting-error", "onNavigationBarChange", "onFieldEdited", "onLearnedUndo", "onLearnedRedo", "onOpenDictionary")
    OnCreate { DictationService.emit = { event, data -> sendEvent(event, data) } }
    // The bubble pipeline listens, in the app or in a headless task: send what the bubble held.
    AsyncFunction("pipelineReady") {
      HeadlessPipeline.ready = true
      android.util.Log.i("OpenWhisprBubble", "Pipeline ready")
      DictationService.instance?.pipelineReady()
    }.runOnQueue(Queues.MAIN)
    OnActivityEntersForeground {
      navigationBar.attach(appContext.currentActivity)
      DictationService.appVisible = true
      DictationService.instance?.unhide()
      DictationService.instance?.updateVisibility()
    }
    OnActivityEntersBackground {
      DictationService.appVisible = false
      DictationService.instance?.updateVisibility()
    }
    OnDestroy {
      android.os.Handler(android.os.Looper.getMainLooper()).post { navigationBar.detach() }
      sampleDecodes.values.forEach { it.set(true) }
      sampleDecodes.clear()
      cloudAudioJobs.values.forEach { it.set(true) }
      cloudAudioJobs.clear()
      appContext.reactContext?.let {
        it.stopService(Intent(it, DictationService::class.java))
        it.stopService(Intent(it, MeetingCaptureService::class.java))
      }
      if (providerRuntime.isInitialized()) providers.close()
      if (speechRuntime.isInitialized()) parakeet.close()
      if (moonshineRuntime.isInitialized()) moonshine.close()
      if (diarizationRuntime.isInitialized()) diarizationRuntime.value.close()
      recorder?.close(); HeadlessPipeline.ready = false; DictationService.emit = null
    }
    AsyncFunction("startPCM") { sampleRate: Int, noteId: Int?, audioNamespace: String, promise: Promise ->
      startMeetingCapture(sampleRate, noteId ?: 0, false, null, audioNamespace, promise)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopPCM") { promise: Promise -> stopMeetingCapture(null, null, promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("startLocalMeeting") { noteId: Int, captureId: String, audioNamespace: String, promise: Promise ->
      startMeetingCapture(24000, noteId, true, captureId, audioNamespace, promise)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopLocalMeeting") { noteId: Int, captureId: String, promise: Promise ->
      require(noteId > 0) { "Invalid meeting note." }
      stopMeetingCapture(noteId, captureId, promise)
    }.runOnQueue(Queues.MAIN)
    Function("isPCMRecording") { MeetingCaptureService.instance?.route?.localOnly == false }
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
    AsyncFunction("diarize") { uri: String, modelDirectory: String, numberOfSpeakers: Int, promise: Promise ->
      diarizationRuntime.value.diarize(localFile(uri), localFile(modelDirectory), numberOfSpeakers, promise)
    }
    Function("cancelDiarization") { if (diarizationRuntime.isInitialized()) diarizationRuntime.value.cancel() }
    AsyncFunction("releaseMoonshine") { promise: Promise ->
      if (moonshineRuntime.isInitialized()) moonshine.release(promise) else promise.resolve(null)
    }
    // Credential lookup/removal uses other modules on Expo's shared async queue.
    // Keep blocking HTTP and response reads off that queue so they remain available.
    AsyncFunction("requestProvider") { options: Map<String, Any?> -> providers.request(options) }
      .runOnQueue(appContext.backgroundCoroutineScope)
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
    // The user's mail app, for "Open email app" after a reset link is sent; Android's chooser when
    // several are installed. False when none is.
    Function("openEmailApp") { title: String ->
      val mail = Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_EMAIL)
      try {
        context.startActivity(Intent.createChooser(mail, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
      } catch (_: android.content.ActivityNotFoundException) {
        false
      }
    }
    Function("setEnabled") { enabled: Boolean, size: Int ->
      if (enabled) {
        check(android.os.Build.VERSION.SDK_INT >= 26) { "The floating bubble needs Android 8 or newer." }
        check(Settings.canDrawOverlays(context)) { "Allow display over other apps first." }
        BubbleRestore.remember(context, true, size)
        context.startForegroundService(Intent(context, DictationService::class.java).putExtra("size", size))
      } else {
        BubbleRestore.remember(context, false, size)
        context.stopService(Intent(context, DictationService::class.java))
      }
    }
    // Stored so the service has it after a restart, and applied live when the bubble is running.
    Function("setAppearance") { options: Map<String, Any?> ->
      val defaults = BubbleAppearance()
      val value = BubbleAppearance(
        size = (options["size"] as? Number)?.toInt() ?: defaults.size,
        opacity = (options["opacity"] as? Number)?.toFloat() ?: defaults.opacity,
        shrinkWhenIdle = options["shrinkWhenIdle"] as? Boolean ?: defaults.shrinkWhenIdle,
        shrinkToDot = options["shrinkToDot"] as? Boolean ?: defaults.shrinkToDot,
        shrinkInSearch = options["shrinkInSearch"] as? Boolean ?: defaults.shrinkInSearch,
      ).let { it.copy(size = it.size.coerceIn(48, 88), opacity = it.alpha) }
      DictationService.writeAppearance(context.getSharedPreferences(DictationService.PREFERENCES, android.content.Context.MODE_PRIVATE), value)
      android.os.Handler(android.os.Looper.getMainLooper()).post { DictationService.instance?.applyAppearance(value) }
    }
    AsyncFunction("getNavigationBar") {
      navigationBar.attach(appContext.currentActivity)
      navigationBar.state()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setNavigationBarColor") { color: Int? ->
      navigationBar.attach(appContext.currentActivity)
      navigationBar.style(color)
    }.runOnQueue(Queues.MAIN)
    Function("restoreBubble") { BubbleRestore.restore(context, fromApp = true) }
    AsyncFunction("setPractice") { visible: Boolean ->
      DictationService.practiceVisible = visible
      DictationService.instance?.let { service ->
        if (!visible) service.leavePractice()
        service.updateVisibility()
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setStatus") { value: String, options: Map<String, Any?>? ->
      DictationService.instance?.status(value, options ?: emptyMap())
    }.runOnQueue(Queues.MAIN)
    // Dictionary's C11: the bubble's "Learned" tab, with strings already translated by JS.
    AsyncFunction("showLearnedTab") { options: Map<String, Any?> ->
      val words = (options["words"] as? List<*>)?.filterIsInstance<String>().orEmpty()
      if (words.isEmpty()) return@AsyncFunction false
      DictationService.instance?.showLearnedTab(LearnedTabText(words,
        options["message"] as? String ?: "", options["undo"] as? String ?: "", options["undone"] as? String ?: "")) ?: false
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("insert") { text: String, options: Map<String, Any?>?, promise: Promise ->
      val service = InsertionService.instance
      if (service == null) promise.resolve(false)
      else service.insert(text, highlight = options?.get("highlight") == true) { promise.resolve(it) }
    }.runOnQueue(Queues.MAIN)
    // What the hold menu shows: the Translate target, why the Assistant is greyed ("" = available),
    // and what holding the bubble does ("menu" or "nothing"). Kept for the bubble's next start.
    Function("setMenuContext") { options: Map<String, Any?> ->
      val translateTarget = options["translateTarget"] as? String
      val assistantBlock = options["assistantBlock"] as? String
      val holdAction = options["holdAction"] as? String
      val preferences = context.getSharedPreferences(DictationService.PREFERENCES, android.content.Context.MODE_PRIVATE)
      preferences.edit().apply {
        if (translateTarget != null) putString("translateTarget", translateTarget)
        if (assistantBlock != null) { if (assistantBlock.isEmpty()) remove("assistantBlock") else putString("assistantBlock", assistantBlock) }
        if (holdAction != null) putString("holdAction", holdAction)
      }.apply()
    }
    // With typing access off nothing can paste: the words go on the clipboard instead.
    Function("copyText") { text: String ->
      val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
      clipboard.setPrimaryClip(android.content.ClipData.newPlainText("OpenWhispr", text))
    }
    AsyncFunction("startRecording") {
      check(recorder == null) { "A recording is already active." }
      val next = WavRecorder(context)
      try { next.start(); recorder = next } catch (error: Exception) { next.close(); throw error }
    }
    Function("getRecordingLevel") { recorder?.level ?: 0f }
    AsyncFunction("stopRecording") { cancel: Boolean ->
      val active = recorder ?: error("No recording is active.")
      try { active.stop(cancel) } finally { active.close(); recorder = null }
    }
    AsyncFunction("decodeAudio") { uri: String -> AudioDecoder.decode(context, localFile(uri)) }
    Function("prepareCloudAudio") {
      val id = UUID.randomUUID().toString()
      cloudAudioJobs[id] = AtomicBoolean(false)
      id
    }
    Function("cancelCloudAudio") { id: String -> cloudAudioJobs[id]?.set(true) }
    AsyncFunction("splitCloudAudio") { uri: String, seconds: Int, id: String ->
      val cancelled = requireNotNull(cloudAudioJobs[id]) { "Transcription cancelled." }
      val directory = File(context.cacheDir, "cloud-audio-${UUID.randomUUID()}")
      var decoded: File? = null
      try {
        check(!cancelled.get()) { "Transcription cancelled." }
        require(seconds in 1..120) { "Invalid Cloud audio chunk duration." }
        check(directory.mkdir()) { "Cannot create temporary Cloud audio storage." }
        val result = AudioDecoder.decode(context, localFile(uri), maxDecodedFrames = AudioDecoder.MAX_WAV_FRAMES) { cancelled.get() }
        val wav = localFile(result.getValue("uri") as String)
        decoded = wav
        val chunks = CloudAudioChunks.split(wav, directory, seconds) { cancelled.get() }
        mapOf("chunks" to chunks.map { "file://${it.path}" }, "durationMs" to result.getValue("durationMs"))
      } catch (error: Exception) {
        directory.deleteRecursively()
        throw error
      } finally {
        decoded?.delete()
        cloudAudioJobs.remove(id)
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)
    AsyncFunction("cleanupCloudAudio") { uris: List<String> ->
      val cache = context.cacheDir.canonicalFile
      // Never accept an arbitrary managed recording or another cache file.
      val chunks = uris.map { uri ->
        val file = localFile(uri)
        val parent = requireNotNull(file.parentFile)
        require(parent.parentFile == cache &&
          parent.name.matches(Regex("cloud-audio-[0-9a-f-]{36}")) &&
          file.name.matches(Regex("chunk-[0-9]+\\.wav"))) { "Not temporary Cloud audio." }
        file
      }
      chunks.forEach { file ->
        check(!file.exists() || file.delete()) { "Cannot remove temporary Cloud audio." }
        file.parentFile?.delete() // Only succeeds once all sibling chunks are gone.
      }
    }
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
