const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/cleanupPromptProfiles.ts");
const dictation = { inferenceScope: "dictationCleanup" };

test("S1-mini has its own cleanup prompt; other models have none", async () => {
  const { getCleanupPromptProfile } = await load();
  const profile = getCleanupPromptProfile("s1-mini-q4_k_m", dictation);
  assert.equal(
    profile.systemPrompt,
    "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text."
  );
  assert.equal(
    profile.buildUserContent("um so send the report"),
    "[Styling: semi-formal] [Structure: prose] [Context: general]\num so send the report"
  );
  assert.equal(profile.temperature, 0);
  assert.equal(profile.maxChunkWords, 600);

  for (const model of ["qwen3.5-0.8b-q4_k_m", "gemma-4-e2b-it-qat-q4_0", "", undefined]) {
    assert.equal(getCleanupPromptProfile(model, dictation), null, String(model));
  }
});

test("a profile only replaces the default dictation cleanup prompt", async () => {
  const { getCleanupPromptProfile } = await load();
  for (const config of [
    {},
    { inferenceScope: "noteFormatting" },
    { ...dictation, systemPrompt: "Translate to French" },
    { ...dictation, requiresAgent: true },
    { ...dictation, hasCustomCleanupPrompt: true },
  ]) {
    assert.equal(getCleanupPromptProfile("s1-mini-q4_k_m", config), null, JSON.stringify(config));
  }
});

test("profiled cleanup sends each part in order and joins the answers", async () => {
  const { getCleanupPromptProfile, runProfiledCleanup } = await load();
  const profile = { ...getCleanupPromptProfile("s1-mini-q4_k_m", dictation), maxChunkWords: 4 };
  const sent = [];
  const result = await runProfiledCleanup(
    profile,
    "one two three. four five six. seven.",
    (user) => {
      sent.push(user);
      return Promise.resolve(user.split("\n")[1].toUpperCase());
    }
  );
  assert.deepEqual(
    sent.map((user) => user.split("\n")[1]),
    ["one two three.", "four five six. seven."]
  );
  assert.ok(sent.every((user) => user.startsWith("[Styling: semi-formal]")));
  assert.equal(result, "ONE TWO THREE. FOUR FIVE SIX. SEVEN.");
});

test("a part the model empties (filler only) is left out of the joined text", async () => {
  const { getCleanupPromptProfile, runProfiledCleanup } = await load();
  const profile = { ...getCleanupPromptProfile("s1-mini-q4_k_m", dictation), maxChunkWords: 2 };
  const answers = ["First.", "  ", "Third."];
  const result = await runProfiledCleanup(profile, "first one. um uh. third one.", () =>
    Promise.resolve(answers.shift())
  );
  assert.equal(result, "First. Third.");
});

test("S1-mini's answers go through the wider output check, part by part", async () => {
  const { getCleanupPromptProfile, runProfiledCleanup } = await load();
  const profile = getCleanupPromptProfile("s1-mini-q4_k_m", dictation);
  const raw = "um so can you uh send me the report by friday";
  await assert.rejects(
    runProfiledCleanup(profile, raw, () => Promise.resolve("")),
    { code: "CLEANUP_OUTPUT_INVALID" }
  );
  await assert.rejects(
    runProfiledCleanup(profile, raw, () => Promise.resolve(`${raw} `.repeat(4))),
    { code: "CLEANUP_OUTPUT_INVALID" }
  );
  assert.equal(await runProfiledCleanup(profile, "um uh", () => Promise.resolve("")), "");

  const answers = ["First part is fine.", ""];
  await assert.rejects(
    runProfiledCleanup(
      { ...profile, maxChunkWords: 6 },
      "first part is fine. second part has real words too.",
      () => Promise.resolve(answers.shift())
    ),
    { code: "CLEANUP_OUTPUT_INVALID" }
  );
});

const TUNED_MODEL = "openwhispr-cleanup-qwen3.5-0.8b-q4_k_m";
// Ten-word sentences of distinct words ("w0 w1 … w9."), so a 4-word phrase of an
// answer matches only where it was said. say(0, 15) is the first 150 words.
const SENTENCES = Array.from(
  { length: 90 },
  (_, s) => `${Array.from({ length: 10 }, (_, w) => `w${s * 10 + w}`).join(" ")}.`
);
const say = (from, to) => SENTENCES.slice(from, to).join(" ");
const unwrap = (user) => user.slice("<transcript>\n".length, -"\n</transcript>".length);
const shout = (users) => Promise.resolve(users.map((user) => unwrap(user).toUpperCase()));
const notCleanedAgain = () => assert.fail("the part was cleaned again");
const loadTuned = async () => {
  const profiles = await load();
  return { ...profiles, tuned: profiles.getCleanupPromptProfile(TUNED_MODEL, dictation) };
};

test("a tuned part is cleaned again only when it is over 150 words and lost 20 in a row", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const requestsFor = async (transcript, answer) => {
    let requests = 0;
    await runProfiledCleanup(
      tuned,
      transcript,
      () => Promise.resolve(answer),
      (users) => {
        requests++;
        return shout(users);
      }
    );
    return requests;
  };
  // 150 words with 100 lost is too short to check; one word more is not.
  assert.equal(await requestsFor(say(0, 15), say(0, 5)), 0);
  assert.equal(await requestsFor(`${say(0, 15)} w150.`, say(0, 5)), 1);

  const words = say(0, 30).split(" ");
  const losing = (count) => [...words.slice(0, 100), ...words.slice(100 + count)].join(" ");
  assert.equal(await requestsFor(say(0, 30), losing(19)), 0);
  assert.equal(await requestsFor(say(0, 30), losing(20)), 1);
});

test("with the guard on, a first answer that fails the output check still fails the cleanup", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  // An empty answer to real speech, and one far longer than what was said.
  for (const [label, answer] of [
    ["empty", ""],
    ["runaway", `${say(0, 30)} ${say(0, 20)}`],
  ]) {
    await assert.rejects(
      runProfiledCleanup(tuned, say(0, 30), () => Promise.resolve(answer), notCleanedAgain),
      { code: "CLEANUP_OUTPUT_INVALID" },
      label
    );
  }
});

test("an unpunctuated part is cleaned again in pieces of exactly 150 words", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const words = Array.from({ length: 300 }, (_, index) => `w${index}`);
  const requests = [];
  await runProfiledCleanup(
    tuned,
    words.join(" "),
    () => Promise.resolve([...words.slice(0, 100), ...words.slice(130)].join(" ")),
    (users) => {
      requests.push(users.map(unwrap));
      return shout(users);
    }
  );
  assert.deepEqual(requests, [[words.slice(0, 150).join(" "), words.slice(150).join(" ")]]);
});

test("a long part that lost words is cleaned again in 150-word pieces, in one request", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const requests = [];
  const result = await runProfiledCleanup(
    tuned,
    say(0, 30),
    () => Promise.resolve(`${say(0, 10)} ${say(13, 30)}`),
    (users) => {
      requests.push(users);
      return shout(users);
    }
  );
  assert.deepEqual(requests, [[say(0, 15), say(15, 30)].map(tuned.buildUserContent)]);
  assert.equal(result, say(0, 30).toUpperCase());
});

test("a piece that failed, fails the output check or still lost words is kept as spoken", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const pieces = [say(0, 15), say(15, 30), say(30, 45), say(45, 60)];
  const result = await runProfiledCleanup(
    tuned,
    say(0, 60),
    () => Promise.resolve(say(0, 30)),
    () =>
      Promise.resolve([
        null,
        // Three times what was said.
        `${pieces[1]} ${pieces[1]} ${pieces[1]}`,
        // 30 words lost in a row.
        `${say(30, 40)} ${say(43, 45)}`,
        pieces[3].toUpperCase(),
      ])
  );
  assert.equal(result, [...pieces.slice(0, 3), pieces[3].toUpperCase()].join(" "));
});

test("an empty piece is kept as spoken, or left out when it was only hesitations", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const hesitations = Array(15).fill("um uh er hmm um uh er hmm um uh.").join(" ");
  const result = await runProfiledCleanup(
    tuned,
    `${say(0, 15)} ${hesitations} ${say(15, 30)}`,
    () => Promise.resolve(say(15, 30)),
    () => Promise.resolve(["", "", say(15, 30).toUpperCase()])
  );
  assert.equal(result, `${say(0, 15)} ${say(15, 30).toUpperCase()}`);
});

test("a part whose answer kept everything is not cleaned again", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const result = await runProfiledCleanup(
    tuned,
    say(0, 30),
    (user) => Promise.resolve(unwrap(user).toUpperCase()),
    notCleanedAgain
  );
  assert.equal(result, say(0, 30).toUpperCase());
});

test("only the part that lost words is cleaned again, in its place", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const answers = [say(0, 60).toUpperCase(), `${say(60, 70)} ${say(73, 90)}`];
  const requests = [];
  const result = await runProfiledCleanup(
    tuned,
    say(0, 90),
    () => Promise.resolve(answers.shift()),
    (users) => {
      requests.push(users.map(unwrap));
      return shout(users);
    }
  );
  assert.deepEqual(requests, [[say(60, 75), say(75, 90)]]);
  assert.equal(result, say(0, 90).toUpperCase());
});

test("S1-mini, and callers with no pieces runner, keep the first answer", async () => {
  const { tuned, getCleanupPromptProfile, runProfiledCleanup } = await loadTuned();
  const answer = `${say(0, 10)} ${say(13, 30)}`;
  const s1 = getCleanupPromptProfile("s1-mini-q4_k_m", dictation);
  assert.equal(
    await runProfiledCleanup(s1, say(0, 30), () => Promise.resolve(answer), notCleanedAgain),
    answer
  );
  assert.equal(await runProfiledCleanup(tuned, say(0, 30), () => Promise.resolve(answer)), answer);
});

test("when the pieces request fails as a whole, the part is kept exactly as spoken", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const transcript = `${say(0, 15)}\n\n${say(15, 30)}`;
  const result = await runProfiledCleanup(
    tuned,
    transcript,
    () => Promise.resolve(`${say(0, 10)} ${say(13, 30)}`),
    () => Promise.resolve(null)
  );
  assert.equal(result, transcript);
});

test("a rejected pieces request (a cancel) fails the whole cleanup, as a failed part does", async () => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const cancelled = Object.assign(new Error("cancelled"), { code: "LOCAL_MODEL_CANCELLED" });
  let parts = 0;
  await assert.rejects(
    runProfiledCleanup(
      tuned,
      say(0, 90),
      () => {
        parts++;
        return Promise.resolve(say(0, 30));
      },
      () => Promise.reject(cancelled)
    ),
    (error) => error === cancelled
  );
  assert.equal(parts, 1);
});

test("a part cleaned again is logged with counts only", async (t) => {
  const { tuned, runProfiledCleanup } = await loadTuned();
  const loggerModule = await import("../../src/utils/logger.ts");
  const logger = loggerModule.default.default ?? loggerModule.default;
  const events = [];
  t.mock.method(logger, "logReasoning", (stage, details) => {
    if (stage === "CLEANUP_DROP_GUARD") events.push(details);
  });
  const answer = () => Promise.resolve(`${say(0, 10)} ${say(13, 30)}`);
  await runProfiledCleanup(tuned, say(0, 30), answer, (users) =>
    Promise.resolve([null, unwrap(users[1])])
  );
  await runProfiledCleanup(tuned, say(0, 30), answer, () => Promise.resolve(null));
  await runProfiledCleanup(tuned, say(0, 30), () => Promise.resolve(say(0, 30)), notCleanedAgain);
  assert.deepEqual(events, [
    { partWords: 300, missingRun: 30, pieces: 2, piecesKeptAsSpoken: 1, runnerFailed: false },
    { partWords: 300, missingRun: 30, pieces: 2, piecesKeptAsSpoken: 2, runnerFailed: true },
  ]);
});
