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
  private struct ResultForInsertion {
    let text: String
    let userId: String
    let documentID: UUID
    let finishedAtMs: Int64
  }

  private var undeliveredText: ResultForInsertion?

  init(_ dependencies: DirectDependencies) {
    deps = dependencies
    deps.capture.onStarted = { [weak self] in self?.captureStarted() }
    deps.capture.onAudio = { [weak self] data, rms in self?.captured(data, rms: rms) }
    deps.capture.onEnded = { [weak self] reason in self?.captureEnded(reason) }
  }

  /// The snapshot decodes, the path hasn't been turned off since the snapshot last changed, and
  /// either a cookie exists (Cloud) or the snapshot's Parakeet model is loaded (Local). Reading
  /// it with a Local snapshot whose model isn't ready asks the transcriber to load it.
  var isEligible: Bool { eligibleContext() != nil }

  func start() {
    switch state {
    case .idle, .failed: break
    default: return
    }
    guard job == nil, let documentID = readDocumentID?(), let (config, eligible) = eligibleContext() else { return }
    let jobId = deps.makeJobId()
    let tone = deps.readTone()
    let engine: JobEngine
    let recordEngine: String
    switch eligible {
    case let .cloud(cookie):
      engine = .cloud(DirectRequestContext(config: config, jobId: jobId, tone: tone, cookie: cookie))
      recordEngine = DirectDictationRecord.cloudEngine
    case let .local(model, languageHint):
      engine = .local(model: model, languageHint: languageHint)
      recordEngine = model.rawValue
    }
    do {
      // The record first, so audio on disk always has an owner, and says which engine it is
      // for, so a Local take left behind is never resumed as an upload.
      try deps.store.begin(jobId: jobId, userId: config.userId, documentID: documentID, tone: tone, engine: recordEngine)
      let writer = try PcmFileWriter(url: deps.store.pcmURL(jobId: jobId))
      nextToken += 1
      job = Job(token: nextToken, jobId: jobId, config: config, engine: engine, documentID: documentID, writer: writer)
      undeliveredText = nil
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
    // Kept until it reaches the field and account it was spoken for, a newer take starts, or
    // it is older than a take may be resumed: an old dictation is never typed unprompted.
    if let result = undeliveredText {
      if deps.store.now() - result.finishedAtMs >= DirectDictationStore.resumeWindowMs {
        undeliveredText = nil
      } else if insertIfDestinationMatches(result) {
        undeliveredText = nil
      }
    }
    switch state {
    case .idle, .failed: break
    default: return
    }
    // Resuming uploads, so only a Cloud snapshot resumes, and only a Cloud record (the store
    // never returns a Local one; the app's outbox makes those retryable rows).
    guard job == nil, let documentID = readDocumentID?(), let (config, eligible) = eligibleContext(),
      case let .cloud(cookie) = eligible,
      let record = deps.store.resumable(userId: config.userId, documentID: documentID), record.isCloud
    else { return }
    nextToken += 1
    job = Job(
      token: nextToken,
      jobId: record.jobId,
      config: config,
      engine: .cloud(DirectRequestContext(config: config, jobId: record.jobId, tone: record.tone, cookie: cookie)),
      documentID: documentID,
      writer: nil,
      durationMs: record.durationMs
    )
    // The keyboard was killed before the take was encoded: encode what reached the disk.
    if !FileManager.default.fileExists(atPath: deps.store.audioURL(jobId: record.jobId).path) {
      guard encodeRecovered(jobId: record.jobId) else { return }
    }
    upload()
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
        self.finish(text: text, original: text, cleanupApplied: nil)
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
        finish(text: text, original: original ?? text, cleanupApplied: applied)
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
      finish(text: raw, original: original, cleanupApplied: false)
      return
    }
    inFlight = deps.transport.send(request) { [weak self] status, body in
      guard let self, self.job?.token == token else { return }
      self.inFlight = nil
      let cleaned = DirectDictationRequests.parseReason(status: status, body: body)
      self.finish(text: cleaned ?? raw, original: original, cleanupApplied: cleaned != nil)
    }
  }

  private func finish(text: String, original: String, cleanupApplied: Bool?) {
    guard let current = job else { return }
    let expanded = SnippetExpander.expand(text, snippets: current.config.snippets)
    try? deps.store.complete(
      jobId: current.jobId, text: expanded, originalText: original, cleanupApplied: cleanupApplied,
      durationMs: current.durationMs
    )
    job = nil
    state = .idle
    let result = ResultForInsertion(
      text: expanded, userId: current.config.userId, documentID: current.documentID, finishedAtMs: deps.store.now()
    )
    if keyboardVisible {
      _ = insertIfDestinationMatches(result)
    } else {
      undeliveredText = result
    }
  }

  private func insertIfDestinationMatches(_ result: ResultForInsertion) -> Bool {
    guard readDocumentID?() == result.documentID, deliverableUserId() == result.userId else { return false }
    onText?(result.text)
    return true
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
