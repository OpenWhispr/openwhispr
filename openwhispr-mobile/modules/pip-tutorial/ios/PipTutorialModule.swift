import ExpoModulesCore
import AVKit
import AVFoundation
import UIKit
import os.log

private let log = Logger(subsystem: "com.gizmolabs.openwhispr", category: "PipTutorial")

// Outcomes `start` resolves with. Anything but `started` means no overlay is showing;
// JS reports the unexpected ones so a silent failure shows up in Sentry.
private enum StartOutcome {
  static let started = "started"
  static let unsupported = "unsupported"
  static let videoMissing = "video_missing"
  static let noRootView = "no_root_view"
  static let controllerFailed = "controller_failed"
  static let timeout = "timeout"
  static let stopped = "stopped"
  static func failed(_ error: Error) -> String { "failed:\(error.localizedDescription)" }
}

public class PipTutorialModule: Module {
  private var player: AVPlayer?
  private var playerLayer: AVPlayerLayer?
  private var pipController: AVPictureInPictureController?
  private var delegateRetainer: PipDelegate?
  private var loopObserver: NSObjectProtocol?
  private var statusObserver: NSKeyValueObservation?
  private var startPromise: Promise?
  private var startTimeoutWorkItem: DispatchWorkItem?
  // True only while the session is the one this module configured, so teardown
  // never deactivates a session the dictation mic owns.
  private var ownsAudioSession = false

  public func definition() -> ModuleDefinition {
    Name("PipTutorial")

    Function("isAvailable") { () -> Bool in
      return AVPictureInPictureController.isPictureInPictureSupported()
    }

    AsyncFunction("start") { (videoName: String, promise: Promise) in
      self.startPip(videoName: videoName, promise: promise)
    }

    AsyncFunction("stop") { () -> Void in
      self.teardown()
    }

    OnDestroy {
      self.teardown()
    }
  }

  private func startPip(videoName: String, promise: Promise) {
    log.info("start(\(videoName, privacy: .public))")

    guard AVPictureInPictureController.isPictureInPictureSupported() else {
      log.error("PiP not supported on this device")
      promise.resolve(StartOutcome.unsupported)
      return
    }

    guard let url = Bundle.main.url(forResource: videoName, withExtension: "mp4") else {
      log.error("Video not found in bundle: \(videoName).mp4")
      promise.resolve(StartOutcome.videoMissing)
      return
    }
    log.info("Video URL: \(url.absoluteString, privacy: .public)")

    DispatchQueue.main.async { [weak self] in
      guard let self = self else {
        promise.resolve(StartOutcome.stopped)
        return
      }
      self.teardownOnMain()

      guard let rootView = Self.activeRootView() else {
        log.error("No root view found; cannot attach player layer")
        promise.resolve(StartOutcome.noRootView)
        return
      }

      self.prepareAudioSession()

      let player = AVPlayer(url: url)
      player.isMuted = true
      player.actionAtItemEnd = .none
      self.player = player
      self.startPromise = promise

      let timeoutWorkItem = DispatchWorkItem { [weak self] in
        guard let self = self else { return }
        if self.pipController?.isPictureInPictureActive == true {
          log.info("PiP start callback timed out after activation; keeping session alive")
          self.resolveStart(StartOutcome.started)
          return
        }
        let possible = self.pipController?.isPictureInPicturePossible == true
        log.error("Timed out waiting for PiP to start (possible=\(possible, privacy: .public))")
        self.teardownOnMain(outcome: "\(StartOutcome.timeout):possible=\(possible)")
      }
      self.startTimeoutWorkItem = timeoutWorkItem
      DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: timeoutWorkItem)

      // PiP stays impossible for a layer outside the visible window, so keep it on
      // screen at a single point in the top-left corner, which the display's rounded
      // corner hides.
      let layer = AVPlayerLayer(player: player)
      layer.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
      layer.videoGravity = .resizeAspectFill
      rootView.layer.addSublayer(layer)
      self.playerLayer = layer
      log.info("Player layer attached to root view")

      guard let pipController = AVPictureInPictureController(playerLayer: layer) else {
        log.error("Failed to create AVPictureInPictureController")
        self.teardownOnMain(outcome: StartOutcome.controllerFailed)
        return
      }
      if #available(iOS 14.2, *) {
        pipController.canStartPictureInPictureAutomaticallyFromInline = true
      }
      let delegate = PipDelegate(
        onDidStart: { [weak self] in
          self?.resolveStart(StartOutcome.started)
        },
        onFailedToStart: { [weak self] error in
          self?.resolveStart(StartOutcome.failed(error))
        }
      )
      pipController.delegate = delegate
      self.delegateRetainer = delegate
      self.pipController = pipController

      self.loopObserver = NotificationCenter.default.addObserver(
        forName: .AVPlayerItemDidPlayToEndTime,
        object: player.currentItem,
        queue: .main
      ) { [weak player] _ in
        player?.seek(to: .zero)
        player?.play()
      }

      // Observe the player's readiness and trigger PiP as soon as it's playable.
      // Trying to start PiP before the player is ready often fails silently.
      self.statusObserver = pipController.observe(
        \.isPictureInPicturePossible, options: [.initial, .new]
      ) { [weak self] controller, _ in
        log.info("isPictureInPicturePossible = \(controller.isPictureInPicturePossible, privacy: .public)")
        if controller.isPictureInPicturePossible, !controller.isPictureInPictureActive {
          DispatchQueue.main.async {
            controller.startPictureInPicture()
            log.info("startPictureInPicture() invoked")
          }
          self?.statusObserver?.invalidate()
          self?.statusObserver = nil
        }
      }

      player.play()
      log.info("player.play() called")
    }
  }

  // The dictation mic keeps a `.playAndRecord` session running while it's warm, and a
  // recording holds `.record`. Switching either to `.playback` would cut the mic's input,
  // and `.playAndRecord` already allows PiP, so only configure a session nobody has set up
  // (or one an earlier tutorial left as `.playback`).
  private func prepareAudioSession() {
    let session = AVAudioSession.sharedInstance()
    let category = session.category
    guard category == .ambient || category == .soloAmbient || category == .playback else {
      log.info("Leaving audio session as \(category.rawValue, privacy: .public)")
      return
    }
    do {
      try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
      try session.setActive(true, options: [])
      ownsAudioSession = true
    } catch {
      log.error("AVAudioSession setup failed: \(error.localizedDescription)")
    }
  }

  private func releaseAudioSession() {
    guard ownsAudioSession else { return }
    ownsAudioSession = false
    let session = AVAudioSession.sharedInstance()
    // The dictation mic may have taken the session over since the tutorial started.
    guard session.category == .playback else { return }
    try? session.setActive(false, options: [.notifyOthersOnDeactivation])
  }

  private func resolveStart(_ outcome: String) {
    startTimeoutWorkItem?.cancel()
    startTimeoutWorkItem = nil
    guard let promise = startPromise else { return }
    startPromise = nil
    promise.resolve(outcome)
  }

  private func teardown() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.teardownOnMain()
    }
  }

  private func teardownOnMain(outcome: String = StartOutcome.stopped) {
    resolveStart(outcome)
    statusObserver?.invalidate()
    statusObserver = nil
    if let observer = loopObserver {
      NotificationCenter.default.removeObserver(observer)
      loopObserver = nil
    }
    pipController?.stopPictureInPicture()
    player?.pause()
    playerLayer?.removeFromSuperlayer()
    player = nil
    playerLayer = nil
    pipController = nil
    delegateRetainer = nil
    releaseAudioSession()
  }

  private static func activeRootView() -> UIView? {
    let scenes = UIApplication.shared.connectedScenes
    for scene in scenes {
      guard let windowScene = scene as? UIWindowScene else { continue }
      if let window = windowScene.windows.first(where: { $0.isKeyWindow })
        ?? windowScene.windows.first
      {
        return window.rootViewController?.view
      }
    }
    return nil
  }
}

private final class PipDelegate: NSObject, AVPictureInPictureControllerDelegate {
  private let onDidStart: () -> Void
  private let onFailedToStart: (Error) -> Void

  init(onDidStart: @escaping () -> Void, onFailedToStart: @escaping (Error) -> Void) {
    self.onDidStart = onDidStart
    self.onFailedToStart = onFailedToStart
  }

  func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
    log.info("PiP will start")
  }
  func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
    log.info("PiP did start")
    onDidStart()
  }
  func pictureInPictureController(
    _ controller: AVPictureInPictureController,
    failedToStartPictureInPictureWithError error: Error
  ) {
    log.error("PiP failed to start: \(error.localizedDescription)")
    onFailedToStart(error)
  }
  func pictureInPictureControllerWillStopPictureInPicture(_ controller: AVPictureInPictureController) {
    log.info("PiP will stop")
  }
  func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
    log.info("PiP did stop")
  }
}
