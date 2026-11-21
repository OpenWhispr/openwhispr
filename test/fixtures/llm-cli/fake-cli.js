// Fake vendor CLI for the llm-cli runtime tests. Tests spawn it through
// process.execPath and pick the behavior with FAKE_CLI_MODE. FAKE_CLI_REPORT
// names a file the fake writes a JSON report to (argv, stdin, whether the
// canary reached argv or env) so tests can prove what the child actually saw.
const fs = require("fs");
const path = require("path");

const mode = process.env.FAKE_CLI_MODE || "codex-ok";
const canary = process.env.FAKE_CLI_CANARY || "";
const argv = process.argv.slice(2);
const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");

function valueAfter(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function report(extra = {}) {
  if (!process.env.FAKE_CLI_REPORT) return;
  const promptFile = valueAfter("--prompt-file");
  fs.writeFileSync(
    process.env.FAKE_CLI_REPORT,
    JSON.stringify({
      argv,
      argvHasCanary: canary.length > 0 && argv.join(" ").includes(canary),
      hasOauthEnv: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
      envKeys: Object.keys(process.env),
      cwd: process.cwd(),
      promptFileContent: promptFile ? fs.readFileSync(promptFile, "utf8") : undefined,
      ...extra,
    })
  );
}

function readStdin(done) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => done(data));
}

switch (mode) {
  case "codex-ok":
    readStdin((stdin) => {
      process.stderr.write("fake codex progress\n");
      fs.writeFileSync(valueAfter("-o"), read("codex-last-message.txt"));
      report({ stdin });
      process.exit(0);
    });
    break;
  case "claude-stream":
    readStdin((stdin) => {
      report({ stdin });
      process.stdout.write(read("claude-stream.ndjson"));
      process.exit(0);
    });
    break;
  case "grok-json":
    // The pinned grok fixture records the CLI's known hang, so the fake prints a
    // synthetic result in the shape the parser reads.
    report();
    process.stdout.write('{"result":"OK"}');
    process.exit(0);
    break;
  case "agy-json":
    report();
    process.stdout.write(read("agy-json.txt"));
    process.exit(0);
    break;
  case "signed-out":
    process.stderr.write("Not logged in. Please run login first.\n");
    process.exit(1);
    break;
  case "stderr-canary":
    process.stderr.write(`request failed for credential ${canary}\n`);
    process.exit(1);
    break;
  case "fail":
    process.stderr.write("boom\n");
    process.exit(3);
    break;
  case "hang":
    report();
    process.stdout.write("");
    setInterval(() => {}, 1000);
    break;
  default:
    process.stderr.write(`unknown FAKE_CLI_MODE ${mode}\n`);
    process.exit(64);
}
