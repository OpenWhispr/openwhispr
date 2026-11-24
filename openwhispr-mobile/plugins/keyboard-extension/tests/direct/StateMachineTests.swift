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
  var calls: [Call] = []

  func prepare(_ model: DirectLocalModel) { prepared.append(model) }

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
  let transcriber = FakeLocalTranscriber()
  /// False for a keyboard where Parakeet can't run (takes effect on the next process).
  var transcriberAvailable = true
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
      localTranscriber: transcriberAvailable ? transcriber : nil
    ))
    machine.readDocumentID = { [unowned self] in self.documentID }
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
