import android.app.Activity
import android.app.Application
import expo.modules.kotlin.AppContext
import expo.modules.superwallexpo.ExpoActivityProvider

fun main() {
  val app = Application()
  val main = Activity("React main")
  val context = AppContext(main, app)
  val provider = ExpoActivityProvider(context)
  check(provider.getCurrentActivity() === main) { "Startup must retain the already resumed Expo activity" }
  val debugger = Activity("Superwall native preview")
  app.callbacks.forEach { it.onActivityStarted(debugger); it.onActivityResumed(debugger); it.onActivityStopped(main) }
  check(provider.getCurrentActivity() === debugger) { "Native preview must present on its foreground activity after React main stops" }
  context.currentActivity = null
  app.callbacks.forEach { it.onActivityDestroyed(main) }
  check(provider.getCurrentActivity() === debugger) { "Destroying older React activity must not clear the foreground preview" }
  app.callbacks.forEach { it.onActivityStopped(debugger) }
  check(provider.getCurrentActivity() == null) { "Backgrounded preview must not be retained as a presenter" }
  app.callbacks.forEach { it.onActivityResumed(debugger) }
  check(provider.getCurrentActivity() === debugger) { "Resumed native preview must be available again" }
  app.callbacks.forEach { it.onActivityDestroyed(debugger) }
  check(provider.getCurrentActivity() == null) { "Destroyed preview must not remain available" }
  val returnedMain = Activity("Returned React main")
  context.currentActivity = returnedMain
  app.callbacks.forEach { it.onActivityStarted(returnedMain); it.onActivityResumed(returnedMain) }
  check(provider.getCurrentActivity() === returnedMain) { "Returning to the app must restore the current React presenter" }
  println("PASS: startup, native preview, old activity destruction, background, resume, preview destruction, return to app")
}
