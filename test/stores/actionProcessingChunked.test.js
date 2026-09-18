const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A note that does not fit the local model's window is summarised in parts and
// then merged (#2142 part 3). Everything that fits keeps today's single call.

const ACTION = { id: 1, name: "Generate Notes", prompt: "Summarize the meeting." };
const LABELS = { noModel: "no model", noEndpoint: "no endpoint", actionFailed: "failed" };
const LINE = "Alice: we agreed to ship the billing migration on Friday after QA.\n";
const BIG_BUDGET = { success: true, maxContextTokens: 131072, modelName: "Qwen3.5 9B" };
// 8192 leaves roughly 4,400 tokens per part after the part prompt and output reserve.
const SMALL_BUDGET = { success: true, maxContextTokens: 8192, modelName: "Qwen3.5 9B" };

async function loadStore(
  t,
  { budget = SMALL_BUDGET, mode = "local", storage = {}, failFirst = false, processText } = {}
) {
  const updates = [];
  const budgetCalls = [];
  installBrowserGlobals(t, {
    // The real settings store reads the route from storage at load time.
    initialStorage: { noteFormattingMode: mode, noteFormattingUseLocal: "true", ...storage },
    window: {
      electronAPI: {
        updateNote: async (noteId, payload) => {
          updates.push({ noteId, payload });
          return { success: true };
        },
        getLocalContextBudget: async (modelId) => {
          budgetCalls.push(modelId);
          if (budget instanceof Error) throw budget;
          return budget;
        },
      },
    },
  });

  const calls = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-action-chunked-test-",
    mockModules: {
      "/services/ReasoningService": `
        export default {
          processText: async (text, model, agentName, config) => {
            const calls = globalThis.__processTextCalls;
            calls.push({ text, model, config });
            if (globalThis.__failFirst && calls.length === 1) {
              const error = new Error("too big");
              error.code = "CONTEXT_TOO_LARGE";
              throw error;
            }
            if (globalThis.__cancelAfter && calls.length === globalThis.__cancelAfter.after) {
              globalThis.__cancelAfter.cancel();
            }
            if (globalThis.__processTextResponse) {
              return globalThis.__processTextResponse(text, config);
            }
            return "# Part notes " + calls.length + "\\n- decided things";
          },
        };
      `,
      "/utils/generateTitle": `export const generateNoteTitle = async () => undefined;`,
    },
  });
  globalThis.__processTextCalls = calls;
  globalThis.__failFirst = failFirst;
  globalThis.__processTextResponse = processText;
  t.after(() => {
    delete globalThis.__processTextCalls;
    delete globalThis.__failFirst;
    delete globalThis.__processTextResponse;
    delete globalThis.__cancelAfter;
  });

  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  return { store, calls, updates, budgetCalls };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const longMaterial = (lines) => ({
  notes: "My own note: watch the QA date.",
  meetingContext: "## Meeting Context\nThe user taking these notes is Alice.",
  transcript: LINE.repeat(lines).trim(),
});

const run = (store, noteId, material, options = {}, action = ACTION) =>
  store.runBackgroundAction(
    noteId,
    [material.notes, material.meetingContext, `## Meeting Transcript\n${material.transcript}`].join(
      "\n\n"
    ),
    "hash",
    action,
    { modelId: "qwen3.5-9b-q4_k_m", isCloudMode: false, isMeetingNote: true, material, ...options },
    LABELS
  );

test("material that fits is one request with today's prompt and no budget read", async (t) => {
  const { store, calls, updates, budgetCalls } = await loadStore(t, { budget: BIG_BUDGET });
  run(store, 1, longMaterial(20));
  await waitFor(() => updates.length > 0, "save");
  assert.equal(calls.length, 1);
  assert.deepEqual(budgetCalls, []);
  assert.ok(calls[0].text.includes("## Meeting Transcript"));
  assert.ok(calls[0].config.systemPrompt.endsWith("Summarize the meeting."));
  assert.equal(calls[0].config.maxTokens, 4096);
});

test("cloud mode never reads the budget and never chunks", async (t) => {
  const { store, calls, updates, budgetCalls } = await loadStore(t, { mode: "openwhispr" });
  run(store, 2, longMaterial(400), { isCloudMode: true });
  await waitFor(() => updates.length > 0, "save");
  assert.equal(calls.length, 1);
  assert.deepEqual(budgetCalls, []);
});

test("refused material is summarised in parts, then merged with the action prompt", async (t) => {
  const { store, calls, updates } = await loadStore(t, { failFirst: true });
  const material = longMaterial(400);
  run(store, 3, material);
  await waitFor(() => updates.length > 0, "save");

  const parts = calls.slice(1, -1);
  const final = calls[calls.length - 1];
  assert.ok(parts.length >= 2, `expected several parts, got ${parts.length}`);
  parts.forEach((call, index) => {
    assert.ok(
      call.text.includes(material.meetingContext),
      "every part carries the meeting context"
    );
    assert.ok(
      call.text.includes(`part ${index + 1} of ${parts.length}`),
      `part ${index + 1} labelled`
    );
    assert.ok(!call.text.includes(material.notes), "manual notes are held for the final pass");
    assert.ok(
      /this part only/i.test(call.config.systemPrompt),
      "part prompt is the part-notes prompt"
    );
    assert.equal(call.config.maxTokens, 2048);
  });
  assert.ok(
    final.config.systemPrompt.includes("Summarize the meeting."),
    "final pass uses the action prompt"
  );
  assert.ok(final.text.includes(material.notes), "final pass carries the manual notes");
  assert.ok(final.text.includes(material.meetingContext));
  for (let index = 1; index <= parts.length; index += 1) {
    assert.ok(
      final.text.includes(`## Notes from part ${index} of ${parts.length}`),
      `part ${index} notes present`
    );
    assert.ok(final.text.includes(`# Part notes ${index + 1}`));
  }
  assert.ok(!final.text.includes("Alice: we agreed"), "final pass never sees the raw transcript");
  assert.equal(
    updates[0].payload.enhanced_content,
    `# Part notes ${calls.length}\n- decided things`
  );
});

test("a refusal whose budget cannot be read is reported without splitting", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    budget: new Error("ipc down"),
    failFirst: true,
  });
  run(store, 4, longMaterial(400));
  await waitForResult(store, updates);
  assert.equal(updates.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(store.consumeErrorEvents()[0].message, "too big");
});

test("a single request refused as CONTEXT_TOO_LARGE falls through to chunking", async (t) => {
  const { store, calls, updates } = await loadStore(t, { budget: BIG_BUDGET, failFirst: true });
  run(store, 5, longMaterial(20));
  await waitFor(() => updates.length > 0, "save");
  assert.ok(calls.length >= 3, `expected the refused call, parts and a merge, got ${calls.length}`);
  assert.ok(/this part only/i.test(calls[1].config.systemPrompt));
});

test("cancelling between parts stops further requests and saves nothing", async (t) => {
  const { store, calls, updates } = await loadStore(t, { failFirst: true });
  globalThis.__cancelAfter = { after: 2, cancel: () => store.cancelAction(6) };
  run(store, 6, longMaterial(400));
  await waitFor(() => calls.length >= 2, "first part");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(calls.length, 2);
  assert.equal(updates.length, 0);
});

test("progress counts parts and ends on the final pass", async (t) => {
  const { store, updates } = await loadStore(t, { failFirst: true });
  const seen = [];
  const unsubscribe = store.useActionProcessingStore.subscribe((state) => {
    const progress = state.noteStates[7]?.progress;
    if (progress) seen.push(`${progress.step}/${progress.total}`);
  });
  t.after(unsubscribe);
  run(store, 7, longMaterial(400));
  await waitFor(() => updates.length > 0, "save");
  assert.ok(seen.length >= 2, `saw ${JSON.stringify(seen)}`);
  const [step, total] = seen[seen.length - 1].split("/").map(Number);
  assert.equal(step, total);
  assert.equal(seen[0], `1/${total}`);
});

async function waitForResult(store, updates) {
  await waitFor(
    () => updates.length > 0 || store.useActionProcessingStore.getState().errorEvents.length > 0,
    "save or failure"
  );
}

const overflow = () => Object.assign(new Error("too big"), { code: "CONTEXT_TOO_LARGE" });
const FLOOR_BUDGET = { success: true, maxContextTokens: 16384, modelName: "Local model" };

test("a truncated part is split and only complete working notes reach the merge", async (t) => {
  let partCalls = 0;
  const { store, calls, updates } = await loadStore(t, {
    failFirst: true,
    processText: (text, config) => {
      if (config.maxTokens === 4096) return "Final notes";
      assert.equal(config.requireCompleteOutput, true);
      partCalls += 1;
      if (partCalls === 1) {
        throw Object.assign(new Error("truncated"), { code: "OUTPUT_TRUNCATED" });
      }
      return `Complete working notes ${partCalls}`;
    },
  });
  run(store, 17, longMaterial(20));
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.equal(partCalls, 3);
  assert.ok(calls.at(-1).text.includes("Complete working notes 2"));
  assert.ok(calls.at(-1).text.includes("Complete working notes 3"));
  assert.equal(calls.at(-1).config.requireCompleteOutput, undefined);
});

test("a part still truncated at the split limit is kept clipped instead of failing the note", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    failFirst: true,
    processText: (text, config) => {
      if (config.maxTokens === 4096) return "Final notes";
      if (config.requireCompleteOutput) {
        throw Object.assign(new Error("truncated"), { code: "OUTPUT_TRUNCATED" });
      }
      return "Clipped working notes";
    },
  });
  run(store, 18, longMaterial(20));
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.deepEqual(store.consumeErrorEvents(), []);
  // 1 + 2 + 4 complete attempts, then 8 leaves that accept a clipped reply.
  assert.equal(calls.filter((call) => call.config.maxTokens === 2048).length, 15);
  assert.ok(calls.at(-1).text.includes("Clipped working notes"));
});

test("cancelling a refused part prevents its first recursive retry", async (t) => {
  let partReturned = false;
  const { store, calls, updates } = await loadStore(t, {
    failFirst: true,
    processText: () => {
      store.cancelAction(19);
      partReturned = true;
      throw overflow();
    },
  });
  run(store, 19, longMaterial(20));
  await waitFor(() => partReturned, "cancelled part");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 2);
  assert.equal(updates.length, 0);
  assert.deepEqual(store.consumeErrorEvents(), []);
});

test("speaker attribution survives packing and an overflow retry", async (t) => {
  let refused = false;
  const { store, calls, updates } = await loadStore(t, {
    failFirst: true,
    processText: (text, config) => {
      if (config.maxTokens === 2048 && !refused) {
        refused = true;
        throw overflow();
      }
      return "Working notes";
    },
  });
  const transcript = "Bob: " + "We discussed the rollout. ".repeat(1500) + "I own the invoice.";
  run(store, 20, { notes: "", meetingContext: "", transcript });
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  for (const call of calls.slice(1, -1)) assert.match(call.text, /\nBob: /);
});

test("a conservative overestimate preserves the original request when the model accepts it", async (t) => {
  const { store, calls, updates } = await loadStore(t, { budget: FLOOR_BUDGET });
  const material = { notes: LINE.repeat(600), meetingContext: "", transcript: "Alice: Hello." };
  run(store, 8, material);
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.includes(material.notes));
  assert.equal(calls[0].config.maxTokens, 4096);
});

test("an exact-token overflow at the final merge reduces the existing part notes and saves", async (t) => {
  let reduced = false;
  const { store, calls, updates } = await loadStore(t, {
    budget: FLOOR_BUDGET,
    failFirst: true,
    processText: (text, config) => {
      if (text.includes("## Working notes")) {
        reduced = true;
        return "Alice owns QA; Bob owns release.";
      }
      if (config.maxTokens === 4096) {
        if (!reduced) throw overflow();
        return "- [ ] QA — Alice\n- [ ] Release — Bob";
      }
      return "Alice owns QA. Bob owns release.";
    },
  });
  run(store, 9, longMaterial(1400));
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.enhanced_content, "- [ ] QA — Alice\n- [ ] Release — Bob");
  assert.equal(calls.filter((call) => call.text.includes("## Working notes")).length, 1);
  assert.equal(calls.filter((call) => call.config.maxTokens === 4096).length, 3);
  assert.ok(calls.at(-1).text.includes("Alice owns QA; Bob owns release."));
});

test("a shorter consolidation is usable even when its section count stays the same", async (t) => {
  let reductions = 0;
  const { store, calls, updates } = await loadStore(t, {
    budget: FLOOR_BUDGET,
    failFirst: true,
    processText: (text, config) => {
      if (text.includes("## Working notes")) {
        reductions += 1;
        return reductions === 1 ? "detail ".repeat(750) : "Alice owns QA.";
      }
      if (config.maxTokens === 4096) {
        if (text.includes("detail")) throw overflow();
        return "- [ ] QA — Alice";
      }
      return "detail ".repeat(750);
    },
  });
  const material = {
    notes: "manual note ".repeat(2325),
    meetingContext: "",
    transcript: LINE.repeat(1400),
  };
  run(store, 10, material);
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.equal(reductions, 2);
  assert.ok(calls.at(-1).text.includes(material.notes));
  assert.ok(calls.at(-1).text.includes("Alice owns QA."));
});

test("the last allowed consolidation still gets a final merge attempt", async (t) => {
  let reductions = 0;
  const { store, updates } = await loadStore(t, {
    failFirst: true,
    processText: (text, config) => {
      if (text.includes("## Working notes")) reductions += 1;
      if (config.maxTokens === 4096) {
        if (reductions < 3) throw overflow();
        return "Final notes";
      }
      return "Working notes";
    },
  });
  run(store, 11, longMaterial(20));
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.equal(reductions, 3);
});

test("repeated merge overflows stop after three consolidations and name the model", async (t) => {
  let reductions = 0;
  const { store, calls, updates } = await loadStore(t, {
    failFirst: true,
    processText: (text, config) => {
      if (text.includes("## Working notes")) reductions += 1;
      if (config.maxTokens === 4096) throw overflow();
      return "Working notes";
    },
  });
  run(store, 12, longMaterial(20));
  await waitForResult(store, updates);
  assert.equal(updates.length, 0);
  assert.equal(reductions, 3);
  assert.equal(calls.filter((call) => call.config.maxTokens === 4096).length, 5);
  const [error] = store.consumeErrorEvents();
  assert.equal(error.messageKey, "models.errors.contextTooLargeGeneric");
  assert.deepEqual(error.messageParams, { model: "Qwen3.5 9B" });
});

test("a non-context merge error is reported without retrying", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    failFirst: true,
    processText: (text, config) => {
      if (config.maxTokens === 4096) throw new Error("model unavailable");
      return "Working notes";
    },
  });
  run(store, 13, longMaterial(20));
  await waitForResult(store, updates);
  assert.equal(updates.length, 0);
  assert.equal(store.consumeErrorEvents()[0].message, "model unavailable");
  assert.equal(
    calls.some((call) => call.text.includes("## Working notes")),
    false
  );
});

test("cancelling a failed merge prevents further consolidation and saving", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    failFirst: true,
    processText: (text, config) => {
      if (config.maxTokens === 4096) {
        store.cancelAction(14);
        throw overflow();
      }
      return "Working notes";
    },
  });
  run(store, 14, longMaterial(20));
  await waitFor(() => calls.length === 3, "failed merge");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(updates.length, 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(store.consumeErrorEvents(), []);
});

test("an unbroken CJK part rejected by the tokenizer is split and merged without losing text", async (t) => {
  const accepted = [];
  const { store, updates } = await loadStore(t, {
    budget: FLOOR_BUDGET,
    failFirst: true,
    processText: (text, config) => {
      if (config.maxTokens === 4096) return "Final notes";
      const characters = (text.match(/𠀀/gu) || []).join("");
      if ([...characters].length > 7000) throw overflow();
      accepted.push(characters);
      return "Working notes";
    },
  });
  const body = "𠀀".repeat(14000);
  run(store, 15, { notes: body, meetingContext: "", transcript: "" }, { isMeetingNote: false });
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.equal(accepted.join(""), body);
});

test("the merge preserves a follow-up email action without imposing exhaustive notes", async (t) => {
  const { BUILTIN_ACTIONS } = await import("../../src/helpers/builtinActions.js");
  const email = BUILTIN_ACTIONS.find(
    (action) => action.translationKey === "notes.actions.builtin.followUpEmail"
  );
  const { store, calls, updates } = await loadStore(t, { failFirst: true });
  run(
    store,
    16,
    longMaterial(20),
    {},
    {
      id: 2,
      name: email.name,
      prompt: email.prompt,
      translation_key: email.translationKey,
    }
  );
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  const prompt = calls.at(-1).config.systemPrompt;
  assert.ok(prompt.includes(email.prompt));
  assert.doesNotMatch(prompt, /Completeness outranks brevity|as long as that requires/);
});

test("a local model reached through dictation cleanup is summarised in parts too", async (t) => {
  // Note formatting on its default mode follows dictation cleanup when the user
  // is not on OpenWhispr Cloud, so a local cleanup model answers the request.
  const { store, calls, updates, budgetCalls } = await loadStore(t, {
    mode: "openwhispr",
    failFirst: true,
  });
  run(store, 22, longMaterial(400));
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.deepEqual(budgetCalls, ["qwen3.5-9b-q4_k_m"]);
  const parts = calls.slice(1, -1);
  assert.ok(parts.length >= 2, `expected several parts, got ${parts.length}`);
  for (const part of parts) assert.match(part.config.systemPrompt, /this part only/i);
});

test("re-running a note right after cancelling it never revives the cancelled run", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    failFirst: true,
    // The second run's reply lands after the cancelled run has unwound, so a
    // cancelled run that cleared the note's slot would stop the new one saving.
    processText: (text) =>
      text.includes("Bob: the second run")
        ? new Promise((resolve) => setTimeout(() => resolve("Second run notes"), 50))
        : "Working notes",
  });
  globalThis.__cancelAfter = {
    after: 2,
    cancel: () => {
      store.cancelAction(21);
      run(store, 21, { notes: "", meetingContext: "", transcript: "Bob: the second run." });
    },
  };
  run(store, 21, longMaterial(400));
  await waitFor(() => updates.length > 0, "the second run's save");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(
    updates.map((update) => update.payload.enhanced_content),
    ["Second run notes"]
  );
  assert.equal(
    calls.filter((call) => call.text.includes("Alice: we agreed")).length,
    2,
    "the cancelled run sends nothing after the part already in flight"
  );
});

test("the whole-note request and the merge refuse a reply the window clipped", async (t) => {
  const { store, calls, updates } = await loadStore(t, { failFirst: true });
  run(store, 23, longMaterial(400));
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.equal(calls[0].config.refuseClippedByWindow, true);
  assert.equal(calls.at(-1).config.refuseClippedByWindow, true);
  assert.equal(calls.at(-1).config.maxTokens, 4096);
});

test("a transcript without speaker labels is packed without a prose prefix", async (t) => {
  const { store, calls, updates } = await loadStore(t, { failFirst: true });
  // A note summarised while it is still recording carries the live transcript:
  // one space-joined paragraph, no "Label:" lines, and a colon in the first clause.
  const transcript =
    "Meeting at 10:30 we discussed the rollout plan. " +
    "Then we covered the budget and the hiring plan. ".repeat(600).trim();
  run(store, 21, { notes: "", meetingContext: "", transcript }, { isMeetingNote: false });
  await waitForResult(store, updates);
  assert.deepEqual(store.consumeErrorEvents(), []);
  assert.equal(updates.length, 1);
  const parts = calls.slice(1, -1);
  assert.ok(parts.length > 1);
  assert.equal(parts.map((call) => call.text).join("").split("Meeting at 10:").length - 1, 1);
});

test("parts never spend their output budget on thinking", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    failFirst: true,
    storage: { noteFormattingDisableThinking: "false" },
  });
  run(store, 22, longMaterial(400));
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  assert.equal(calls[0].config.disableThinking, false);
  assert.equal(calls.at(-1).config.disableThinking, false);
  for (const call of calls.slice(1, -1)) assert.equal(call.config.disableThinking, true);
});

test("manual notes that cannot fit the final pass are refused before any part runs", async (t) => {
  const { store, calls, updates } = await loadStore(t, {
    budget: FLOOR_BUDGET,
    failFirst: true,
    processText: (text, config) => {
      if (config.maxTokens === 4096) throw overflow();
      return "Working notes";
    },
  });
  const material = {
    notes: "manual note ".repeat(6000),
    meetingContext: "",
    transcript: LINE.repeat(400),
  };
  run(store, 23, material);
  await waitForResult(store, updates);
  assert.equal(updates.length, 0);
  assert.equal(calls.length, 1);
  const [error] = store.consumeErrorEvents();
  assert.equal(error.messageKey, "models.errors.contextTooLargeGeneric");
});

test("a long plain note is condensed as a document, not as a meeting", async (t) => {
  const { store, calls, updates } = await loadStore(t, { failFirst: true });
  const notes = "The proposal argues that the migration should wait for the audit.\n".repeat(600);
  store.runBackgroundAction(
    24,
    notes,
    "hash",
    ACTION,
    {
      modelId: "qwen3.5-9b-q4_k_m",
      isCloudMode: false,
      material: { notes, meetingContext: "", transcript: "" },
    },
    LABELS
  );
  await waitForResult(store, updates);
  assert.equal(updates.length, 1);
  const parts = calls.slice(1, -1);
  assert.ok(parts.length > 1);
  for (const call of parts) {
    assert.match(call.config.systemPrompt, /document/);
    assert.doesNotMatch(call.config.systemPrompt, /speaker|Decisions|Action Items/);
    assert.match(call.text, /^## Notes \(part \d+ of \d+\)\n/);
  }
});
