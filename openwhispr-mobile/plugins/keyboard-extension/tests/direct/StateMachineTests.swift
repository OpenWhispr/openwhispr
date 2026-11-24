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
  /// The keyboard's effective translation target, as `readTranslation` reports it.
  var translation: (code: String, label: String)?
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
      readTranslation: { [unowned self] in self.translation },
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
      makeBoundary: { "B" }
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

    let sameLanguage = Harness()
    defer { sameLanguage.cleanup() }
    sameLanguage.translation = (code: "en-US", label: "English (US)")
    expect(sameLanguage.dictation.isEligible, false, "no same-language exception")

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
  }

  static func translatedHarness() -> Harness {
    let h = Harness()
    h.configJSON = translatedConfig
    h.translation = (code: "es", label: "Spanish")
    return h
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
  }

  static func machineTranslationFails() {
    for (status, body, name) in [(500, "", "500"), (0, "", "transport error"),
                                 (200, #"{"text":"send it to a@b.co"}"#, "unchanged reply"),
                                 (200, #"{"text":""}"#, "empty reply")] {
      let h = translatedHarness()
      h.record()
      h.dictation.confirm()
      h.transport.uploads.first?.complete(200, sentText)
      h.transport.sends.first?.complete(status, body)
      expect(h.transport.sends.count, 1, "translate \(name): not retried")
      expect(h.texts, ["send it to a@b.co"], "translate \(name): the untranslated, expanded text is typed")
      expect(h.store.record(jobId: "job-1")?.translatedTo == nil, true, "translate \(name): record not translated")
      expect(h.store.record(jobId: "job-1")?.status, .completed, "translate \(name): record completed")
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
