const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSeoYoutubeRadarStore } = require("../../src/helpers/seoYoutubeRadar/store.js");

test("store persists config and processed videos", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-radar-"));
  const filePath = path.join(dir, "radar.json");
  const store = createSeoYoutubeRadarStore({ filePath });
  const config = store.setConfig({ enabled: true, keywords: ["technical seo"] });
  assert.equal(config.enabled, true);
  assert.deepEqual(config.keywords, ["technical seo"]);
  store.markVideo("abc123", "processed", { title: "SEO update" });

  const reloaded = createSeoYoutubeRadarStore({ filePath });
  assert.equal(reloaded.hasProcessed("abc123"), true);
  assert.equal(reloaded.load().videos.abc123.title, "SEO update");
});
