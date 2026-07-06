const test = require("node:test");
const assert = require("node:assert/strict");

const { runSeoYoutubeRadar } = require("../../src/helpers/seoYoutubeRadar/runner.js");

test("runner imports, transcribes, summarizes locally, and saves selected SEO videos", async () => {
  const memory = {};
  const store = {
    load: () => memory,
    save: (data) => Object.assign(memory, data),
    hasProcessed: () => false,
    markVideo: (id, status, meta) => {
      memory.videos = memory.videos || {};
      memory.videos[id] = { status, ...meta };
    },
    appendRun: (run) => {
      memory.runs = [run];
    },
  };
  const youtubeClient = {
    searchVideos: async () => [{ id: "abc123" }],
    getVideoDetails: async () => [
      {
        id: "abc123",
        title: "Technical SEO update",
        channelTitle: "SEO Channel",
        url: "https://www.youtube.com/watch?v=abc123",
        publishedAt: "2026-07-06T06:00:00Z",
        durationSeconds: 900,
        viewCount: 12000,
        likeCount: 100,
        commentCount: 20,
        description: "Technical SEO update",
      },
    ],
  };
  const notes = [];
  const result = await runSeoYoutubeRadar({
    config: {
      keywords: ["technical seo"],
      lookbackHours: 72,
      maxSearchResultsPerQuery: 10,
      maxVideosToProcess: 1,
      minDurationSeconds: 180,
      excludeShorts: true,
      regionCode: "US",
      language: "en",
    },
    store,
    youtubeClient,
    importAudio: async () => ({ success: true, audioPath: "/tmp/abc123.mp3" }),
    transcribeAudio: async () => ({ success: true, text: "Full transcript text" }),
    summarizeLocal: async () => ({
      relevanceScore: 92,
      summary: "Useful technical SEO update.",
      keyTakeaways: ["Check Search Console"],
    }),
    saveNote: async (note) => {
      notes.push(note);
      return { success: true, note: { id: 10 } };
    },
    nowMs: Date.parse("2026-07-06T12:00:00Z"),
  });
  assert.equal(result.processed, 1);
  assert.equal(notes[0].title.includes("Technical SEO update"), true);
  assert.match(notes[0].content, /Full transcript text/);
  assert.match(notes[0].enhancedContent, /## Summary/);
  assert.match(notes[0].enhancedContent, /## Full Transcript/);
});

test("runner rejects low-relevance videos before import", async () => {
  let importCalled = false;
  const store = {
    hasProcessed: () => false,
    markVideo: () => {},
    appendRun: () => {},
  };
  const result = await runSeoYoutubeRadar({
    config: { keywords: ["seo"], maxVideosToProcess: 1, minDurationSeconds: 180 },
    store,
    youtubeClient: {
      searchVideos: async () => [{ id: "bad123" }],
      getVideoDetails: async () => [
        {
          id: "bad123",
          title: "Crypto side hustle",
          publishedAt: "2026-07-06T06:00:00Z",
          durationSeconds: 800,
          viewCount: 20000,
        },
      ],
    },
    importAudio: async () => {
      importCalled = true;
      return { success: true, audioPath: "/tmp/bad.mp3" };
    },
    transcribeAudio: async () => ({ success: true, text: "" }),
    summarizeLocal: async () => ({ relevanceScore: 20, reject: true, summary: "" }),
    saveNote: async () => ({ success: true }),
    nowMs: Date.parse("2026-07-06T12:00:00Z"),
  });
  assert.equal(result.rejected, 1);
  assert.equal(importCalled, false);
});
