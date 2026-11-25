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

test("the wider check rejects an empty answer to real speech", async () => {
  const { assertPlausibleCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const output of ["", "   \n", "..."]) {
    assert.throws(() => assertPlausibleCleanupOutput(RAW, output), {
      code: "CLEANUP_OUTPUT_INVALID",
      messageKey: "hooks.audioRecording.errorDescriptions.cleanupEmptyReply",
    });
  }
});

test("the wider check accepts an empty answer to filler or a few words", async () => {
  const { assertPlausibleCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const raw of ["um uh", "um so yeah uh like okay", "uh thank you", "", "hmm okay so well"]) {
    assert.doesNotThrow(() => assertPlausibleCleanupOutput(raw, ""), raw);
  }
});

test("the wider check rejects an answer far longer than what was said", async () => {
  const { assertPlausibleCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const [raw, output] of [
    [RAW, `${CLEAN} ${CLEAN} ${CLEAN}`],
    [
      "write a haiku about autumn",
      "Crisp leaves drift and fall, golden light on quiet paths, the year breathes out slow.",
    ],
    [
      LONG_RAW,
      `${LONG_CLEAN} Here is a summary of the key points you raised, along with some suggestions for next steps.`,
    ],
  ]) {
    assert.throws(() => assertPlausibleCleanupOutput(raw, output), {
      code: "CLEANUP_OUTPUT_INVALID",
      message: /far more text/,
    });
  }
});

test("the wider check accepts ordinary cleanup, including modest growth", async () => {
  const { assertPlausibleCleanupOutput } = await import("../../src/utils/cleanupOutput.ts");
  for (const [raw, output] of [
    [RAW, CLEAN],
    [LONG_RAW, LONG_CLEAN],
    // Short dictations may grow past 1.5x while staying short.
    ["thx c u 2moro", "Thanks, see you tomorrow at the office."],
    ["send it", "Send it."],
    // Numbers and abbreviations spelled out.
    ["meet at 3 pm on the 5th re q3 kpis", "Meet at three PM on the fifth regarding Q3 KPIs."],
  ]) {
    assert.doesNotThrow(() => assertPlausibleCleanupOutput(raw, output), output);
  }
});

const OPTIONS =
  "we looked at three options for the new onboarding flow and the team liked the second one best because it asks for the microphone permission only when it is needed.";
const QUESTION =
  "the open question is whether the account step should come before or after the first dictation since signing in early lets us sync the dictionary.";
const NEXT_STEP =
  "next week we will build a prototype of both orders and test them with five people from the beta list.";
const OPTIONS_CLEAN =
  "We looked at three options for the new onboarding flow, and the team liked the second one best because it asks for the microphone permission only when it is needed.";
const QUESTION_CLEAN =
  "The open question is whether the account step should come before or after the first dictation, since signing in early lets us sync the dictionary.";
const NEXT_STEP_CLEAN =
  "Next week we will build a prototype of both orders and test them with five people from the beta list.";
const PASSAGES = `${OPTIONS} ${QUESTION} ${NEXT_STEP}`;

test("the missing-run check finds nothing missing from a faithful answer", async () => {
  const { longestMissingRun } = await import("../../src/utils/cleanupOutput.ts");
  assert.equal(longestMissingRun(PASSAGES, PASSAGES), 0);
  assert.equal(
    longestMissingRun(PASSAGES, `${OPTIONS_CLEAN} ${QUESTION_CLEAN} ${NEXT_STEP_CLEAN}`),
    0
  );
  assert.equal(longestMissingRun(LONG_RAW, LONG_CLEAN), 0);
});

test("the missing-run check counts a dropped passage word for word", async () => {
  const { longestMissingRun } = await import("../../src/utils/cleanupOutput.ts");
  // QUESTION is 25 words.
  assert.equal(longestMissingRun(PASSAGES, `${OPTIONS_CLEAN} ${NEXT_STEP_CLEAN}`), 25);
});

test("the missing-run check counts what a looping answer never reached", async () => {
  const { longestMissingRun } = await import("../../src/utils/cleanupOutput.ts");
  // Longer than what was said, yet QUESTION and NEXT_STEP (45 words) are gone.
  const looping = Array(4).fill(OPTIONS_CLEAN).join(" ");
  assert.equal(longestMissingRun(PASSAGES, looping), 45);
});

test("the missing-run check ignores hesitations on the speaker's side only", async () => {
  const { longestMissingRun } = await import("../../src/utils/cleanupOutput.ts");
  assert.equal(
    longestMissingRun(
      "um so uh i think um we should uh move the meeting to uh friday because er the client is hmm out on thursday",
      "So I think we should move the meeting to Friday because the client is out on Thursday."
    ),
    0
  );
  // "like" and "so" are words the answer keeps, so they still count.
  assert.equal(
    longestMissingRun(
      "we would like to move the launch to friday so that the support team has time to update the help center articles",
      "We would like to move the launch to Friday so that the support team has time to update the help center articles."
    ),
    0
  );
});

test("punctuation, case and apostrophes are not missing words", async () => {
  const { longestMissingRun } = await import("../../src/utils/cleanupOutput.ts");
  for (const [raw, output] of [
    [
      "dont worry its fine we cant ship it on friday because the client isnt ready yet so lets wait until monday",
      "Don't worry, it's fine. We can't ship it on Friday because the client isn't ready yet, so let's wait until Monday.",
    ],
    [
      "we don’t need the old export step any more because the new one is faster",
      "We don't need the old export step any more because the new one is faster.",
    ],
    [
      "the follow-up email goes out on MONDAY to everyone on the beta list",
      "The follow up email goes out on Monday to everyone on the beta list.",
    ],
  ]) {
    assert.equal(longestMissingRun(raw, output), 0, output);
  }
});

test("a short edit the cleanup is meant to make stays well under a drop", async () => {
  const { longestMissingRun } = await import("../../src/utils/cleanupOutput.ts");
  // The false start "can you send the report" is removed.
  assert.equal(
    longestMissingRun(
      "can you send the report can you please send the quarterly report to marie by friday afternoon so she has time to review it before the board meeting on monday",
      "Can you please send the quarterly report to Marie by Friday afternoon, so she has time to review it before the board meeting on Monday?"
    ),
    5
  );
});

test("the missing-run check reads languages written without spaces", async () => {
  const { longestMissingRun } = await import("../../src/utils/cleanupOutput.ts");
  const chinese = [
    "我们下周要发布新版本，但是测试还没有通过，所以可能要推迟到下下周。",
    "另外设计团队希望在发布之前再检查一遍新的引导流程，因为上次的反馈说权限请求出现得太早了。",
    "最后我们还需要更新帮助中心的文章，并且通知所有测试用户。",
  ];
  // The dropped sentence's words, as this runtime's ICU splits them.
  const segmenter = new Intl.Segmenter("und", { granularity: "word" });
  const dropped = Array.from(segmenter.segment(chinese[1])).filter((s) => s.isWordLike).length;
  assert.ok(dropped >= 20, `only ${dropped} words`);
  assert.equal(longestMissingRun(chinese.join(""), chinese.join("")), 0);
  assert.equal(longestMissingRun(chinese.join(""), `${chinese[0]}${chinese[2]}`), dropped);

  const russian = [
    "Мы планируем выпустить новую версию на следующей неделе, если все тесты пройдут успешно.",
    // 20 words.
    "Команда дизайна хочет ещё раз проверить новый процесс регистрации, потому что пользователи жаловались на слишком ранний запрос доступа к микрофону.",
    "После этого мы обновим статьи в справочном центре.",
  ];
  assert.equal(longestMissingRun(russian.join(" "), `${russian[0]} ${russian[2]}`), 20);
});

test("the missing-run check matches 4-word phrases: one word rewritten in five is no gap", async () => {
  const { longestMissingRun } = await import("../../src/utils/cleanupOutput.ts");
  // Four kept words around each rewritten one are covered by 4-word phrases;
  // 5-word phrases would find all 30 words missing.
  const groups = Array.from({ length: 6 }, (_, g) =>
    [0, 1, 2, 3].map((w) => `a${g * 4 + w}`).join(" ")
  );
  const raw = groups.map((group) => `${group} gonna`).join(" ");
  const output = groups.map((group) => `${group} going to`).join(" ");
  assert.equal(longestMissingRun(raw, output), 1);
});

test("the missing-run check matches the measured reference (guards.py, 4-word phrases)", async () => {
  const { longestMissingRun } = await import("../../src/utils/cleanupOutput.ts");
  // Expected values from openwhispr-finetune guard/guards.py uncovered_run(). Its
  // tokens are ASCII only and keep apostrophes, so these vectors avoid both.
  for (const [raw, output, expected] of [
    [
      "um so first we need to finish the migration script and run it against the staging database twice then uh we should write the release notes for the desktop app and send them to the design team for review before thursday and finally we can tag the build and ship it to the beta channel on friday morning",
      "So first we need to finish the migration script and run it against the staging database twice. Finally, we can tag the build and ship it to the beta channel on Friday morning.",
      23,
    ],
    ["please book a table for six people at the italian place", "Okay.", 11],
    // Fewer than four words said (hesitations aside): nothing to measure.
    ["um yes uh please do", "", 0],
    [LONG_RAW, LONG_CLEAN, 0],
  ]) {
    assert.equal(longestMissingRun(raw, output), expected, raw);
  }
});
