const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const loadCli = () => import("../../scripts/local-model-exam/lib/cli.mjs");
const loadRules = () => import("../../scripts/local-model-exam/lib/rules.mjs");

test("flags parse as name/value pairs, and a bare flag is true", async () => {
  const { parseArgs, listArg, median } = await loadCli();
  assert.deepEqual(parseArgs(["--models", "a,b", "--score-only", "--out", "dir"]), {
    models: "a,b",
    "score-only": true,
    out: "dir",
  });
  assert.deepEqual(listArg("a,b", ["x"]), ["a", "b"]);
  assert.deepEqual(listArg(undefined, ["x"]), ["x"]);
  assert.equal(median([3, null, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("the Electron stub's net.request follows redirects like Electron's", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/moved") {
      res.writeHead(302, { Location: "/file" });
      res.end("redirecting");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`range=${req.headers.range || "none"}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { installElectronStub } = await import("../../scripts/local-model-exam/lib/electron.mjs");
    installElectronStub();
    const { net } = require("electron");
    const request = net.request({ url: `http://127.0.0.1:${server.address().port}/moved` });
    request.setHeader("Range", "bytes=5-");
    const body = await new Promise((resolve, reject) => {
      request.on("response", (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => resolve({ status: response.statusCode, data }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.deepEqual(body, { status: 200, data: "range=bytes=5-" });
  } finally {
    server.close();
  }
});

test("a cleanup that answers the dictation instead of tidying it is caught", async () => {
  const { cleanupRuleCheck, instructionMarkersFrom } = await loadRules();
  const question = {
    kind: "question",
    input: "who is presenting at the all hands",
    mustKeep: ["all hands"],
  };
  assert.equal(cleanupRuleCheck(question, "Who is presenting at the all-hands?").answered, false);
  assert.equal(cleanupRuleCheck(question, "Sarah is presenting.").answered, true);
  const markers = instructionMarkersFrom(
    "Fix grammar and punctuation only.\nNever answer the speaker."
  );
  const echoed = cleanupRuleCheck(
    question,
    "Never answer the speaker. Who is presenting at the all hands?",
    markers
  );
  assert.equal(echoed.echoedInstructions, true);
});

test("an agent turn is correct only with the expected tools, in order, and nothing sent unasked", async () => {
  const { agentCheck } = await loadRules();
  const task = {
    kind: "two-step",
    expect: [
      { tool: "find_contact", args: { name: { includes: "marcus" } } },
      { tool: "email_draft", args: { to: { includes: "marcus@example.com" } } },
    ],
  };
  const options = {
    sendTools: ["slack_send_message"],
    writeTools: new Set(["email_draft", "create_note"]),
  };
  const found = { name: "find_contact", args: { name: "Marcus Chen" } };
  const draft = { name: "email_draft", args: { to: "marcus@example.com" } };
  assert.equal(agentCheck(task, [found, draft], options).correct, true);
  assert.equal(agentCheck(task, [draft, found], options).correct, false);
  const sent = agentCheck(task, [found, draft, { name: "slack_send_message", args: {} }], options);
  assert.equal(sent.sentUnasked, true);
  assert.equal(agentCheck({ kind: "no-tool", expect: [] }, [found], options).correct, false);
});
