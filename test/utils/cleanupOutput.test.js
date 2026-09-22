const test = require("node:test");
const assert = require("node:assert/strict");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";

// #2225: these synthetic cases cover duplication. CUS-227's original raw/final
// pair and configuration are still missing, so example substitution is unverified.
test("cleanup rejects whole-output duplication without requiring a match to raw speech", async () => {
  const { assertValidCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const output of [
    `${CLEAN} ${CLEAN}`,
    `Cleaned transcript:\n${CLEAN}\n\n${CLEAN}`,
    `**Cleaned transcript:**\n${CLEAN}\n**Cleaned transcript:**\n${CLEAN}`,
    `**Cleaned transcript**:\n${CLEAN}\n${CLEAN}`,
    "CAN YOU SEND ME THE REPORT BY FRIDAY!\ncan you send me the report by Friday?",
    "Ｃａｎ you send me the report by Friday?\nCan you send me the report by Friday?",
    "Please send the updated report tomorrow. Please send the updated report tomorrow.",
    "请你明天把修改后的报告发送给项目负责人。请你明天把修改后的报告发送给项目负责人。",
    "Envoyez le rapport complet à Marie demain. Envoyez le rapport complet à Marie demain.",
  ]) {
    assert.throws(
      () => assertValidCleanupOutput(RAW, output),
      {
        code: "CLEANUP_OUTPUT_INVALID",
        reason: "duplicated_transcript",
        messageKey: "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
      },
      output
    );
  }
});

test("cleanup leaves legitimate, ambiguous, and out-of-scope output alone", async () => {
  const { assertValidCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const [raw, output] of [
    [RAW, CLEAN],
    [RAW, "Please send the report tomorrow. Please send the report tomorrow."],
    [RAW, "I'm sorry, I can't. I'm sorry, I can't."],
    [RAW, `${CLEAN} Can you send me the report by Monday?`],
    [RAW, `Introduction. ${CLEAN} ${CLEAN}`],
    [RAW, `${CLEAN} ${CLEAN} Additional details.`],
    [RAW, `${CLEAN}\n${CLEAN}\nCleaned transcript:`],
    [RAW, `Can you send me\nCleaned transcript:\nthe report by Friday?\n${CLEAN}`],
    [RAW, `**Cleaned transcript:**\n${CLEAN}`],
    [RAW, `**${CLEAN}**`],
    [RAW, "What's the capital of France?"],
    [RAW, ""],
    [RAW, "  \n "],
    [`${CLEAN} ${CLEAN}`, `${CLEAN.toUpperCase()}\n${CLEAN}`],
    ["Send it Thursday no wait Friday", "Send it Friday."],
    ["déjà vu élève", "Déjà vu, élève."],
  ]) {
    assert.doesNotThrow(() => assertValidCleanupOutput(raw, output), output);
  }
});
