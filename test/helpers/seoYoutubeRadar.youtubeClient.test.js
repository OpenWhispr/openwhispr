const test = require("node:test");
const assert = require("node:assert/strict");

const { createYouTubeClient } = require("../../src/helpers/seoYoutubeRadar/youtubeClient.js");

test("searchVideos calls YouTube search.list with quota-safe params", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    return {
      ok: true,
      json: async () => ({
        items: [{ id: { videoId: "abc123" }, snippet: { title: "SEO update" } }],
      }),
    };
  };
  const client = createYouTubeClient({ apiKey: "key", fetchImpl });
  const result = await client.searchVideos({
    query: "technical seo SEO",
    publishedAfter: "2026-07-03T00:00:00.000Z",
    maxResults: 10,
    regionCode: "US",
    language: "en",
  });
  assert.equal(result[0].id, "abc123");
  assert.equal(calls[0].searchParams.get("part"), "snippet");
  assert.equal(calls[0].searchParams.get("type"), "video");
  assert.equal(calls[0].searchParams.get("order"), "viewCount");
  assert.equal(calls[0].searchParams.get("maxResults"), "10");
});

test("getVideoDetails maps statistics and ISO 8601 duration", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      items: [
        {
          id: "abc123",
          snippet: {
            title: "SEO update",
            channelTitle: "SEO Channel",
            publishedAt: "2026-07-06T00:00:00Z",
            description: "Useful",
          },
          statistics: { viewCount: "1000", likeCount: "50", commentCount: "12" },
          contentDetails: { duration: "PT12M34S" },
        },
      ],
    }),
  });
  const client = createYouTubeClient({ apiKey: "key", fetchImpl });
  const videos = await client.getVideoDetails(["abc123"]);
  assert.equal(videos[0].durationSeconds, 754);
  assert.equal(videos[0].url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(videos[0].viewCount, 1000);
});

test("client throws clear error for missing api key", async () => {
  assert.throws(() => createYouTubeClient({ apiKey: "" }), /YouTube API key/);
});
