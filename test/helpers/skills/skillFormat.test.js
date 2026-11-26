const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSkillMarkdown,
  validateSkillFiles,
  slugifySkillName,
  buildSkillMarkdown,
  displayNameFor,
  isTextFile,
  isScriptPath,
  contentHash,
} = require("../../../src/helpers/skills/skillFormat");

const md = (header, body = "Do the thing.\n") => `---\n${header}\n---\n\n${body}`;
const file = (text) => [{ path: "SKILL.md", data: Buffer.from(text) }];
const codes = (issues) => issues.map((issue) => issue.code);
const check = (header, options = { source: "upload" }, body = undefined) =>
  validateSkillFiles(file(md(header, body)), options);
const lines = (count) => `${Array.from({ length: count }, (_, i) => `Line ${i + 1}`).join("\n")}\n`;

test("a valid skill parses with its name, description and display name", () => {
  const header =
    'name: meeting-prep\ndescription: Briefs me.\nmetadata:\n  display_name: "Meeting prep"';
  const r = check(header, { folderName: "meeting-prep", source: "upload" });
  assert.deepEqual(
    [r.name, r.displayName, r.description, r.problems, r.warnings],
    ["meeting-prep", "Meeting prep", "Briefs me.", [], []]
  );
});

test("CRLF and a BOM parse like LF", () => {
  const crlf = parseSkillMarkdown("\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\nx\r\ny");
  const parsed = { name: "a", description: "b" };
  assert.deepEqual([crlf.data, crlf.body, crlf.problems], [parsed, "x\ny", []]);
  const cr = parseSkillMarkdown("---\rname: a\rdescription: b\r---\rx");
  assert.deepEqual([cr.data, cr.body, cr.problems], [parsed, "x", []]);
});

test("a header can close with ... as YAML allows", () => {
  const r = parseSkillMarkdown("---\nname: a\ndescription: b\n...\nSteps\n");
  assert.deepEqual([r.data, r.body, r.problems], [{ name: "a", description: "b" }, "Steps\n", []]);
});

test("an empty name or description is a hard error", () => {
  assert.deepEqual(codes(check("name:\ndescription: b").problems), ["missingName"]);
  assert.deepEqual(codes(check('name: "  "\ndescription: b').problems), ["missingName"]);
  assert.deepEqual(codes(check("name: 12\ndescription: b").problems), ["missingName"]);
  assert.deepEqual(codes(check("description: b").problems), ["missingName"]);
  assert.deepEqual(codes(check('name: a\ndescription: ""').problems), ["missingDescription"]);
  assert.deepEqual(codes(check("name: a\ndescription:   ").problems), ["missingDescription"]);
});

test("a name that breaks the pattern or runs past 64 characters is refused", () => {
  for (const name of ["Meeting-Prep", "a--b", "-a", "a-", "a_b", "a b"]) {
    const r = check(`name: "${name}"\ndescription: b`);
    assert.deepEqual(codes(r.problems), ["nameFormat"], name);
  }
  const tooLong = check(`name: ${"a".repeat(65)}\ndescription: b`);
  assert.deepEqual(codes(tooLong.problems), ["nameTooLong"]);
  assert.deepEqual(check(`name: ${"a".repeat(64)}\ndescription: b`).problems, []);
});

test("a Windows device name can't be a skill's name, since it can't be a folder there", () => {
  for (const name of ["con", "aux", "nul", "prn", "com1", "lpt9"]) {
    assert.deepEqual(codes(check(`name: ${name}\ndescription: b`).problems), ["unsafePath"], name);
  }
  assert.deepEqual(check("name: con-notes\ndescription: b").problems, []);
});

test("a description over 1,024 characters or with < or > is refused", () => {
  const long = check(`name: a\ndescription: ${"d".repeat(1025)}`);
  assert.deepEqual(long.problems, [{ code: "descriptionTooLong", values: { max: 1024 } }]);
  assert.deepEqual(check(`name: a\ndescription: ${"d".repeat(1024)}`).problems, []);
  // Counted in characters, so 1,024 emoji (2,048 UTF-16 units) still fit
  assert.deepEqual(check(`name: a\ndescription: ${"😀".repeat(1024)}`).problems, []);
  const tag = check("name: a\ndescription: Wraps <b> tags");
  assert.deepEqual(codes(tag.problems), ["descriptionAngleBrackets"]);
  const arrow = check("name: a\ndescription: a > b");
  assert.deepEqual(codes(arrow.problems), ["descriptionAngleBrackets"]);
});

test("a header that is a list or a scalar is refused", () => {
  assert.deepEqual(codes(parseSkillMarkdown(md("- a\n- b")).problems), ["frontmatterNotMapping"]);
  assert.deepEqual(codes(parseSkillMarkdown(md("just text")).problems), ["frontmatterNotMapping"]);
});

test("duplicate keys are refused", () => {
  const duplicate = parseSkillMarkdown(md("name: a\nname: b"));
  assert.deepEqual(codes(duplicate.problems), ["frontmatterInvalid"]);
  const broken = parseSkillMarkdown(md("name: [unclosed\ndescription: b"));
  assert.deepEqual(codes(broken.problems), ["frontmatterInvalid"]);
});

test("a file with no header block is refused", () => {
  assert.deepEqual(codes(parseSkillMarkdown("# Title\n\nSteps").problems), ["frontmatterMissing"]);
  // An opening line with no closing line is not a header either
  const unclosed = parseSkillMarkdown("---\nname: a\ndescription: b\n");
  assert.deepEqual(codes(unclosed.problems), ["frontmatterMissing"]);
});

// SKILL.md is read as UTF-8 and copied back out exactly as stored, so it must be UTF-8 text.
test("a SKILL.md that isn't UTF-8 text is refused, saying how to fix it", () => {
  const text = md("name: resume\ndescription: Résumé helper.");
  for (const data of [
    Buffer.from(text, "latin1"),
    Buffer.from(`\uFEFF${text}`, "utf16le"),
    Buffer.concat([Buffer.from(text), Buffer.from([0])]),
  ]) {
    const r = validateSkillFiles([{ path: "SKILL.md", data }], { source: "upload" });
    assert.deepEqual(codes(r.problems), ["skillFileNotUtf8"]);
  }
  assert.deepEqual(codes(validateSkillFiles(file(text), { source: "upload" }).problems), []);
});

test("a folder without SKILL.md is refused", () => {
  const r = validateSkillFiles([{ path: "notes.md", data: Buffer.from("x") }], { source: "disk" });
  assert.deepEqual(codes(r.problems), ["noSkillFile"]);
});

test("unknown keys are a warning, not an error", () => {
  const r = check("name: a\ndescription: b\nwhen_to_use: x\nversion: 2");
  assert.deepEqual(r.problems, []);
  const keys = "when_to_use, version";
  assert.deepEqual(r.warnings, [{ code: "unknownKeys", values: { keys } }]);
  const allowed = check(
    "name: a\ndescription: b\nlicense: MIT\ncompatibility: x\nallowed-tools: Read\n" +
      "metadata:\n  k: v"
  );
  assert.deepEqual(allowed.warnings, []);
});

test("each warning is raised", () => {
  const renamed = check("name: a\ndescription: b", { folderName: "other", source: "upload" });
  assert.deepEqual([codes(renamed.warnings), renamed.problems], [["folderRenamed"], []]);
  assert.equal(renamed.displayName, "A");
  assert.deepEqual(codes(check("name: claude-helper\ndescription: b").warnings), ["reservedWord"]);
  assert.deepEqual(codes(check("name: anthropic\ndescription: b").warnings), ["reservedWord"]);
  const longBody = check("name: a\ndescription: b", undefined, lines(501));
  assert.deepEqual(codes(longBody.warnings), ["longBody"]);
  assert.deepEqual(check("name: a\ndescription: b", undefined, lines(500)).warnings, []);
  const longDescription = check(`name: a\ndescription: ${"d".repeat(301)}`);
  assert.deepEqual(codes(longDescription.warnings), ["longDescription"]);
  assert.deepEqual(check(`name: a\ndescription: ${"d".repeat(300)}`).warnings, []);
});

test("on disk, a name that differs from its folder is an error", () => {
  const r = check("name: a\ndescription: b", { folderName: "other", source: "disk" });
  assert.deepEqual([codes(r.problems), r.warnings], [["nameMismatch"], []]);
  // The folder's own name still shows, so the row can be found and fixed
  assert.equal(r.displayName, "Other");
  const matching = check("name: a\ndescription: b", { folderName: "a", source: "disk" });
  assert.deepEqual(matching.problems, []);
});

test("a skill whose header can't be read is named after its folder", () => {
  const r = check("name: [unclosed", { folderName: "weekly-recap", source: "disk" });
  assert.deepEqual([r.name, r.displayName, r.description], ["", "Weekly recap", ""]);
});

test("a [TODO: placeholder in the instructions blocks an app save, never an upload", () => {
  const inBody = file(md("name: a\ndescription: b", "1. [TODO: fill in]\n"));
  assert.deepEqual(codes(validateSkillFiles(inBody, { source: "app" }).problems), ["placeholder"]);
  assert.deepEqual(validateSkillFiles(inBody, { source: "upload" }).problems, []);
});

test("a [TODO: in an attached file doesn't block an app save", () => {
  const files = [
    { path: "SKILL.md", data: Buffer.from(md("name: a\ndescription: b", "Steps\n")) },
    { path: "references/notes.md", data: Buffer.from("[TODO: add examples]") },
  ];
  assert.deepEqual(validateSkillFiles(files, { source: "app" }).problems, []);
});

test("slugs come from the title, stay unique and fall back for non-Latin titles", () => {
  assert.equal(slugifySkillName("Weekly status report", new Set()), "weekly-status-report");
  assert.equal(slugifySkillName("  Café: résumé & notes!  ", new Set()), "cafe-resume-notes");
  const taken = new Set(["weekly-status-report", "weekly-status-report-2"]);
  assert.equal(slugifySkillName("Weekly status report", taken), "weekly-status-report-3");
  assert.equal(slugifySkillName("تقرير أسبوعي", new Set()), "skill");
  assert.equal(slugifySkillName("تقرير أسبوعي", new Set(["skill"])), "skill-2");
  assert.equal(slugifySkillName("x".repeat(80), new Set()).length, 64);
  const longTaken = slugifySkillName("x".repeat(80), new Set(["x".repeat(64)]));
  assert.equal(longTaken, `${"x".repeat(62)}-2`);
  // A cut that lands on a hyphen doesn't leave one dangling
  assert.equal(slugifySkillName(`${"a".repeat(63)} b`, new Set()), "a".repeat(63));
});

test("a title that slugs to a Windows device name gets a suffix", () => {
  assert.equal(slugifySkillName("Con", new Set()), "con-2");
  assert.equal(slugifySkillName("AUX", new Set()), "aux-2");
  assert.equal(slugifySkillName("Com1", new Set(["com1-2"])), "com1-3");
});

test("a built SKILL.md round-trips through the parser with every value quoted", () => {
  const text = buildSkillMarkdown({
    name: "a",
    title: 'He said "hi": ok',
    description: "Use when: always #1",
    instructions: "Steps",
  });
  const r = parseSkillMarkdown(text);
  assert.equal(r.data.metadata.display_name, 'He said "hi": ok');
  assert.equal(r.data.description, "Use when: always #1");
  assert.deepEqual([r.data.name, r.body, r.problems, r.warnings], ["a", "Steps\n", [], []]);
});

test("a built SKILL.md has the header, a blank line and the trimmed instructions", () => {
  const text = buildSkillMarkdown({
    name: "weekly-recap",
    title: " Weekly recap ",
    description: " Writes my recap. ",
    instructions: "\n## Steps\n1. Read notes.\n\n",
  });
  assert.equal(
    text,
    [
      "---",
      "name: weekly-recap",
      'description: "Writes my recap."',
      "metadata:",
      '  display_name: "Weekly recap"',
      "---",
      "",
      "## Steps",
      "1. Read notes.",
      "",
    ].join("\n")
  );
});

test("display names fall back to the prettified name", () => {
  assert.equal(displayNameFor("meeting-prep", {}), "Meeting prep");
  assert.equal(displayNameFor("meeting-prep", null), "Meeting prep");
  assert.equal(displayNameFor("meeting-prep", { display_name: 7 }), "Meeting prep");
  assert.equal(displayNameFor("meeting-prep", { display_name: "  " }), "Meeting prep");
  assert.equal(displayNameFor("meeting-prep", { display_name: " Prep " }), "Prep");
});

test("text and script detection", () => {
  assert.equal(isTextFile(Buffer.from("# Notes\nÜmlaut ✓\n")), true);
  assert.equal(isTextFile(Buffer.alloc(0)), true);
  assert.equal(isTextFile(Buffer.from("abc\u0000def")), false);
  assert.equal(isTextFile(Buffer.from([0x61, 0xc3, 0x28])), false);
  assert.equal(isTextFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
  assert.equal(isScriptPath("scripts/x.sh"), true);
  assert.equal(isScriptPath("scripts/notes.md"), true);
  assert.equal(isScriptPath("tools/run.py"), true);
  assert.equal(isScriptPath("tools/Run.PS1"), true);
  assert.equal(isScriptPath("references/a.md"), false);
  assert.equal(isScriptPath("assets/logo.png"), false);
});

test("the content hash ignores file order and changes with any byte", () => {
  const a = { path: "SKILL.md", data: Buffer.from("x") };
  const b = { path: "references/r.md", data: Buffer.from("y") };
  assert.match(contentHash([a, b]), /^[0-9a-f]{64}$/);
  assert.equal(contentHash([a, b]), contentHash([b, a]));
  assert.notEqual(contentHash([a, b]), contentHash([a, { ...b, data: Buffer.from("z") }]));
  assert.notEqual(contentHash([a, b]), contentHash([a, { ...b, path: "references/s.md" }]));
  assert.notEqual(contentHash([a]), contentHash([a, { path: "empty.md", data: Buffer.alloc(0) }]));
});
