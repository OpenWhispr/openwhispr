import ExpoModulesCore
import Foundation

public class LiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiveActivity")

    OnCreate {
      LiveActivityController.shared.startObserving()
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
  }
}
