import Foundation

/// What one dictation sends: the snapshot it started with, its job id, the tone and translation
/// target the user picked in the keyboard, and the session cookie read from the shared Keychain item.
struct DirectRequestContext: Equatable {
  let config: DirectDictationConfig
  let jobId: String
  /// "default" | "formal" | "casual" | "very_casual" | "excited"
  let tone: String
  /// The Cookie header value, verbatim.
  let cookie: String
  /// A language registry code ("es", "zh-TW"); nil when translation is off.
  let translationTarget: String?
  /// The target's English label, which the prompt names.
  let translationLabel: String?
}

enum TranscribeOutcome: Equatable {
  case success(text: String, originalText: String?, cleanupApplied: Bool?)
  /// 422 NO_SPEECH_DETECTED, or a 200 with empty text.
  case noSpeech
  /// 401
  case unauthorized
  /// 403, 426
  case policyBlocked
  /// 429
  case limitReached
  /// 408, 5xx, and status 0 for a transport error.
  case retryable
  /// Any other status.
  case rejected
}

/// The requests a direct dictation makes, in the shape the app sends them today
/// (`src/services/transcription/TranscriptionService.ts`), and how their answers are read.
enum DirectDictationRequests {
  static let transcribeTimeout: TimeInterval = 60
  static let reasonTimeout: TimeInterval = 12
  static let cleanupTimeoutMs = "12000"

  /// Ordered multipart text fields, as the spec's "The request" lists them.
  static func transcribeFields(_ context: DirectRequestContext) -> [(name: String, value: String)] {
    let config = context.config
    var fields: [(name: String, value: String)] = [
      ("clientType", "mobile"),
      ("requestContext", "keyboard"),
      ("purpose", "dictation"),
      ("jobId", context.jobId),
      ("clientTranscriptionId", context.jobId),
    ]
    if let language = config.language { fields.append(("language", language)) }
    if !config.dictionary.prompt.isEmpty { fields.append(("prompt", config.dictionary.prompt)) }
    guard config.cleanup.enabled else { return fields }

    fields.append(("cleanup", "full"))
    fields.append(("cleanupEnabled", "1"))
    fields.append(("cleanupTimeoutMs", cleanupTimeoutMs))
    if let language = config.cleanup.language {
      fields.append(("cleanupLanguage", language))
      fields.append(("cleanupLocale", language))
    }
    if !config.dictionary.personal.isEmpty {
      fields.append(("customDictionary", jsonArray(config.dictionary.personal)))
    }
    if !config.dictionary.shared.isEmpty {
      fields.append(("sharedDictionary", jsonArray(config.dictionary.shared)))
    }
    if let tone = appliedTone(context) { fields.append(("tone", tone)) }
    return fields
  }

  /// Writes preamble + fields + the audio file + closing boundary to `bodyURL` without
  /// loading the audio into memory, and returns a POST request with no body for
  /// `URLSession.uploadTask(with:fromFile:)`.
  static func makeTranscribeRequest(
    _ context: DirectRequestContext, audioURL: URL, bodyURL: URL, boundary: String
  ) throws -> URLRequest {
    let audio = try FileHandle(forReadingFrom: audioURL)
    defer { try? audio.close() }
    FileManager.default.createFile(atPath: bodyURL.path, contents: nil)
    let body = try FileHandle(forWritingTo: bodyURL)
    defer { try? body.close() }
    try body.truncate(atOffset: 0)

    for field in transcribeFields(context) {
      try body.write(contentsOf: Data(
        "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field.name)\"\r\n\r\n\(field.value)\r\n".utf8
      ))
    }
    try body.write(contentsOf: Data(
      "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(context.jobId).m4a\"\r\nContent-Type: audio/mp4\r\n\r\n".utf8
    ))
    while let chunk = try audio.read(upToCount: 64 * 1024), !chunk.isEmpty {
      try body.write(contentsOf: chunk)
    }
    try body.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))

    // The server's parser takes everything after `boundary=`, so it goes last and unquoted.
    var request = baseRequest(context, path: "api/transcribe", timeout: transcribeTimeout)
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    return request
  }

  /// The cleanup pass the app runs when the fused request comes back without one.
  static func makeReasonRequest(_ context: DirectRequestContext, rawText: String) throws -> URLRequest {
    let config = context.config
    var payload: [String: Any] = [
      "text": rawText,
      "promptMode": "cleanup",
      "purpose": "cleanup",
      "clientType": "mobile",
    ]
    if !config.dictionary.personal.isEmpty { payload["customDictionary"] = config.dictionary.personal }
    if !config.dictionary.shared.isEmpty { payload["sharedDictionary"] = config.dictionary.shared }
    if let language = config.cleanup.language {
      payload["language"] = language
      payload["locale"] = language
    }
    if let tone = appliedTone(context) { payload["tone"] = tone }

    var request = baseRequest(context, path: "api/reason", timeout: reasonTimeout)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(cleanupTimeoutMs, forHTTPHeaderField: "x-openwhispr-cleanup-timeout-ms")
    request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes])
    return request
  }

  /// Translates the final text, as the app's `translateTranscript` does on OpenWhispr Cloud. nil
  /// unless the snapshot allows it, a target and label are set, the prompt is non-empty, and the
  /// dictation language isn't already the target's.
  static func makeTranslateRequest(_ context: DirectRequestContext, text: String) throws -> URLRequest? {
    let translation = context.config.translation
    guard translation.enabled, !translation.prompt.isEmpty,
      let target = context.translationTarget, let label = context.translationLabel,
      !isSameLanguage(context.config.language, target)
    else { return nil }
    let payload: [String: Any] = [
      "text": text,
      "systemPrompt": translation.prompt.replacingOccurrences(of: "{{targetLanguage}}", with: label),
      "purpose": "translation",
      "clientType": "mobile",
    ]
    var request = baseRequest(context, path: "api/reason", timeout: reasonTimeout)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [.withoutEscapingSlashes])
    return request
  }

  static func parseTranscribe(status: Int, body: Data) -> TranscribeOutcome {
    switch status {
    case 200..<300:
      guard let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
        return .retryable
      }
      let original = firstText(object, ["originalText", "original_text", "rawText", "raw_text", "rawTranscript", "raw_transcript"])
      guard let text = firstText(object, ["text", "cleanedText", "cleaned_text", "transcript"]) ?? original else {
        return .noSpeech
      }
      let applied = (object["cleanupApplied"] ?? object["cleanup_applied"]) as? Bool
      return .success(text: text, originalText: original, cleanupApplied: applied)
    case 422:
      let code = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["code"] as? String
      return code == "NO_SPEECH_DETECTED" ? .noSpeech : .rejected
    case 401:
      return .unauthorized
    case 403, 426:
      return .policyBlocked
    case 429:
      return .limitReached
    case 0, 408, 500..<600:
      return .retryable
    default:
      return .rejected
    }
  }

  /// The cleaned text from a 200 `/api/reason` answer, else nil.
  static func parseReason(status: Int, body: Data) -> String? {
    guard (200..<300).contains(status),
      let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    else { return nil }
    return firstText(object, ["text"])
  }

  /// The translation from a 200 `/api/reason` answer; nil when it is empty or only differs from
  /// `input` in whitespace, so the untranslated text is typed instead.
  static func parseTranslation(status: Int, body: Data, input: String) -> String? {
    guard let text = parseReason(status: status, body: body), collapse(text) != collapse(input) else { return nil }
    return text
  }

  private static func collapse(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  }

  // Only an exact match skips, as the app's shouldTranslate and desktop. The dictation language has
  // no region ("en"), so a regional target (en-GB, zh-TW) still runs; an unchanged reply is typed as
  // is. No language, or "auto", may be any.
  private static func isSameLanguage(_ source: String?, _ target: String) -> Bool {
    guard let source, source != "auto" else { return false }
    return source == target
  }

  private static func baseRequest(_ context: DirectRequestContext, path: String, timeout: TimeInterval) -> URLRequest {
    var request = URLRequest(url: context.config.apiBaseURL.appendingPathComponent(path), timeoutInterval: timeout)
    request.httpMethod = "POST"
    request.httpShouldHandleCookies = false
    request.setValue(context.cookie, forHTTPHeaderField: "Cookie")
    request.setValue("mobile", forHTTPHeaderField: "x-openwhispr-platform")
    request.setValue("1", forHTTPHeaderField: "x-openwhispr-policy-version")
    if let version = context.config.appVersion {
      request.setValue(version, forHTTPHeaderField: "x-openwhispr-version")
    }
    return request
  }

  private static func appliedTone(_ context: DirectRequestContext) -> String? {
    guard context.config.cleanup.toneApplies, !context.tone.isEmpty, context.tone != "default" else { return nil }
    return context.tone
  }

  private static func firstText(_ object: [String: Any], _ keys: [String]) -> String? {
    for key in keys {
      if let value = object[key] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return value
      }
    }
    return nil
  }

  private static func jsonArray(_ words: [String]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: words, options: [.withoutEscapingSlashes]) else {
      return "[]"
    }
    return String(decoding: data, as: UTF8.self)
  }
}
