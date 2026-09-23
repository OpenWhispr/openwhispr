const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/services/voice/voiceTools.ts");

const result = (index) => ({
  title: `Result ${index}`,
  url: `https://example.com/${index}`,
  text: "x".repeat(500),
  publishedDate: "2026-09-22",
});

test("web search results are cut to three short, URL-free entries for voice", async () => {
  const { compactToolResultForVoice } = await load();
  const compact = compactToolResultForVoice("web_search", [1, 2, 3, 4, 5].map(result));
  assert.equal(compact.length, 3);
  assert.deepEqual(Object.keys(compact[0]).sort(), ["publishedDate", "text", "title"]);
  assert.ok(compact[0].text.length <= 241);
  assert.equal(compact[0].title, "Result 1");
});

test("other tools and non-array results pass through unchanged", async () => {
  const { compactToolResultForVoice } = await load();
  const notes = [{ id: 1, title: "Standup", snippet: "..." }];
  assert.equal(compactToolResultForVoice("search_notes", notes), notes);
  const failure = { error: "Search failed" };
  assert.equal(compactToolResultForVoice("web_search", failure), failure);
});

test("the filler line names what the assistant is doing", async () => {
  const { voiceToolFiller } = await load();
  assert.equal(voiceToolFiller(["web_search"]), "Let me look that up.");
  assert.equal(voiceToolFiller(["search_notes"]), "Let me check your notes.");
  assert.equal(voiceToolFiller(["get_calendar_events"]), "Let me check your calendar.");
  assert.equal(voiceToolFiller(["create_note"]), "One moment.");
});

test("a session stops after the idle window only when nothing is in progress", async () => {
  const { shouldStopForIdle } = await load();
  const base = { lastActivityAt: 0, idleMs: 150_000 };
  assert.equal(shouldStopForIdle({ ...base, now: 149_999, busy: false }), false);
  assert.equal(shouldStopForIdle({ ...base, now: 150_000, busy: false }), true);
  assert.equal(shouldStopForIdle({ ...base, now: 400_000, busy: true }), false);
});
