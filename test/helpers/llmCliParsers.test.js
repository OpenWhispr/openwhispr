const test = require("node:test");
const assert = require("node:assert");

const mod = require("../../src/helpers/llmCliProviders.js");

const TOKEN =
  "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_AbCdEfGhIjKlMnOp-AA";

test("stripAnsi removes CSI, OSC and carriage-return redraws", () => {
  assert.strictEqual(mod.stripAnsi("\x1b[31mred\x1b[0m text"), "red text");
  assert.strictEqual(mod.stripAnsi("\x1b]0;title\x07body"), "body");
  assert.strictEqual(mod.stripAnsi("\x1b]8;;https://a.b\x1b\\link\x1b]8;;\x1b\\"), "link");
  assert.strictEqual(mod.stripAnsi("progress 10%\rprogress 100%\nnext"), "progress 100%\nnext");
  assert.strictEqual(mod.stripAnsi("a\r\nb"), "a\nb");
  assert.strictEqual(mod.stripAnsi(null), "");
});

test("extractSetupToken: plain, colored, wrapped; null for partial and api keys", () => {
  assert.ok(TOKEN.length >= 100);
  const plain = `Your OAuth token:\n\n${TOKEN}\n\nStore this token securely.\n`;
  assert.strictEqual(mod.extractSetupToken(plain), TOKEN);
  assert.strictEqual(mod.extractSetupToken(`\x1b[1;32m${TOKEN}\x1b[0m\r\n`), TOKEN);
  const wrapped = `${TOKEN.slice(0, 80)}\n${TOKEN.slice(80)}\n\nStore this token securely. You will not see it again.\n`;
  assert.strictEqual(mod.extractSetupToken(wrapped), TOKEN);
  assert.strictEqual(mod.extractSetupToken(`${TOKEN.slice(0, 80)}\n`), null);
  assert.strictEqual(mod.extractSetupToken("sk-ant-oat01-abc"), null);
  assert.strictEqual(mod.extractSetupToken(`key: sk-ant-api03-${"A".repeat(90)}`), null);
  assert.strictEqual(mod.extractSetupToken("no token here"), null);
});

test("extractSignInUrl returns the first allowlisted URL only", () => {
  const out = [
    "Docs: https://example.com/help",
    "Phish: https://claude.ai.evil.example/login",
    "Open https://auth.openai.com/codex/device to continue.",
  ].join("\n");
  assert.strictEqual(mod.extractSignInUrl("codex", out), "https://auth.openai.com/codex/device");
  assert.strictEqual(mod.extractSignInUrl("claude", out), null);
  assert.strictEqual(
    mod.extractSignInUrl("grok", "\x1b[4mhttps://accounts.x.ai/device?user_code=AB12-CD34\x1b[0m."),
    "https://accounts.x.ai/device?user_code=AB12-CD34"
  );
  assert.strictEqual(mod.extractSignInUrl("claude", "http://claude.ai/x"), null);
});

test("extractDeviceCode needs a device URL and a letter in the code", () => {
  const text = "Open https://auth.openai.com/codex/device\nEnter code: ABCD-EFGH\n";
  assert.strictEqual(mod.extractDeviceCode(text), "ABCD-EFGH");
  assert.strictEqual(mod.extractDeviceCode("code 7XQK-ZPL3 visit https://accounts.x.ai/d"), "7XQK-ZPL3");
  assert.strictEqual(mod.extractDeviceCode("ABCD-EFGH but no url"), null);
  assert.strictEqual(mod.extractDeviceCode("https://a.example/x 2026-1120"), null);
});

test("parseClaudeStreamLine", () => {
  const delta = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  });
  assert.deepStrictEqual(mod.parseClaudeStreamLine(delta), { type: "text-delta", text: "OK" });
  assert.deepStrictEqual(
    mod.parseClaudeStreamLine(JSON.stringify({ type: "result", is_error: false, result: "OK" })),
    { type: "final", text: "OK" }
  );
  const err = (result) =>
    mod.parseClaudeStreamLine(JSON.stringify({ type: "result", is_error: true, result }));
  assert.deepStrictEqual(err("Invalid API key - please run /login"), { type: "error", code: "not-signed-in" });
  assert.deepStrictEqual(err("OAuth token has expired"), { type: "error", code: "not-signed-in" });
  assert.deepStrictEqual(err("Usage limit reached"), { type: "error", code: "quota-or-rate-limit" });
  assert.deepStrictEqual(err("boom"), { type: "error", code: "exit-nonzero" });
  for (const line of [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: {} }),
    JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
    JSON.stringify({ type: "mystery" }),
    "not json",
    "",
    "null",
    "[1]",
  ]) {
    assert.strictEqual(mod.parseClaudeStreamLine(line), null, line);
  }
});

test("parseCodexFinal", () => {
  assert.deepStrictEqual(mod.parseCodexFinal({ fileText: "  OK \n", stderrText: "" }), {
    type: "final",
    text: "OK",
  });
  assert.deepStrictEqual(mod.parseCodexFinal({ fileText: "", stderrText: "Error: not logged in" }), {
    type: "error",
    code: "not-signed-in",
  });
  assert.deepStrictEqual(mod.parseCodexFinal({ fileText: "", stderrText: "429 Too Many Requests" }), {
    type: "error",
    code: "quota-or-rate-limit",
  });
  assert.deepStrictEqual(mod.parseCodexFinal({}), { type: "error", code: "parse-failed" });
});

test("parseJsonResult field order, plain fallback, empty", () => {
  for (const seat of ["grok", "agy"]) {
    assert.deepStrictEqual(mod.parseJsonResult(seat, JSON.stringify({ result: "A", text: "B" })), {
      type: "final",
      text: "A",
    });
    assert.deepStrictEqual(mod.parseJsonResult(seat, JSON.stringify({ result: "", response: "C" })), {
      type: "final",
      text: "C",
    });
    assert.deepStrictEqual(mod.parseJsonResult(seat, JSON.stringify({ output: "D" })), {
      type: "final",
      text: "D",
    });
    assert.deepStrictEqual(mod.parseJsonResult(seat, "plain OK\n"), { type: "final", text: "plain OK" });
    assert.deepStrictEqual(mod.parseJsonResult(seat, "  \n"), { type: "error", code: "parse-failed" });
    assert.deepStrictEqual(mod.parseJsonResult(seat, JSON.stringify({ nope: 1 })), {
      type: "error",
      code: "parse-failed",
    });
  }
  assert.deepStrictEqual(mod.parseJsonResult("zzz", "x"), { type: "error", code: "parse-failed" });
});

test("classifyStderr", () => {
  assert.strictEqual(mod.classifyStderr("claude", "Please run /login"), "not-signed-in");
  assert.strictEqual(mod.classifyStderr("grok", "You are not logged in. Run grok login"), "not-signed-in");
  assert.strictEqual(mod.classifyStderr("agy", "authentication required"), "not-signed-in");
  assert.strictEqual(mod.classifyStderr("codex", "rate limit exceeded"), "quota-or-rate-limit");
  assert.strictEqual(mod.classifyStderr("codex", "weekly quota used"), "quota-or-rate-limit");
  assert.strictEqual(mod.classifyStderr("codex", "something else"), null);
  assert.strictEqual(mod.classifyStderr("nope", "not logged in"), null);
});

test("scrubFixture removes identifying data", () => {
  const raw = [
    "mail me@corp.example",
    "id 123e4567-e89b-12d3-a456-426614174000",
    `tok ${TOKEN}`,
    "jwt eyJhbGciOi.eyJzdWIiOiIx.abcDEF123",
    "path C:\\Users\\someone\\proj and C:\\\\Users\\\\someone\\\\proj and /Users/bob/x and /home/amy/y",
    "org org_ABCDEF123456 acct_ZZZZ99998888",
  ].join("\n");
  const out = mod.scrubFixture(raw);
  for (const leak of ["me@corp", "123e4567", "AbCdEfGh", "eyJhbGciOi", "someone", "bob", "amy", "ABCDEF123456", "ZZZZ9999"]) {
    assert.ok(!out.includes(leak), leak);
  }
  assert.ok(out.includes("<HOME>"));
});

test("hostile input: completes fast and never throws", () => {
  const big = "\x1b[0".repeat(350000);
  const spaces = " ".repeat(1000000) + "x";
  const token = "sk-ant-oat01-" + "A".repeat(1000000);
  const noNewline = "https://claude.ai/" + "a".repeat(1000000);
  const start = Date.now();
  for (const input of [big, spaces, token, noNewline, "\r".repeat(1000000), "a ".repeat(500000)]) {
    mod.stripAnsi(input);
    mod.extractSetupToken(input);
    mod.extractSignInUrl("claude", input);
    mod.extractDeviceCode(input);
    mod.classifyStderr("claude", input);
    mod.parseJsonResult("grok", input);
    mod.parseClaudeStreamLine(input);
    mod.parseCodexFinal({ fileText: "", stderrText: input });
    mod.scrubFixture(input);
    mod.redactSecrets(input);
  }
  assert.ok(Date.now() - start < 5000, "all parsers over 6 hostile 1 MB inputs finished");
  const each = (fn, input) => {
    const t = Date.now();
    fn(input);
    return Date.now() - t;
  };
  const path = "\x1b]" + "a".repeat(1000000);
  assert.ok(each(mod.stripAnsi, path) < 500);
  assert.ok(each((s) => mod.extractSetupToken(s), token) < 500);
  assert.ok(each((s) => mod.extractSignInUrl("claude", s), noNewline) < 500);
  assert.ok(each(mod.scrubFixture, spaces) < 500);
});

test("inputs over 2 MB are capped, not processed whole", () => {
  const huge = "a".repeat(3 * 1024 * 1024);
  assert.ok(mod.stripAnsi(huge).length <= 2 * 1024 * 1024);
});
