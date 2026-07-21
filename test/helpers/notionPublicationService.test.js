const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NotionPublicationService,
  contentHash,
  stableStringify,
} = require("../../src/helpers/notionPublicationService");

function createDatabase(overrides = {}) {
  const updates = [];
  const note = {
    id: 12,
    client_note_id: "client-note",
    title: "Long note",
    content: Array.from({ length: 230 }, (_, index) => `Paragraph ${index + 1}`).join("\n\n"),
    enhanced_content: null,
    enhanced_at_content_hash: null,
    note_type: "personal",
    transcript: null,
    participants: null,
    created_at: "2026-07-16 10:00:00",
  };
  const destination = {
    id: 3,
    connection_id: 4,
    data_source_id: "source-id",
    data_source_name: "Notes",
    schema_snapshot: JSON.stringify({ properties: { Name: { id: "title", type: "title" } } }),
    layout_key: "general",
    include_transcript: 0,
  };
  const publication = {
    id: 8,
    note_id: note.id,
    destination_id: destination.id,
    notion_page_id: "page-id",
    notion_page_url: "https://notion.so/page-id",
    next_block_index: 100,
    attempt_count: 1,
    status: "partial",
  };
  return {
    updates,
    getNote: () => note,
    getNotionDestination: () => destination,
    getNotionDestinationById: () => destination,
    findPublishedNotionPublication: () => null,
    findUncertainNotionPublication: () => null,
    findResumableNotionPublication: () => publication,
    createNotionPublication: () => publication,
    updateNotionPublication: (_id, update) => {
      updates.push(update);
      Object.assign(publication, {
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.nextBlockIndex !== undefined ? { next_block_index: update.nextBlockIndex } : {}),
      });
      return publication;
    },
    getNotionConnection: () => ({ id: 4 }),
    ...overrides,
  };
}

test("stable hashing does not depend on object key order", () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
  assert.equal(
    contentHash({ title: "A", blocks: [] }, 1),
    contentHash({ blocks: [], title: "A" }, 1)
  );
});

test("returns the existing page instead of silently duplicating unchanged content", async () => {
  const existing = { id: 99, notion_page_url: "https://notion.so/existing", status: "published" };
  const database = createDatabase({ findPublishedNotionPublication: () => existing });
  const service = new NotionPublicationService(database, {});

  const result = await service.publish(12, { contentSource: "original" });
  assert.equal(result.success, false);
  assert.equal(result.code, "DUPLICATE");
  assert.equal(result.duplicate, existing);
});

test("uses the renderer draft consistently instead of stale persisted content", () => {
  const database = createDatabase();
  const service = new NotionPublicationService(database, {});

  const result = service.preview(12, {
    contentSource: "enhanced",
    draft: {
      title: "Draft title",
      content: "Current original",
      enhancedContent: "Current enhanced",
      transcript: null,
    },
  });

  assert.equal(result.payload.title, "Draft title");
  assert.match(result.preview, /Current enhanced/);
  assert.doesNotMatch(result.preview, /Paragraph 1/);
});

test("does not automatically resume a publish left in an uncertain state", async () => {
  const uncertain = {
    id: 21,
    status: "publishing",
    notion_page_id: "possibly-created-page",
    notion_page_url: "https://notion.so/possibly-created-page",
  };
  const database = createDatabase({ findUncertainNotionPublication: () => uncertain });
  let appendCalls = 0;
  const service = new NotionPublicationService(database, {
    appendBlocks: async () => {
      appendCalls += 1;
    },
  });

  const result = await service.publish(12, { contentSource: "original" });
  assert.equal(result.success, false);
  assert.equal(result.code, "OUTCOME_UNKNOWN");
  assert.equal(result.pageUrl, uncertain.notion_page_url);
  assert.equal(appendCalls, 0);
});

test("resumes a partial publish from next_block_index in 100-block batches", async () => {
  const database = createDatabase();
  const appended = [];
  const service = new NotionPublicationService(database, {
    appendBlocks: async (_connectionId, pageId, blocks) => {
      assert.equal(pageId, "page-id");
      appended.push(blocks.length);
    },
  });

  const result = await service.publish(12, { contentSource: "original" });
  assert.equal(result.success, true);
  assert.deepEqual(appended, [100, 33]);
  assert.equal(database.updates.at(-1).status, "published");
  assert.equal(database.updates.at(-1).nextBlockIndex, 233);
});

test("marks the tracked publication partial when a later batch fails", async () => {
  const database = createDatabase();
  let batches = 0;
  const service = new NotionPublicationService(database, {
    appendBlocks: async () => {
      batches += 1;
      if (batches === 2) throw Object.assign(new Error("boom"), { retryable: true });
    },
  });

  const result = await service.publish(12, { contentSource: "original" });
  assert.equal(result.success, false);
  assert.equal(result.retryable, true);
  const last = database.updates.at(-1);
  assert.equal(last.status, "partial");
  assert.ok(last.lastError.includes("boom"));
});

test("persists an ambiguous append outcome so it cannot be resumed silently", async () => {
  const database = createDatabase();
  const service = new NotionPublicationService(database, {
    appendBlocks: async () => {
      throw Object.assign(new Error("Check Notion before trying again"), {
        code: "OUTCOME_UNKNOWN",
        outcomeUnknown: true,
      });
    },
  });

  const result = await service.publish(12, { contentSource: "original" });
  assert.equal(result.success, false);
  assert.equal(result.code, "OUTCOME_UNKNOWN");
  assert.equal(result.pageUrl, "https://notion.so/page-id");
  const last = database.updates.at(-1);
  assert.equal(last.status, "partial");
  assert.match(last.lastError, /"outcomeUnknown":true/);
});

test("touches no publication row when the failure precedes its creation", async () => {
  const database = createDatabase({ getNotionDestination: () => null });
  const service = new NotionPublicationService(database, {});

  const result = await service.publish(12, { contentSource: "original" });
  assert.equal(result.success, false);
  assert.equal(database.updates.length, 0);
});
