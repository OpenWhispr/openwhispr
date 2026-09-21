import ExpoModulesCore
import Foundation
import UIKit

private struct UploadRequest: Record {
  @Field var url: String = ""
  @Field var fileUri: String = ""
  @Field var fileFieldName: String = "file"
  @Field var fileMimeType: String = "application/octet-stream"
  @Field var fileName: String?
  @Field var parameters: [String: String] = [:]
  @Field var headers: [String: String] = [:]
  @Field var timeoutSeconds: Double?
}

private enum BackgroundUploaderConstants {
  static let sessionIdentifier = "com.openwhispr.background-uploader"
  static let pendingTranscriptKey = "keyboard_pending_transcript"
  static let pendingTranscriptJobIdKey = "keyboard_pending_transcript_job_id"
  static let orphanedRawTranscriptKey = "keyboard_orphaned_raw_transcript"
  static let orphanedRawTranscriptJobIdKey = "keyboard_orphaned_raw_transcript_job_id"
  static let recordingJobIdKey = "keyboard_recording_job_id"
  static let transcriptionStatusKey = "keyboard_transcription_status"
  static let transcriptionErrorKey = "keyboard_transcription_error"
  static let transcriptionStatusUpdatedAtMsKey = "keyboard_transcription_status_updated_at_ms"
  static let agentJobKey = "keyboard_agent_job"
  static var darwinStatusNotificationName: String {
    "\(bundleId).keyboardStatusChanged"
  }
  static var darwinTranscriptReadyNotificationName: String {
    "\(bundleId).transcriptReady"
  }

  // Derived from the host app's bundle id so the same module works for any
  // signing identity (the convention is `group.<bundle-id>`).
  static var bundleId: String {
    Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr"
  }

  static var appGroupId: String {
    return "group.\(bundleId)"
  }

  static func postDarwinNotification(_ name: String) {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    CFNotificationCenterPostNotification(
      center,
      CFNotificationName(name as CFString),
      nil,
      nil,
      true
    )
  }
}

private final class PendingUpload {
  let promise: Promise
  var responseData = Data()
  var bodyFileUrl: URL?
  let startedAtMs = Int(Date().timeIntervalSince1970 * 1000)
  var bodyBuildMs: Int = 0
  init(promise: Promise) { self.promise = promise }
}

private final class UploadDelegate: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  static let shared = UploadDelegate()
  private let lock = NSLock()
  private var pending: [Int: PendingUpload] = [:]
  // Buffers response bytes for tasks not tracked by an in-process promise
  // (i.e. completions arriving after a previous app process was killed).
  private var orphanedBuffers: [Int: Data] = [:]

  func track(taskIdentifier: Int, upload: PendingUpload) {
    lock.lock(); defer { lock.unlock() }
    pending[taskIdentifier] = upload
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock()
    if pending[dataTask.taskIdentifier] != nil {
      pending[dataTask.taskIdentifier]?.responseData.append(data)
    } else {
      orphanedBuffers[dataTask.taskIdentifier, default: Data()].append(data)
    }
    lock.unlock()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    let upload = pending.removeValue(forKey: task.taskIdentifier)
    let orphanData = orphanedBuffers.removeValue(forKey: task.taskIdentifier) ?? Data()
    lock.unlock()

    if let upload {
      handleAlive(upload: upload, task: task, error: error)
    } else if error == nil {
      handleOrphaned(responseData: orphanData, jobId: task.taskDescription)
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    DispatchQueue.main.async {
      BackgroundUploaderAppDelegate.invokeCompletionHandler()
    }
  }

  private func handleAlive(upload: PendingUpload, task: URLSessionTask, error: Error?) {
    if let bodyFileUrl = upload.bodyFileUrl {
      try? FileManager.default.removeItem(at: bodyFileUrl)
    }
    if let error {
      upload.promise.reject("BG_UPLOAD_ERROR", error.localizedDescription)
      return
    }
    let httpResponse = task.response as? HTTPURLResponse
    let body = String(data: upload.responseData, encoding: .utf8) ?? ""
    let uploadMs = Int(Date().timeIntervalSince1970 * 1000) - upload.startedAtMs
    upload.promise.resolve([
      "status": httpResponse?.statusCode ?? 0,
      "body": body,
      "uploadMs": uploadMs,
      "bodyBuildMs": upload.bodyBuildMs
    ])
  }

  private func handleOrphaned(responseData: Data, jobId: String?) {
    guard let json = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any],
          let defaults = UserDefaults(suiteName: BackgroundUploaderConstants.appGroupId)
    else {
      #if DEBUG
      NSLog("[BackgroundUploader] orphaned completion discarded (no parseable text)")
      #endif
      return
    }

    let textCandidates = [
      json["text"],
      json["cleanedText"],
      json["cleaned_text"],
      json["transcript"]
    ]
    guard let text = textCandidates.compactMap({ ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) })
      .first(where: { !$0.isEmpty }) else {
      #if DEBUG
      NSLog("[BackgroundUploader] orphaned completion discarded (empty text)")
      #endif
      return
    }

    let cleanupApplied =
      (json["cleanupApplied"] as? Bool)
      ?? (json["cleanup_applied"] as? Bool)
      ?? false

    func writeJobId(_ jobId: String?, forKey key: String) {
      if let jobId, !jobId.isEmpty {
        defaults.set(jobId, forKey: key)
      } else {
        defaults.removeObject(forKey: key)
      }
    }

    // A newer recording is already in flight when the active recording jobId
    // differs from this (now stale) completion. In that case the transcript
    // must not commandeer the shared handoff status, or recording #2's UI
    // would briefly flip to "ready"/"Inserting".
    let activeJobId = defaults.string(forKey: BackgroundUploaderConstants.recordingJobIdKey)
    let supersededByNewerRecording: Bool = {
      guard let jobId, !jobId.isEmpty, let activeJobId, !activeJobId.isEmpty else { return false }
      return jobId != activeJobId
    }()

    // Guard: if this orphaned job was an agent job, do NOT paste the raw
    // instruction (e.g. "write a follow-up email") into the keyboard's pending
    // transcript slot — that would insert the prompt verbatim. Instead, signal
    // agent_error so the keyboard can show an appropriate recovery UI.
    if let agentJobJson = defaults.string(forKey: BackgroundUploaderConstants.agentJobKey),
       let agentJobData = agentJobJson.data(using: .utf8),
       let agentJob = try? JSONSerialization.jsonObject(with: agentJobData) as? [String: Any],
       let agentJobId = agentJob["jobId"] as? String,
       let orphanJobId = jobId,
       !agentJobId.isEmpty,
       agentJobId == orphanJobId {
      defaults.set("agent_error", forKey: BackgroundUploaderConstants.transcriptionStatusKey)
      defaults.set(
        String(Int(Date().timeIntervalSince1970 * 1000)),
        forKey: BackgroundUploaderConstants.transcriptionStatusUpdatedAtMsKey
      )
      defaults.set("orphaned_agent_job", forKey: BackgroundUploaderConstants.transcriptionErrorKey)
      defaults.synchronize()
      BackgroundUploaderConstants.postDarwinNotification(BackgroundUploaderConstants.darwinStatusNotificationName)
      #if DEBUG
      NSLog(
        "[BackgroundUploader] orphaned agent job %@ — set agent_error, skipped pending transcript",
        agentJobId
      )
      #endif
      return
    }

    // Always deliver the transcript to the keyboard's pending slot so it is
    // never lost — even if the app is never relaunched to run JS-side cleanup.
    // The keyboard rejects it on consume when its jobId is stale.
    defaults.set(text, forKey: BackgroundUploaderConstants.pendingTranscriptKey)
    writeJobId(jobId, forKey: BackgroundUploaderConstants.pendingTranscriptJobIdKey)

    if cleanupApplied {
      defaults.removeObject(forKey: BackgroundUploaderConstants.orphanedRawTranscriptKey)
      defaults.removeObject(forKey: BackgroundUploaderConstants.orphanedRawTranscriptJobIdKey)
    } else {
      // Preserve the raw text so the app, on next launch, can clean it, persist
      // it to history, and upgrade the pending slot if it hasn't been consumed.
      defaults.set(text, forKey: BackgroundUploaderConstants.orphanedRawTranscriptKey)
      writeJobId(jobId, forKey: BackgroundUploaderConstants.orphanedRawTranscriptJobIdKey)
    }

    if !supersededByNewerRecording {
      defaults.set("ready", forKey: BackgroundUploaderConstants.transcriptionStatusKey)
      defaults.set(
        String(Int(Date().timeIntervalSince1970 * 1000)),
        forKey: BackgroundUploaderConstants.transcriptionStatusUpdatedAtMsKey
      )
    }
    defaults.synchronize()
    if !supersededByNewerRecording {
      BackgroundUploaderConstants.postDarwinNotification(BackgroundUploaderConstants.darwinStatusNotificationName)
    }
    BackgroundUploaderConstants.postDarwinNotification(
      BackgroundUploaderConstants.darwinTranscriptReadyNotificationName
    )
    #if DEBUG
    NSLog(
      "[BackgroundUploader] orphaned completion delivered cleanupApplied=%d stale=%d chars=%ld",
      cleanupApplied ? 1 : 0,
      supersededByNewerRecording ? 1 : 0,
      text.count
    )
    #endif
  }
}

public class BackgroundUploaderAppDelegate: ExpoAppDelegateSubscriber {
  private static let lock = NSLock()
  private static var pendingCompletionHandler: (() -> Void)?

  public required init() {}

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) -> Bool {
    guard identifier == BackgroundUploaderConstants.sessionIdentifier else {
      return false
    }
    Self.lock.lock()
    Self.pendingCompletionHandler = completionHandler
    Self.lock.unlock()
    return true
  }

  static func invokeCompletionHandler() {
    lock.lock()
    let handler = pendingCompletionHandler
    pendingCompletionHandler = nil
    lock.unlock()
    handler?()
  }
}

public class BackgroundUploaderModule: Module {
  private var session: URLSession!

  public func definition() -> ModuleDefinition {
    Name("BackgroundUploader")

    OnCreate {
      let config = URLSessionConfiguration.background(
        withIdentifier: BackgroundUploaderConstants.sessionIdentifier
      )
      config.sessionSendsLaunchEvents = true
      config.isDiscretionary = false
      config.waitsForConnectivity = true
      config.allowsCellularAccess = true
      config.timeoutIntervalForRequest = 45
      config.timeoutIntervalForResource = 60
      self.session = URLSession(
        configuration: config,
        delegate: UploadDelegate.shared,
        delegateQueue: nil
      )
    }

    AsyncFunction("upload") { (request: UploadRequest, promise: Promise) in
      self.startUpload(request: request, promise: promise)
    }
  }

  private func startUpload(request: UploadRequest, promise: Promise) {
    guard let url = URL(string: request.url) else {
      promise.reject("BG_UPLOAD_BAD_URL", "Invalid URL: \(request.url)")
      return
    }

    let fileUrl: URL
    if request.fileUri.hasPrefix("file://") {
      guard let parsed = URL(string: request.fileUri) else {
        promise.reject("BG_UPLOAD_BAD_FILE", "Invalid fileUri: \(request.fileUri)")
        return
      }
      fileUrl = parsed
    } else {
      fileUrl = URL(fileURLWithPath: request.fileUri)
    }

    guard FileManager.default.fileExists(atPath: fileUrl.path) else {
      promise.reject("BG_UPLOAD_MISSING_FILE", "File does not exist: \(fileUrl.path)")
      return
    }

    let resolvedFileName = request.fileName ?? fileUrl.lastPathComponent
    let boundary = "----OpenWhisprBoundary\(UUID().uuidString)"

    let bodyFileUrl: URL
    let bodyBuildStartedAt = Int(Date().timeIntervalSince1970 * 1000)
    do {
      bodyFileUrl = try buildMultipartBodyFile(
        boundary: boundary,
        parameters: request.parameters,
        fileFieldName: request.fileFieldName,
        fileName: resolvedFileName,
        fileMimeType: request.fileMimeType,
        fileUrl: fileUrl
      )
    } catch {
      promise.reject("BG_UPLOAD_BODY_ERROR", "Failed to build multipart body: \(error.localizedDescription)")
      return
    }
    let bodyBuildMs = Int(Date().timeIntervalSince1970 * 1000) - bodyBuildStartedAt

    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = "POST"
    urlRequest.timeoutInterval = request.timeoutSeconds ?? 45
    urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    for (key, value) in request.headers {
      urlRequest.setValue(value, forHTTPHeaderField: key)
    }

    let task = session.uploadTask(with: urlRequest, fromFile: bodyFileUrl)
    task.taskDescription = request.parameters["jobId"]
    let pending = PendingUpload(promise: promise)
    pending.bodyFileUrl = bodyFileUrl
    pending.bodyBuildMs = bodyBuildMs
    UploadDelegate.shared.track(taskIdentifier: task.taskIdentifier, upload: pending)
    #if DEBUG
    NSLog(
      "[BackgroundUploader] upload task=%ld file=%@ bodyBuildMs=%d",
      task.taskIdentifier,
      resolvedFileName,
      bodyBuildMs
    )
    #endif
    task.resume()
  }

  private func buildMultipartBodyFile(
    boundary: String,
    parameters: [String: String],
    fileFieldName: String,
    fileName: String,
    fileMimeType: String,
    fileUrl: URL
  ) throws -> URL {
    let tmpUrl = FileManager.default.temporaryDirectory
      .appendingPathComponent("bg-upload-\(UUID().uuidString).tmp")
    FileManager.default.createFile(atPath: tmpUrl.path, contents: nil)

    let handle = try FileHandle(forWritingTo: tmpUrl)
    defer { try? handle.close() }

    let crlf = "\r\n"
    for (key, value) in parameters {
      var part = "--\(boundary)\(crlf)"
      part += "Content-Disposition: form-data; name=\"\(key)\"\(crlf)\(crlf)"
      part += "\(value)\(crlf)"
      handle.write(Data(part.utf8))
    }

    var fileHeader = "--\(boundary)\(crlf)"
    fileHeader += "Content-Disposition: form-data; name=\"\(fileFieldName)\"; filename=\"\(fileName)\"\(crlf)"
    fileHeader += "Content-Type: \(fileMimeType)\(crlf)\(crlf)"
    handle.write(Data(fileHeader.utf8))

    let inputHandle = try FileHandle(forReadingFrom: fileUrl)
    defer { try? inputHandle.close() }
    while autoreleasepool(invoking: {
      let chunk = inputHandle.readData(ofLength: 64 * 1024)
      if chunk.isEmpty { return false }
      handle.write(chunk)
      return true
    }) {}

    let trailer = "\(crlf)--\(boundary)--\(crlf)"
    handle.write(Data(trailer.utf8))

    return tmpUrl
  }
}
