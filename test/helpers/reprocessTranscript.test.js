const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/reprocessTranscript.ts");

test("reprocesses and persists while preserving the exact raw transcript", async () => {
  const { reprocessTranscript } = await load();
  const rawText = "  Um, exact source.  ";
  const calls = [];

  const row = await reprocessTranscript({
    rawText,
    process: async (text) => {
      calls.push(["process", text]);
      return "Exact source.";
    },
    persist: async (processed, raw) => {
      calls.push(["persist", processed, raw]);
      return { success: true, transcription: { id: 7, text: processed, raw_text: raw } };
    },
  });

  assert.deepEqual(calls, [
    ["process", rawText],
    ["persist", "Exact source.", rawText],
  ]);
  assert.equal(row.raw_text, rawText);
});

test("does not write when reasoning fails or returns empty text", async () => {
  const { reprocessTranscript } = await load();
  let writes = 0;
  const persist = async () => {
    writes += 1;
    return { success: true, transcription: {} };
  };

  await assert.rejects(
    reprocessTranscript({
      rawText: "source",
      process: async () => {
        throw new Error("provider unavailable");
      },
      persist,
    }),
    /provider unavailable/
  );
  await assert.rejects(
    reprocessTranscript({ rawText: "source", process: async () => "  ", persist }),
    /empty transcript/
  );
  assert.equal(writes, 0);
});

test("rejects missing raw text and a failed database write", async () => {
  const { reprocessTranscript } = await load();
  let processed = false;

  await assert.rejects(
    reprocessTranscript({
      rawText: null,
      process: async () => {
        processed = true;
        return "unused";
      },
      persist: async () => ({ success: true, transcription: {} }),
    }),
    /raw transcript is unavailable/
  );
  assert.equal(processed, false);

  await assert.rejects(
    reprocessTranscript({
      rawText: "source",
      process: async () => "cleaned",
      persist: async () => ({ success: false, error: "write failed" }),
    }),
    /write failed/
  );
});
