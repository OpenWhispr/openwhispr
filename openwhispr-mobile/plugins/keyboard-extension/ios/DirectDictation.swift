import Foundation

protocol DirectCancellable {
  func cancel()
}

/// The microphone. `WebAudioCapture` in the keyboard; a fake in tests.
protocol DirectCapture: AnyObject {
  /// Capture is running.
  var onStarted: (() -> Void)? { get set }
  /// 16 kHz Int16 PCM, and its RMS (0...1).
  var onAudio: ((Data, Float) -> Void)? { get set }
  /// Capture ended; "stopped" when `stop()` asked for it.
  var onEnded: ((String) -> Void)? { get set }
  func start()
  func stop()
}

protocol DirectTransport {
  /// Status 0 means a transport error.
  func upload(_ request: URLRequest, fromFile: URL, completion: @escaping (Int, Data) -> Void) -> DirectCancellable
  func send(_ request: URLRequest, completion: @escaping (Int, Data) -> Void) -> DirectCancellable
}

protocol DirectScheduler {
  func after(_ seconds: TimeInterval, _ work: @escaping () -> Void) -> DirectCancellable
}

enum DirectFailure: Equatable {
  /// "Tap to open app"
  case captureUnavailable
  /// "No speech"
  case noSpeech
  /// "Tap to open app"
  case signInAgain
  /// "Set up in app"
  case setUpInApp
  /// "Limit reached"
  case limitReached
  /// "Try again"
  case tryAgain
}

enum DirectDictationState: Equatable {
  case idle
  case starting
  case recording
  case transcribing
  case failed(DirectFailure)
}

struct DirectDependencies {
  var capture: DirectCapture
  var transport: DirectTransport
  var scheduler: DirectScheduler
  var store: DirectDictationStore
  var readConfigJSON: () -> String?
  /// The shared session's cookie, only when it belongs to this account.
  var readCookie: (_ userId: String) -> String?
  var readTone: () -> String
  /// The keyboard's effective translation target and its English label; nil when Off.
  var readTranslation: () -> (code: String, label: String)?
  /// `DirectAudioEncoder.encodeAAC` in production; a file copy in tests.
  var encode: (_ pcmURL: URL, _ m4aURL: URL, _ gain: Float) throws -> Void
  var makeJobId: () -> String
  var makeBoundary: () -> String
  /// Parakeet in the keyboard; nil where it can't run, which leaves Local snapshots ineligible.
  var localTranscriber: DirectLocalTranscriber?
}

/// A dictation the keyboard records and transcribes itself when the app isn't running: uploaded
/// for OpenWhispr Cloud users, or transcribed on the device with Parakeet for Local Mode users.
/// One per keyboard process: the view controller can be recreated mid-take, so it attaches to
/// this object rather than owning it. Every call happens on the main thread.
final class DirectDictation {
  static let startTimeout: TimeInterval = 3
  static let takeCap: TimeInterval = 300

  private(set) var state: DirectDictationState = .idle {
    didSet { if state != oldValue { onStateChange?(state) } }
  }

  var readDocumentID: (() -> UUID?)?
  /// The text before the cursor. iOS gives a field a new document ID when the keyboard comes
  /// back from under Notification Centre or the app switcher; unchanged text there is what
  /// says it is still the same place.
  var readContextBefore: (() -> String?)?
  /// `hasHeldDictation` may have changed.
  var onHeldChange: (() -> Void)?
  var onStateChange: ((DirectDictationState) -> Void)?
  /// `directMeterLevel` of each chunk, for the waveform.
  var onLevel: ((Float) -> Void)?
  /// The final text, already snippet-expanded.
  var onText: ((String) -> Void)?

  /// How a take is transcribed. A Local job has no request context at all, so no code path can
  /// build a request for it.
  private enum JobEngine {
    case cloud(DirectRequestContext)
    case local(model: DirectLocalModel, languageHint: String?)
  }

  private enum EligibleEngine {
    case cloud(cookie: String)
    case local(model: DirectLocalModel, languageHint: String?)
  }

  private struct Job {
    let token: Int
    let jobId: String
    let config: DirectDictationConfig
    let engine: JobEngine
    let documentID: UUID
    var contextBefore: String?
    var writer: PcmFileWriter?
    var meter = SpeechActivityMeter()
    var attempt = 0
    var durationMs = 0
  }

  private let deps: DirectDependencies
  private var job: Job?
  private var nextToken = 0
  private var startTimer: DirectCancellable?
  private var capTimer: DirectCancellable?
  private var inFlight: DirectCancellable?
  private var turnedOff = false
  private var configWhenTurnedOff: String?
  private var keyboardVisible = true
  /// How long unchanged text before the cursor counts as the same place.
  static let sameTextWindowMs: Int64 = 60_000

  /// Where a take was spoken, and when it stopped.
  private struct Place {
    let userId: String
    let documentID: UUID
    let contextBefore: String?
    let atMs: Int64
  }

  private struct ResultForInsertion {
    let text: String
    let place: Place
  }

  private var undeliveredText: ResultForInsertion? {
    didSet { reportHeldChange() }
  }

  /// A Cloud take encoded when the keyboard was covered, not yet sent.
  private var suspendedTake: Place? {
    didSet { reportHeldChange() }
  }

  private var heldReported = false

  private func reportHeldChange() {
    let held = hasHeldDictation
    guard held != heldReported else { return }
    heldReported = held
    onHeldChange?()
  }

  init(_ dependencies: DirectDependencies) {
    deps = dependencies
    deps.capture.onStarted = { [weak self] in self?.captureStarted() }
    deps.capture.onAudio = { [weak self] data, rms in self?.captured(data, rms: rms) }
    deps.capture.onEnded = { [weak self] reason in self?.captureEnded(reason) }
  }

  /// A new take may start: the snapshot decodes, the path hasn't been turned off since the
  /// snapshot last changed, either a cookie exists (Cloud) or the snapshot's Parakeet model is
  /// loaded (Local), and a language picked in the keyboard is one this take can translate into,
  /// or exactly the dictation language. Reading it with a Local snapshot whose model isn't ready
  /// asks the transcriber to load it.
  var isEligible: Bool { newTakeContext() != nil }

  /// As `isEligible` without the translation check, for preparing capture: picking Off later in
  /// the same keyboard session must find the microphone ready.
  var isEligibleIgnoringTranslation: Bool { eligibleContext() != nil }

  func start() {
    switch state {
    case .idle, .failed: break
    default: return
    }
    // The target is the one the gate checked: one picked mid-take applies to the next dictation.
    guard job == nil, let documentID = readDocumentID?(), let (config, eligible, translation) = newTakeContext()
    else { return }
    let jobId = deps.makeJobId()
    let tone = deps.readTone()
    let engine: JobEngine
    let recordEngine: String
    switch eligible {
    case let .cloud(cookie):
      engine = .cloud(DirectRequestContext(
        config: config, jobId: jobId, tone: tone, cookie: cookie,
        translationTarget: translation?.code, translationLabel: translation?.label
      ))
      recordEngine = DirectDictationRecord.cloudEngine
    case let .local(model, languageHint):
      engine = .local(model: model, languageHint: languageHint)
      recordEngine = model.rawValue
    }
    do {
      // The record first, so audio on disk always has an owner, and says which engine it is
      // for, so a Local take left behind is never resumed as an upload.
      try deps.store.begin(
        jobId: jobId, userId: config.userId, documentID: documentID, tone: tone, engine: recordEngine,
        // nil for a Local take: newTakeContext never gives one a target.
        translationTarget: translation?.code, translationLabel: translation?.label
      )
      let writer = try PcmFileWriter(url: deps.store.pcmURL(jobId: jobId))
      nextToken += 1
      job = Job(
        token: nextToken, jobId: jobId, config: config, engine: engine, documentID: documentID,
        contextBefore: readContextBefore?(), writer: writer
      )
      undeliveredText = nil
      suspendedTake = nil
    } catch {
      deps.store.cancel(jobId: jobId)
      state = .failed(.tryAgain)
      return
    }
    state = .starting
    let token = nextToken
    startTimer = deps.scheduler.after(Self.startTimeout) { [weak self] in
      guard self?.job?.token == token else { return }
      self?.captureUnavailable()
    }
    deps.capture.start()
  }

  func confirm() {
    finishRecording(upload: true)
  }

  func cancel() {
    let wasCapturing = state == .starting || state == .recording
    cancelTimers()
    inFlight?.cancel()
    inFlight = nil
    let current = job
    job = nil
    if wasCapturing { deps.capture.stop() }
    if let current {
      current.writer?.close()
      deps.store.cancel(jobId: current.jobId)
    }
    state = .idle
  }

  /// Capture never outlives the keyboard. Audio already captured is kept, to send when the
  /// keyboard comes back (a Local take is transcribed at once); a request or a transcription in
  /// flight is left to finish.
  func keyboardWillDisappear() {
    keyboardVisible = false
    switch state {
    case .starting: cancel()
    case .recording: finishRecording(upload: false)
    default: break
    }
  }

  func keyboardDidAppear() {
    keyboardVisible = true
    deliverHeldTextIfSamePlace()
    switch state {
    case .idle, .failed: break
    default: return
    }
    guard job == nil, let documentID = readDocumentID?() else { return }
    if resumeCloudTake(recordedIn: documentID) {
      suspendedTake = nil
      return
    }
    // The field's ID changed while the keyboard was covered.
    guard let suspended = suspendedTake else { return }
    if deps.store.now() - suspended.atMs >= DirectDictationStore.resumeWindowMs {
      suspendedTake = nil
    } else if isSamePlace(suspended), resumeCloudTake(recordedIn: suspended.documentID) {
      suspendedTake = nil
    }
  }

  /// The text before the cursor changed, or the cursor moved.
  func fieldChanged() {
    guard keyboardVisible else { return }
    switch state {
    case .starting, .recording:
      // Keys still work during a take: the newest text is the place it was spoken.
      if let current = job, readDocumentID?() == current.documentID {
        job?.contextBefore = readContextBefore?()
      }
    default:
      // The text can arrive a moment after the keyboard appears.
      deliverHeldTextIfSamePlace()
    }
  }

  // MARK: - A take waiting for its place

  /// A finished take has text that was not typed, or a Cloud take waits to be sent: the
  /// keyboard offers to insert it.
  var hasHeldDictation: Bool {
    let cutoff = deps.store.now() - DirectDictationStore.resumeWindowMs
    let userId = deliverableUserId()
    if let result = undeliveredText, result.place.atMs > cutoff, result.place.userId == userId { return true }
    if let suspended = suspendedTake, suspended.atMs > cutoff, suspended.userId == userId { return true }
    return false
  }

  /// The user asked for the waiting take here, whatever the field.
  func insertHeld() {
    guard hasHeldDictation else {
      discardHeld()
      return
    }
    if let result = undeliveredText {
      guard deliverableUserId() == result.place.userId else { return }
      undeliveredText = nil
      onText?(result.text)
      return
    }
    guard let suspended = suspendedTake else { return }
    switch state {
    case .idle, .failed: break
    default: return
    }
    suspendedTake = nil
    _ = resumeCloudTake(recordedIn: suspended.documentID)
  }

  /// Not typed. A finished take stays in History; an unsent one becomes a row to retry there.
  func discardHeld() {
    undeliveredText = nil
    suspendedTake = nil
  }

  /// The field the take was spoken in: the same document, or, once iOS has renamed it, the same
  /// text before the cursor soon after. An empty field proves nothing.
  private func isSamePlace(_ place: Place) -> Bool {
    guard let current = readDocumentID?() else { return false }
    if current == place.documentID { return true }
    guard let before = place.contextBefore, !before.isEmpty,
      deps.store.now() - place.atMs < Self.sameTextWindowMs
    else { return false }
    return readContextBefore?() == before
  }

  /// Kept until it reaches the place and account it was spoken for, the user asks for it or
  /// discards it, a newer take starts, or it is older than a take may be resumed: an old
  /// dictation is never typed unprompted.
  private func deliverHeldTextIfSamePlace() {
    guard let result = undeliveredText else { return }
    if deps.store.now() - result.place.atMs >= DirectDictationStore.resumeWindowMs {
      undeliveredText = nil
    } else if isSamePlace(result.place), deliverableUserId() == result.place.userId {
      undeliveredText = nil
      onText?(result.text)
    }
  }

  /// Sends the pending Cloud take recorded in `recordedIn` and types its text in the field the
  /// keyboard is in now. Resuming uploads, so only a Cloud snapshot resumes, and only a Cloud
  /// record (the store never returns a Local one; the app's outbox makes those retryable rows).
  private func resumeCloudTake(recordedIn: UUID) -> Bool {
    guard job == nil, let documentID = readDocumentID?(), let (config, eligible) = eligibleContext(),
      case let .cloud(cookie) = eligible,
      let record = deps.store.resumable(userId: config.userId, documentID: recordedIn), record.isCloud
    else { return false }
    nextToken += 1
    job = Job(
      token: nextToken,
      jobId: record.jobId,
      config: config,
      // The target the take started with, not today's.
      engine: .cloud(DirectRequestContext(
        config: config, jobId: record.jobId, tone: record.tone, cookie: cookie,
        translationTarget: record.translationTarget, translationLabel: record.translationLabel
      )),
      documentID: documentID,
      contextBefore: readContextBefore?(),
      writer: nil,
      durationMs: record.durationMs
    )
    // The keyboard was killed before the take was encoded: encode what reached the disk.
    if !FileManager.default.fileExists(atPath: deps.store.audioURL(jobId: record.jobId).path) {
      guard encodeRecovered(jobId: record.jobId) else { return true }
    }
    upload()
    return true
  }

  /// Encodes a take whose keyboard died before it could; false when nothing is left to send.
  private func encodeRecovered(jobId: String) -> Bool {
    let store = deps.store
    let pcm = store.pcmURL(jobId: jobId)
    do {
      let scan = try PcmFileScan.scan(pcm)
      guard scan.activity.durationMs > 0, !scan.activity.noSpeechLikely else {
        store.cancel(jobId: jobId)
        job = nil
        return false
      }
      job?.durationMs = scan.activity.durationMs
      try encode(jobId: jobId, durationMs: scan.activity.durationMs, gain: DirectGain.factor(peakSample: scan.peakSample))
      return true
    } catch {
      try? store.fail(jobId: jobId, durationMs: job?.durationMs ?? 0)
      job = nil
      return false
    }
  }

  // MARK: - Capture

  private func captureStarted() {
    guard state == .starting, let token = job?.token else { return }
    startTimer?.cancel()
    startTimer = nil
    state = .recording
    capTimer = deps.scheduler.after(Self.takeCap) { [weak self] in
      guard self?.job?.token == token else { return }
      self?.finishRecording(upload: true)
    }
  }

  private func captured(_ data: Data, rms: Float) {
    guard state == .recording, job != nil else { return }
    try? job?.writer?.append(data)
    job?.meter.add(data)
    onLevel?(directMeterLevel(rms: rms * DirectGain.displayBoost))
  }

  private func captureEnded(_ reason: String) {
    // "stopped" is the echo of our own stop().
    guard reason != "stopped" else { return }
    switch state {
    case .starting: captureUnavailable()
    case .recording: finishRecording(upload: true)
    default: break
    }
  }

  private func captureUnavailable() {
    guard state == .starting, let current = job else { return }
    cancelTimers()
    job = nil
    deps.capture.stop()
    current.writer?.close()
    deps.store.cancel(jobId: current.jobId)
    turnPathOff()
    state = .failed(.captureUnavailable)
  }

  /// Closes and encodes the take before upload or suspension; a Local take goes to the
  /// transcriber instead.
  private func finishRecording(upload shouldUpload: Bool) {
    guard state == .recording, var current = job else { return }
    cancelTimers()
    deps.capture.stop()
    current.writer?.close()
    current.durationMs = current.writer?.durationMs ?? 0
    let store = deps.store
    let jobId = current.jobId

    let gain = DirectGain.factor(peakSample: current.writer?.peakSample ?? 0)
    let activity = current.meter.result(gain: gain)
    if current.durationMs == 0 || activity.noSpeechLikely {
      store.cancel(jobId: jobId)
      job = nil
      state = shouldUpload ? .failed(.noSpeech) : .idle
      return
    }

    // Parakeet takes the take as captured: the gain is for the AAC upload. It is transcribed
    // even when the keyboard is going away, since nothing leaves the device and the keyboard
    // never resumes a Local take; the text waits for the same field (`undeliveredText`).
    if case let .local(model, languageHint) = current.engine {
      current.writer = nil
      job = current
      transcribeLocally(model: model, languageHint: languageHint)
      return
    }

    do {
      try encode(jobId: jobId, durationMs: current.durationMs, gain: gain)
    } catch {
      try? store.fail(jobId: jobId, durationMs: current.durationMs)
      job = nil
      state = shouldUpload ? .failed(.tryAgain) : .idle
      return
    }

    current.writer = nil
    guard shouldUpload else {
      suspendedTake = Place(
        userId: current.config.userId, documentID: current.documentID, contextBefore: current.contextBefore,
        atMs: deps.store.now()
      )
      job = nil
      state = .idle
      return
    }
    job = current
    upload()
  }

  private func encode(jobId: String, durationMs: Int, gain: Float) throws {
    let store = deps.store
    // Save the duration before replacing PCM, so recovery can use either representation.
    try store.setDuration(jobId: jobId, durationMs: durationMs)
    let pcm = store.pcmURL(jobId: jobId)
    try deps.encode(pcm, store.audioURL(jobId: jobId), gain)
    try? FileManager.default.removeItem(at: pcm)
  }

  // MARK: - On the device

  /// The PCM stays until the take completes, so a failure leaves History a take to retry.
  private func transcribeLocally(model: DirectLocalModel, languageHint: String?) {
    guard let current = job else { return }
    let store = deps.store
    let wav = store.wavURL(jobId: current.jobId)
    // The model loaded now must be the one the take started with: the language may have moved
    // the route from v2 to v3 since, and v2 must never transcribe German.
    guard let transcriber = deps.localTranscriber, transcriber.readyModel == model else {
      failJob(.tryAgain, turnOff: false)
      return
    }
    do {
      try store.setDuration(jobId: current.jobId, durationMs: current.durationMs)
      try PcmWav.wrap(pcmURL: store.pcmURL(jobId: current.jobId), into: wav)
    } catch {
      failJob(.tryAgain, turnOff: false)
      return
    }
    state = .transcribing
    let token = current.token
    inFlight = transcriber.transcribe(wavURL: wav, languageHint: languageHint) { [weak self] result in
      guard let self, self.job?.token == token else { return }
      self.inFlight = nil
      switch result {
      // No words is a failed take (its PCM kept for a retry), never an empty insert.
      case let .success(text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
        // Raw Parakeet text: snippets expand and, with no target on a Local job, nothing else.
        self.translateThenFinish(text: text, original: text, cleanupApplied: nil, token: token)
      case .success, .failure:
        self.failJob(.tryAgain, turnOff: false)
      }
    }
  }

  // MARK: - Requests

  private func upload() {
    // Only a Cloud job has a request context; anything else is a take that must not leave
    // the device.
    guard let current = job else { return }
    guard case let .cloud(context) = current.engine else {
      failJob(.tryAgain, turnOff: false)
      return
    }
    state = .transcribing
    let store = deps.store
    do {
      let request = try DirectDictationRequests.makeTranscribeRequest(
        context,
        audioURL: store.audioURL(jobId: current.jobId),
        bodyURL: store.bodyURL(jobId: current.jobId),
        boundary: deps.makeBoundary()
      )
      let token = current.token
      inFlight = deps.transport.upload(request, fromFile: store.bodyURL(jobId: current.jobId)) { [weak self] status, body in
        self?.transcribed(token: token, status: status, body: body)
      }
    } catch {
      failJob(.tryAgain, turnOff: false)
    }
  }

  private func transcribed(token: Int, status: Int, body: Data) {
    guard let current = job, current.token == token else { return }
    inFlight = nil
    let outcome = DirectDictationRequests.parseTranscribe(status: status, body: body)
    switch outcome {
    case let .success(text, original, applied):
      // As the app: a fused request that came back without cleanup gets one cleanup pass.
      if current.config.cleanup.enabled && applied != true {
        cleanUp(raw: text, original: original ?? text, token: token)
      } else {
        translateThenFinish(text: text, original: original ?? text, cleanupApplied: applied, token: token)
      }
    case .noSpeech:
      deps.store.cancel(jobId: current.jobId)
      job = nil
      state = .failed(.noSpeech)
    case .unauthorized:
      failJob(.signInAgain, turnOff: true)
    case .policyBlocked:
      failJob(.setUpInApp, turnOff: true)
    case .limitReached:
      failJob(.limitReached, turnOff: true)
    case .retryable where current.attempt == 0:
      job?.attempt = 1
      upload()
    case .retryable, .rejected:
      failJob(.tryAgain, turnOff: false)
    }
  }

  private func cleanUp(raw: String, original: String, token: Int) {
    guard let current = job, case let .cloud(context) = current.engine,
      let request = try? DirectDictationRequests.makeReasonRequest(context, rawText: raw)
    else {
      translateThenFinish(text: raw, original: original, cleanupApplied: false, token: token)
      return
    }
    inFlight = deps.transport.send(request) { [weak self] status, body in
      guard let self, self.job?.token == token else { return }
      self.inFlight = nil
      let cleaned = DirectDictationRequests.parseReason(status: status, body: body)
      self.translateThenFinish(text: cleaned ?? raw, original: original, cleanupApplied: cleaned != nil, token: token)
    }
  }

  /// Snippets expand first, since their triggers are in the spoken language (as the app's
  /// pipeline). Anything but a translation types the expanded text untranslated; the record says
  /// so unless the reply came back unchanged, which the app and desktop read as already translated.
  private func translateThenFinish(text: String, original: String, cleanupApplied: Bool?, token: Int) {
    guard let current = job, current.token == token else { return }
    let expanded = SnippetExpander.expand(text, snippets: current.config.snippets)
    // Only a Cloud job has a request context, and with it a target: a Local job never translates,
    // whatever its snapshot says. No target, or one that is the dictation language itself:
    // nothing to translate.
    guard case let .cloud(context) = current.engine, let target = context.translationTarget,
      !DirectDictationRequests.isSameLanguage(current.config.language, target)
    else {
      finish(text: expanded, original: original, cleanupApplied: cleanupApplied, translatedTo: nil,
             translationFailed: false)
      return
    }
    // A resumed take whose snapshot can no longer translate still had a target to honour.
    guard let request = try? DirectDictationRequests.makeTranslateRequest(context, text: expanded) else {
      finish(text: expanded, original: original, cleanupApplied: cleanupApplied, translatedTo: nil,
             translationFailed: true)
      return
    }
    inFlight = deps.transport.send(request) { [weak self] status, body in
      guard let self, self.job?.token == token else { return }
      self.inFlight = nil
      let outcome = DirectDictationRequests.parseTranslation(status: status, body: body, input: expanded)
      if case let .translated(translated) = outcome {
        self.finish(text: translated, original: original, cleanupApplied: cleanupApplied, translatedTo: target,
                    translationFailed: false)
      } else {
        self.finish(text: expanded, original: original, cleanupApplied: cleanupApplied, translatedTo: nil,
                    translationFailed: outcome == .failed)
      }
    }
  }

  /// `text` is final: snippet-expanded, and translated when `translatedTo` is set.
  private func finish(
    text: String, original: String, cleanupApplied: Bool?, translatedTo: String?, translationFailed: Bool
  ) {
    guard let current = job else { return }
    try? deps.store.complete(
      jobId: current.jobId, text: text, originalText: original, cleanupApplied: cleanupApplied,
      translatedTo: translatedTo, translationFailed: translationFailed, durationMs: current.durationMs
    )
    job = nil
    state = .idle
    // Typed now when the keyboard is in the take's place; otherwise it waits there.
    undeliveredText = ResultForInsertion(
      text: text,
      place: Place(
        userId: current.config.userId, documentID: current.documentID, contextBefore: current.contextBefore,
        atMs: deps.store.now()
      )
    )
    if keyboardVisible { deliverHeldTextIfSamePlace() }
  }

  /// Keeps the `.m4a` (or the `.pcm` of a take never encoded, as every Local take), so the app
  /// can offer a retry from History.
  private func failJob(_ failure: DirectFailure, turnOff: Bool) {
    guard let current = job else { return }
    try? deps.store.fail(jobId: current.jobId, durationMs: current.durationMs)
    job = nil
    if turnOff { turnPathOff() }
    state = .failed(failure)
  }

  // MARK: - Eligibility

  private func currentConfig() -> DirectDictationConfig? {
    let json = deps.readConfigJSON()
    if turnedOff {
      // Off until the app writes a different snapshot (a new sign-in, a setting change).
      guard json != configWhenTurnedOff else { return nil }
      turnedOff = false
    }
    return DirectDictationConfig.decode(json)
  }

  private func eligibleContext() -> (DirectDictationConfig, EligibleEngine)? {
    guard let config = currentConfig() else { return nil }
    switch config.engine {
    case .cloud:
      guard let cookie = deps.readCookie(config.userId), !cookie.isEmpty else { return nil }
      return (config, .cloud(cookie: cookie))
    case let .local(model, languageHint):
      guard let transcriber = deps.localTranscriber else { return nil }
      guard transcriber.readyModel == model else {
        // Not ready (or another model loaded): load this one for the next take, and hand off
        // this time.
        transcriber.prepare(model)
        return nil
      }
      return (config, .local(model: model, languageHint: languageHint))
    }
  }

  /// The account a finished take may still be typed for. Unlike eligibility, a Local result
  /// doesn't need the model loaded any more: only the account has to be the same.
  private func deliverableUserId() -> String? {
    guard let config = currentConfig() else { return nil }
    switch config.engine {
    case .cloud:
      guard let cookie = deps.readCookie(config.userId), !cookie.isEmpty else { return nil }
      return config.userId
    case .local:
      return config.userId
    }
  }

  /// Stands down while a language is picked that this take can't translate into, so the
  /// keyboard's other route records and the app translates: a Cloud snapshot whose AI route isn't
  /// OpenWhispr Cloud, and every Local take, which never sends anything (even when a stale or
  /// hand-edited snapshot says `translation.enabled`). A target that is exactly the dictation
  /// language wouldn't be translated there either, so it keeps app-closed dictation. Returns the
  /// target it checked, so the take records only a target that passed this gate (none for a Local
  /// take). Recovery and delivery use `eligibleContext()`: a take already started keeps its own target.
  private func newTakeContext() -> (
    config: DirectDictationConfig, engine: EligibleEngine, translation: (code: String, label: String)?
  )? {
    guard let (config, eligible) = eligibleContext() else { return nil }
    guard let translation = deps.readTranslation() else { return (config, eligible, nil) }
    let isLocal: Bool
    if case .local = eligible { isLocal = true } else { isLocal = false }
    if DirectDictationRequests.isSameLanguage(config.language, translation.code) {
      return (config, eligible, isLocal ? nil : translation)
    }
    guard !isLocal, config.translation.enabled else { return nil }
    return (config, eligible, translation)
  }

  private func turnPathOff() {
    turnedOff = true
    configWhenTurnedOff = deps.readConfigJSON()
  }

  private func cancelTimers() {
    startTimer?.cancel()
    startTimer = nil
    capTimer?.cancel()
    capTimer = nil
  }
}
