package com.openwhispr.dictation

import android.content.Context
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/**
 * Runs the bubble's JS pipeline without the app on screen. After an update or a restart the bubble
 * comes back with no JS running; a tap starts the app's shared React runtime and a headless task in
 * it, and JS reports back through [ready] once it listens. The task is what keeps JS timers running
 * with no activity, so it runs only while a dictation is in flight. All calls run on the main thread.
 */
object HeadlessPipeline {
  const val TASK = "OpenWhisprBubblePipeline"
  private const val TAG = "OpenWhisprBubble"

  /** Set when the pipeline listens; cleared when the JS runtime goes away. */
  @Volatile var ready = false
  private var wanted = false
  private var taskId = 0
  private var waiting: ReactInstanceEventListener? = null

  fun start(context: Context) {
    wanted = true
    val host = (context.applicationContext as? ReactApplication)?.reactHost
    if (host == null) { DebugLog.logcat(TAG, "No React host to run the bubble pipeline", warn = true); DebugLog.event('E', "pipe", "no_react_host"); return }
    val running = host.currentReactContext
    if (running != null && running.hasActiveReactInstance()) { startTask(running); return }
    DebugLog.event('I', "pipe", "react_host.start", "has_react" to (running != null))
    if (waiting == null) {
      val listener = object : ReactInstanceEventListener {
        override fun onReactContextInitialized(context: ReactContext) {
          host.removeReactInstanceEventListener(this)
          DebugLog.event('I', "app", "react_host.created")
          waiting = null
          if (wanted) startTask(context)
        }
      }
      waiting = listener
      host.addReactInstanceEventListener(listener)
    }
    // Safe to call again: it joins a start in progress, and tries again after one that failed.
    host.start()
  }

  /** Ends the task so JS timers pause again; the runtime itself lives on. */
  fun stop(context: Context) {
    wanted = false
    if (taskId == 0) return
    val running = (context.applicationContext as? ReactApplication)?.reactHost?.currentReactContext ?: return
    val tasks = HeadlessJsTaskContext.getInstance(running)
    if (tasks.isTaskRunning(taskId)) tasks.finishTask(taskId)
    taskId = 0
  }

  private fun startTask(context: ReactContext) {
    val tasks = HeadlessJsTaskContext.getInstance(context)
    if (taskId != 0 && tasks.isTaskRunning(taskId)) return
    taskId = tasks.startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
    DebugLog.logcat(TAG, "Pipeline task started")
  }
}
