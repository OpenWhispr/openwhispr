const test = require("node:test");
const assert = require("node:assert/strict");

const RAW = "um so can you uh send me the report by friday";
const CLEAN = "Can you send me the report by Friday?";
const LONG_RAW =
  "the team wants to ship the release next week but the team also wants the tests to pass first so the release might slip to the week after";
const LONG_CLEAN =
  "The team wants to ship the release next week, but the team also wants the tests to pass first, so the release might slip to the week after.";

// #2225: these synthetic cases cover duplication. CUS-227's original raw/final
// pair and configuration are still missing, so example substitution is unverified.
test("cleanup rejects whole-output duplication without requiring a match to raw speech", async () => {
  const { assertValidCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const output of [
    `${CLEAN} ${CLEAN}`,
    `Cleaned transcript:\n${CLEAN}\n\n${CLEAN}`,
    `**Cleaned transcript:**\n${CLEAN}\n**Cleaned transcript:**\n${CLEAN}`,
    `**Cleaned transcript**:\n${CLEAN}\n${CLEAN}`,
    `Can you send me\nCleaned transcript:\nthe report by Friday? ${CLEAN}`,
    `${CLEAN}\n${CLEAN}\nCleaned transcript:`,
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
        messageKey: "hooks.audioRecording.errorDescriptions.cleanupDuplicated",
      },
      output
    );
  }
  // Filler-heavy speech can be as long as its cleanup said twice, and longer or
  // stuttered speech repeats words without being said twice.
  for (const [raw, output] of [
    ["um so uh basically can you uh like send me the report by friday um yeah", CLEAN],
    [LONG_RAW, LONG_CLEAN],
    [
      "I I I think we we should uh we should move the the meeting to to friday because because the the client is is out on on thursday",
      "I think we should move the meeting to Friday because the client is out on Thursday.",
    ],
  ]) {
    assert.throws(() => assertValidCleanupOutput(raw, `${output} ${output}`), {
      code: "CLEANUP_OUTPUT_INVALID",
    });
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
    [RAW, `**Cleaned transcript:**\n${CLEAN}`],
    [RAW, `**${CLEAN}**`],
    [RAW, "What's the capital of France?"],
    [RAW, ""],
    [RAW, "  \n "],
    [`${CLEAN} ${CLEAN}`, `${CLEAN.toUpperCase()}\n${CLEAN}`],
    ["Send it Thursday no wait Friday", "Send it Friday."],
    ["déjà vu élève", "Déjà vu, élève."],
    [
      "um please send the report by friday please send the report by friday",
      "Please send the report by Friday. Please send the report by Friday.",
    ],
    [
      "im gonna send the report to marie tomorrow im gonna send the report to marie tomorrow",
      "I'm going to send the report to Marie tomorrow. I'm going to send the report to Marie tomorrow.",
    ],
    [`${LONG_RAW} ${LONG_RAW}`, `${LONG_CLEAN} ${LONG_CLEAN}`],
    [
      "were gonna ship it on friday for sure um were gonna ship it on friday for sure",
      "We're going to ship it on Friday for sure. We're going to ship it on Friday for sure.",
    ],
  ]) {
    assert.doesNotThrow(() => assertValidCleanupOutput(raw, output), output);
  }
});
