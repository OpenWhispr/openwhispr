#if canImport(ActivityKit)
import ActivityKit
import Foundation

/// Shared contract between the app (requests/updates the activity) and the widget
/// extension (renders it). The state lives in RecordingActivityContentState.swift
/// (Foundation-only, unit-tested); these aliases keep existing call sites compiling.
@available(iOS 16.1, *)
public struct RecordingActivityAttributes: ActivityAttributes {
  public typealias ContentState = RecordingActivityContentState
  public typealias Phase = RecordingActivityPhase

  public init() {}
}
#endif
