const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Compiles the real browser match and typing plan, never posting a keystroke, and
// prints one JSON line per case: which apps are typed into and the chunks per text.
const HARNESS = `
import Cocoa

__TYPING__

let bundleIds = [
    "com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.app.fmgjjmmmlfnkbppncabfkddbjimcfncm",
    "com.microsoft.edgemac.Beta", "company.thebrowser.dia", "com.google.Chromecast",
    "com.tinyspeck.slackmacgap", "com.microsoft.VSCode", "com.apple.Safari",
]
for bundleId in bundleIds {
    print("{\\"browser\\":\\"\\(bundleId)\\",\\"typed\\":\\(isTypedBrowser(bundleId))}")
}
let input = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
for text in try! JSONDecoder().decode([String].self, from: Data(input.utf8)) {
    let chunks = typingChunks(for: text).map { $0.map { String(utf16CodeUnits: $0, count: $0.count) } }
    let encoded = String(decoding: try! JSONEncoder().encode(chunks), as: UTF8.self)
    print("{\\"chunks\\":\\(encoded)}")
}
`;

const FAMILY = "👨‍👩‍👧‍👦";
const TEXTS = [
  "Hello there",
  "x".repeat(21),
  "two\nlines",
  "carriage\rreturn",
  "line separator",
  "tab\there",
  "e",
  "a".repeat(2000),
  "a".repeat(2001),
  `${FAMILY}${FAMILY}${FAMILY}`,
  "café 👍🏽 done",
];

test(
  "macOS typing covers Chromium browsers and only single lines it can type safely",
  { skip: process.platform !== "darwin" },
  (t) => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../resources/macos-fast-paste.swift"),
      "utf8"
    );
    const start = source.indexOf("let typedBrowsers");
    const end = source.indexOf("// End of typingChunks.", start);
    assert.ok(start >= 0 && end > start);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-paste-typing-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const harness = path.join(directory, "main.swift");
    const binary = path.join(directory, "paste-typing-test");
    fs.writeFileSync(harness, HARNESS.replace("__TYPING__", source.slice(start, end)));
    const compile = spawnSync("xcrun", ["swiftc", "-O", harness, "-o", binary], {
      encoding: "utf8",
    });
    assert.equal(compile.status, 0, compile.stderr);

    const run = spawnSync(binary, [], { input: JSON.stringify(TEXTS), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const typed = Object.fromEntries(
      lines.filter((line) => "browser" in line).map((line) => [line.browser, line.typed])
    );
    const chunks = lines.filter((line) => "chunks" in line).map((line) => line.chunks);

    // Channels and installed web apps share the browser's identifier; Electron apps don't.
    assert.deepEqual(typed, {
      "com.google.Chrome": true,
      "com.google.Chrome.canary": true,
      "com.google.Chrome.app.fmgjjmmmlfnkbppncabfkddbjimcfncm": true,
      "com.microsoft.edgemac.Beta": true,
      "company.thebrowser.dia": true,
      "com.google.Chromecast": false,
      "com.tinyspeck.slackmacgap": false,
      "com.microsoft.VSCode": false,
      "com.apple.Safari": false,
    });

    const [
      plain,
      overflow,
      newline,
      carriageReturn,
      lineSeparator,
      tab,
      single,
      longest,
      tooLong,
      families,
      accents,
    ] = chunks;
    assert.deepEqual(plain, ["Hello there"]);
    // A lone character left at the end would reach the page as a keypress.
    assert.deepEqual(overflow, ["x".repeat(19), "xx"]);
    for (const [label, plan] of Object.entries({
      newline,
      carriageReturn,
      lineSeparator,
      tab,
      single,
      tooLong,
    })) {
      assert.equal(plan, null, `${label} goes through ⌘V`);
    }
    assert.equal(longest.join(""), "a".repeat(2000));
    assert.ok(longest.every((chunk) => chunk.length <= 20));
    // Whole characters only: a family emoji is 11 UTF-16 units and never split.
    assert.deepEqual(families, [FAMILY, FAMILY, FAMILY]);
    assert.deepEqual(accents, ["café 👍🏽 done"]);
  }
);
