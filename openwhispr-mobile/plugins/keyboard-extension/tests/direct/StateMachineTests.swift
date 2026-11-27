import Foundation

// Fakes for DirectDictation's dependencies, and one test per row of the plan's table.

final class FakeCapture: DirectCapture {
  var onStarted: (() -> Void)?
  var onAudio: ((Data, Float) -> Void)?
  var onEnded: ((String) -> Void)?
  var startCount = 0
  var stopCount = 0
  var startHook: (() -> Void)?
  private var capturing = false

  func start() {
    startCount += 1
    capturing = true
    startHook?()
  }

  // Like WebAudioCapture: stopping reports "stopped" at once.
  func stop() {
    stopCount += 1
    guard capturing else { return }
    capturing = false
    onEnded?("stopped")
  }

  func started() { onStarted?() }
  func audio(_ data: Data, rms: Float) { onAudio?(data, rms) }
  func ended(_ reason: String) {
    capturing = false
    onEnded?(reason)
  }
}

final class FakeCall: DirectCancellable {
  let request: URLRequest
  let file: URL?
  private let completion: (Int, Data) -> Void
  var cancelled = false

  init(request: URLRequest, file: URL?, completion: @escaping (Int, Data) -> Void) {
    self.request = request
    self.file = file
    self.completion = completion
  }

  func cancel() { cancelled = true }
  func complete(_ status: Int, _ body: String = "") { completion(status, Data(body.utf8)) }
}

final class FakeTransport: DirectTransport {
  var uploads: [FakeCall] = []
  var sends: [FakeCall] = []

  func upload(_ request: URLRequest, fromFile: URL, completion: @escaping (Int, Data) -> Void) -> DirectCancellable {
    let call = FakeCall(request: request, file: fromFile, completion: completion)
    uploads.append(call)
    return call
  }

  func send(_ request: URLRequest, completion: @escaping (Int, Data) -> Void) -> DirectCancellable {
    let call = FakeCall(request: request, file: nil, completion: completion)
    sends.append(call)
    return call
  }
}

final class FakeTranscription: DirectCancellable {
  var cancelled = false
  func cancel() { cancelled = true }
}

/// Parakeet as the state machine sees it: a model that is ready or not, and transcriptions the
/// test completes when it wants.
final class FakeLocalTranscriber: DirectLocalTranscriber {
  struct Call {
    let wavURL: URL
    let languageHint: String?
    /// The WAV's size when the transcriber got it.
    let wavBytes: Int
    let handle: FakeTranscription
    let completion: (Result<String, Error>) -> Void
  }

  var readyModel: DirectLocalModel?
  var prepared: [DirectLocalModel] = []
  var releases = 0
  var calls: [Call] = []

  func prepare(_ model: DirectLocalModel) { prepared.append(model) }

  func release() {
    guard readyModel != nil else { return }
    releases += 1
    readyModel = nil
  }

  func transcribe(
    wavURL: URL, languageHint: String?, completion: @escaping (Result<String, Error>) -> Void
  ) -> DirectCancellable {
    let size = (try? FileManager.default.attributesOfItem(atPath: wavURL.path)[.size] as? Int) ?? -1
    let handle = FakeTranscription()
    calls.append(Call(wavURL: wavURL, languageHint: languageHint, wavBytes: size, handle: handle, completion: completion))
    return handle
  }

  func succeed(_ text: String) { calls.last?.completion(.success(text)) }
  func fail() { calls.last?.completion(.failure(NSError(domain: "parakeet", code: 1))) }
}

final class FakeScheduler: DirectScheduler {
  final class Item: DirectCancellable {
    let due: Int64
    let work: () -> Void
    var cancelled = false
    init(due: Int64, work: @escaping () -> Void) {
      self.due = due
      self.work = work
    }
    func cancel() { cancelled = true }
  }

  let clock: DirectDictationTests.TestClock
  private var items: [Item] = []

  init(clock: DirectDictationTests.TestClock) { self.clock = clock }

  func after(_ seconds: TimeInterval, _ work: @escaping () -> Void) -> DirectCancellable {
    let item = Item(due: clock.ms + Int64(seconds * 1000), work: work)
    items.append(item)
    return item
  }

  /// Moves the clock forward, running each piece of work that falls due on the way, in order.
  func advance(seconds: Double) {
    let target = clock.ms + Int64(seconds * 1000)
    while let next = items.filter({ !$0.cancelled && $0.due <= target }).min(by: { $0.due < $1.due }) {
      items.removeAll { $0 === next }
      clock.ms = max(clock.ms, next.due)
      next.work()
    }
    clock.ms = target
  }
}

final class Harness {
  let clock = DirectDictationTests.TestClock()
  let folder = DirectDictationTests.tempFolder("machine")
  let capture = FakeCapture()
  let transport = FakeTransport()
  lazy var scheduler = FakeScheduler(clock: clock)
  lazy var store = DirectDictationStore(directory: folder, now: { [clock] in clock.ms })
  var configJSON: String? = DirectDictationTests.validConfig
  var cookie: String? = "session=1"
  /// The account the shared session belongs to.
  var cookieUser = "u1"
  var documentID: UUID? = UUID()
  /// The text before the cursor, as `readContextBefore` reports it.
  var contextBefore: String?
  let transcriber = FakeLocalTranscriber()
  /// False for a keyboard where Parakeet can't run (takes effect on the next process).
  var transcriberAvailable = true
  /// The keyboard's effective translation target, as `readTranslation` reports it.
  var translation: (code: String, label: String)?
  var translationReads = 0
  /// The audio route's port types, as `readRoutePortTypes` reports them.
  var routePortTypes = ["Speaker"]
  /// Runs after each `readTranslation`, to change the target between two reads.
  var afterTranslationRead: (() -> Void)?
  /// The App Group the capture-lease heartbeat is read from; nil reads as no meeting.
  var meetingDefaults: UserDefaults?
  var encodeError: Error?
  var encodeGains: [Float] = []
  var texts: [String] = []
  var states: [DirectDictationState] = []
  var levels: [Float] = []
  private var jobCounter = 0

  lazy var dictation: DirectDictation = makeDictation()

  /// iOS killed the keyboard and started it again: a new machine over the same files.
  func restartProcess() {
    dictation = makeDictation()
  }

  private func makeDictation() -> DirectDictation {
    let machine = DirectDictation(DirectDependencies(
      capture: capture,
      transport: transport,
      scheduler: scheduler,
      store: store,
      readConfigJSON: { [unowned self] in self.configJSON },
      readCookie: { [unowned self] userId in userId == self.cookieUser ? self.cookie : nil },
      readTone: { "default" },
      readTranslation: { [unowned self] in
        self.translationReads += 1
        defer { self.afterTranslationRead?() }
        return self.translation
      },
      readRoutePortTypes: { [unowned self] in self.routePortTypes },
      encode: { [unowned self] pcm, m4a, gain in
        self.encodeGains.append(gain)
        if let error = self.encodeError { throw error }
        try? FileManager.default.removeItem(at: m4a)
        try FileManager.default.copyItem(at: pcm, to: m4a)
      },
      makeJobId: { [unowned self] in
        self.jobCounter += 1
        return "job-\(self.jobCounter)"
      },
      makeBoundary: { "B" },
      localTranscriber: transcriberAvailable ? transcriber : nil,
      isMeetingRecording: { [unowned self] in
        MeetingCaptureLease.isMeetingRecording(defaults: self.meetingDefaults, nowMs: self.clock.ms)
      }
    ))
    machine.readDocumentID = { [unowned self] in self.documentID }
    machine.readContextBefore = { [unowned self] in self.contextBefore }
    machine.onText = { [unowned self] in self.texts.append($0) }
    machine.onStateChange = { [unowned self] in self.states.append($0) }
    machine.onLevel = { [unowned self] in self.levels.append($0) }
    return machine
  }

  var state: DirectDictationState { dictation.state }

  /// Alternating ±2,294: peak sample 2,294, RMS 0.07 — speech to the check.
  func loud(seconds: Double) -> Data {
    var data = Data()
    for index in 0..<Int(seconds * 16_000) {
      let sample: Int16 = index % 2 == 0 ? 2_294 : -2_294
      withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) }
    }
    return data
  }

  func silence(seconds: Double) -> Data { Data(count: Int(seconds * 16_000) * 2) }

  func feed(_ data: Data) {
    let chunk = 3_200  // 0.1 s
    var offset = 0
    while offset < data.count {
      let end = min(offset + chunk, data.count)
      capture.audio(data.subdata(in: offset..<end), rms: 0.07)
      offset = end
    }
  }

  /// Start, let capture start, and record `seconds` of speech.
  func record(seconds: Double = 1) {
    dictation.start()
    capture.started()
    feed(loud(seconds: seconds))
  }

  func files(_ jobId: String = "job-1") -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [])
      .filter { $0.hasPrefix("\(jobId).") }
      .sorted()
  }

  /// Every network call the machine made, of either kind.
  var networkCalls: Int { transport.uploads.count + transport.sends.count }

  /// A Local Mode snapshot for `model`, with the model already loaded.
  func useLocal(_ model: DirectLocalModel = .parakeetV2, ready: Bool = true) {
    configJSON = DirectDictationTests.localConfig(model: model)
    transcriber.readyModel = ready ? model : nil
  }

  func cleanup() { try? FileManager.default.removeItem(at: folder) }
}

extension DirectDictationTests {
  static let sentText = #"{"text":"send it to my email","cleanupApplied":true}"#

  static func testStateMachine() {
    machineHappyPath()
    machineStartTimeout()
    machineBluetoothStartWaitsLonger()
    machineStartFailure()
    machineEligibleAgainAfterNewSnapshot()
    machineCapAtFiveMinutes()
    machineEncodeFails()
    machineCaptureEndsByItself()
    machineLocalNoSpeech()
    machineCancelWhileRecording()
    machineCancelWhileTranscribing()
    machineRefusals()
    machineRetryThenFail()
    machineRetryThenSucceed()
    machineServerNoSpeech()
    machineCleanupRetry()
    machineCleanupRetryFails()
    machineCleanupOff()
    machineDisappearWhileRecording()
    machineDisappearWithNoSpeech()
    machineResumeOnAppear()
    machineResumeTooLate()
    machineDisappearWhileTranscribing()
    machineDoubleStart()
    machineIneligible()
    machineControllerReplaced()
    machineRecoverAfterKill()
    machineRecoverSilenceAfterKill()
    machineCookieForAnotherAccount()
    machineDeliveryRequiresOriginalDestination()
    machineResumeRequiresOriginalDocument()
    machineRecoverQuietSpeech()
    machineCleanupMissingFlag()
    testLocalEligibleOnlyWhenModelReady()
    testLocalNotEligibleWhenLoadedModelDiffers()
    testLocalTakeTranscribesWithoutNetwork()
    testLocalTranscriptionFailureKeepsPcm()
    testLocalRecordIsNeverResumedAsUpload()
    testLocalResultWaitsForSameDocument()
    testLocalNoSpeechNeverTranscribes()
    testLocalAsksTranscriberToPrepare()
    machineLocalDisappearWhileRecording()
    machineLocalCancelWhileTranscribing()
    machineCloudResultWaitsForSameDocument()
    machineUndeliveredTextExpires()
    machineLocalEmptyTextFails()
    machineTranslates()
    machineTranslationFails()
    machineCancelWhileTranslating()
    machineTranslationTargetPinnedAtStart()
    machineTranslationOffInKeyboard()
    machineTranslationSameLanguage()
    machineTranslatesAfterCleanupRetry()
    machineResumeKeepsTranslationTarget()
    machineTranslationWhileHidden()
    machineStandsDownWhenSnapshotCannotTranslate()
    machineStartReadsTargetOnce()
    machineResumedTakeCannotTranslate()
    machineLocalStandsDownForTranslationTarget()
    machineLocalStaleTranslationNeverSends()
  }

  /// The contract's Local snapshot for `model`, with an English hint and cleanup switched on
  /// (which a Local snapshot never has), so a stray cleanup call would show up as a send.
  static func localConfig(model: DirectLocalModel) -> String {
    localConfig
      .replacingOccurrences(of: "parakeet-v3", with: model.rawValue)
      .replacingOccurrences(of: #""languageHint":"de""#, with: #""languageHint":"en""#)
      .replacingOccurrences(of: #""cleanup":{"enabled":false"#, with: #""cleanup":{"enabled":true"#)
  }

  static func testLocalEligibleOnlyWhenModelReady() {
    let h = Harness()
    defer { h.cleanup() }
    h.cookie = nil  // Local needs no session
    h.useLocal(.parakeetV2, ready: false)
    expect(h.dictation.isEligible, false, "local: not eligible before the model is ready")
    h.dictation.start()
    expect(h.capture.startCount, 0, "local: nothing starts before the model is ready")
    h.transcriber.readyModel = .parakeetV2
    expect(h.dictation.isEligible, true, "local: eligible once the model is ready, without a cookie")
    h.transcriberAvailable = false
    h.restartProcess()
    expect(h.dictation.isEligible, false, "local: never eligible where Parakeet can't run")
    expect(h.networkCalls, 0, "local eligibility: no network")
  }

  static func testLocalNotEligibleWhenLoadedModelDiffers() {
    let h = Harness()
    defer { h.cleanup() }
    h.useLocal(.parakeetV3, ready: false)
    h.transcriber.readyModel = .parakeetV2
    expect(h.dictation.isEligible, false, "local: v2 loaded, v3 asked: not eligible")
    expect(h.transcriber.prepared.last, .parakeetV3, "local: the snapshot's model is asked for")
    h.dictation.start()
    expect(h.capture.startCount, 0, "local: v2 loaded, v3 asked: nothing starts")

    // A take started with v2, and the language moved the route to v3 before stop.
    let switched = Harness()
    defer { switched.cleanup() }
    switched.useLocal(.parakeetV2)
    switched.record()
    switched.configJSON = localConfig(model: .parakeetV3)
    switched.transcriber.readyModel = .parakeetV3
    switched.dictation.confirm()
    expect(switched.transcriber.calls.count, 0, "local: a v2 take is never transcribed with another model")
    expect(switched.state, .failed(.tryAgain), "local: model changed mid-take: try again")
    expect(switched.files(), ["job-1.json", "job-1.pcm"], "local: model changed mid-take: take kept")
    expect(switched.networkCalls, 0, "local: model changed mid-take: no network")
  }

  static func testLocalTakeTranscribesWithoutNetwork() {
    let h = Harness()
    defer { h.cleanup() }
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    expect(h.store.record(jobId: "job-1")?.engine, "parakeet-v2", "local: the record names its model from the start")
    h.dictation.confirm()
    expect(h.state, .transcribing, "local: transcribing")
    expect(h.transcriber.calls.count, 1, "local: transcribed once")
    expect(h.transcriber.calls.first?.wavURL, h.store.wavURL(jobId: "job-1"), "local: gets <jobId>.wav")
    expect(h.transcriber.calls.first?.languageHint, "en", "local: gets the hint")
    expect(h.transcriber.calls.first?.wavBytes, 44 + 32_000, "local: the WAV holds the whole take, as captured")
    expect(h.encodeGains.count, 0, "local: never encoded for upload")
    expect(h.transport.uploads.count, 0, "local: no upload")
    expect(h.transport.sends.count, 0, "local: no send")
    h.transcriber.succeed("send it to my email")
    expect(h.state, .idle, "local: idle")
    expect(h.texts, ["send it to a@b.co"], "local: snippet-expanded text inserted")
    let record = h.store.record(jobId: "job-1")
    expect(record?.status, .completed, "local: record completed")
    expect(record?.engine, "parakeet-v2", "local: record engine")
    expect(record?.cleanupApplied == nil, true, "local: cleanupApplied nil")
    expect(record?.originalText, "send it to my email", "local: original is the raw text")
    expect(record?.durationMs, 1_000, "local: duration")
    expect(h.files(), ["job-1.json"], "local: .pcm and .wav gone")
    expect(h.networkCalls, 0, "local: no network at all, cleanup on in the snapshot or not")
  }

  static func testLocalTranscriptionFailureKeepsPcm() {
    let h = Harness()
    defer { h.cleanup() }
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    h.dictation.confirm()
    h.transcriber.fail()
    expect(h.state, .failed(.tryAgain), "local fail: try again")
    expect(h.store.record(jobId: "job-1")?.status, .failed, "local fail: record failed")
    expect(h.files(), ["job-1.json", "job-1.pcm"], "local fail: PCM kept for History, WAV removed")
    expect(h.dictation.isEligible, true, "local fail: path stays on")
    expect(h.networkCalls, 0, "local fail: no retry over the network")
    h.dictation.start()
    expect(h.state, .starting, "local fail: the next take starts")
  }

  // Killed mid-take with Local, then Cloud with a working session: the take must stay on the
  // device (the app's outbox makes it a retryable row).
  static func testLocalRecordIsNeverResumedAsUpload() {
    let h = Harness()
    defer { h.cleanup() }
    h.useLocal(.parakeetV2)
    h.record(seconds: 2)
    h.restartProcess()
    h.configJSON = validConfig
    h.cookie = "session=1"
    expect(h.dictation.isEligible, true, "local resume: Cloud is eligible now")
    h.dictation.keyboardDidAppear()
    expect(h.networkCalls, 0, "local resume: nothing uploaded or sent")
    expect(h.encodeGains.count, 0, "local resume: not encoded for upload")
    expect(h.state, .idle, "local resume: idle")
    expect(h.store.record(jobId: "job-1")?.status, .pending, "local resume: record left for the app")
    expect(h.files(), ["job-1.json", "job-1.pcm"], "local resume: PCM kept")

    // Still Local: the keyboard doesn't resume it either.
    h.useLocal(.parakeetV2)
    h.restartProcess()
    h.dictation.keyboardDidAppear()
    expect(h.transcriber.calls.count, 0, "local resume: not transcribed on return")
    expect(h.networkCalls, 0, "local resume: still no network")
  }

  static func testLocalResultWaitsForSameDocument() {
    let h = Harness()
    defer { h.cleanup() }
    let original = h.documentID
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    h.dictation.confirm()
    h.dictation.keyboardWillDisappear()
    expect(h.transcriber.calls.first?.handle.cancelled, false, "local hidden: transcription left running")
    h.transcriber.succeed("hello there")
    expect(h.texts, [], "local hidden: nothing typed while hidden")
    expect(h.store.record(jobId: "job-1")?.status, .completed, "local hidden: saved for History")
    h.documentID = UUID()
    h.dictation.keyboardDidAppear()
    expect(h.texts, [], "local hidden: another field never receives it")
    h.dictation.keyboardWillDisappear()
    h.documentID = original
    h.transcriber.readyModel = nil  // released meanwhile: the text needs no model
    h.dictation.keyboardDidAppear()
    expect(h.texts, ["hello there"], "local hidden: typed once back in the original field")
    h.dictation.keyboardWillDisappear()
    h.dictation.keyboardDidAppear()
    expect(h.texts.count, 1, "local hidden: typed only once")

    // Same field, another account: never.
    let other = Harness()
    defer { other.cleanup() }
    other.useLocal(.parakeetV2)
    other.record(seconds: 1)
    other.dictation.confirm()
    other.dictation.keyboardWillDisappear()
    other.transcriber.succeed("hello there")
    other.configJSON = localConfig(model: .parakeetV2).replacingOccurrences(of: #""u1""#, with: #""u2""#)
    other.dictation.keyboardDidAppear()
    expect(other.texts, [], "local hidden: another account never receives it")
  }

  static func testLocalNoSpeechNeverTranscribes() {
    let h = Harness()
    defer { h.cleanup() }
    h.useLocal(.parakeetV2)
    h.dictation.start()
    h.capture.started()
    h.feed(h.silence(seconds: 1))
    h.dictation.confirm()
    expect(h.state, .failed(.noSpeech), "local silence: no speech")
    expect(h.transcriber.calls.count, 0, "local silence: transcriber not called")
    expect(h.files(), [], "local silence: files deleted")
    expect(h.networkCalls, 0, "local silence: no network")
  }

  static func testLocalAsksTranscriberToPrepare() {
    let h = Harness()
    defer { h.cleanup() }
    h.useLocal(.parakeetV2, ready: false)
    _ = h.dictation.isEligible
    expect(h.transcriber.prepared, [.parakeetV2], "local: reading eligibility asks for the model once")
    expect(h.networkCalls, 0, "local warm-up: no network")
    h.transcriber.readyModel = .parakeetV2
    _ = h.dictation.isEligible
    expect(h.transcriber.prepared.count, 1, "local: a ready model isn't asked for again")
  }

  static func machineLocalDisappearWhileRecording() {
    let h = Harness()
    defer { h.cleanup() }
    h.useLocal(.parakeetV2)
    h.record(seconds: 2)
    h.dictation.keyboardWillDisappear()
    expect(h.capture.stopCount >= 1, true, "local disappear recording: capture stopped")
    expect(h.transcriber.calls.count, 1, "local disappear recording: transcribed on the device")
    expect(h.encodeGains.count, 0, "local disappear recording: never encoded")
    h.transcriber.succeed("hello")
    expect(h.texts, [], "local disappear recording: nothing typed while hidden")
    h.dictation.keyboardDidAppear()
    expect(h.texts, ["hello"], "local disappear recording: typed on return")
    expect(h.networkCalls, 0, "local disappear recording: no network")
  }

  // A transcriber that reports success with no words: a failed take, never an empty insert.
  static func machineLocalEmptyTextFails() {
    let h = Harness()
    defer { h.cleanup() }
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    h.dictation.confirm()
    h.transcriber.succeed(" \n ")
    expect(h.state, .failed(.tryAgain), "local empty: try again")
    expect(h.texts, [], "local empty: nothing typed")
    expect(h.store.record(jobId: "job-1")?.status, .failed, "local empty: record failed")
    expect(h.files(), ["job-1.json", "job-1.pcm"], "local empty: PCM kept for a retry")
    expect(h.networkCalls, 0, "local empty: no network")
  }

  static func machineLocalCancelWhileTranscribing() {
    let h = Harness()
    defer { h.cleanup() }
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    h.dictation.confirm()
    h.dictation.cancel()
    expect(h.transcriber.calls.first?.handle.cancelled, true, "local cancel: transcription cancelled")
    expect(h.state, .idle, "local cancel: idle")
    expect(h.files(), [], "local cancel: no files")
    h.transcriber.succeed("late")
    expect(h.texts, [], "local cancel: a late result inserts nothing")
  }

  // Text left undelivered waits only as long as a take may be resumed: coming back to the field
  // much later must not type an old dictation unprompted.
  static func machineUndeliveredTextExpires() {
    let window = Double(DirectDictationStore.resumeWindowMs) / 1000

    let inside = Harness()
    defer { inside.cleanup() }
    inside.useLocal(.parakeetV2)
    inside.record(seconds: 1)
    inside.dictation.confirm()
    inside.dictation.keyboardWillDisappear()
    inside.transcriber.succeed("still fresh")
    inside.scheduler.advance(seconds: window - 1)
    inside.dictation.keyboardDidAppear()
    expect(inside.texts, ["still fresh"], "undelivered: typed inside the window")

    let late = Harness()
    defer { late.cleanup() }
    late.useLocal(.parakeetV2)
    late.record(seconds: 1)
    late.dictation.confirm()
    late.dictation.keyboardWillDisappear()
    late.transcriber.succeed("too old")
    late.scheduler.advance(seconds: window + 1)
    late.dictation.keyboardDidAppear()
    expect(late.texts, [], "undelivered: a Local result is dropped after the window")
    expect(late.store.record(jobId: "job-1")?.status, .completed, "undelivered: still saved for History")
    late.dictation.keyboardWillDisappear()
    late.dictation.keyboardDidAppear()
    expect(late.texts, [], "undelivered: and never typed later")

    let cloud = Harness()
    defer { cloud.cleanup() }
    cloud.record(seconds: 1)
    cloud.dictation.confirm()
    cloud.dictation.keyboardWillDisappear()
    cloud.transport.uploads.first?.complete(200, sentText)
    cloud.scheduler.advance(seconds: window + 1)
    cloud.dictation.keyboardDidAppear()
    expect(cloud.texts, [], "undelivered: a Cloud result is dropped after the window too")
  }

  // The same keep-until-delivered rule for a Cloud take answered while hidden.
  static func machineCloudResultWaitsForSameDocument() {
    let h = Harness()
    defer { h.cleanup() }
    let original = h.documentID
    h.record(seconds: 1)
    h.dictation.confirm()
    h.dictation.keyboardWillDisappear()
    h.transport.uploads.first?.complete(200, sentText)
    h.documentID = UUID()
    h.dictation.keyboardDidAppear()
    expect(h.texts, [], "cloud hidden: another field never receives it")
    h.dictation.keyboardWillDisappear()
    h.documentID = original
    h.dictation.keyboardDidAppear()
    expect(h.texts, ["send it to a@b.co"], "cloud hidden: typed once back in the original field")
    // A new take drops a result still waiting.
    let dropped = Harness()
    defer { dropped.cleanup() }
    let first = dropped.documentID
    dropped.record(seconds: 1)
    dropped.dictation.confirm()
    dropped.dictation.keyboardWillDisappear()
    dropped.transport.uploads.first?.complete(200, sentText)
    dropped.documentID = UUID()
    dropped.dictation.keyboardDidAppear()
    dropped.dictation.start()
    dropped.dictation.cancel()
    dropped.dictation.keyboardWillDisappear()
    dropped.documentID = first
    dropped.dictation.keyboardDidAppear()
    expect(dropped.texts, [], "cloud hidden: a newer take replaces the waiting result")
  }

  static func machineStandsDownWhenSnapshotCannotTranslate() {
    // A language picked in the keyboard that this snapshot can't translate into: the keyboard's
    // other route records instead, so the app translates on the user's own route.
    let blocked = Harness()
    defer { blocked.cleanup() }
    blocked.translation = (code: "es", label: "Spanish")
    expect(blocked.dictation.isEligible, false, "target without snapshot translation: not eligible")
    expect(blocked.dictation.isEligibleIgnoringTranslation, true,
           "target without snapshot translation: capture is still prepared, for picking Off later")
    blocked.dictation.start()
    expect(blocked.capture.startCount, 0, "target without snapshot translation: nothing starts")
    expect(blocked.state, .idle, "target without snapshot translation: idle")
    expect(blocked.files(), [], "target without snapshot translation: no record")
    expect(blocked.transport.uploads.count, 0, "target without snapshot translation: no upload")
    blocked.translation = nil
    expect(blocked.dictation.isEligible, true, "Off picked later: eligible again")

    // Exactly the dictation language ("en"): the app wouldn't translate it either, so standing
    // down would only cost app-closed dictation.
    let sameLanguage = Harness()
    defer { sameLanguage.cleanup() }
    sameLanguage.translation = (code: "en", label: "English")
    expect(sameLanguage.dictation.isEligible, true, "exact dictation language: eligible without snapshot translation")
    sameLanguage.record()
    sameLanguage.dictation.confirm()
    sameLanguage.transport.uploads.first?.complete(200, sentText)
    expect(sameLanguage.transport.sends.count, 0, "exact dictation language: no translate request")
    expect(sameLanguage.texts, ["send it to a@b.co"], "exact dictation language: typed as dictated")
    let sameRecord = sameLanguage.store.record(jobId: "job-1")
    expect(sameRecord?.translationTarget, "en", "exact dictation language: target recorded")
    expect(sameRecord?.translationFailed, false, "exact dictation language: not a failed translation")

    let regional = Harness()
    defer { regional.cleanup() }
    regional.translation = (code: "en-US", label: "English (US)")
    expect(regional.dictation.isEligible, false, "a regional target of the dictation language still stands down")
    regional.dictation.start()
    expect(regional.capture.startCount, 0, "regional target without snapshot translation: nothing starts")

    let translating = translatedHarness()
    defer { translating.cleanup() }
    expect(translating.dictation.isEligible, true, "target with snapshot translation: eligible")
    translating.dictation.start()
    expect(translating.capture.startCount, 1, "target with snapshot translation: starts")

    let off = Harness()
    defer { off.cleanup() }
    expect(off.dictation.isEligible, true, "translation Off: eligible as before")
    off.dictation.start()
    expect(off.capture.startCount, 1, "translation Off: starts")

    // A take already on disk resumes with its stored target, whatever the keyboard shows now.
    let resumed = Harness()
    defer { resumed.cleanup() }
    resumed.record(seconds: 2)
    resumed.dictation.keyboardWillDisappear()
    resumed.translation = (code: "es", label: "Spanish")
    resumed.dictation.keyboardDidAppear()
    expect(resumed.transport.uploads.count, 1, "recovery is not gated")
    resumed.transport.uploads.first?.complete(200, sentText)
    expect(resumed.texts, ["send it to a@b.co"], "recovery: delivered untranslated, as it started")
    expect(resumed.store.record(jobId: "job-1")?.translationFailed, false, "recovery: started without a target, so no warning")
  }

  static func machineStartReadsTargetOnce() {
    // A target picked right after the gate looked must not reach the take ungated.
    let h = Harness()
    defer { h.cleanup() }
    h.afterTranslationRead = { [unowned h] in h.translation = (code: "es", label: "Spanish") }
    h.dictation.start()
    expect(h.translationReads, 1, "start reads the target once")
    expect(h.capture.startCount, 1, "start: the gate passed with no target")
    expect(h.store.record(jobId: "job-1")?.translationTarget == nil, true, "start: records the target the gate checked")
  }

  static func machineResumedTakeCannotTranslate() {
    // Started translating, resumed under a snapshot that no longer can: typed untranslated, and
    // History is told.
    let h = translatedHarness()
    defer { h.cleanup() }
    h.record(seconds: 2)
    h.dictation.keyboardWillDisappear()
    h.configJSON = validConfig
    h.dictation.keyboardDidAppear()
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.transport.sends.count, 0, "resumed, can't translate: no translate request")
    expect(h.texts, ["send it to a@b.co"], "resumed, can't translate: typed untranslated")
    let record = h.store.record(jobId: "job-1")
    expect(record?.translationFailed, true, "resumed, can't translate: recorded as not translated")
    expect(record?.translatedTo == nil, true, "resumed, can't translate: no translatedTo")
    expect(record?.translationTarget, "es", "resumed, can't translate: target kept for History")
  }

  static func translatedHarness() -> Harness {
    let h = Harness()
    h.configJSON = translatedConfig
    h.translation = (code: "es", label: "Spanish")
    return h
  }

  /// A Local snapshot that (stale or hand-edited) says translation is on. The app never writes
  /// one: buildKeyboardDirectConfig turns translation off for every Local snapshot.
  static func staleTranslatingLocalConfig(model: DirectLocalModel) -> String {
    localConfig(model: model).replacingOccurrences(
      of: #""snippets":"#,
      with: #""translation":{"enabled":true,"prompt":"Translate the text into {{targetLanguage}}."},"snippets":"#
    )
  }

  static func machineLocalStandsDownForTranslationTarget() {
    // A language picked in the keyboard over a Local snapshot: as for a Cloud route the keyboard
    // can't translate on, direct dictation stands down and the take goes to the app.
    let h = Harness()
    defer { h.cleanup() }
    h.cookie = nil
    h.useLocal(.parakeetV3)
    h.translation = (code: "es", label: "Spanish")
    expect(h.dictation.isEligible, false, "local + target: not eligible, the app takes it")
    expect(h.dictation.isEligibleIgnoringTranslation, true, "local + target: capture still prepared for Off")
    h.dictation.start()
    expect(h.capture.startCount, 0, "local + target: nothing starts")
    expect(h.files(), [], "local + target: no record")
    expect(h.transcriber.calls.count, 0, "local + target: nothing transcribed")
    expect(h.networkCalls, 0, "local + target: no network")
    h.translation = nil
    expect(h.dictation.isEligible, true, "local, Off picked: eligible again")

    // Exactly the dictation language ("de" in the Local fixture): nothing to translate, so the
    // keyboard keeps the take, records no target, and types the raw text.
    let same = Harness()
    defer { same.cleanup() }
    same.useLocal(.parakeetV3)
    same.translation = (code: "de", label: "German")
    expect(same.dictation.isEligible, true, "local + the dictation language: eligible")
    same.record()
    same.dictation.confirm()
    same.transcriber.succeed("schick es an my email")
    expect(same.texts, ["schick es an a@b.co"], "local + the dictation language: raw text, snippets expanded")
    let record = same.store.record(jobId: "job-1")
    expect(record?.engine, "parakeet-v3", "local + the dictation language: engine recorded")
    expect(record?.translationTarget == nil, true, "local + the dictation language: no target recorded")
    expect(record?.translatedTo == nil, true, "local + the dictation language: not translated")
    expect(record?.translationFailed, false, "local + the dictation language: no warning")
    expect(same.networkCalls, 0, "local + the dictation language: no network")
  }

  static func machineLocalStaleTranslationNeverSends() {
    // Fails closed in the keyboard too: a Local snapshot that says translation is on still never
    // takes a target, and so never builds a translate request.
    let h = Harness()
    defer { h.cleanup() }
    h.configJSON = staleTranslatingLocalConfig(model: .parakeetV2)
    h.transcriber.readyModel = .parakeetV2
    expect(DirectDictationConfig.decode(h.configJSON)?.translation.enabled, true, "fixture: translation on")
    h.translation = (code: "es", label: "Spanish")
    expect(h.dictation.isEligible, false, "stale local + target: stands down")
    h.dictation.start()
    expect(h.capture.startCount, 0, "stale local + target: nothing starts")
    expect(h.networkCalls, 0, "stale local + target: no network")

    // A target picked mid-take doesn't change a running Local take (the target is pinned at
    // start, for either engine): it is typed raw and no request is made.
    h.translation = nil
    h.record()
    h.translation = (code: "es", label: "Spanish")
    h.dictation.confirm()
    h.transcriber.succeed("send it to my email")
    expect(h.texts, ["send it to a@b.co"], "stale local: raw text typed")
    expect(h.store.record(jobId: "job-1")?.translationFailed, false, "stale local: no translation warning")
    expect(h.networkCalls, 0, "stale local: no translate request")

    // The dictation language as target with translation on: kept on the device, never sent.
    let same = Harness()
    defer { same.cleanup() }
    same.configJSON = staleTranslatingLocalConfig(model: .parakeetV2)
    same.transcriber.readyModel = .parakeetV2
    same.translation = (code: "de", label: "German")
    same.record()
    same.dictation.confirm()
    same.transcriber.succeed("hallo")
    expect(same.texts, ["hallo"], "stale local, dictation language: raw text")
    expect(same.store.record(jobId: "job-1")?.translationTarget == nil, true, "stale local: no target recorded")
    expect(same.networkCalls, 0, "stale local, dictation language: no network")
  }

  static func sentBody(_ call: FakeCall?) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: call?.request.httpBody ?? Data())) as? [String: Any] ?? [:]
  }

  static func machineTranslates() {
    let h = translatedHarness()
    defer { h.cleanup() }
    h.record()
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.transport.sends.count, 1, "translate: one reason call")
    expect(h.transport.sends.first?.request.url?.path, "/api/reason", "translate: to /api/reason")
    expect(sentBody(h.transport.sends.first)["text"] as? String, "send it to a@b.co",
           "translate: snippets are expanded before translation")
    expect(sentBody(h.transport.sends.first)["systemPrompt"] as? String, "Translate the text into Spanish.",
           "translate: the prompt names the target")
    expect(h.state, .transcribing, "translate: still transcribing while translating")
    expect(h.texts, [], "translate: nothing typed before the translation")
    // The reply is typed as is: a snippet trigger in it is not expanded a second time.
    h.transport.sends.first?.complete(200, #"{"text":"envíalo a my email"}"#)
    expect(h.texts, ["envíalo a my email"], "translate: the translation is typed once, not expanded again")
    expect(h.state, .idle, "translate: idle")
    let record = h.store.record(jobId: "job-1")
    expect(record?.text, "envíalo a my email", "translate: record has the translation")
    expect(record?.translatedTo, "es", "translate: record says translated to es")
    expect(record?.originalText, "send it to my email", "translate: originalText stays the raw transcript")
    expect(record?.translationTarget, "es", "translate: target recorded at start")
    expect(record?.translationFailed, false, "translate: not a failed translation")
  }

  static func machineTranslationFails() {
    // An unchanged reply is already in the target language, as the app and desktop read it: no warning.
    for (status, body, name, failed) in [(500, "", "500", true), (0, "", "transport error", true),
                                         (403, #"{"text":"Hola"}"#, "refused", true),
                                         (200, #"{"text":""}"#, "empty reply", true),
                                         (200, "<html>", "unreadable reply", true),
                                         (200, #"{"text":"send it to a@b.co"}"#, "unchanged reply", false)] {
      let h = translatedHarness()
      h.record()
      h.dictation.confirm()
      h.transport.uploads.first?.complete(200, sentText)
      h.transport.sends.first?.complete(status, body)
      expect(h.transport.sends.count, 1, "translate \(name): not retried")
      expect(h.texts, ["send it to a@b.co"], "translate \(name): the untranslated, expanded text is typed")
      expect(h.store.record(jobId: "job-1")?.translatedTo == nil, true, "translate \(name): record not translated")
      expect(h.store.record(jobId: "job-1")?.status, .completed, "translate \(name): record completed")
      expect(h.store.record(jobId: "job-1")?.translationFailed, failed, "translate \(name): translationFailed")
      h.cleanup()
    }
  }

  static func machineCancelWhileTranslating() {
    let h = translatedHarness()
    defer { h.cleanup() }
    h.record()
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, sentText)
    h.dictation.cancel()
    expect(h.transport.sends.first?.cancelled, true, "cancel translating: request cancelled")
    expect(h.state, .idle, "cancel translating: idle")
    expect(h.files(), [], "cancel translating: no files")
    h.transport.sends.first?.complete(200, #"{"text":"Hola"}"#)
    expect(h.texts, [], "cancel translating: a late translation inserts nothing")
    expect(h.files(), [], "cancel translating: a late translation writes nothing")

    // A newer dictation: the first one's late translation still belongs to nobody.
    h.record()
    expect(h.state, .recording, "cancel translating: a new take starts")
    h.transport.sends.first?.complete(200, #"{"text":"Hola"}"#)
    expect(h.texts, [], "superseded: the old translation inserts nothing")
    expect(h.store.record(jobId: "job-2")?.status, .pending, "superseded: the new take is untouched")
  }

  static func machineTranslationTargetPinnedAtStart() {
    let h = translatedHarness()
    defer { h.cleanup() }
    h.dictation.start()
    h.translation = (code: "fr", label: "French")
    h.capture.started()
    h.feed(h.loud(seconds: 1))
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, sentText)
    expect(sentBody(h.transport.sends.first)["systemPrompt"] as? String, "Translate the text into Spanish.",
           "pinned: the language start() saw")
    h.transport.sends.first?.complete(200, #"{"text":"Hola"}"#)
    expect(h.store.record(jobId: "job-1")?.translatedTo, "es", "pinned: translatedTo is the start's target")
  }

  static func machineTranslationOffInKeyboard() {
    // (A target the snapshot can't translate: machineStandsDownWhenSnapshotCannotTranslate.)
    let none = translatedHarness()
    defer { none.cleanup() }
    none.translation = nil
    none.record()
    none.dictation.confirm()
    none.transport.uploads.first?.complete(200, sentText)
    expect(none.transport.sends.count, 0, "translation off in the keyboard: no translate request")
    expect(none.texts, ["send it to a@b.co"], "translation off in the keyboard: text typed")
    expect(none.store.record(jobId: "job-1")?.translationFailed, false, "translation off in the keyboard: no warning")
  }

  static func machineTranslationSameLanguage() {
    let h = translatedHarness()
    defer { h.cleanup() }
    // The snapshot's dictation language is "en"; only an exact match skips.
    h.translation = (code: "en", label: "English")
    h.record()
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.transport.sends.count, 0, "same language: no translate request")
    expect(h.texts, ["send it to a@b.co"], "same language: text typed")
    expect(h.store.record(jobId: "job-1")?.translationFailed, false, "same language: not a failed translation")
  }

  static func machineTranslatesAfterCleanupRetry() {
    let h = translatedHarness()
    defer { h.cleanup() }
    h.record()
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, #"{"text":"raw words","cleanupApplied":false}"#)
    expect(h.transport.sends.count, 1, "cleanup then translate: cleanup first")
    expect(sentBody(h.transport.sends.first)["purpose"] as? String, "cleanup", "cleanup then translate: cleanup call")
    h.transport.sends.first?.complete(200, #"{"text":"Clean words."}"#)
    expect(h.transport.sends.count, 2, "cleanup then translate: then translation")
    expect(sentBody(h.transport.sends.last)["text"] as? String, "Clean words.", "cleanup then translate: translates the cleaned text")
    h.transport.sends.last?.complete(200, #"{"text":"Palabras limpias."}"#)
    expect(h.texts, ["Palabras limpias."], "cleanup then translate: translation typed")
    let record = h.store.record(jobId: "job-1")
    expect(record?.cleanupApplied, true, "cleanup then translate: cleaned")
    expect(record?.originalText, "raw words", "cleanup then translate: raw transcript kept")
    expect(record?.translatedTo, "es", "cleanup then translate: translated")
  }

  static func machineResumeKeepsTranslationTarget() {
    for restart in [false, true] {
      let h = translatedHarness()
      h.record(seconds: 2)
      h.dictation.keyboardWillDisappear()
      if restart { h.restartProcess() }
      h.translation = (code: "fr", label: "French")
      h.dictation.keyboardDidAppear()
      h.transport.uploads.first?.complete(200, sentText)
      expect(sentBody(h.transport.sends.first)["systemPrompt"] as? String, "Translate the text into Spanish.",
             "resume (restart \(restart)): the recorded target, not the live one")
      h.transport.sends.first?.complete(200, #"{"text":"Hola"}"#)
      expect(h.store.record(jobId: "job-1")?.translatedTo, "es", "resume (restart \(restart)): translatedTo es")
      expect(h.texts, ["Hola"], "resume (restart \(restart)): translation typed")
      h.cleanup()
    }
  }

  static func machineTranslationWhileHidden() {
    let h = translatedHarness()
    defer { h.cleanup() }
    h.record()
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, sentText)
    h.dictation.keyboardWillDisappear()
    expect(h.transport.sends.first?.cancelled, false, "hidden translating: request left running")
    h.transport.sends.first?.complete(200, #"{"text":"Hola"}"#)
    expect(h.texts, [], "hidden translating: nothing typed while hidden")
    h.dictation.keyboardDidAppear()
    expect(h.texts, ["Hola"], "hidden translating: typed on return")
  }

  static func machineDeliveryRequiresOriginalDestination() {
    for hidden in [false, true] {
      for changeAccount in [false, true] {
        let h = Harness()
        defer { h.cleanup() }
        h.record()
        h.dictation.confirm()
        if hidden { h.dictation.keyboardWillDisappear() }
        let changeDestination = {
          if changeAccount {
            h.cookieUser = "other-user"
            h.configJSON = validConfig.replacingOccurrences(of: #""u1""#, with: #""other-user""#)
          } else {
            h.documentID = UUID()
          }
        }
        if !hidden { changeDestination() }
        h.transport.uploads.first?.complete(200, sentText)
        if hidden {
          changeDestination()
          h.dictation.keyboardDidAppear()
        }
        expect(h.texts, [], "a different account or field never receives the finished take")
        expect(h.store.record(jobId: "job-1")?.status, .completed, "the result is saved for History")
      }
    }
  }

  static func machineResumeRequiresOriginalDocument() {
    let h = Harness()
    defer { h.cleanup() }
    let original = h.documentID
    h.record()
    h.dictation.keyboardWillDisappear()
    h.restartProcess()
    h.documentID = UUID()
    h.dictation.keyboardDidAppear()
    expect(h.transport.uploads.count, 0, "another field cannot resume the pending recording")
    h.documentID = original
    h.dictation.keyboardDidAppear()
    expect(h.transport.uploads.count, 1, "the originating field can resume the recording")
    h.documentID = nil
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.texts, [], "a missing destination cannot receive the result")
  }

  static func machineRecoverQuietSpeech() {
    let h = Harness()
    defer { h.cleanup() }
    h.dictation.start()
    h.capture.started()
    h.feed(pcm(seconds: 1, amplitude: 0.003))
    h.restartProcess()
    h.dictation.keyboardDidAppear()
    expect(h.state, .transcribing, "quiet speech receives the same gain on recovery as a live take")
  }

  static func machineCleanupMissingFlag() {
    let h = Harness()
    defer { h.cleanup() }
    h.record()
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, #"{"raw_text":"raw words"}"#)
    expect(h.transport.sends.count, 1, "a raw-only response still gets the requested cleanup")
    h.transport.sends.first?.complete(200, #"{"text":"Clean words."}"#)
    expect(h.texts, ["Clean words."], "the cleaned text is inserted")
  }

  // Killed mid-take: the record is pending with its .pcm and no .m4a (or a cut-off partial).
  static func machineRecoverAfterKill() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 2)
    try? Data("cut off".utf8).write(to: DirectAudioEncoder.partialURL(for: h.store.audioURL(jobId: "job-1")))
    h.restartProcess()
    h.dictation.keyboardDidAppear()
    expect(h.encodeGains.count, 1, "recover: the take is encoded")
    expect(abs((h.encodeGains.first ?? 0) - 10) < 0.01, true, "recover: gain from the take's peak")
    expect(h.state, .transcribing, "recover: transcribing")
    expect(h.transport.uploads.count, 1, "recover: uploaded")
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.texts, ["send it to a@b.co"], "recover: text inserted")
    expect(h.store.record(jobId: "job-1")?.durationMs, 2_000, "recovery measures the PCM written before interruption")
    expect(h.files(), ["job-1.json"], "recover: only the record is left")
  }

  static func machineRecoverSilenceAfterKill() {
    let h = Harness()
    defer { h.cleanup() }
    h.dictation.start()
    h.capture.started()
    h.feed(h.silence(seconds: 2))
    h.restartProcess()
    h.dictation.keyboardDidAppear()
    expect(h.transport.uploads.count, 0, "recover silence: nothing uploaded")
    expect(h.files(), [], "recover silence: files removed")
    h.dictation.start()
    h.restartProcess()
    h.dictation.keyboardDidAppear()
    expect(h.transport.uploads.count, 0, "a process killed before the first sample has nothing to upload")
    expect(h.files("job-2"), [], "an empty take is discarded")
  }

  // The app couldn't rewrite the shared session after an account switch: never send A's
  // session with B's snapshot.
  static func machineCookieForAnotherAccount() {
    let h = Harness()
    defer { h.cleanup() }
    h.cookieUser = "u2"
    expect(h.dictation.isEligible, false, "another account's session: not eligible")
    h.dictation.start()
    expect(h.capture.startCount, 0, "another account's session: nothing starts")
  }

  static func machineHappyPath() {
    let h = Harness()
    defer { h.cleanup() }
    var recordAtCaptureStart = false
    h.capture.startHook = { recordAtCaptureStart = h.store.record(jobId: "job-1")?.status == .pending }
    h.dictation.start()
    expect(h.state, .starting, "happy: starting")
    expect(recordAtCaptureStart, true, "happy: pending record written before capture starts")
    h.capture.started()
    expect(h.state, .recording, "happy: recording")
    h.feed(h.loud(seconds: 1))
    expect(h.levels.isEmpty, false, "happy: levels reported")
    h.dictation.confirm()
    expect(h.encodeGains.count, 1, "happy: encoded once")
    expect(abs((h.encodeGains.first ?? 0) - 10) < 0.01, true, "happy: gain brings peak 2,294 to 70% (×10)")
    expect(h.state, .transcribing, "happy: transcribing")
    expect(h.transport.uploads.count, 1, "happy: one upload")
    expect(h.transport.uploads.first?.file, h.store.bodyURL(jobId: "job-1"), "happy: uploads the body file")
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.texts, ["send it to a@b.co"], "happy: snippet-expanded text inserted once")
    expect(h.state, .idle, "happy: idle")
    let record = h.store.record(jobId: "job-1")
    expect(record?.status, .completed, "happy: record completed")
    expect(record?.text, "send it to a@b.co", "happy: record has the inserted text")
    expect(h.files(), ["job-1.json"], "happy: only the record is left")
  }

  static func machineStartTimeout() {
    let h = Harness()
    defer { h.cleanup() }
    h.dictation.start()
    h.scheduler.advance(seconds: 3.01)
    expect(h.state, .failed(.captureUnavailable), "timeout: capture unavailable")
    expect(h.capture.stopCount >= 1, true, "timeout: capture stopped")
    expect(h.dictation.isEligible, false, "timeout: path off")
    expect(h.files(), [], "timeout: no record left")
  }

  /// A Bluetooth link can take longer than the built-in mic to start, so a slow start there
  /// still records instead of dropping the take and turning the path off.
  static func machineBluetoothStartWaitsLonger() {
    let h = Harness()
    defer { h.cleanup() }
    h.routePortTypes = ["BluetoothA2DPOutput"]
    h.dictation.start()
    h.scheduler.advance(seconds: 5)
    expect(h.state, .starting, "bluetooth: still starting after the default timeout")
    h.capture.started()
    expect(h.state, .recording, "bluetooth: a slow start records")
    expect(h.dictation.isEligible, true, "bluetooth: path stays on")

    let slow = Harness()
    defer { slow.cleanup() }
    slow.routePortTypes = ["BluetoothHFP"]
    slow.dictation.start()
    slow.scheduler.advance(seconds: 8.01)
    expect(slow.state, .failed(.captureUnavailable), "bluetooth: a start that never comes still times out")
    expect(slow.dictation.isEligible, false, "bluetooth timeout: path off")
  }

  static func machineStartFailure() {
    let h = Harness()
    defer { h.cleanup() }
    h.dictation.start()
    h.capture.ended("failed: NotAllowedError")
    expect(h.state, .failed(.captureUnavailable), "start failure: capture unavailable")
    expect(h.dictation.isEligible, false, "start failure: path off")
    expect(h.files(), [], "start failure: no record left")
  }

  static func machineEligibleAgainAfterNewSnapshot() {
    let h = Harness()
    defer { h.cleanup() }
    h.dictation.start()
    h.scheduler.advance(seconds: 3.01)
    expect(h.dictation.isEligible, false, "new snapshot: off first")
    h.configJSON = validConfig + " "
    expect(h.dictation.isEligible, true, "new snapshot: on again")
    h.dictation.start()
    expect(h.state, .starting, "new snapshot: starts again")
  }

  static func machineCapAtFiveMinutes() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    h.scheduler.advance(seconds: 299)
    expect(h.state, .recording, "cap: still recording at 299 s")
    h.scheduler.advance(seconds: 1.01)
    expect(h.state, .transcribing, "cap: transcribes at 300 s")
    expect(h.transport.uploads.count, 1, "cap: uploaded")
  }

  static func machineEncodeFails() {
    let h = Harness()
    defer { h.cleanup() }
    h.encodeError = NSError(domain: "test", code: 1)
    h.record(seconds: 1)
    h.dictation.confirm()
    expect(h.state, .failed(.tryAgain), "encode fails: try again")
    expect(h.store.record(jobId: "job-1")?.status, .failed, "encode fails: record failed")
    expect(h.files(), ["job-1.json", "job-1.pcm"], "encode fails: History can retry from PCM")
    expect(h.dictation.isEligible, true, "encode fails: path stays on")
    expect(h.transport.uploads.count, 0, "encode fails: nothing uploaded")
  }

  static func machineCaptureEndsByItself() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 2)
    h.capture.ended("interrupted: track-ended")
    expect(h.state, .transcribing, "capture ends: transcribes what it has")
    expect(h.transport.uploads.count, 1, "capture ends: uploaded")
  }

  static func machineLocalNoSpeech() {
    let h = Harness()
    defer { h.cleanup() }
    h.dictation.start()
    h.capture.started()
    h.feed(h.silence(seconds: 1))
    h.dictation.confirm()
    expect(h.state, .failed(.noSpeech), "local no speech: no speech")
    expect(h.transport.uploads.count, 0, "local no speech: nothing uploaded")
    expect(h.files(), [], "local no speech: files deleted")
  }

  static func machineCancelWhileRecording() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    h.dictation.cancel()
    expect(h.state, .idle, "cancel recording: idle")
    expect(h.capture.stopCount >= 1, true, "cancel recording: capture stopped")
    expect(h.files(), [], "cancel recording: no files")
  }

  static func machineCancelWhileTranscribing() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    h.dictation.confirm()
    h.dictation.cancel()
    expect(h.transport.uploads.first?.cancelled, true, "cancel transcribing: request cancelled")
    expect(h.state, .idle, "cancel transcribing: idle")
    expect(h.files(), [], "cancel transcribing: no files")
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.texts, [], "cancel transcribing: a late answer inserts nothing")
    expect(h.state, .idle, "cancel transcribing: still idle")
  }

  static func machineRefusals() {
    for (status, failure, name) in [(401, DirectFailure.signInAgain, "401"), (403, .setUpInApp, "403"),
                                    (429, .limitReached, "429")] {
      let h = Harness()
      h.record(seconds: 1)
      h.dictation.confirm()
      h.transport.uploads.first?.complete(status, "{}")
      expect(h.state, .failed(failure), "\(name): failure")
      expect(h.dictation.isEligible, false, "\(name): path off")
      expect(h.store.record(jobId: "job-1")?.status, .failed, "\(name): record failed")
      expect(h.files(), ["job-1.json", "job-1.m4a"], "\(name): audio kept for a retry in the app")
      h.cleanup()
    }
  }

  static func machineRetryThenFail() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    h.dictation.confirm()
    h.transport.uploads.first?.complete(500)
    expect(h.transport.uploads.count, 2, "retry fail: retried once")
    expect(h.state, .transcribing, "retry fail: still transcribing")
    h.transport.uploads.last?.complete(500)
    expect(h.transport.uploads.count, 2, "retry fail: no third try")
    expect(h.state, .failed(.tryAgain), "retry fail: try again")
    expect(h.store.record(jobId: "job-1")?.status, .failed, "retry fail: record failed")
    expect(h.files(), ["job-1.json", "job-1.m4a"], "retry fail: audio kept")
    expect(h.dictation.isEligible, true, "retry fail: path stays on")
  }

  static func machineRetryThenSucceed() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    h.dictation.confirm()
    h.transport.uploads.first?.complete(0)
    h.transport.uploads.last?.complete(200, sentText)
    expect(h.texts, ["send it to a@b.co"], "retry success: inserted once")
    expect(h.state, .idle, "retry success: idle")
  }

  static func machineServerNoSpeech() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    h.dictation.confirm()
    h.transport.uploads.first?.complete(422, #"{"code":"NO_SPEECH_DETECTED"}"#)
    expect(h.state, .failed(.noSpeech), "server no speech: no speech")
    expect(h.files(), [], "server no speech: files deleted")
  }

  static func machineCleanupRetry() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, #"{"text":"raw words","originalText":"raw words","cleanupApplied":false}"#)
    expect(h.transport.sends.count, 1, "cleanup retry: one reason call")
    expect(h.transport.sends.first?.request.url?.path, "/api/reason", "cleanup retry: to /api/reason")
    expect(h.state, .transcribing, "cleanup retry: still transcribing")
    h.transport.sends.first?.complete(200, #"{"text":"Clean words."}"#)
    expect(h.texts, ["Clean words."], "cleanup retry: cleaned text inserted")
    expect(h.store.record(jobId: "job-1")?.cleanupApplied, true, "cleanup retry: record says cleaned")
    expect(h.store.record(jobId: "job-1")?.originalText, "raw words", "cleanup retry: original kept")
  }

  static func machineCleanupRetryFails() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, #"{"text":"raw words","cleanupApplied":false}"#)
    h.transport.sends.first?.complete(500)
    expect(h.texts, ["raw words"], "cleanup retry fails: raw text inserted")
    expect(h.store.record(jobId: "job-1")?.cleanupApplied, false, "cleanup retry fails: record says not cleaned")
  }

  static func machineCleanupOff() {
    let h = Harness()
    defer { h.cleanup() }
    h.configJSON = validConfig.replacingOccurrences(of: #""cleanup":{"enabled":true"#, with: #""cleanup":{"enabled":false"#)
    h.record(seconds: 1)
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, #"{"text":"raw words"}"#)
    expect(h.transport.sends.count, 0, "cleanup off: no reason call")
    expect(h.texts, ["raw words"], "cleanup off: text inserted")
  }

  static func machineDisappearWhileRecording() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 2)
    h.dictation.keyboardWillDisappear()
    expect(h.capture.stopCount >= 1, true, "disappear recording: capture stopped")
    expect(h.encodeGains.count, 1, "disappear recording: take encoded")
    expect(h.store.record(jobId: "job-1")?.status, .pending, "disappear recording: record pending")
    expect(h.files(), ["job-1.json", "job-1.m4a"], "disappear recording: encoded audio kept")
    expect(h.state, .idle, "disappear recording: idle")
    expect(h.transport.uploads.count, 0, "disappear recording: nothing uploaded")
  }

  static func machineDisappearWithNoSpeech() {
    let h = Harness()
    defer { h.cleanup() }
    h.dictation.start()
    h.capture.started()
    h.feed(h.silence(seconds: 2))
    h.dictation.keyboardWillDisappear()
    expect(h.files(), [], "disappear silence: files removed")
    expect(h.store.resumable(userId: "u1", documentID: h.documentID!) == nil, true, "disappear silence: nothing to resume")
  }

  static func machineResumeOnAppear() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 2)
    h.dictation.keyboardWillDisappear()
    h.scheduler.advance(seconds: 60)
    h.dictation.keyboardDidAppear()
    expect(h.state, .transcribing, "resume: transcribing")
    expect(h.transport.uploads.count, 1, "resume: uploaded")
    let body = (try? Data(contentsOf: h.store.bodyURL(jobId: "job-1"))).map { String(decoding: $0, as: UTF8.self) } ?? ""
    expect(body.contains("\r\n\r\njob-1\r\n"), true, "resume: same job id")
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.store.record(jobId: "job-1")?.durationMs, 2_000, "resume keeps the recording duration")
    expect(h.texts, ["send it to a@b.co"], "resume: text inserted")
    expect(h.store.record(jobId: "job-1")?.status, .completed, "resume: record completed")
  }

  static func machineResumeTooLate() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 2)
    h.dictation.keyboardWillDisappear()
    h.scheduler.advance(seconds: 11 * 60)
    h.dictation.keyboardDidAppear()
    expect(h.transport.uploads.count, 0, "too late: nothing uploaded")
    expect(h.state, .idle, "too late: idle")
  }

  static func machineDisappearWhileTranscribing() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    h.dictation.confirm()
    h.dictation.keyboardWillDisappear()
    expect(h.transport.uploads.first?.cancelled, false, "disappear transcribing: request left running")
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.store.record(jobId: "job-1")?.status, .completed, "disappear transcribing: record completed")
    expect(h.texts, [], "disappear transcribing: nothing typed while hidden")
    h.dictation.keyboardDidAppear()
    expect(h.texts, ["send it to a@b.co"], "disappear transcribing: typed once on return")
    expect(h.transport.uploads.count, 1, "disappear transcribing: not uploaded again")
    h.dictation.keyboardWillDisappear()
    h.dictation.keyboardDidAppear()
    expect(h.texts.count, 1, "disappear transcribing: typed only once")
  }

  static func machineDoubleStart() {
    let h = Harness()
    defer { h.cleanup() }
    h.dictation.start()
    h.dictation.start()
    expect(h.capture.startCount, 1, "double start: one capture start")
    let records = ((try? FileManager.default.contentsOfDirectory(atPath: h.folder.path)) ?? []).filter { $0.hasSuffix(".json") }
    expect(records.count, 1, "double start: one record")
  }

  static func machineIneligible() {
    let noCookie = Harness()
    noCookie.cookie = nil
    expect(noCookie.dictation.isEligible, false, "ineligible: no cookie")
    noCookie.dictation.start()
    expect(noCookie.state, .idle, "ineligible: no cookie does nothing")
    expect(noCookie.capture.startCount, 0, "ineligible: no capture")
    noCookie.cleanup()

    let badConfig = Harness()
    badConfig.configJSON = "{"
    expect(badConfig.dictation.isEligible, false, "ineligible: bad config")
    badConfig.dictation.start()
    expect(badConfig.capture.startCount, 0, "ineligible: bad config does nothing")
    badConfig.cleanup()
  }

  static func machineControllerReplaced() {
    let h = Harness()
    defer { h.cleanup() }
    h.record(seconds: 1)
    var newTexts: [String] = []
    var newStates: [DirectDictationState] = []
    var newLevels: [Float] = []
    h.dictation.onText = { newTexts.append($0) }
    h.dictation.onStateChange = { newStates.append($0) }
    h.dictation.onLevel = { newLevels.append($0) }
    h.feed(h.loud(seconds: 1))
    h.dictation.confirm()
    h.transport.uploads.first?.complete(200, sentText)
    expect(newLevels.isEmpty, false, "replaced: new controller gets levels")
    expect(newStates.contains(.transcribing), true, "replaced: new controller gets states")
    expect(newTexts, ["send it to a@b.co"], "replaced: new controller gets the text")
    expect(h.texts, [], "replaced: old controller gets nothing")
  }
}
