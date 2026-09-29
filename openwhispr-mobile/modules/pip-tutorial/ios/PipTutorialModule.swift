import ExpoModulesCore
import AVKit
import AVFoundation
import UIKit
import os.log

private let log = Logger(subsystem: "com.gizmolabs.openwhispr", category: "PipTutorial")

public class PipTutorialModule: Module {
  private var player: AVPlayer?
  private var playerLayer: AVPlayerLayer?
  private var pipController: AVPictureInPictureController?
  private var delegateRetainer: PipDelegate?
  private var loopObserver: NSObjectProtocol?
  private var statusObserver: NSKeyValueObservation?
  private var startPromise: Promise?
  private var startTimeoutWorkItem: DispatchWorkItem?

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
      promise.resolve(false)
      return
    }

    guard let url = Bundle.main.url(forResource: videoName, withExtension: "mp4") else {
      log.error("Video not found in bundle: \(videoName).mp4")
      promise.resolve(false)
      return
    }
    log.info("Video URL: \(url.absoluteString, privacy: .public)")

    DispatchQueue.main.async { [weak self] in
      guard let self = self else {
        promise.resolve(false)
        return
      }
      self.resolveStart(false)
      self.teardownOnMain()

      guard let rootView = Self.activeRootView() else {
        log.error("No root view found; cannot attach player layer")
        promise.resolve(false)
        return
      }

      do {
        try AVAudioSession.sharedInstance().setCategory(
          .playback, mode: .moviePlayback, options: [.mixWithOthers])
        try AVAudioSession.sharedInstance().setActive(true, options: [])
      } catch {
        log.error("AVAudioSession setup failed: \(error.localizedDescription)")
      }

      let player = AVPlayer(url: url)
      player.isMuted = true
      player.actionAtItemEnd = .none
      self.player = player
      self.startPromise = promise

      let timeoutWorkItem = DispatchWorkItem { [weak self] in
        guard let self = self else { return }
        if self.pipController?.isPictureInPictureActive == true {
          log.info("PiP start callback timed out after activation; keeping session alive")
          self.resolveStart(true)
          return
        }
        log.error("Timed out waiting for PiP to start")
        self.teardownOnMain()
      }
      self.startTimeoutWorkItem = timeoutWorkItem
      DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: timeoutWorkItem)

      let layer = AVPlayerLayer(player: player)
      layer.frame = CGRect(x: -1000, y: -1000, width: 200, height: 100)
      layer.videoGravity = .resizeAspectFill
      rootView.layer.addSublayer(layer)
      self.playerLayer = layer
      log.info("Player layer attached to root view")

      guard let pipController = AVPictureInPictureController(playerLayer: layer) else {
        log.error("Failed to create AVPictureInPictureController")
        self.teardownOnMain()
        return
      }
      if #available(iOS 14.2, *) {
        pipController.canStartPictureInPictureAutomaticallyFromInline = true
      }
      let delegate = PipDelegate(
        onDidStart: { [weak self] in
          self?.resolveStart(true)
        },
        onFailedToStart: { [weak self] in
          self?.resolveStart(false)
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

  private func resolveStart(_ success: Bool) {
    startTimeoutWorkItem?.cancel()
    startTimeoutWorkItem = nil
    guard let promise = startPromise else { return }
    startPromise = nil
    promise.resolve(success)
  }

  private func teardown() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.teardownOnMain()
    }
  }

  private func teardownOnMain() {
    resolveStart(false)
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
    try? AVAudioSession.sharedInstance().setActive(
      false, options: [.notifyOthersOnDeactivation])
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
  private let onFailedToStart: () -> Void

  init(onDidStart: @escaping () -> Void, onFailedToStart: @escaping () -> Void) {
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
    onFailedToStart()
  }
  func pictureInPictureControllerWillStopPictureInPicture(_ controller: AVPictureInPictureController) {
    log.info("PiP will stop")
  }
  func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
    log.info("PiP did stop")
  }
}
