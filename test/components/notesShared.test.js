const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/components/notes/shared.ts");

test("folder scopes get the folder-specific empty title", async () => {
  const { notesEmptyTitleKey } = await load();

  assert.equal(notesEmptyTitleKey(true), "notes.empty.emptyFolder");
});

test("space roots keep the generic empty title", async () => {
  const { notesEmptyTitleKey } = await load();

  assert.equal(notesEmptyTitleKey(false), "notes.empty.title");
});

test("both empty-title keys resolve to strings in the en locale", async () => {
  const { notesEmptyTitleKey } = await load();
  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );

  for (const inFolder of [true, false]) {
    const key = notesEmptyTitleKey(inFolder);
    const value = key.split(".").reduce((node, part) => node?.[part], en);
    assert.equal(typeof value, "string", `missing en translation for ${key}`);
  }
});
