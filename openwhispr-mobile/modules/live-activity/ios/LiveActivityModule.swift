import ExpoModulesCore
import Foundation

public class LiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiveActivity")

    Events("onEndMeetingRequested")

    OnCreate { [weak self] in
      let controller = LiveActivityController.shared
      controller.setEndMeetingHandler { [weak self] in
        self?.sendEvent("onEndMeetingRequested", [:])
      }
      controller.startObserving()
      controller.resetForNewJSRuntime()
    }

    Function("startSession") {
      LiveActivityController.shared.startSession()
    }

    Function("endSession") {
      LiveActivityController.shared.endSession()
    }

    Function("setDictationMode") { (enabled: Bool) in
      LiveActivityController.shared.setDictationMode(enabled)
    }

    Function("isDictationModeEnabled") { () -> Bool in
      LiveActivityController.shared.isDictationModeEnabled()
    }

    Function("startMeeting") { (title: String?, startedAtMs: Double) in
      LiveActivityController.shared.startMeeting(
        title: title, startedAt: Date(timeIntervalSince1970: startedAtMs / 1000))
    }

    Function("setMeetingProcessing") { (recordedSeconds: Int) in
      LiveActivityController.shared.setMeetingProcessing(recordedSeconds: recordedSeconds)
    }

    Function("endMeeting") {
      LiveActivityController.shared.endMeeting()
    }
  }
}
