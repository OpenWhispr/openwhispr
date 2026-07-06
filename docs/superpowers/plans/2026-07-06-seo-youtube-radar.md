# SEO YouTube Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first workflow that discovers newly popular SEO-related YouTube videos, imports only the best candidates into OpenWhispr, transcribes them, and saves notes containing the full transcript plus a local-AI summary.

**Architecture:** The Electron main process owns discovery, caching, scheduling, YouTube API calls, and orchestration. The existing OpenWhispr YouTube import/transcription/note-save flow is reused for selected videos. Local AI is mandatory for ranking and summarisation; cloud AI is not used by this workflow.

**Tech Stack:** Electron IPC, Node helpers in `src/helpers`, React settings UI, SQLite/JSON userData cache, YouTube Data API v3 metadata calls, existing `ytow` import helper, existing local Whisper/Parakeet transcription, existing local reasoning runtime.

## Global Constraints

- Discovery must use YouTube Data API v3 for metadata; avoid scraping search pages.
- Use YouTube API quota conservatively: default to one daily run, cache video IDs, and cap searches/results.
- Use local AI only for relevance ranking and summaries.
- Do not consume paid or cloud AI credits in this workflow.
- Never store the YouTube API key in renderer localStorage.
- Keep full transcripts in note `content`; save summary plus transcript in `enhanced_content`.
- If summary or ranking fails, save/keep the full transcript and log the failure.
- All new UI strings must be added to every `src/locales/*/translation.json`.
- Respect the existing dirty `src/helpers/mediaPlayer.js`; do not modify it.

---

## File Structure

- Create `src/helpers/seoYoutubeRadar/scoring.js`
  - Pure functions for query config, candidate dedupe, view-velocity scoring, and local-AI prompt construction.
- Create `src/helpers/seoYoutubeRadar/youtubeClient.js`
  - Thin YouTube Data API client with injected `fetchImpl`, quota guard, and no persistent state.
- Create `src/helpers/seoYoutubeRadar/store.js`
  - Persistent cache under Electron `app.getPath("userData")`, keyed by YouTube video ID.
- Create `src/helpers/seoYoutubeRadar/runner.js`
  - Orchestrates discovery, cache filtering, import, transcription, local AI summary, and note creation.
- Create `src/helpers/seoYoutubeRadar/scheduler.js`
  - Starts/stops the daily scheduled job when OpenWhispr is running.
- Create tests under `test/helpers/seoYoutubeRadar.*.test.js`
  - Unit tests for scoring, client request construction, cache behaviour, and runner orchestration.
- Modify `src/helpers/ipcHandlers.js`
  - Register API-key storage, config get/set, manual run, and scheduler handlers.
- Modify `preload.js`
  - Expose safe SEO Radar methods to renderer.
- Modify `src/types/electron.ts`
  - Type the new IPC surface.
- Modify `src/components/SettingsPage.tsx`
  - Add a compact SEO Radar settings panel.
- Modify `src/locales/*/translation.json`
  - Add labels, statuses, errors, and helper text.

---

### Task 1: Scoring And Query Planning

**Files:**
- Create: `src/helpers/seoYoutubeRadar/scoring.js`
- Test: `test/helpers/seoYoutubeRadar.scoring.test.js`

**Interfaces:**
- Produces:
  - `normalizeRadarConfig(input?: object): SeoRadarConfig`
  - `buildSearchQueries(config: SeoRadarConfig): string[]`
  - `scoreVideoCandidate(video: SeoVideoCandidate, nowMs: number): SeoVideoScore`
  - `dedupeCandidates(candidates: SeoVideoCandidate[]): SeoVideoCandidate[]`
  - `buildLocalRelevancePrompt(video: SeoVideoCandidate): string`

- [ ] **Step 1: Write failing tests**

```js
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
  assert.deepEqual(queries, [
    "technical seo SEO",
    "search console SEO",
  ]);
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
  assert.deepEqual(candidates.map((c) => c.id), ["a", "b"]);
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
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/helpers/seoYoutubeRadar.scoring.test.js`

Expected: fails with `Cannot find module '../../src/helpers/seoYoutubeRadar/scoring.js'`.

- [ ] **Step 3: Implement minimal scoring module**

```js
const DEFAULT_KEYWORDS = [
  "seo",
  "technical seo",
  "google algorithm update",
  "search console",
  "local seo",
  "ai seo",
];

function normalizeRadarConfig(input = {}) {
  return {
    enabled: Boolean(input.enabled),
    keywords: Array.isArray(input.keywords) && input.keywords.length > 0
      ? input.keywords.map((v) => String(v).trim()).filter(Boolean)
      : DEFAULT_KEYWORDS,
    lookbackHours: Number.isFinite(input.lookbackHours) ? input.lookbackHours : 72,
    maxSearchResultsPerQuery: Number.isFinite(input.maxSearchResultsPerQuery)
      ? input.maxSearchResultsPerQuery
      : 10,
    maxVideosToProcess: Number.isFinite(input.maxVideosToProcess)
      ? input.maxVideosToProcess
      : 5,
    minDurationSeconds: Number.isFinite(input.minDurationSeconds) ? input.minDurationSeconds : 180,
    excludeShorts: input.excludeShorts !== false,
    regionCode: String(input.regionCode || "US"),
    language: String(input.language || "en"),
  };
}

function buildSearchQueries(config) {
  return config.keywords.map((keyword) => `${keyword} SEO`);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate?.id || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    result.push(candidate);
  }
  return result;
}

function scoreVideoCandidate(video, nowMs = Date.now()) {
  const publishedMs = Date.parse(video.publishedAt || "");
  const ageHours = Math.max(1, (nowMs - publishedMs) / 3_600_000);
  const viewsPerHour = Math.round((Number(video.viewCount) || 0) / ageHours);
  const engagement = (Number(video.likeCount) || 0) * 0.5 + (Number(video.commentCount) || 0) * 2;
  const durationPenalty = video.durationSeconds && video.durationSeconds < 180 ? 500 : 0;
  return {
    videoId: video.id,
    viewsPerHour,
    score: Math.round(viewsPerHour + engagement - durationPenalty),
  };
}

function buildLocalRelevancePrompt(video) {
  return [
    "You are filtering YouTube videos for an SEO operator.",
    "Return strict JSON with keys: relevanceScore, reason, reject.",
    "relevanceScore must be 0-100. reject must be true for spam, generic marketing, crypto, dropshipping, or non-SEO content.",
    "",
    `Title: ${video.title || ""}`,
    `Channel: ${video.channelTitle || ""}`,
    `Description: ${video.description || ""}`,
  ].join("\n");
}

module.exports = {
  normalizeRadarConfig,
  buildSearchQueries,
  dedupeCandidates,
  scoreVideoCandidate,
  buildLocalRelevancePrompt,
};
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/helpers/seoYoutubeRadar.scoring.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/seoYoutubeRadar/scoring.js test/helpers/seoYoutubeRadar.scoring.test.js
git commit -m "feat: add seo youtube radar scoring"
```

---

### Task 2: YouTube Metadata Client

**Files:**
- Create: `src/helpers/seoYoutubeRadar/youtubeClient.js`
- Test: `test/helpers/seoYoutubeRadar.youtubeClient.test.js`

**Interfaces:**
- Consumes:
  - `SeoRadarConfig` from Task 1.
- Produces:
  - `createYouTubeClient({ apiKey, fetchImpl }): YouTubeClient`
  - `client.searchVideos({ query, publishedAfter, maxResults, regionCode, language }): Promise<SearchResult[]>`
  - `client.getVideoDetails(videoIds: string[]): Promise<SeoVideoCandidate[]>`

- [ ] **Step 1: Write failing tests**

```js
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
      items: [{
        id: "abc123",
        snippet: {
          title: "SEO update",
          channelTitle: "SEO Channel",
          publishedAt: "2026-07-06T00:00:00Z",
          description: "Useful",
        },
        statistics: { viewCount: "1000", likeCount: "50", commentCount: "12" },
        contentDetails: { duration: "PT12M34S" },
      }],
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
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/helpers/seoYoutubeRadar.youtubeClient.test.js`

Expected: fails with missing module.

- [ ] **Step 3: Implement YouTube client**

Implement `search.list` and `videos.list` only. Use official endpoints:

```js
const API_BASE = "https://www.googleapis.com/youtube/v3";

function parseDurationSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || "");
  if (!match) return 0;
  return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url.toString());
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `YouTube API request failed: ${response.status}`);
  }
  return data;
}

function createYouTubeClient({ apiKey, fetchImpl = fetch }) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("YouTube API key is required");

  return {
    async searchVideos({ query, publishedAfter, maxResults, regionCode, language }) {
      const url = new URL(`${API_BASE}/search`);
      url.searchParams.set("key", key);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("type", "video");
      url.searchParams.set("order", "viewCount");
      url.searchParams.set("q", query);
      url.searchParams.set("publishedAfter", publishedAfter);
      url.searchParams.set("maxResults", String(maxResults));
      url.searchParams.set("regionCode", regionCode);
      url.searchParams.set("relevanceLanguage", language);
      const data = await fetchJson(fetchImpl, url);
      return (data.items || [])
        .map((item) => ({ id: item?.id?.videoId, snippet: item.snippet }))
        .filter((item) => item.id);
    },

    async getVideoDetails(videoIds) {
      if (!videoIds.length) return [];
      const url = new URL(`${API_BASE}/videos`);
      url.searchParams.set("key", key);
      url.searchParams.set("part", "snippet,statistics,contentDetails");
      url.searchParams.set("id", videoIds.join(","));
      const data = await fetchJson(fetchImpl, url);
      return (data.items || []).map((item) => ({
        id: item.id,
        title: item.snippet?.title || "",
        channelTitle: item.snippet?.channelTitle || "",
        publishedAt: item.snippet?.publishedAt || "",
        description: item.snippet?.description || "",
        viewCount: Number(item.statistics?.viewCount || 0),
        likeCount: Number(item.statistics?.likeCount || 0),
        commentCount: Number(item.statistics?.commentCount || 0),
        durationSeconds: parseDurationSeconds(item.contentDetails?.duration),
        url: `https://www.youtube.com/watch?v=${item.id}`,
      }));
    },
  };
}

module.exports = { createYouTubeClient, parseDurationSeconds };
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/helpers/seoYoutubeRadar.youtubeClient.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/seoYoutubeRadar/youtubeClient.js test/helpers/seoYoutubeRadar.youtubeClient.test.js
git commit -m "feat: add seo youtube metadata client"
```

---

### Task 3: Persistent Cache And Config Store

**Files:**
- Create: `src/helpers/seoYoutubeRadar/store.js`
- Test: `test/helpers/seoYoutubeRadar.store.test.js`

**Interfaces:**
- Produces:
  - `createSeoYoutubeRadarStore({ filePath }): Store`
  - `store.load(): object`
  - `store.save(data: object): void`
  - `store.getConfig(): SeoRadarConfig`
  - `store.setConfig(config: object): SeoRadarConfig`
  - `store.markVideo(videoId: string, status: "seen" | "processed" | "rejected", meta?: object): void`
  - `store.hasProcessed(videoId: string): boolean`

- [ ] **Step 1: Write failing tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSeoYoutubeRadarStore } = require("../../src/helpers/seoYoutubeRadar/store.js");

test("store persists config and processed videos", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-radar-"));
  const store = createSeoYoutubeRadarStore({ filePath: path.join(dir, "radar.json") });
  const config = store.setConfig({ enabled: true, keywords: ["technical seo"] });
  assert.equal(config.enabled, true);
  assert.deepEqual(config.keywords, ["technical seo"]);
  store.markVideo("abc123", "processed", { title: "SEO update" });

  const reloaded = createSeoYoutubeRadarStore({ filePath: path.join(dir, "radar.json") });
  assert.equal(reloaded.hasProcessed("abc123"), true);
  assert.equal(reloaded.load().videos.abc123.title, "SEO update");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/helpers/seoYoutubeRadar.store.test.js`

Expected: fails with missing module.

- [ ] **Step 3: Implement store**

Use atomic JSON writes and `normalizeRadarConfig` from Task 1. Store shape:

```json
{
  "config": {},
  "videos": {
    "abc123": {
      "status": "processed",
      "title": "SEO update",
      "updatedAt": "2026-07-06T12:00:00.000Z"
    }
  },
  "runs": []
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/helpers/seoYoutubeRadar.store.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/seoYoutubeRadar/store.js test/helpers/seoYoutubeRadar.store.test.js
git commit -m "feat: add seo youtube radar store"
```

---

### Task 4: Runner Orchestration

**Files:**
- Create: `src/helpers/seoYoutubeRadar/runner.js`
- Test: `test/helpers/seoYoutubeRadar.runner.test.js`

**Interfaces:**
- Consumes:
  - `createYouTubeClient()` from Task 2.
  - `createSeoYoutubeRadarStore()` from Task 3.
  - Existing `importYoutubeAudio(url)` from `src/helpers/youtubeImport.js`.
- Produces:
  - `runSeoYoutubeRadar({ config, store, youtubeClient, importAudio, transcribeAudio, summarizeLocal, saveNote, nowMs }): Promise<SeoRadarRunResult>`

- [ ] **Step 1: Write failing orchestration test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const { runSeoYoutubeRadar } = require("../../src/helpers/seoYoutubeRadar/runner.js");
const { createSeoYoutubeRadarStore } = require("../../src/helpers/seoYoutubeRadar/store.js");

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
  };
  const youtubeClient = {
    searchVideos: async () => [{ id: "abc123" }],
    getVideoDetails: async () => [{
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
    }],
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
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/helpers/seoYoutubeRadar.runner.test.js`

Expected: fails with missing runner module.

- [ ] **Step 3: Implement runner**

Implement the orchestration with these behaviours:

- Build queries from config.
- Fetch search results.
- Fetch details for found video IDs.
- Exclude videos already marked processed.
- Exclude duration below `minDurationSeconds`.
- Sort by score descending.
- For each finalist:
  - Ask local AI relevance classifier.
  - Reject if `reject === true` or `relevanceScore < 70`.
  - Call `importAudio(video.url)`.
  - Call `transcribeAudio(audioPath)`.
  - Call `summarizeLocal(video, transcript)`.
  - Save note with raw transcript in `content`.
  - Save enhanced markdown in `enhancedContent`.
  - Mark video processed.

Enhanced markdown format:

```markdown
## Summary

[summary]

## Key Takeaways

- [takeaway]

## Source

- Video: [title](url)
- Channel: [channelTitle]
- Score: [score]

## Full Transcript

[transcript]
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/helpers/seoYoutubeRadar.runner.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/seoYoutubeRadar/runner.js test/helpers/seoYoutubeRadar.runner.test.js
git commit -m "feat: add seo youtube radar runner"
```

---

### Task 5: Main-Process IPC And Secure API Key Storage

**Files:**
- Modify: `src/helpers/ipcHandlers.js`
- Modify: `preload.js`
- Modify: `src/types/electron.ts`
- Test: `test/helpers/seoYoutubeRadar.ipcContract.test.js`

**Interfaces:**
- Produces renderer API:
  - `seoRadarGetConfig(): Promise<SeoRadarConfig>`
  - `seoRadarSetConfig(config): Promise<{ success: boolean; config?: SeoRadarConfig; error?: string }>`
  - `seoRadarSaveYouTubeKey(key: string): Promise<{ success: boolean; error?: string }>`
  - `seoRadarHasYouTubeKey(): Promise<{ success: boolean; hasKey: boolean }>`
  - `seoRadarRunNow(): Promise<{ success: boolean; result?: SeoRadarRunResult; error?: string }>`

- [ ] **Step 1: Write IPC contract test**

Create `test/helpers/seoYoutubeRadar.ipcContract.test.js` that reads `preload.js` and `src/types/electron.ts` and asserts the five method names exist.

- [ ] **Step 2: Run test and verify RED**

Run: `node --test test/helpers/seoYoutubeRadar.ipcContract.test.js`

Expected: fails because methods are not exposed.

- [ ] **Step 3: Add IPC handlers**

In `src/helpers/ipcHandlers.js`, register:

```js
ipcMain.handle("seo-radar-get-config", async () => radarStore.getConfig());
ipcMain.handle("seo-radar-set-config", async (_event, config) => ({ success: true, config: radarStore.setConfig(config) }));
ipcMain.handle("seo-radar-save-youtube-key", async (_event, key) => secureKeyStore.save("youtubeDataApiKey", key));
ipcMain.handle("seo-radar-has-youtube-key", async () => ({ success: true, hasKey: !!secureKeyStore.get("youtubeDataApiKey") }));
ipcMain.handle("seo-radar-run-now", async () => runSeoYoutubeRadarWithRuntimeDeps());
```

Use the existing secure key mechanism in the repo; if it only exposes named helpers for current keys, add one narrowly scoped helper for `youtubeDataApiKey`.

- [ ] **Step 4: Expose preload methods and TypeScript types**

Add methods to `preload.js` using `ipcRenderer.invoke`. Add matching types to `src/types/electron.ts`.

- [ ] **Step 5: Run checks**

Run:

```bash
node --test test/helpers/seoYoutubeRadar.ipcContract.test.js
npm run typecheck
node --check preload.js
node --check src/helpers/ipcHandlers.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/helpers/ipcHandlers.js preload.js src/types/electron.ts test/helpers/seoYoutubeRadar.ipcContract.test.js
git commit -m "feat: expose seo youtube radar ipc"
```

---

### Task 6: Settings UI

**Files:**
- Modify: `src/components/SettingsPage.tsx`
- Modify: `src/locales/de/translation.json`
- Modify: `src/locales/en/translation.json`
- Modify: `src/locales/es/translation.json`
- Modify: `src/locales/fr/translation.json`
- Modify: `src/locales/it/translation.json`
- Modify: `src/locales/ja/translation.json`
- Modify: `src/locales/pt/translation.json`
- Modify: `src/locales/ru/translation.json`
- Modify: `src/locales/zh-CN/translation.json`
- Modify: `src/locales/zh-TW/translation.json`

**Interfaces:**
- Consumes renderer API from Task 5.
- Produces a Settings panel with:
  - Enable daily SEO Radar.
  - YouTube API key save field.
  - Keyword textarea.
  - Max videos per run input.
  - Manual `Run now` button.
  - Last run summary.

- [ ] **Step 1: Add UI keys to all locale files**

Add keys under `settingsPage.seoRadar`:

```json
{
  "title": "SEO YouTube Radar",
  "description": "Find newly popular SEO videos, transcribe them, and summarize them with local AI.",
  "enabled": "Run daily",
  "apiKey": "YouTube API key",
  "apiKeySaved": "YouTube API key saved",
  "keywords": "Search topics",
  "keywordsPlaceholder": "seo, technical seo, google algorithm update",
  "maxVideos": "Max videos per run",
  "runNow": "Run now",
  "running": "Running",
  "lastRun": "Last run",
  "noRunYet": "No runs yet",
  "saved": "Settings saved",
  "failed": "SEO Radar failed"
}
```

Use accurate translations for non-English locales or English fallback text if the repo already accepts fallback-like translations for new operational strings.

- [ ] **Step 2: Add settings panel**

Add a compact panel to the existing Settings page. Use existing `Input`, `Button`, `Toggle`, and panel conventions. Do not add a landing page or marketing copy.

- [ ] **Step 3: Wire `Run now`**

Call `window.electronAPI.seoRadarRunNow()`. Display result counts:

```tsx
const label = result.success
  ? `${result.result?.processed ?? 0} processed, ${result.result?.rejected ?? 0} rejected`
  : t("settingsPage.seoRadar.failed");
```

- [ ] **Step 4: Run checks**

Run:

```bash
npm run i18n:check
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPage.tsx src/locales/de/translation.json src/locales/en/translation.json src/locales/es/translation.json src/locales/fr/translation.json src/locales/it/translation.json src/locales/ja/translation.json src/locales/pt/translation.json src/locales/ru/translation.json src/locales/zh-CN/translation.json src/locales/zh-TW/translation.json
git commit -m "feat: add seo youtube radar settings"
```

---

### Task 7: Scheduler

**Files:**
- Create: `src/helpers/seoYoutubeRadar/scheduler.js`
- Modify: `src/helpers/ipcHandlers.js`
- Test: `test/helpers/seoYoutubeRadar.scheduler.test.js`

**Interfaces:**
- Produces:
  - `createSeoYoutubeRadarScheduler({ store, runNow, setTimeoutImpl, clearTimeoutImpl, now }): Scheduler`
  - `scheduler.start(): void`
  - `scheduler.stop(): void`
  - `scheduler.runNow(): Promise<SeoRadarRunResult>`

- [ ] **Step 1: Write failing scheduler test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const { createSeoYoutubeRadarScheduler } = require("../../src/helpers/seoYoutubeRadar/scheduler.js");

test("scheduler does not schedule when disabled", () => {
  let scheduled = false;
  const scheduler = createSeoYoutubeRadarScheduler({
    store: { getConfig: () => ({ enabled: false }) },
    runNow: async () => ({ processed: 0 }),
    setTimeoutImpl: () => { scheduled = true; return 1; },
    clearTimeoutImpl: () => {},
    now: () => new Date("2026-07-06T12:00:00Z"),
  });
  scheduler.start();
  assert.equal(scheduled, false);
});

test("scheduler schedules enabled daily run", () => {
  let delay = null;
  const scheduler = createSeoYoutubeRadarScheduler({
    store: { getConfig: () => ({ enabled: true, runHourLocal: 7 }) },
    runNow: async () => ({ processed: 0 }),
    setTimeoutImpl: (_fn, ms) => { delay = ms; return 1; },
    clearTimeoutImpl: () => {},
    now: () => new Date("2026-07-06T06:00:00"),
  });
  scheduler.start();
  assert.ok(delay > 0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/helpers/seoYoutubeRadar.scheduler.test.js`

Expected: fails with missing scheduler module.

- [ ] **Step 3: Implement scheduler**

Schedule the next run at `config.runHourLocal || 7` local time. After every run, schedule the next one. Do not overlap runs; if a run is active, `runNow()` returns `{ skipped: true, reason: "already_running" }`.

- [ ] **Step 4: Hook scheduler into app startup**

In `ipcHandlers.js` or the existing main-process initialization point, instantiate the scheduler once after IPC dependencies are available. Stop it during app quit using the same lifecycle pattern as other sidecar managers.

- [ ] **Step 5: Run tests and checks**

Run:

```bash
node --test test/helpers/seoYoutubeRadar.scheduler.test.js
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/helpers/seoYoutubeRadar/scheduler.js src/helpers/ipcHandlers.js test/helpers/seoYoutubeRadar.scheduler.test.js
git commit -m "feat: schedule seo youtube radar"
```

---

### Task 8: End-To-End Verification

**Files:**
- Modify: `docs/superpowers/plans/2026-07-06-seo-youtube-radar.md` only if verification reveals an implementation detail that must be documented for operators.

**Interfaces:**
- Consumes all prior tasks.
- Produces verified local workflow.

- [ ] **Step 1: Run full focused test suite**

Run:

```bash
node --test test/helpers/seoYoutubeRadar.scoring.test.js
node --test test/helpers/seoYoutubeRadar.youtubeClient.test.js
node --test test/helpers/seoYoutubeRadar.store.test.js
node --test test/helpers/seoYoutubeRadar.runner.test.js
node --test test/helpers/seoYoutubeRadar.ipcContract.test.js
node --test test/helpers/seoYoutubeRadar.scheduler.test.js
npm run typecheck
npm run lint
npm run i18n:check
```

Expected: all pass.

- [ ] **Step 2: Run OpenWhispr and verify UI loads**

Run:

```bash
ow restart
ow status
curl -I --max-time 5 http://127.0.0.1:5183
```

Expected:
- `ow status` reports `RUNNING`.
- `curl` returns `HTTP/1.1 200 OK`.

- [ ] **Step 3: Manual dry run with quota guard**

Use Settings → SEO YouTube Radar:

1. Save YouTube API key.
2. Set keywords to `technical seo`.
3. Set max videos per run to `1`.
4. Click `Run now`.

Expected:
- One run starts.
- At most one video is imported/transcribed.
- Saved note contains raw transcript in `content`.
- Saved note contains `## Summary` and `## Full Transcript` in `enhanced_content`.
- Local AI model server is used; no cloud AI calls are made.

- [ ] **Step 4: Confirm cache prevents duplicate processing**

Click `Run now` again with the same settings.

Expected:
- Previously processed video is skipped.
- Run result shows `processed: 0` if no new candidate appears.

- [ ] **Step 5: Commit final verification notes if docs changed**

```bash
git add docs/superpowers/plans/2026-07-06-seo-youtube-radar.md
git commit -m "docs: document seo youtube radar verification"
```

Skip this commit if no documentation changes were made during verification.

---

## Self-Review

- Spec coverage: The plan covers discovery, popularity scoring, cache, local AI filtering, import, transcription, summary, note saving, settings, scheduler, and verification.
- Placeholder scan: No placeholder markers or unspecified error-handling steps remain.
- Type consistency: The runner consumes the exact functions produced by scoring, client, and store tasks. Renderer IPC names match preload and `electron.ts` method names.
- Scope check: This is one cohesive feature. It touches discovery, orchestration, settings, and scheduling, but each task is independently testable and can be reviewed separately.
