const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadInfer(t, reply) {
  installBrowserGlobals(t);
  const calls = [];
  globalThis.__inferCalls = calls;
  globalThis.__inferReply = reply;
  t.after(() => {
    delete globalThis.__inferCalls;
    delete globalThis.__inferReply;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-infer-action-output-test-",
    mockModules: {
      "/services/ReasoningService": `
        export default {
          processText: async (text, model, agentName, config) => {
            globalThis.__inferCalls.push({ text, model, config });
            const reply = globalThis.__inferReply;
            if (reply instanceof Error) throw reply;
            return reply;
          },
        };
      `,
    },
  });
  const { inferActionOutput } = await vite.ssrLoadModule("/utils/inferActionOutput.ts");
  return { inferActionOutput, calls };
}

test("an action that changes the summary is inferred as a summary action", async (t) => {
  const { inferActionOutput, calls } = await loadInfer(t, "SUMMARY");
  assert.equal(await inferActionOutput("Translate it to Spanish.", "gpt-4.1", true), "summary");
  assert.equal(calls[0].text, "Translate it to Spanish.");
  assert.equal(calls[0].config.inferenceScope, "noteFormatting", "asks the note model");
  assert.equal(calls[0].config.disableThinking, true, "thinking text would hide the answer");
});

test("a reply is read by its first word, whatever the case or punctuation", async (t) => {
  const { inferActionOutput } = await loadInfer(t, "  summary.");
  assert.equal(await inferActionOutput("Shorten it.", "gpt-4.1", true), "summary");
  globalThis.__inferReply = "<think>Could be chat, but it rewrites the summary.</think>\nSUMMARY";
  assert.equal(await inferActionOutput("Make it longer.", "gpt-4.1", true), "summary");
  globalThis.__inferReply = "CHAT — it writes an email, not the summary";
  assert.equal(await inferActionOutput("Draft an email.", "gpt-4.1", true), "chat");
});

test("without an answer, an action answers in chat and leaves the summary alone", async (t) => {
  const { inferActionOutput } = await loadInfer(t, new Error("no model"));
  assert.equal(await inferActionOutput("Anything.", "", false), "chat");
  globalThis.__inferReply = "";
  assert.equal(await inferActionOutput("Anything.", "gpt-4.1", true), "chat");
});
