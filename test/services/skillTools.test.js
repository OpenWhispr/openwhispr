const test = require("node:test");
const assert = require("node:assert/strict");

let createLoadSkillTool;

test.before(async () => {
  ({ createLoadSkillTool } = await import("../../src/services/tools/skillTools.ts"));
});

const summary = (name, displayName) => ({
  name,
  displayName,
  description: `${displayName}, when it fits.`,
  enabled: true,
  valid: true,
  addedAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
  lastUsedAt: null,
});

const USABLE = [summary("meeting-prep", "Meeting prep"), summary("weekly-recap", "Weekly recap")];
const OBJECTIONS = {
  path: "references/objections.md",
  size: 18,
  text: true,
  script: false,
};

// What main returns: the skill, and a listed text file's content only when asked for.
function readSkill({ name, file }) {
  if (name !== "meeting-prep") return null;
  if (file && file !== OBJECTIONS.path) return null;
  return {
    name,
    displayName: "Meeting prep",
    body: "Steps for meeting prep.\n",
    files: [file ? { ...OBJECTIONS, content: "Price: anchor it.\n" } : OBJECTIONS],
  };
}

function loadTool({ active = [] } = {}) {
  const reads = [];
  const used = [];
  const tool = createLoadSkillTool({
    usable: USABLE,
    activeNames: () => new Set(active),
    read: async (ref) => {
      reads.push(ref);
      return readSkill(ref);
    },
    markUsed: (name) => used.push(name),
    maxTokens: 16_000,
  });
  return { tool, reads, used };
}

test("load_skill's name is one of the skills it was given", () => {
  const { tool } = loadTool();

  assert.deepEqual(tool.parameters.properties.name.enum, ["meeting-prep", "weekly-recap"]);
  assert.deepEqual(tool.parameters.required, ["name"]);
  assert.equal(tool.readOnly, true);
});

test("load_skill asks to be called before a follow-up question", () => {
  const { tool } = loadTool();

  assert.match(tool.description, /before asking the user a follow-up question/);
});

test("a call naming a disabled skill returns no text", async () => {
  const { tool, reads, used } = loadTool();

  const result = await tool.execute({ name: "meeting-decisions" });

  assert.equal(result.success, false);
  assert.equal(result.data, null);
  assert.deepEqual([reads, used], [[], []]);
});

test("the result is a string, so nothing is saved as tool metadata", async () => {
  const { tool } = loadTool();

  const result = await tool.execute({ name: "meeting-prep" });

  assert.equal(result.success, true);
  assert.equal(result.displayText, "Meeting prep");
  assert.equal(
    result.data,
    '<skill_content name="meeting-prep" title="Meeting prep">\nSteps for meeting prep.\n' +
      "</skill_content>\nFiles: references/objections.md (read one with load_skill and its file; " +
      "scripts are shown to the user to run, never run by you)"
  );
});

test("a second load of an active skill says it is already loaded", async () => {
  const { tool, reads } = loadTool({ active: ["meeting-prep"] });

  const result = await tool.execute({ name: "meeting-prep" });

  assert.deepEqual(result, {
    success: true,
    data: "The meeting-prep skill is already loaded in this conversation. Follow it as given.",
    displayText: "Meeting prep",
  });
  assert.deepEqual(reads, []);
});

test("a listed file is read; another path is refused", async () => {
  const { tool, reads } = loadTool({ active: ["meeting-prep"] });

  const listed = await tool.execute({ name: "meeting-prep", file: "references/objections.md" });
  const other = await tool.execute({ name: "meeting-prep", file: "../secrets.txt" });

  assert.equal(
    listed.data,
    '<skill_file skill="meeting-prep" path="references/objections.md">\nPrice: anchor it.\n' +
      "</skill_file>"
  );
  assert.deepEqual([other.success, other.data], [false, null]);
  assert.deepEqual(reads, [
    { name: "meeting-prep", file: "references/objections.md" },
    { name: "meeting-prep", file: "../secrets.txt" },
  ]);
});

test("loading marks the skill used", async () => {
  const { tool, used } = loadTool();

  await tool.execute({ name: "meeting-prep" });
  await tool.execute({ name: "weekly-recap" });

  assert.deepEqual(used, ["meeting-prep"], "a skill that couldn't be read isn't marked");
});
