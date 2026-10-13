const test = require("node:test");
const assert = require("node:assert/strict");
const { runLinuxFastPasteFixture } = require("../lib/linuxFastPasteFixture");

test(
  "native input regions scale, clip and route clicks without changing the visible window",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async (t) => {
    const result = await runLinuxFastPasteFixture(t, "linuxInputRegion");
    if (!result) return;
    assert.match(result.stdout, /input region native checks passed/);
  }
);
