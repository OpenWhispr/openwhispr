const test = require("node:test");
const assert = require("node:assert/strict");
const unzipper = require("unzipper");

const { readSkillArchive, isSafeArchivePath } = require("../../../src/helpers/skills/skillArchive");
const { buildZip, withClaimedEntries, withComment } = require("./zipFixture");

const SKILL = "---\nname: my-skill\ndescription: Does it.\n---\n\nSteps\n";
const read = (entries, options) => readSkillArchive(buildZip(entries), options);
const refusal = (code) => ({ files: [], rootFolder: null, problems: [{ code }] });
const paths = (result) => result.files.map((entry) => entry.path).sort();

test("SKILL.md at the root or inside one folder is found", async () => {
  const atRoot = await read([
    { path: "SKILL.md", data: SKILL },
    { path: "references/a.md", data: "A" },
  ]);
  assert.deepEqual([paths(atRoot), atRoot.rootFolder, atRoot.problems], [
    ["SKILL.md", "references/a.md"],
    null,
    [],
  ]);

  const inFolder = await read([
    { path: "my-skill/", mode: 0o040755 },
    { path: "my-skill/skill.md", data: SKILL },
    { path: "my-skill/references/a.md", data: "A" },
  ]);
  assert.deepEqual([paths(inFolder), inFolder.rootFolder, inFolder.problems], [
    ["SKILL.md", "references/a.md"],
    "my-skill",
    [],
  ]);
});

test("an entry that climbs out with ../ is refused", async () => {
  const result = await read([
    { path: "SKILL.md", data: SKILL },
    { path: "references/../../escape.md", data: "x" },
  ]);
  assert.deepEqual(result, refusal("unsafePath"));
});

test("absolute, drive and backslash paths are refused", async () => {
  for (const raw of ["/etc/x", "C:/x", "c:x", "a\\..\\..\\x", "references//a.md", "a\u0001b"]) {
    const result = await read([
      { path: "SKILL.md", data: SKILL },
      { path: raw, data: "x" },
    ]);
    assert.deepEqual(result, refusal("unsafePath"), raw);
  }
});

test("a symlink entry is refused", async () => {
  const result = await read([
    { path: "SKILL.md", data: SKILL },
    { path: "references/secrets", data: "/Users/someone/.ssh/id_rsa", mode: 0o120777 },
  ]);
  assert.deepEqual(result, refusal("symlink"));
});

test("an entry larger than its declared size stops at the 25 MB cap", async () => {
  const limits = { maxBytes: 1000 };
  const deflated = await read(
    [
      { path: "SKILL.md", data: SKILL },
      { path: "assets/bomb.bin", data: Buffer.alloc(5000), declaredSize: 10, deflate: true },
    ],
    { limits }
  );
  assert.deepEqual(deflated, refusal("tooLarge"));

  const stored = await read(
    [
      { path: "SKILL.md", data: SKILL },
      { path: "assets/big.bin", data: Buffer.alloc(5000, 1), declaredSize: 10 },
    ],
    { limits }
  );
  assert.deepEqual(stored, refusal("tooLarge"));

  const honest = await read(
    [
      { path: "SKILL.md", data: SKILL },
      { path: "assets/big.bin", data: Buffer.alloc(2000, 1) },
    ],
    { limits }
  );
  assert.deepEqual(honest, refusal("tooLarge"));
});

test("more than 500 files are refused", async () => {
  const entries = [
    { path: "SKILL.md", data: SKILL },
    { path: "a.md", data: "a" },
    { path: "b.md", data: "b" },
    { path: "c.md", data: "c" },
  ];
  assert.deepEqual(await read(entries, { limits: { maxFiles: 3 } }), refusal("tooManyFiles"));
  assert.deepEqual((await read(entries, { limits: { maxFiles: 4 } })).problems, []);
});

// The reader walks every entry the end record claims, so the claim is checked first.
test("an end record that claims more entries than allowed is refused unopened", async () => {
  const forged = buildZip([{ path: "SKILL.md", data: SKILL }]);
  forged.writeUInt16LE(3000, forged.length - 12); // the end record's total entry count
  assert.deepEqual(await readSkillArchive(forged), refusal("tooManyFiles"));
});

// A skill is far smaller than zip64 exists for, and a zip64 record can claim more entries
// than the reader could walk.
test("a zip64 archive claiming millions of entries is refused at once", async () => {
  const zip = buildZip([{ path: "SKILL.md", data: SKILL }]);
  const forged = withClaimedEntries(zip, 2_000_000, "offset");
  const peakKilobytes = process.resourceUsage().maxRSS;
  const started = Date.now();
  assert.deepEqual(await readSkillArchive(forged), refusal("unreadableArchive"));
  assert.ok(Date.now() - started < 1000);
  assert.ok(process.resourceUsage().maxRSS - peakKilobytes < 50 * 1024);
});

for (const [marker, field] of [
  ["entries", "entry count"],
  ["offset", "listing offset"],
  ["disk", "disk number"],
]) {
  test(`a zip64 archive marked by its end record's ${field} is refused unopened`, async (t) => {
    const open = t.mock.method(unzipper.Open, "buffer", async () => {
      throw new Error("opened");
    });
    const zip = buildZip([{ path: "SKILL.md", data: SKILL }]);
    for (const count of [1, 2_000_000]) {
      const forged = withClaimedEntries(zip, count, marker);
      assert.deepEqual(await readSkillArchive(forged), refusal("unreadableArchive"), `${count}`);
    }
    assert.equal(open.mock.callCount(), 0);
  });
}

test("a file too short to hold an end record is refused", async () => {
  const stub = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(await readSkillArchive(stub), refusal("unreadableArchive"));
});

test("an archive with a long comment still opens", async () => {
  const commented = withComment(buildZip([{ path: "SKILL.md", data: SKILL }]), "x".repeat(200));
  const result = await readSkillArchive(commented);
  assert.deepEqual([paths(result), result.problems], [["SKILL.md"], []]);
});

test("no SKILL.md, two SKILL.md files, or one nested two folders deep are refused", async () => {
  assert.deepEqual(await read([{ path: "notes.md", data: "x" }]), refusal("noSkillFile"));
  const two = await read([
    { path: "a/SKILL.md", data: SKILL },
    { path: "b/skill.md", data: SKILL },
  ]);
  assert.deepEqual(two, refusal("multipleSkillFiles"));
  const deep = await read([{ path: "a/b/SKILL.md", data: SKILL }]);
  assert.deepEqual(deep, refusal("skillFileTooDeep"));
  const stray = await read([
    { path: "my-skill/SKILL.md", data: SKILL },
    { path: "stray.md", data: "x" },
  ]);
  assert.deepEqual(stray, refusal("skillFileTooDeep"));
});

test("macOS archive leftovers are ignored", async () => {
  const result = await read([
    { path: "__MACOSX/my-skill/._SKILL.md", data: "junk" },
    { path: "my-skill/SKILL.md", data: SKILL },
    { path: "my-skill/.DS_Store", data: "junk" },
    { path: "my-skill/references/.DS_Store", data: "junk" },
  ]);
  assert.deepEqual([paths(result), result.rootFolder, result.problems], [
    ["SKILL.md"],
    "my-skill",
    [],
  ]);
});

test("a name this computer can't save is refused", async () => {
  for (const raw of [
    "references/con.md",
    "references/COM1",
    "references/CONIN$",
    "references/con .md",
    "nul  .txt",
    "conout$.md",
    "lpt¹.txt",
    "a?.md",
    "trailing. ",
  ]) {
    const result = await read([
      { path: "SKILL.md", data: SKILL },
      { path: raw, data: "x" },
    ]);
    assert.deepEqual(result, refusal("unsafePath"), raw);
  }
});

test("two paths that differ only in case are refused", async () => {
  const result = await read([
    { path: "SKILL.md", data: SKILL },
    { path: "references/A.md", data: "x" },
    { path: "references/a.md", data: "y" },
  ]);
  assert.deepEqual(result, refusal("unsafePath"));
});

test("a file with the same name as a folder is refused", async () => {
  const result = await read([
    { path: "SKILL.md", data: SKILL },
    { path: "references", data: "x" },
    { path: "references/a.md", data: "y" },
  ]);
  assert.deepEqual(result, refusal("unsafePath"));
});

test("a file that isn't a zip is refused", async () => {
  assert.deepEqual(await readSkillArchive(Buffer.from("plain text")), refusal("unreadableArchive"));
  const corrupt = buildZip([{ path: "SKILL.md", data: SKILL, deflate: true }]);
  corrupt.fill(0xff, 30 + "SKILL.md".length, 40 + "SKILL.md".length);
  assert.deepEqual(await readSkillArchive(corrupt), refusal("unreadableArchive"));
});

test("an entry whose bytes don't match its checksum is refused", async () => {
  for (const deflate of [false, true]) {
    const result = await read([
      { path: "SKILL.md", data: SKILL },
      { path: "references/notes.md", data: "Notes", deflate, crc: 0xdeadbeef },
    ]);
    assert.deepEqual(result, refusal("unreadableArchive"), `deflate ${deflate}`);
  }
});

// Each entry inflates its own bytes, so entries that share them would repeat that work.
test("entries that share one stretch of data are refused", async () => {
  const result = await read([
    { path: "SKILL.md", data: SKILL },
    { path: "assets/a.bin", data: Buffer.alloc(2000, 7) },
    { path: "assets/b.bin", sharesDataOf: 1 },
    { path: "assets/c.bin", sharesDataOf: 1 },
  ]);
  assert.deepEqual(result, refusal("unreadableArchive"));
});

// Without the zip64 field its listing points at, an entry has no size to keep its read to
// its own bytes, so entries could share data unnoticed.
test("entries whose listed sizes point at a missing zip64 field are refused", async () => {
  const result = await read([
    { path: "SKILL.md", data: SKILL },
    { path: "assets/a.bin", data: Buffer.alloc(2000, 7) },
    { path: "assets/b.bin", sharesDataOf: 1, sizeInZip64: true },
    { path: "assets/c.bin", sharesDataOf: 1, sizeInZip64: true },
  ]);
  assert.deepEqual(result, refusal("unreadableArchive"));
});

test("file bytes come back unchanged", async () => {
  const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 254, 255]);
  const crlf = "---\r\nname: my-skill\r\ndescription: Does it.\r\n---\r\n\r\nSteps\r\n";
  const result = await read([
    { path: "SKILL.md", data: crlf, deflate: true },
    { path: "assets/logo.png", data: logo },
  ]);
  const byPath = Object.fromEntries(result.files.map((entry) => [entry.path, entry.data]));
  assert.deepEqual(byPath["assets/logo.png"], logo);
  assert.equal(byPath["SKILL.md"].toString("utf8"), crlf);
});

test("archive paths are checked the way the folder will be written", () => {
  assert.equal(isSafeArchivePath("references/notes.md"), true);
  assert.equal(isSafeArchivePath("./SKILL.md"), true);
  assert.equal(isSafeArchivePath("references/../SKILL.md"), false);
  assert.equal(isSafeArchivePath(""), false);
  assert.equal(isSafeArchivePath("references/"), false);
  assert.equal(isSafeArchivePath('say"hi".md'), false);
  assert.equal(isSafeArchivePath("references/con x.md"), true);
});
