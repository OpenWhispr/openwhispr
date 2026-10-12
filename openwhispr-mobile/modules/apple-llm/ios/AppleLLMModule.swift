import ExpoModulesCore
import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

private struct AppleLLMTokenCountRequest: Record {
  @Field var instructions: String?
  @Field var prompt: String = ""
}

private struct AppleLLMGenerateRequest: Record {
  @Field var instructions: String = ""
  @Field var prompt: String = ""
  @Field var temperature: Double?
  @Field var maxTokens: Int?
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
private struct AppleGeneratedMeetingActionItem {
  var text: String
  var owner: String?
}

@available(iOS 26.0, *)
@Generable
private struct AppleGeneratedMeetingNotes {
  var summary: String
  var keyDiscussionPoints: [String]
  var decisions: [String]
  var actionItems: [AppleGeneratedMeetingActionItem]
  var followUps: [String]
}
#endif

public class AppleLLMModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppleLLM")

    AsyncFunction("getAvailability") { (promise: Promise) in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        promise.resolve(Self.availabilityPayload())
      } else {
        promise.resolve(Self.unsupportedPayload())
      }
      #else
      promise.resolve(Self.unsupportedPayload())
      #endif
    }

    AsyncFunction("countTokens") { (request: AppleLLMTokenCountRequest, promise: Promise) in
      #if canImport(FoundationModels)
      guard #available(iOS 26.4, *) else {
        promise.resolve(nil)
        return
      }

      Task {
        do {
          let model = SystemLanguageModel.default
          var count = try await model.tokenCount(for: request.prompt)
          if let instructions = request.instructions, !instructions.isEmpty {
            count += try await model.tokenCount(for: instructions)
          }
          promise.resolve(count)
        } catch {
          Self.reject(promise, error: error)
        }
      }
      #else
      promise.resolve(nil)
      #endif
    }

    AsyncFunction("generateText") { (request: AppleLLMGenerateRequest, promise: Promise) in
      #if canImport(FoundationModels)
      guard #available(iOS 26.0, *) else {
        promise.reject("APPLE_LLM_UNAVAILABLE", "Apple Foundation Models require iOS 26 or later.")
        return
      }

      Task {
        do {
          try Self.ensureAvailable()
          let session = LanguageModelSession(instructions: request.instructions)
          let response = try await session.respond(
            to: request.prompt,
            options: Self.generationOptions(for: request)
          )
          promise.resolve([
            "text": response.content,
            "model": "apple-foundation-models",
          ])
        } catch {
          Self.reject(promise, error: error)
        }
      }
      #else
      promise.reject("APPLE_LLM_UNAVAILABLE", "Apple Foundation Models are not available in this SDK.")
      #endif
    }

    AsyncFunction("generateMeetingNotes") { (request: AppleLLMGenerateRequest, promise: Promise) in
      #if canImport(FoundationModels)
      guard #available(iOS 26.0, *) else {
        promise.reject("APPLE_LLM_UNAVAILABLE", "Apple Foundation Models require iOS 26 or later.")
        return
      }

      Task {
        do {
          try Self.ensureAvailable()
          let session = LanguageModelSession(instructions: request.instructions)
          let response = try await session.respond(
            to: request.prompt,
            generating: AppleGeneratedMeetingNotes.self,
            options: Self.generationOptions(for: request)
          )
          promise.resolve(Self.meetingNotesPayload(response.content))
        } catch {
          Self.reject(promise, error: error)
        }
      }
      #else
      promise.reject("APPLE_LLM_UNAVAILABLE", "Apple Foundation Models are not available in this SDK.")
      #endif
    }
  }

  private static func unsupportedPayload() -> [String: Any] {
    [
      "status": "unsupportedOS",
      "tokenCounting": false,
    ]
  }

  #if canImport(FoundationModels)
  @available(iOS 26.0, *)
  private static func availabilityPayload() -> [String: Any] {
    let model = SystemLanguageModel.default
    var payload: [String: Any] = [
      "contextSize": model.contextSize,
      "tokenCounting": false,
    ]

    if #available(iOS 26.4, *) {
      payload["tokenCounting"] = true
    }

    switch model.availability {
    case .available:
      payload["status"] = "available"
    case .unavailable(let reason):
      switch reason {
      case .deviceNotEligible:
        payload["status"] = "deviceNotEligible"
      case .appleIntelligenceNotEnabled:
        payload["status"] = "appleIntelligenceNotEnabled"
      case .modelNotReady:
        payload["status"] = "modelNotReady"
      @unknown default:
        payload["status"] = "unavailable"
      }
    @unknown default:
      payload["status"] = "unavailable"
    }

    return payload
  }

  @available(iOS 26.0, *)
  private static func ensureAvailable() throws {
    guard SystemLanguageModel.default.isAvailable else {
      throw AppleLLMUnavailableError()
    }
  }

  @available(iOS 26.0, *)
  private static func generationOptions(for request: AppleLLMGenerateRequest) -> GenerationOptions {
    GenerationOptions(
      temperature: request.temperature,
      maximumResponseTokens: request.maxTokens
    )
  }

  @available(iOS 26.0, *)
  private static func meetingNotesPayload(_ notes: AppleGeneratedMeetingNotes) -> [String: Any] {
    [
      "summary": notes.summary,
      "keyDiscussionPoints": notes.keyDiscussionPoints,
      "decisions": notes.decisions,
      "actionItems": notes.actionItems.map { item in
        var payload: [String: Any] = ["text": item.text]
        if let owner = item.owner {
          payload["owner"] = owner
        }
        return payload
      },
      "followUps": notes.followUps,
    ]
  }

  @available(iOS 26.0, *)
  private static func reject(_ promise: Promise, error: Error) {
    if error is AppleLLMUnavailableError {
      promise.reject("APPLE_LLM_UNAVAILABLE", "Apple Foundation Models are unavailable on this device.")
      return
    }

    if let generationError = error as? LanguageModelSession.GenerationError {
      switch generationError {
      case .guardrailViolation(_), .refusal(_, _):
        promise.reject("APPLE_LLM_GUARDRAIL", generationError.localizedDescription)
      case .exceededContextWindowSize(_):
        promise.reject("APPLE_LLM_CONTEXT_LIMIT", generationError.localizedDescription)
      case .rateLimited(_), .concurrentRequests(_):
        promise.reject("APPLE_LLM_RATE_LIMITED", generationError.localizedDescription)
      case .assetsUnavailable(_), .unsupportedLanguageOrLocale(_):
        promise.reject("APPLE_LLM_UNAVAILABLE", generationError.localizedDescription)
      default:
        promise.reject("APPLE_LLM_FAILED", generationError.localizedDescription)
      }
      return
    }

    promise.reject("APPLE_LLM_FAILED", error.localizedDescription)
  }
  #endif
}

#if canImport(FoundationModels)
private struct AppleLLMUnavailableError: Error {}
#endif
