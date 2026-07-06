const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeRadarConfig,
  buildSearchQueries,
  scoreVideoCandidate,
  dedupeCandidates,
  buildLocalRelevancePrompt,
} = require("../../src/helpers/seoYoutubeRadar/scoring.js");

test("normalizeRadarConfig applies safe local-first defaults", () => {
  const config = normalizeRadarConfig({});
  assert.deepEqual(config.keywords, [
    "seo",
    "technical seo",
    "google algorithm update",
    "search console",
    "local seo",
    "ai seo",
  ]);
  assert.equal(config.lookbackHours, 72);
  assert.equal(config.maxSearchResultsPerQuery, 10);
  assert.equal(config.maxVideosToProcess, 5);
  assert.equal(config.minDurationSeconds, 180);
  assert.equal(config.excludeShorts, true);
});

test("buildSearchQueries combines each keyword with practical SEO intent", () => {
  const queries = buildSearchQueries(
    normalizeRadarConfig({ keywords: ["technical seo", "search console"] })
  );
  assert.deepEqual(queries, ["technical seo SEO", "search console SEO"]);
});

test("scoreVideoCandidate rewards view velocity and engagement", () => {
  const nowMs = Date.parse("2026-07-06T12:00:00Z");
  const score = scoreVideoCandidate(
    {
      id: "vid1",
      title: "Google SEO update explained",
      channelTitle: "SEO Channel",
      url: "https://www.youtube.com/watch?v=vid1",
      publishedAt: "2026-07-06T06:00:00Z",
      durationSeconds: 900,
      viewCount: 12000,
      likeCount: 600,
      commentCount: 80,
      description: "Useful technical SEO update",
    },
    nowMs
  );
  assert.equal(score.videoId, "vid1");
  assert.equal(score.viewsPerHour, 2000);
  assert.ok(score.score > 2000);
});

test("dedupeCandidates keeps first instance of each video id", () => {
  const candidates = dedupeCandidates([
    { id: "a", title: "A" },
    { id: "b", title: "B" },
    { id: "a", title: "A duplicate" },
  ]);
  assert.deepEqual(
    candidates.map((c) => c.id),
    ["a", "b"]
  );
});

test("buildLocalRelevancePrompt asks for strict JSON classification", () => {
  const prompt = buildLocalRelevancePrompt({
    id: "vid1",
    title: "SEO audit checklist",
    channelTitle: "SEO Channel",
    description: "A checklist for technical SEO audits",
  });
  assert.match(prompt, /Return strict JSON/);
  assert.match(prompt, /relevanceScore/);
  assert.match(prompt, /SEO audit checklist/);
});
