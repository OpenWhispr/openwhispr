import AVFoundation
import UIKit

/// What the keyboard's view controller asks of the direct path. The runtime in the keyboard;
/// a fake in the touch tests.
@MainActor
protocol DirectDictationControlling: AnyObject {
  var canRecordHere: Bool { get }
  var state: DirectDictationState { get }
  var onStateChange: ((DirectDictationState) -> Void)? { get set }
  var onLevel: ((Float) -> Void)? { get set }
  var onText: ((String) -> Void)? { get set }
  func attach(to view: UIView)
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

  private init() {
    let appGroupId = "group.\(Self.containingAppBundleIdentifier)"
    let defaults = UserDefaults(suiteName: appGroupId)
    let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    hasContainer = container != nil
    let folder = (container ?? FileManager.default.temporaryDirectory)
      .appendingPathComponent(DirectDictationStore.folderName, isDirectory: true)
    let store = DirectDictationStore(directory: folder, now: { Int64(Date().timeIntervalSince1970 * 1000) })
    store.prune()

    dictation = DirectDictation(DirectDependencies(
      capture: capture,
      transport: URLSessionTransport(),
      scheduler: MainQueueScheduler(),
      store: store,
      readConfigJSON: { defaults?.string(forKey: "keyboard_direct_config") },
      readCookie: { userId in KeyboardCredentialStore.readCookie(accessGroup: appGroupId, userId: userId) },
      readTone: { defaults?.string(forKey: "keyboard_dictation_tone") ?? "default" },
      encode: { pcm, m4a, gain in try DirectAudioEncoder.encodeAAC(pcmURL: pcm, m4aURL: m4a, gain: gain) },
      // The job id format the keyboard already uses: <ms>-<UUID>.
      makeJobId: { "\(Int64(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString)" },
      makeBoundary: { "OpenWhispr-\(UUID().uuidString)" }
    ))
  }

  /// The path is usable right now: the snapshot and the session allow it, OpenWhispr has the
  /// microphone, and recording here wouldn't interrupt the user's audio.
  var canRecordHere: Bool {
    guard hasContainer, dictation.isEligible, AVAudioApplication.shared.recordPermission == .granted else {
      return false
    }
    let session = AVAudioSession.sharedInstance()
    return !DirectAudioRoute.blocksDirectCapture(
      otherAudioPlaying: session.isOtherAudioPlaying,
      outputPortTypes: session.currentRoute.outputs.map { $0.portType.rawValue }
    )
  }

  /// Why the keyboard can or can't record by itself right now, and what the last capture
  /// did. For the diagnostics menu.
  var diagnosticsSummary: String {
    let session = AVAudioSession.sharedInstance()
    let capture = WebAudioCapture.diagnostics
    return String(
      format: "container %@, eligible %@, mic %@, other audio %@, output %@ · captures %d (started %d), %d chunks at %d Hz, peak %.3f, last end: %@ · state %@",
      hasContainer ? "yes" : "no",
      dictation.isEligible ? "yes" : "no",
      AVAudioApplication.shared.recordPermission == .granted ? "granted" : "not granted",
      session.isOtherAudioPlaying ? "yes" : "no",
      session.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: "+"),
      capture.starts, capture.started, capture.chunks, capture.sampleRate, capture.peakRms, capture.lastEnd,
      String(describing: dictation.state)
    ) + " · " + DirectDictation.lastTake + " · " + DirectDictation.lastResponse
  }

  /// Moves the hidden web view into this controller's view. The web view is only made for a
  /// keyboard that can dictate this way.
  func attach(to view: UIView) {
    guard dictation.isEligible else { return }
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
