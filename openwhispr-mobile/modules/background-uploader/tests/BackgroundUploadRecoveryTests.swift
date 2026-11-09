import ObjectiveC

// The network/OS callback boundary is controlled; the app delegate, module
// lifecycle and upload delegate below are the unchanged production types.
private enum RecoveryTestEnvironment {
  static let session = URLSession(configuration: .ephemeral)
  static var configurations: [URLSessionConfiguration] = []
  static var delegates: [URLSessionDelegate] = []
  static let bundleIdentifier = "com.openwhispr.recovery-tests.\(ProcessInfo.processInfo.environment["BACKGROUND_RECOVERY_TEST_ID"]!)"

  static func install() {
    let sessionMethod = class_getClassMethod(
      URLSession.self, NSSelectorFromString("sessionWithConfiguration:delegate:delegateQueue:")
    )!
    // Initialize before intercepting the factory so the replacement cannot recurse.
    _ = session
    let createSession: @convention(block) (AnyObject, URLSessionConfiguration, URLSessionDelegate?, OperationQueue?) -> URLSession = {
      _, configuration, delegate, _ in
      configurations.append(configuration)
      delegates.append(delegate!)
      return session
    }
    method_setImplementation(sessionMethod, imp_implementationWithBlock(createSession))

    // Never read or write the real app's shared preferences or Darwin notifications.
    let identifierMethod = class_getInstanceMethod(Bundle.self, #selector(getter: Bundle.bundleIdentifier))!
    let identifier: @convention(block) (AnyObject) -> String = { _ in bundleIdentifier }
    method_setImplementation(identifierMethod, imp_implementationWithBlock(identifier))
  }

  static func finishEvents() {
    let delegate = delegates.first!
    delegate.urlSessionDidFinishEvents?(forBackgroundURLSession: session)
    // The production delegate dispatches completion to the main queue.
    var drained = false
    DispatchQueue.main.async { drained = true }
    let deadline = Date().addingTimeInterval(2)
    while !drained && Date() < deadline {
      RunLoop.main.run(mode: .default, before: deadline)
    }
    precondition(drained, "Main queue did not drain")
  }

  static func deliver(_ json: String, jobId: String) {
    let task = session.dataTask(with: URL(string: "https://example.invalid/transcription")!)
    task.taskDescription = jobId
    let delegate = delegates.first as! URLSessionDataDelegate
    delegate.urlSession?(session, dataTask: task, didReceive: Data(json.utf8))
    delegate.urlSession?(session, task: task, didCompleteWithError: nil)
  }
}

@main
private struct BackgroundUploadRecoveryTests {
  static func main() {
    RecoveryTestEnvironment.install()
    let defaults = UserDefaults(suiteName: "group.\(RecoveryTestEnvironment.bundleIdentifier)")!
    defaults.removePersistentDomain(forName: "group.\(RecoveryTestEnvironment.bundleIdentifier)")
    defer {
      defaults.removePersistentDomain(forName: "group.\(RecoveryTestEnvironment.bundleIdentifier)")
      RecoveryTestEnvironment.session.invalidateAndCancel()
    }
    let subscriber: UIApplicationDelegate = AppDelegate()
    let selector = #selector(UIApplicationDelegate.application(_:handleEventsForBackgroundURLSession:completionHandler:))
    precondition(subscriber.responds(to: selector), "UIKit must be able to dispatch the background session callback")
    var completions = 0
    var completionOnMainThread = false

    var unrelatedCompletions = 0
    subscriber.application?(
      UIApplication.shared, handleEventsForBackgroundURLSession: "another-module",
      completionHandler: { unrelatedCompletions += 1 }
    )
    precondition(RecoveryTestEnvironment.configurations.isEmpty, "An unrelated session must not start the uploader")
    precondition(ExpoAppDelegate.backgroundCallbacks.count == 1)
    precondition(ExpoAppDelegate.backgroundCallbacks[0].identifier == "another-module")
    precondition(unrelatedCompletions == 0, "Let the owning Expo subscriber finish unrelated work")
    ExpoAppDelegate.backgroundCallbacks[0].completion()
    precondition(unrelatedCompletions == 1)
    ExpoAppDelegate.backgroundCallbacks.removeAll()

    let foregroundFirst = CommandLine.arguments[1] == "foreground-first"
    var module: BackgroundUploaderModule?
    if foregroundFirst {
      module = BackgroundUploaderModule()
      module!.definition().forEach { $0.onCreate?() }
    }
    subscriber.application?(
      UIApplication.shared, handleEventsForBackgroundURLSession: "com.openwhispr.background-uploader",
      completionHandler: {
        completions += 1
        completionOnMainThread = Thread.isMainThread
      }
    )
    precondition(
      RecoveryTestEnvironment.configurations.count == 1,
      "A background relaunch must reconnect the upload session before a scene or React Native module exists"
    )
    precondition(ExpoAppDelegate.backgroundCallbacks.isEmpty, "Our session must bypass Expo subscribers that cannot drain it")
    precondition(completions == 0, "Do not complete before the session's pending results are delivered")
    let configuration = RecoveryTestEnvironment.configurations[0]
    precondition(configuration.identifier == "com.openwhispr.background-uploader")
    precondition(configuration.sessionSendsLaunchEvents && !configuration.isDiscretionary)
    precondition(configuration.waitsForConnectivity && configuration.allowsCellularAccess)
    precondition(configuration.timeoutIntervalForRequest == 45 && configuration.timeoutIntervalForResource == 60)

    defaults.set("recovered-job", forKey: "keyboard_recording_job_id")
    defaults.set("transcribing", forKey: "keyboard_transcription_status")
    RecoveryTestEnvironment.deliver("{\"text\":\"Recovered dictation\"}", jobId: "recovered-job")
    precondition(defaults.string(forKey: "keyboard_pending_transcript") == "Recovered dictation")
    precondition(defaults.string(forKey: "keyboard_pending_transcript_job_id") == "recovered-job")
    precondition(defaults.string(forKey: "keyboard_orphaned_raw_transcript") == "Recovered dictation")
    precondition(defaults.string(forKey: "keyboard_transcription_status") == "ready")
    RecoveryTestEnvironment.finishEvents()
    precondition(completions == 1 && completionOnMainThread, "Finish the system callback once, on the main thread")
    RecoveryTestEnvironment.finishEvents()
    precondition(completions == 1, "A duplicate finish event must not invoke the callback again")

    if module == nil {
      module = BackgroundUploaderModule()
      module!.definition().forEach { $0.onCreate?() }
    }
    let reloadedModule = BackgroundUploaderModule()
    reloadedModule.definition().forEach { $0.onCreate?() }
    precondition(RecoveryTestEnvironment.configurations.count == 1, "Foreground startup and module reload must reuse the recovery session")

    // Newer dictations and agent instructions must retain their existing safeguards.
    defaults.set("new-job", forKey: "keyboard_recording_job_id")
    defaults.set("recording", forKey: "keyboard_transcription_status")
    RecoveryTestEnvironment.deliver("{\"text\":\"Old result\",\"cleanupApplied\":true}", jobId: "old-job")
    precondition(defaults.string(forKey: "keyboard_transcription_status") == "recording")
    precondition(defaults.string(forKey: "keyboard_pending_transcript_job_id") == "old-job")
    precondition(defaults.string(forKey: "keyboard_orphaned_raw_transcript") == nil)
    defaults.set("{\"jobId\":\"agent-job\"}", forKey: "keyboard_agent_job")
    RecoveryTestEnvironment.deliver("{\"text\":\"Send an email\"}", jobId: "agent-job")
    precondition(defaults.string(forKey: "keyboard_transcription_status") == "agent_error")
    precondition(defaults.string(forKey: "keyboard_pending_transcript") == "Old result", "An agent instruction must not be pasted as dictation")

    // An in-process upload must still resolve its JS promise, not become an orphan.
    var resolvedBody: String?
    let pending = PendingUpload(promise: Promise(resolve: { value in
      resolvedBody = (value as? [String: Any])?["body"] as? String
    }, reject: { _, _ in preconditionFailure("Successful upload rejected") }))
    let task = RecoveryTestEnvironment.session.dataTask(with: URL(string: "https://example.invalid/upload")!)
    UploadDelegate.shared.track(taskIdentifier: task.taskIdentifier, upload: pending)
    UploadDelegate.shared.urlSession(RecoveryTestEnvironment.session, dataTask: task, didReceive: Data("{\"text\":\"Live dictation\"}".utf8))
    UploadDelegate.shared.urlSession(RecoveryTestEnvironment.session, task: task, didCompleteWithError: nil)
    precondition(resolvedBody == "{\"text\":\"Live dictation\"}")
    precondition(defaults.string(forKey: "keyboard_pending_transcript") == "Old result")

    subscriber.application?(
      UIApplication.shared, handleEventsForBackgroundURLSession: "com.openwhispr.background-uploader",
      completionHandler: { completions += 1 }
    )
    RecoveryTestEnvironment.finishEvents()
    precondition(completions == 2, "Later background wakeups must also complete")
    precondition(RecoveryTestEnvironment.configurations.count == 1)
    print("PASS: \(CommandLine.arguments[1]) — recovery, session reuse, orphan safeguards, live promise and completion delivery")
  }
}
