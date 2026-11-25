import Foundation

/// iOS gives a field a new document ID when the keyboard comes back from under Notification
/// Centre or the app switcher. A take that ended there is typed by itself only where the text
/// before the cursor is still what it was; anywhere else it waits for a tap.
extension DirectDictationTests {
  static func testHeld() {
    heldLocalTypedWhenTextBeforeCursorUnchanged()
    heldLocalWaitsWhenTextDiffers()
    heldEmptyFieldAndLateReturnWait()
    heldDiscardAndNewTake()
    heldResultForAnotherFieldWhileVisible()
    heldCloudResumesWhenTextUnchanged()
    heldCloudWaitsForTap()
    heldTypingDuringTheTake()
    heldNeverReportedForAnOrdinaryTake()
    heldNeverPulledInByTyping()
    heldTextArrivingLate()
    heldBlankTextProvesNothing()
    heldTranscriptionFollowsRenamedField()
    heldCloudDiscardIsNeverSent()
    heldCloudNotOfferedToLocalSnapshot()
  }

  static func heldNeverPulledInByTyping() {
    // A take spoken after "Hi " waits; the user moves on and types "Hi " in another field.
    let h = coveredLocalTake(context: "Hi ")
    defer { h.cleanup() }
    h.documentID = UUID()
    h.contextBefore = ""
    h.dictation.keyboardDidAppear()
    expect(h.dictation.hasHeldDictation, true, "held: an empty field gets the pill")
    h.contextBefore = "H"
    h.dictation.fieldChanged()
    h.contextBefore = "Hi "
    h.dictation.fieldChanged()
    expect(h.texts, [], "held: typing the same words in another field types nothing")
    expect(h.dictation.hasHeldDictation, true, "held: the take still waits for a tap")

    // Prefilled with the same text and typed into after the moment the field could still report.
    let prefilled = coveredLocalTake(context: "@alice ")
    defer { prefilled.cleanup() }
    prefilled.documentID = UUID()
    prefilled.contextBefore = nil
    prefilled.dictation.keyboardDidAppear()
    prefilled.scheduler.advance(seconds: Double(DirectDictation.renamedFieldCheckMs) / 1000 + 0.5)
    prefilled.contextBefore = "@alice "
    prefilled.dictation.fieldChanged()
    expect(prefilled.texts, [], "held: text arriving after the check is never proof")

    // A result for another field, with the keyboard on screen the whole time.
    let visible = Harness()
    defer { visible.cleanup() }
    visible.contextBefore = "Hi "
    visible.useLocal(.parakeetV2)
    visible.record(seconds: 1)
    visible.dictation.confirm()
    visible.documentID = UUID()
    visible.contextBefore = ""
    visible.dictation.fieldChanged()
    visible.contextBefore = "Hi "
    visible.transcriber.succeed("hello there")
    visible.dictation.fieldChanged()
    expect(visible.texts, [], "held: a result for another field isn't typed when its text matches")
    expect(visible.dictation.hasHeldDictation, true, "held: it waits for a tap")
  }

  static func heldTextArrivingLate() {
    let h = coveredLocalTake(context: "Dear Sam, ")
    defer { h.cleanup() }
    h.documentID = UUID()
    h.contextBefore = nil
    h.dictation.keyboardDidAppear()
    expect(h.texts, [], "held: nothing to compare yet")
    h.contextBefore = "Dear Sam, "
    h.dictation.fieldChanged()
    expect(h.texts, ["hello there"], "held: typed when the field's text arrives a moment later")

    let other = coveredLocalTake(context: "Dear Sam, ")
    defer { other.cleanup() }
    other.documentID = UUID()
    other.contextBefore = nil
    other.dictation.keyboardDidAppear()
    other.contextBefore = "Notes"
    other.dictation.fieldChanged()
    other.contextBefore = "Dear Sam, "
    other.dictation.fieldChanged()
    expect(other.texts, [], "held: only the first text read after appearing identifies the field")
  }

  static func heldBlankTextProvesNothing() {
    let h = coveredLocalTake(context: "\n")
    defer { h.cleanup() }
    h.documentID = UUID()
    h.dictation.keyboardDidAppear()
    expect(h.texts, [], "held: a blank line before the cursor is not proof of the same place")
    expect(h.dictation.hasHeldDictation, true, "held: blank text waits for a tap")
  }

  static func heldTranscriptionFollowsRenamedField() {
    // Covered while Parakeet still works: the field comes back renamed before the text is ready.
    let h = Harness()
    defer { h.cleanup() }
    h.contextBefore = "Dear Sam, "
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    h.dictation.keyboardWillDisappear()
    expect(h.state, .transcribing, "held: still transcribing while covered")
    h.documentID = UUID()
    h.dictation.keyboardDidAppear()
    h.scheduler.advance(seconds: Double(DirectDictation.renamedFieldCheckMs) / 1000 + 1)
    h.transcriber.succeed("hello there")
    expect(h.texts, ["hello there"], "held: typed in the renamed field when it arrives")
  }

  static func heldCloudDiscardIsNeverSent() {
    let h = Harness()
    defer { h.cleanup() }
    h.contextBefore = "Dear Sam, "
    h.record(seconds: 1)
    h.dictation.keyboardWillDisappear()
    let spokenIn = h.documentID
    h.documentID = UUID()
    h.contextBefore = "elsewhere"
    h.dictation.keyboardDidAppear()
    expect(h.dictation.hasHeldDictation, true, "held cloud: offered elsewhere")
    h.dictation.discardHeld()
    expect(h.store.record(jobId: "job-1")?.status, .failed, "held cloud: discarded take is a History retry")
    for restart in [false, true] {
      if restart { h.restartProcess() }
      h.dictation.keyboardWillDisappear()
      h.documentID = spokenIn
      h.contextBefore = "Dear Sam, "
      h.dictation.keyboardDidAppear()
      expect(h.transport.uploads.count, 0, "held cloud: a discarded take is never sent (restart \(restart))")
    }
    expect(h.texts, [], "held cloud: and never typed")
  }

  static func heldCloudNotOfferedToLocalSnapshot() {
    let h = Harness()
    defer { h.cleanup() }
    h.contextBefore = "Dear Sam, "
    h.record(seconds: 1)
    h.dictation.keyboardWillDisappear()
    h.useLocal(.parakeetV2)
    h.documentID = UUID()
    h.contextBefore = "elsewhere"
    h.dictation.keyboardDidAppear()
    expect(h.dictation.hasHeldDictation, false, "held cloud: never offered where it can't be sent")
    h.dictation.insertHeld()
    expect(h.networkCalls, 0, "held cloud: a Local snapshot sends nothing")
  }

  static func heldNeverReportedForAnOrdinaryTake() {
    let h = Harness()
    defer { h.cleanup() }
    var changes = 0
    h.dictation.onHeldChange = { changes += 1 }
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    h.dictation.confirm()
    h.transcriber.succeed("hello there")
    expect(h.texts, ["hello there"], "held: an ordinary take is typed")
    expect(changes, 0, "held: and the pill never offers to insert it")
  }

  /// A Local take stopped by the keyboard being covered, with its text ready.
  private static func coveredLocalTake(context: String?, text: String = "hello there") -> Harness {
    let h = Harness()
    h.contextBefore = context
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    h.dictation.keyboardWillDisappear()
    h.transcriber.succeed(text)
    return h
  }

  static func heldLocalTypedWhenTextBeforeCursorUnchanged() {
    let h = coveredLocalTake(context: "Dear Sam, ")
    defer { h.cleanup() }
    expect(h.texts, [], "held: nothing typed while covered")
    h.documentID = UUID()
    h.dictation.keyboardDidAppear()
    expect(h.texts, ["hello there"], "held: typed when the field came back under a new ID")
    expect(h.dictation.hasHeldDictation, false, "held: nothing left waiting")
    expect(h.networkCalls, 0, "held: a Local take made no request")
    h.dictation.keyboardWillDisappear()
    h.dictation.keyboardDidAppear()
    expect(h.texts.count, 1, "held: typed only once")
  }

  static func heldLocalWaitsWhenTextDiffers() {
    let h = coveredLocalTake(context: "Dear Sam, ")
    defer { h.cleanup() }
    var changes = 0
    h.dictation.onHeldChange = { changes += 1 }
    h.documentID = UUID()
    h.contextBefore = "Password: "
    h.dictation.keyboardDidAppear()
    expect(h.texts, [], "held: another text before the cursor gets nothing by itself")
    expect(h.dictation.hasHeldDictation, true, "held: the take waits for a tap")
    h.dictation.insertHeld()
    expect(h.texts, ["hello there"], "held: a tap types it")
    expect(h.dictation.hasHeldDictation, false, "held: gone once typed")
    expect(changes > 0, true, "held: the keyboard is told to redraw")
    h.dictation.insertHeld()
    expect(h.texts.count, 1, "held: a second tap types nothing")
    expect(h.networkCalls, 0, "held: a Local take made no request")
  }

  static func heldEmptyFieldAndLateReturnWait() {
    // An empty field looks like every other empty field.
    let empty = coveredLocalTake(context: "")
    defer { empty.cleanup() }
    empty.documentID = UUID()
    empty.dictation.keyboardDidAppear()
    expect(empty.texts, [], "held: an empty field is not proof of the same place")
    expect(empty.dictation.hasHeldDictation, true, "held: empty field waits for a tap")

    let late = coveredLocalTake(context: "Dear Sam, ")
    defer { late.cleanup() }
    var redraws = 0
    late.dictation.onHeldChange = { redraws += 1 }
    let spokenIn = late.documentID
    late.documentID = UUID()
    late.contextBefore = "elsewhere"
    late.dictation.keyboardDidAppear()
    expect(late.dictation.hasHeldDictation, true, "held: offered on the pill elsewhere")
    late.scheduler.advance(seconds: Double(DirectDictation.heldWindowMs) / 1000 + 1)
    expect(late.dictation.hasHeldDictation, false, "held: no longer offered after a minute")
    expect(redraws, 1, "held: the pill is told when the offer ends")
    late.dictation.keyboardWillDisappear()
    late.contextBefore = "Dear Sam, "
    late.dictation.keyboardDidAppear()
    expect(late.texts, [], "held: not typed by itself in a renamed field after the window")
    late.dictation.keyboardWillDisappear()
    late.documentID = spokenIn
    late.dictation.keyboardDidAppear()
    expect(late.texts, ["hello there"], "held: still typed in the field it was spoken in")

    let expired = coveredLocalTake(context: "Dear Sam, ")
    defer { expired.cleanup() }
    expired.documentID = UUID()
    expired.scheduler.advance(seconds: Double(DirectDictationStore.resumeWindowMs) / 1000 + 1)
    expired.dictation.keyboardDidAppear()
    expect(expired.dictation.hasHeldDictation, false, "held: gone after ten minutes")
    expired.dictation.insertHeld()
    expect(expired.texts, [], "held: an expired take is never typed")
  }

  static func heldDiscardAndNewTake() {
    let h = coveredLocalTake(context: "Dear Sam, ")
    defer { h.cleanup() }
    let original = h.documentID
    h.documentID = UUID()
    h.contextBefore = "elsewhere"
    h.dictation.keyboardDidAppear()
    h.dictation.discardHeld()
    expect(h.dictation.hasHeldDictation, false, "held: discarded")
    h.dictation.keyboardWillDisappear()
    h.documentID = original
    h.contextBefore = "Dear Sam, "
    h.dictation.keyboardDidAppear()
    expect(h.texts, [], "held: a discarded take is never typed")
    expect(h.store.record(jobId: "job-1")?.status, .completed, "held: discarded text stays in History")
  }

  static func heldResultForAnotherFieldWhileVisible() {
    let h = Harness()
    defer { h.cleanup() }
    h.contextBefore = "Dear Sam, "
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    h.dictation.confirm()
    h.documentID = UUID()
    h.contextBefore = "another field"
    h.transcriber.succeed("hello there")
    expect(h.texts, [], "held: a result for another field is not typed here")
    expect(h.dictation.hasHeldDictation, true, "held: and is kept for a tap, not dropped")
  }

  static func heldCloudResumesWhenTextUnchanged() {
    let h = Harness()
    defer { h.cleanup() }
    h.contextBefore = "Dear Sam, "
    h.record(seconds: 1)
    h.dictation.keyboardWillDisappear()
    expect(h.transport.uploads.count, 0, "held cloud: nothing sent while covered")
    h.documentID = UUID()
    h.dictation.keyboardDidAppear()
    expect(h.transport.uploads.count, 1, "held cloud: sent once the same text is back")
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.texts, ["send it to a@b.co"], "held cloud: typed in the field under its new ID")
    expect(h.dictation.hasHeldDictation, false, "held cloud: nothing left waiting")
  }

  static func heldCloudWaitsForTap() {
    let h = Harness()
    defer { h.cleanup() }
    h.contextBefore = "Dear Sam, "
    h.record(seconds: 1)
    h.dictation.keyboardWillDisappear()
    h.documentID = UUID()
    h.contextBefore = "elsewhere"
    h.dictation.keyboardDidAppear()
    expect(h.transport.uploads.count, 0, "held cloud: another text sends nothing by itself")
    expect(h.dictation.hasHeldDictation, true, "held cloud: waits for a tap")
    h.dictation.insertHeld()
    expect(h.dictation.hasHeldDictation, false, "held cloud: the tap takes it")
    expect(h.transport.uploads.count, 1, "held cloud: the tap sends it")
    h.transport.uploads.first?.complete(200, sentText)
    expect(h.texts, ["send it to a@b.co"], "held cloud: and types it here")
  }

  static func heldTypingDuringTheTake() {
    // Keys typed while recording move the text before the cursor; the newest is what counts.
    let h = Harness()
    defer { h.cleanup() }
    h.contextBefore = "Dear Sam, "
    h.useLocal(.parakeetV2)
    h.record(seconds: 1)
    h.contextBefore = "Dear Sam, hi "
    h.dictation.fieldChanged()
    h.dictation.keyboardWillDisappear()
    h.transcriber.succeed("hello there")
    h.documentID = UUID()
    h.dictation.keyboardDidAppear()
    expect(h.texts, ["hello there"], "held: the text typed during the take is the place")
  }
}
