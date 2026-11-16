const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

// Compiles the real TranscriptPromise without the permission check or event posting,
// and drives it on a private named pasteboard so the user's clipboard is never touched.
// Reads come from separate processes, as a target app's would.
const HARNESS = `
import Cocoa

__PROMISE__

let arguments = CommandLine.arguments
let pasteboard = NSPasteboard(name: NSPasteboard.Name(arguments[2]))
switch arguments[1] {
case "own":
    let promise = TranscriptPromise(
        pasteboard: pasteboard,
        transcript: String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self),
        session: arguments[4]
    )
    guard promise.write() else { exit(1) }
    let postedAt = ProcessInfo.processInfo.systemUptime
    print("PASTE_POSTED")
    fflush(stdout)
    print(promise.waitForRead(postedAt: postedAt, budgetMs: Int(arguments[3])!))
case "read":
    print(pasteboard.string(forType: .string) ?? "<none>", terminator: "")
case "inspect":
    let tag = pasteboard.data(forType: pasteSessionType).map { String(decoding: $0, as: UTF8.self) }
    print(tag ?? "<none>", (pasteboard.types ?? []).map(\\.rawValue).joined(separator: ","))
case "copy":
    pasteboard.clearContents()
    pasteboard.setString(arguments[3], forType: .string)
case "release":
    pasteboard.releaseGlobally()
default:
    exit(64)
}
`;

function buildHarness(t) {
  const source = fs.readFileSync(
    path.join(__dirname, "../../resources/macos-fast-paste.swift"),
    "utf8"
  );
  const start = source.indexOf("let pasteSessionType");
  const end = source.indexOf("// End of TranscriptPromise.", start);
  assert.ok(start >= 0 && end > start);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-paste-read-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const harness = path.join(directory, "main.swift");
  const binary = path.join(directory, "paste-read-test");
  fs.writeFileSync(harness, HARNESS.replace("__PROMISE__", source.slice(start, end)));
  const compile = spawnSync("xcrun", ["swiftc", "-O", harness, "-o", binary], {
    encoding: "utf8",
  });
  assert.equal(compile.status, 0, compile.stderr);
  return binary;
}

function runOwner(binary, board, budgetMs, transcript) {
  const owner = spawn(binary, ["own", board, String(budgetMs), "session-1"]);
  owner.stdin.end(transcript);
  let output = "";
  const posted = new Promise((resolve) => {
    owner.stdout.on("data", (data) => {
      output += data.toString();
      if (output.includes("PASTE_POSTED\n")) resolve();
    });
  });
  const exited = new Promise((resolve) => owner.on("close", () => resolve(output)));
  return { posted, exited };
}

function run(binary, ...args) {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "macOS transcript promise reports the target's read, however late, and only that",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const binary = buildHarness(t);
    const board = `com.openwhispr.test.paste-read.${process.pid}`;
    try {
      await t.test("a late read is the paste landing", async () => {
        const transcript = "Late reader 👍🏽\nsecond line";
        const owner = runOwner(binary, board, 3000, transcript);
        await owner.posted;
        await sleep(600);
        // Clipboard managers and the caller's restore look at types and the tag only.
        assert.equal(
          run(binary, "inspect", board).trim(),
          "session-1 org.nspasteboard.TransientType,com.openwhispr.paste-session,public.utf8-plain-text,NSStringPboardType"
        );
        assert.equal(run(binary, "read", board), transcript);
        const verdict = /PASTE_READ (\d+)/.exec(await owner.exited);
        assert.ok(verdict, "the read is reported");
        assert.ok(Number(verdict[1]) >= 550, `read reported at ${verdict[1]} ms`);
        assert.equal(run(binary, "read", board), transcript, "the transcript outlives the binary");
      });

      await t.test("nothing read in the budget leaves the transcript itself", async () => {
        const owner = runOwner(binary, board, 200, "never read");
        assert.match(await owner.exited, /^PASTE_POSTED\nPASTE_NOT_READ\n$/);
        assert.equal(run(binary, "read", board), "never read");
      });

      await t.test("a copy before the read is reported as replaced", async () => {
        const owner = runOwner(binary, board, 3000, "transcript");
        await owner.posted;
        run(binary, "copy", board, "copied meanwhile");
        assert.match(await owner.exited, /^PASTE_POSTED\nPASTE_REPLACED\n$/);
        assert.equal(run(binary, "read", board), "copied meanwhile");
      });
    } finally {
      run(binary, "release", board);
    }
  }
);
