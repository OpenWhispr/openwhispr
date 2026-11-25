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
    late.documentID = UUID()
    late.scheduler.advance(seconds: Double(DirectDictation.sameTextWindowMs) / 1000 + 1)
    late.dictation.keyboardDidAppear()
    expect(late.texts, [], "held: not typed by itself after the window")
    expect(late.dictation.hasHeldDictation, true, "held: still there for a tap")

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
