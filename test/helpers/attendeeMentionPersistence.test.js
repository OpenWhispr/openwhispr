const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");

for (const kind of ["personal", "imported", "shared"]) {
  test(`${kind} note preserves corrected speakers and exact mention identities after database reopen`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const { buildLlmTranscript, collectKnownPeople } =
      await import("../../src/utils/llmTranscript.ts");
    const { serializeTranscriptSegments, lockTranscriptSpeaker } =
      await import("../../src/utils/transcriptSpeakerState.ts");
    const { parseTranscriptSegments } = await import("../../src/utils/parseTranscriptSegments.ts");
    const { tagActionItemOwners, buildMentionMarkdown } =
      await import("../../src/utils/mentionMarkdown.ts");
    const attendees = [
      { displayName: "Alex Morgan", email: "alex.design@example.test", self: false },
      { displayName: "Alex Morgan", email: "alex.engineering@example.test", self: false },
    ];
    const transcript = serializeTranscriptSegments([
      lockTranscriptSpeaker(
        { source: "mic", speaker: "you", timestamp: 1, text: "I will send the proposal." },
        { speakerName: "Ravi Patel" }
      ),
      { source: "system", speaker: "speaker_0", timestamp: 2, text: "I will review it." },
    ]);
    const content = "Keep these handwritten notes.";
    const participants = kind === "personal" ? null : JSON.stringify(attendees);
    let note;
    if (kind === "imported") {
      const imported = db.importNotes([
        {
          clientNoteId: "fictional-import",
          title: "Fictional imported meeting",
          content,
          transcript,
          participants,
          sourceFile: "fictional.csv",
          createdAt: "2026-01-01T12:00:00Z",
        },
      ]);
      assert.equal(imported.imported, 1);
      note = db.getNote(imported.noteIds[0]);
    } else if (kind === "shared") {
      note = db.upsertNoteFromCloud(
        {
          id: "fictional-cloud-note",
          client_note_id: "fictional-shared",
          user_id: "fictional-teammate",
          title: "Fictional shared meeting",
          content,
          transcript,
          participants,
          note_type: "meeting",
          created_at: "2026-01-01T12:00:00Z",
          updated_at: "2026-01-01T12:00:00Z",
        },
        null
      );
    } else {
      note = db.saveNote("Fictional personal note", content).note;
      assert.equal(db.updateNote(note.id, { transcript, participants }).success, true);
    }
    assert.equal(db.setSpeakerMapping(note.id, "speaker_0", null, "Zoë Rivera").success, true);
    const identity = {
      selfName: null,
      selfEmail: null,
      participants: participants ? attendees : [],
    };
    const segments = parseTranscriptSegments(transcript);
    const mappings = { speaker_0: "Zoë Rivera" };
    const chosenOwner = { name: "Alex Morgan", email: "alex.engineering@example.test" };
    const summary = tagActionItemOwners(
      [
        "- [ ] Send the proposal — Ravi Patel",
        "- [ ] Check the budget — Alex Morgan",
        `- [x] Review the plan — ${buildMentionMarkdown(chosenOwner)}`,
      ].join("\n"),
      collectKnownPeople(identity, mappings, segments)
    );
    assert.equal(db.updateNote(note.id, { enhanced_content: summary }).success, true);
    db.db.close();

    const reopened = new DatabaseManager();
    t.after(() => reopened.db.close());
    const saved = reopened.getNote(note.id);
    const savedMappings = Object.fromEntries(
      reopened.getSpeakerMappings(note.id).map((row) => [row.speaker_id, row.display_name])
    );
    const savedSegments = parseTranscriptSegments(saved.transcript);
    assert.equal(saved.content, content);
    assert.equal(saved.participants, participants);
    if (kind === "shared") assert.equal(saved.owner_user_id, "fictional-teammate");
    assert.equal(
      buildLlmTranscript(savedSegments, savedMappings, "Viewer", (key) => key),
      "Ravi Patel: I will send the proposal.\nZoë Rivera: I will review it."
    );
    assert.equal(savedSegments[0].speakerLocked, true);
    assert.equal(
      saved.enhanced_content,
      [
        "- [ ] Send the proposal — [@Ravi Patel](mention:Ravi%20Patel)",
        "- [ ] Check the budget — Alex Morgan",
        "- [x] Review the plan — [@Alex Morgan](mention:alex.engineering%40example.test)",
      ].join("\n")
    );
    assert.equal(
      tagActionItemOwners(
        saved.enhanced_content,
        collectKnownPeople(identity, savedMappings, savedSegments)
      ),
      saved.enhanced_content
    );
  });
}
