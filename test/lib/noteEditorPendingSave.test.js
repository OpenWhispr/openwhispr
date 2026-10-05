const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/noteEditorPendingSave.ts");

function note(id, content, enhancedContent = null) {
  return {
    id,
    title: `Note ${id}`,
    content,
    enhanced_content: enhancedContent,
  };
}

test("applies title, content, and enhanced mutations only for the draft owner", async () => {
  const { applyNoteDraftMutation } = await load();
  const original = {
    noteId: 1,
    title: "Original title",
    content: "Original body",
    enhancedContent: "Original enhancement",
  };

  assert.deepEqual(
    applyNoteDraftMutation(original, {
      sourceNoteId: 1,
      field: "title",
      value: "Edited title",
    }),
    { ...original, title: "Edited title" }
  );
  assert.deepEqual(
    applyNoteDraftMutation(original, {
      sourceNoteId: 1,
      field: "content",
      value: "Edited body",
    }),
    { ...original, content: "Edited body" }
  );
  assert.deepEqual(
    applyNoteDraftMutation(original, {
      sourceNoteId: 1,
      field: "enhancedContent",
      value: "Edited enhancement",
    }),
    { ...original, enhancedContent: "Edited enhancement" }
  );
  assert.deepEqual(original, {
    noteId: 1,
    title: "Original title",
    content: "Original body",
    enhancedContent: "Original enhancement",
  });
});

test("rejects foreign and stale source-note mutations without changing the draft", async () => {
  const { applyNoteDraftMutation } = await load();
  const draftA = {
    noteId: 1,
    title: "A title",
    content: "A body",
    enhancedContent: "A enhancement",
  };

  for (const mutation of [
    { sourceNoteId: 2, field: "title", value: "B title" },
    { sourceNoteId: 2, field: "content", value: "B body" },
    { sourceNoteId: 2, field: "enhancedContent", value: "B enhancement" },
  ]) {
    assert.equal(applyNoteDraftMutation(draftA, mutation), null);
  }
  assert.equal(
    applyNoteDraftMutation(null, {
      sourceNoteId: 1,
      field: "content",
      value: "No owner",
    }),
    null
  );
  assert.deepEqual(draftA, {
    noteId: 1,
    title: "A title",
    content: "A body",
    enhancedContent: "A enhancement",
  });

  const draftB = { ...draftA, noteId: 2 };
  assert.equal(
    applyNoteDraftMutation(draftB, {
      sourceNoteId: 1,
      field: "content",
      value: "Stale A callback",
    }),
    null
  );
});

test("collects document and enhanced writes under their captured owner", async () => {
  const { collectPendingNoteWrites } = await load();
  const documentA = { noteId: 1, title: "A title", content: "A body" };
  const enhancedA = { noteId: 1, enhancedContent: "A enhancement" };

  assert.deepEqual(collectPendingNoteWrites(null, null), []);
  assert.deepEqual(collectPendingNoteWrites(documentA, null), [
    {
      noteId: 1,
      updates: { title: "A title", content: "A body" },
    },
  ]);
  assert.deepEqual(collectPendingNoteWrites(null, enhancedA), [
    {
      noteId: 1,
      updates: { enhanced_content: "A enhancement" },
    },
  ]);
  assert.deepEqual(collectPendingNoteWrites(documentA, enhancedA), [
    {
      noteId: 1,
      updates: {
        title: "A title",
        content: "A body",
        enhanced_content: "A enhancement",
      },
    },
  ]);
});

test("keeps document and enhanced writes with different owners separate", async () => {
  const { collectPendingNoteWrites } = await load();

  assert.deepEqual(
    collectPendingNoteWrites(
      { noteId: 1, title: "A title", content: "0" },
      { noteId: 2, enhancedContent: null }
    ),
    [
      {
        noteId: 1,
        updates: { title: "A title", content: "0" },
      },
      {
        noteId: 2,
        updates: { enhanced_content: null },
      },
    ]
  );
});

test("models B's editor event before the A-to-B parent transition, then returns to A", async () => {
  const { applyNoteDraftMutation, planNoteTransition } = await load();
  const noteA = note(1, "A body", "A enhancement");
  const noteB = note(2, "B body", "B enhancement");

  let draft = planNoteTransition(noteA, null, null).nextDraft;
  assert.equal(
    applyNoteDraftMutation(draft, {
      sourceNoteId: 2,
      field: "content",
      value: "B early mount event",
    }),
    null
  );

  const toB = planNoteTransition(noteB, null, null);
  assert.deepEqual(toB.writes, []);
  assert.deepEqual(toB.nextDraft, {
    noteId: 2,
    title: "Note 2",
    content: "B body",
    enhancedContent: "B enhancement",
  });

  draft = toB.nextDraft;
  assert.equal(
    applyNoteDraftMutation(draft, {
      sourceNoteId: 1,
      field: "content",
      value: "A stale callback",
    }),
    null
  );

  const backToA = planNoteTransition(noteA, null, null);
  assert.deepEqual(backToA.writes, []);
  assert.deepEqual(backToA.nextDraft, {
    noteId: 1,
    title: "Note 1",
    content: "A body",
    enhancedContent: "A enhancement",
  });
});

test("edit A then immediately switch to B keeps empty, zero, and raw content owned by A", async () => {
  const { applyNoteDraftMutation, planNoteTransition } = await load();
  const noteA = note(1, "Original A");
  const noteB = note(2, "Original B");

  for (const content of ["", "0", "Edited raw A"]) {
    const draftA = planNoteTransition(noteA, null, null).nextDraft;
    const editedA = applyNoteDraftMutation(draftA, {
      sourceNoteId: 1,
      field: "content",
      value: content,
    });
    assert.ok(editedA);

    const pendingA = {
      noteId: editedA.noteId,
      title: editedA.title,
      content: editedA.content,
    };
    assert.equal(
      applyNoteDraftMutation(editedA, {
        sourceNoteId: 2,
        field: "content",
        value: "B early mount event",
      }),
      null
    );

    const toB = planNoteTransition(noteB, pendingA, null);
    assert.deepEqual(toB.writes, [
      {
        noteId: 1,
        updates: { title: "Note 1", content },
      },
    ]);
    assert.equal(toB.nextDraft.noteId, 2);
    assert.equal(pendingA.noteId, 1);
  }
});

test("an enhanced A edit flushes only to A during an immediate B transition", async () => {
  const { applyNoteDraftMutation, planNoteTransition } = await load();
  const noteA = note(1, "A body", "Old enhanced A");
  const noteB = note(2, "B body", "Enhanced B");
  const draftA = planNoteTransition(noteA, null, null).nextDraft;
  const editedA = applyNoteDraftMutation(draftA, {
    sourceNoteId: 1,
    field: "enhancedContent",
    value: "New enhanced A",
  });
  assert.ok(editedA);

  const pendingEnhancedA = {
    noteId: editedA.noteId,
    enhancedContent: editedA.enhancedContent,
  };
  assert.equal(
    applyNoteDraftMutation(editedA, {
      sourceNoteId: 2,
      field: "enhancedContent",
      value: "B early enhanced event",
    }),
    null
  );

  const toB = planNoteTransition(noteB, null, pendingEnhancedA);
  assert.deepEqual(toB.writes, [
    {
      noteId: 1,
      updates: { enhanced_content: "New enhanced A" },
    },
  ]);
  assert.equal(toB.nextDraft.noteId, 2);
  assert.equal(pendingEnhancedA.noteId, 1);
});

test("an overview transition flushes captured owners and clears the draft", async () => {
  const { planNoteTransition } = await load();

  const transition = planNoteTransition(
    null,
    { noteId: 1, title: "A title", content: "A body" },
    { noteId: 2, enhancedContent: "B enhancement" }
  );

  assert.deepEqual(transition, {
    writes: [
      {
        noteId: 1,
        updates: { title: "A title", content: "A body" },
      },
      {
        noteId: 2,
        updates: { enhanced_content: "B enhancement" },
      },
    ],
    nextDraft: null,
  });
});

test("deleting inactive B does not cancel A's pending save", async () => {
  const { shouldCancelPendingSavesForDelete } = await load();

  assert.equal(shouldCancelPendingSavesForDelete(17, 23), false);
  assert.equal(shouldCancelPendingSavesForDelete(17, 17), true);
  assert.equal(shouldCancelPendingSavesForDelete(null, 17), false);
});
