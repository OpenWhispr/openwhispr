import AVFoundation
import UIKit

/// What the keyboard's view controller asks of the direct path. The runtime in the keyboard;
/// a fake in the touch tests.
@MainActor
protocol DirectDictationControlling: AnyObject {
  var canRecordHere: Bool { get }
  var state: DirectDictationState { get }
  var readDocumentID: (() -> UUID?)? { get set }
  /// The text before the cursor: what tells a field iOS has renamed is still the same place.
  var readContextBefore: (() -> String?)? { get set }
  /// A take waits to be inserted: finished text that was not typed, or a Cloud take not yet sent.
  var hasHeldDictation: Bool { get }
  var onHeldChange: (() -> Void)? { get set }
  func insertHeld()
  func discardHeld()
  func fieldChanged()
  var onStateChange: ((DirectDictationState) -> Void)? { get set }
  var onLevel: ((Float) -> Void)? { get set }
  var onText: ((String) -> Void)? { get set }
  /// One line per on-device model load or transcription (timings and MB, never text). The runtime
  /// also keeps them in `direct-dictations/local-model.log` in the App Group.
  var onLocalModelLog: ((String) -> Void)? { get set }
  /// The on-device model became ready or stopped being ready (loaded, released, swapped), so
  /// whether the keyboard can dictate this way may have changed. Called on the main thread,
  /// never from inside an eligibility read.
  var onLocalModelReadyChange: (() -> Void)? { get set }
  func attach(to view: UIView)
  /// Starts loading the on-device model a Local snapshot names, so the next tap can use it.
  func warmUp()
  /// A memory warning: lets go of the on-device model once no transcription needs it.
  func releaseLocalModelWhenIdle()
  func start()
  func confirm()
  func cancel()
  func keyboardWillDisappear()
  func keyboardDidAppear()
}

/// Real dependencies for `DirectDictation`, one per keyboard process. The view controller is
/// recreated by iOS within a process, so it attaches to this rather than owning the dictation.
@available(iOS 26.0, *)
@MainActor
final class DirectDictationRuntime {
  static let shared = DirectDictationRuntime()

  let dictation: DirectDictation
  private let capture = WebAudioCapture()
  private let hasContainer: Bool
  #if canImport(FluidAudio)
  private let parakeet: KeyboardParakeetTranscriber
  /// Every model line also goes to the App Group file, which a Release build can be read from.
  private let localModelLog: DirectLocalModelLog?
  private var localModelLogListener: ((String) -> Void)?
  #endif

  private init() {
    let appGroupId = "group.\(Self.containingAppBundleIdentifier)"
    let defaults = UserDefaults(suiteName: appGroupId)
    let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    hasContainer = container != nil
    let folder = (container ?? FileManager.default.temporaryDirectory)
      .appendingPathComponent(DirectDictationStore.folderName, isDirectory: true)
    let store = DirectDictationStore(directory: folder, now: { Int64(Date().timeIntervalSince1970 * 1000) })
    store.prune()
    #if canImport(FluidAudio)
    let parakeet = KeyboardParakeetTranscriber(appGroupContainer: container)
    self.parakeet = parakeet
    localModelLog = container.map { _ in DirectLocalModelLog(url: folder.appendingPathComponent(DirectLocalModelLog.fileName)) }
    let localTranscriber: DirectLocalTranscriber? = parakeet
    #else
    let localTranscriber: DirectLocalTranscriber? = nil
    #endif

    dictation = DirectDictation(DirectDependencies(
      capture: capture,
      transport: URLSessionTransport(),
      scheduler: MainQueueScheduler(),
      store: store,
      readConfigJSON: { defaults?.string(forKey: "keyboard_direct_config") },
      readCookie: { userId in KeyboardCredentialStore.readCookie(accessGroup: appGroupId, userId: userId) },
      readTone: { defaults?.string(forKey: "keyboard_dictation_tone") ?? "default" },
      readTranslation: { directDictationTranslation() },
      readRoutePortTypes: {
        let route = AVAudioSession.sharedInstance().currentRoute
        return (route.inputs + route.outputs).map { $0.portType.rawValue }
      },
      encode: { pcm, m4a, gain in try DirectAudioEncoder.encodeAAC(pcmURL: pcm, m4aURL: m4a, gain: gain) },
      // The job id format the keyboard already uses: <ms>-<UUID>.
      makeJobId: { "\(Int64(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString)" },
      makeBoundary: { "OpenWhispr-\(UUID().uuidString)" },
      localTranscriber: localTranscriber,
      isMeetingRecording: {
        MeetingCaptureLease.isMeetingRecording(defaults: defaults, nowMs: Int64(Date().timeIntervalSince1970 * 1000))
      }
    ))
    #if canImport(FluidAudio)
    parakeet.log = { [weak self] line in
      self?.localModelLog?.append(line, at: Date())
      self?.localModelLogListener?(line)
    }
    #endif
  }

  /// The path is usable right now: the snapshot and the session allow it, OpenWhispr has the
  /// microphone, and recording here wouldn't interrupt the user's audio. `isEligible` is false
  /// while the app records a meeting (its capture-lease heartbeat), so the keyboard never takes
  /// the microphone from one.
  var canRecordHere: Bool {
    guard hasContainer, readDocumentID?() != nil, dictation.isEligible, AVAudioApplication.shared.recordPermission == .granted else {
      return false
    }
    return !DirectAudioRoute.blocksDirectCapture(
      otherAudioPlaying: AVAudioSession.sharedInstance().isOtherAudioPlaying
    )
  }

  /// Moves the hidden web view into this controller's view. The web view is only made for a
  /// keyboard that can dictate this way.
  func attach(to view: UIView) {
    guard dictation.isEligibleIgnoringTranslation else { return }
    capture.attach(to: view)
  }

  // As KeyboardViewController and KeyboardHandoffProvider resolve it.
  private static var containingAppBundleIdentifier: String {
    if let configured = Bundle.main.object(forInfoDictionaryKey: "OpenWhisprContainingAppBundleIdentifier") as? String,
      !configured.isEmpty
    {
      return configured
    }
    let bundleID = Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr.keyboard"
    let suffix = ".keyboard"
    return bundleID.hasSuffix(suffix) ? String(bundleID.dropLast(suffix.count)) : bundleID
  }
}

@available(iOS 26.0, *)
extension DirectDictationRuntime: DirectDictationControlling {
  var state: DirectDictationState { dictation.state }

  var readDocumentID: (() -> UUID?)? {
    get { dictation.readDocumentID }
    set { dictation.readDocumentID = newValue }
  }

  var readContextBefore: (() -> String?)? {
    get { dictation.readContextBefore }
    set { dictation.readContextBefore = newValue }
  }

  var hasHeldDictation: Bool { dictation.hasHeldDictation }

  var onHeldChange: (() -> Void)? {
    get { dictation.onHeldChange }
    set { dictation.onHeldChange = newValue }
  }

  func insertHeld() { dictation.insertHeld() }
  func discardHeld() { dictation.discardHeld() }
  func fieldChanged() { dictation.fieldChanged() }

  var onStateChange: ((DirectDictationState) -> Void)? {
    get { dictation.onStateChange }
    set { dictation.onStateChange = newValue }
  }

  var onLevel: ((Float) -> Void)? {
    get { dictation.onLevel }
    set { dictation.onLevel = newValue }
  }

  var onText: ((String) -> Void)? {
    get { dictation.onText }
    set { dictation.onText = newValue }
  }

  var onLocalModelLog: ((String) -> Void)? {
    get {
      #if canImport(FluidAudio)
      return localModelLogListener
      #else
      return nil
      #endif
    }
    set {
      #if canImport(FluidAudio)
      localModelLogListener = newValue
      #endif
    }
  }

  var onLocalModelReadyChange: (() -> Void)? {
    get {
      #if canImport(FluidAudio)
      return parakeet.onReadyChange
      #else
      return nil
      #endif
    }
    set {
      #if canImport(FluidAudio)
      parakeet.onReadyChange = newValue
      #endif
    }
  }

  // Reading eligibility asks the transcriber to prepare a Local snapshot's model.
  func warmUp() { _ = dictation.isEligible }

  func releaseLocalModelWhenIdle() {
    #if canImport(FluidAudio)
    parakeet.releaseWhenIdle()
    #endif
  }

  func start() { dictation.start() }
  func confirm() { dictation.confirm() }
  func cancel() { dictation.cancel() }
  func keyboardWillDisappear() { dictation.keyboardWillDisappear() }
  func keyboardDidAppear() { dictation.keyboardDidAppear() }
}

/// No cookie store or cache, so the only credential sent is the explicit Cookie header, and
/// completions come back on the main thread, where `DirectDictation` lives.
private final class URLSessionTransport: DirectTransport {
  private let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration)
  }()

  func upload(_ request: URLRequest, fromFile: URL, completion: @escaping (Int, Data) -> Void) -> DirectCancellable {
    let task = session.uploadTask(with: request, fromFile: fromFile) { data, response, error in
      Self.deliver(data, response, error, completion)
    }
    task.resume()
    return TaskCancellable(task: task)
  }

  func send(_ request: URLRequest, completion: @escaping (Int, Data) -> Void) -> DirectCancellable {
    let task = session.dataTask(with: request) { data, response, error in
      Self.deliver(data, response, error, completion)
    }
    task.resume()
    return TaskCancellable(task: task)
  }

  private static func deliver(
    _ data: Data?, _ response: URLResponse?, _ error: Error?, _ completion: @escaping (Int, Data) -> Void
  ) {
    let status = error == nil ? ((response as? HTTPURLResponse)?.statusCode ?? 0) : 0
    let body = data ?? Data()
    DispatchQueue.main.async { completion(status, body) }
  }
}

private struct TaskCancellable: DirectCancellable {
  let task: URLSessionTask
  func cancel() { task.cancel() }
}

private struct MainQueueScheduler: DirectScheduler {
  func after(_ seconds: TimeInterval, _ work: @escaping () -> Void) -> DirectCancellable {
    let item = DispatchWorkItem(block: work)
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    return WorkItemCancellable(item: item)
  }
}

private struct WorkItemCancellable: DirectCancellable {
  let item: DispatchWorkItem
  func cancel() { item.cancel() }
}
