const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/chat/actionClaims.ts");

const OFFERED = new Set([
  "email_draft",
  "slack_send_message",
  "create_note",
  "linear_create_issue",
  "github_comment",
  "request_connection",
  "request_api_key",
  "update_dictionary",
  "search_notes",
]);

const call = (name, extra = {}) => ({
  id: `call-${name}`,
  name,
  arguments: "{}",
  status: "completed",
  ...extra,
});
const sent = (name = "email_draft", extra = {}) =>
  call(name, { metadata: { status: "sent", ...extra } });

test("a send cannot back a claim that a note was created, this turn or earlier", async () => {
  for (const calls of ["turnCalls", "earlierCalls"]) {
    assert.equal(
      await unbacked("I've created the note.", { [calls]: [sent("slack_send_message")] }),
      true
    );
    assert.equal(
      await unbacked("The issue has been created.", { [calls]: [sent("email_draft")] }),
      true
    );
    assert.equal(
      await unbacked("The note has been created.", { [calls]: [call("create_note")] }),
      false
    );
  }
});

const context = (overrides = {}) => ({
  turnCalls: [],
  earlierCalls: [],
  isOffered: (name) => OFFERED.has(name),
  request: { text: "Can you help?" },
  ...overrides,
});

async function unbacked(text, overrides) {
  const { isUnbackedClaim } = await load();
  return isUnbackedClaim(text, context(overrides));
}

test("the adversarial cases come out as a precise safety net should", async () => {
  const dictionaryEdit = call("update_dictionary", { metadata: { added: ["Gabe"] } });
  const cases = [
    ["According to your notes, the invoice was sent Monday", {}, false],
    ["According to your notes, the email was sent Monday", {}, false],
    ["Once it's sent, you'll see it in Sent", {}, false],
    ["Notes are saved automatically", {}, false],
    ["Translation:\n\nHi team, I have sent the email.", {}, false],
    [
      "Here it is, as I wrote it: Hi Gabe, I've sent the invoice for October.",
      {
        turnCalls: [
          call("email_draft", {
            arguments: JSON.stringify({
              to: ["gabe@acme.test"],
              body: "Hi Gabe, I've sent the invoice for October.",
            }),
            metadata: { status: "draft_opened" },
          }),
        ],
      },
      false,
    ],
    ["Message posted to #eng", {}, true],
    ["Sent to Gabe!", {}, true],
    ["Your email to Gabe has been sent.", { turnCalls: [dictionaryEdit] }, true],
    ["I've sent it to Gabe!", { request: { text: "Let me know once it's sent" } }, true],
    ["The issue has been created.", {}, true],
    ["Here's what I did: I've sent the email to Gabe.", {}, true],
    [
      "Yes, it was sent.",
      { earlierCalls: [sent("email_draft", { destination: "gabe@acme.test" })] },
      false,
    ],
  ];
  for (const [text, overrides, expected] of cases) {
    assert.equal(await unbacked(text, overrides), expected, text);
  }
});

test("the three forms in the reply's own voice are claims", async () => {
  for (const text of [
    "I've sent the follow-up to Gabe.",
    "I have just posted it in #eng.",
    "I sent the message to Chad.",
    "I emailed Dana the slides.",
    "It's been sent!",
    "That was posted to #eng.",
    "Your message has been sent to the team.",
    "The email is now sent.",
    "The draft has been drafted and is in Gmail.",
    "Sent to #eng.",
    "✅ Email sent to Josh.",
    "I've connected Gmail for you.",
    "I've saved your OpenAI key.",
    "I've created the note.",
    "I've filed the bug in Linear.",
  ]) {
    assert.equal(await unbacked(text), true, text);
  }
});

test("plans, questions, negations, states and descriptions are not claims", async () => {
  for (const text of [
    "I can send it once you confirm.",
    "I'll send it now.",
    "I haven't sent anything yet.",
    "I have not sent it.",
    "Should I send it to Josh?",
    "Gmail is connected.",
    "Your standup is scheduled for 5:45 PM.",
    "I've created a summary of the meeting:\n- Dana sent the budget.",
    "I've drafted an email to Sarah below:\n\nHi Sarah, I've sent the invite.",
    "I've saved it to your notes.",
    "Done ✅",
    "If it was sent, Gabe has it by now.",
    "",
  ]) {
    assert.equal(await unbacked(text), false, text);
  }
});

test("text the reply writes for the user is not its own voice", async () => {
  for (const text of [
    "Here's a reply: Hi Sarah, I've sent the invite for Thursday.",
    "Sure! Here's a friendlier version:\n\nHi Sarah, I've sent the invite.",
    "**Draft:**\nI have emailed the client and they agreed.",
    "Reply:\nThanks! I've posted it in #eng.",
    'She wrote "I\'ve sent the invite" an hour ago.',
    "> I've sent the invite.\n\nWant me to reply to this?",
    "```\nI've sent the invite.\n```",
  ]) {
    assert.equal(await unbacked(text), false, text);
  }
  // "All done:" and "Here's what I did:" introduce no draft.
  assert.equal(await unbacked("All done: I've sent the email to Gabe."), true);
});

test("a requested English translation is not the assistant's own action claim", async () => {
  const cases = [
    ["I sent the email.", { text: "Translate this: J’ai envoyé le courriel." }],
    ["I sent the email.", { text: "Translate this message: J’ai envoyé le courriel." }],
    ["I sent the email.", { text: "Please translate this email: J’ai envoyé le courriel." }],
    [
      "I sent the email.",
      { text: "Translate to English, output only the translation: J’ai envoyé le courriel." },
    ],
    [
      "I created the note.",
      {
        text: "Translate this to English. Output only the translation.",
        selectedText: "J’ai créé la note.",
      },
    ],
    [
      "I sent the email.",
      { text: 'Could you please translate this email into English: "J’ai envoyé le courriel."' },
    ],
  ];
  for (const [reply, request] of cases) {
    assert.equal(await unbacked(reply, { request }), false, request.text);
  }
});

test("translation requests that also ask for actions still need action evidence", async () => {
  for (const text of [
    "Translate this to English and send it to Gabe.",
    "Translate this into English and afterwards send it to Gabe.",
    "Translate this into English. I also need you to send it to Gabe.",
    "Translate this into English & send it to Gabe.",
    "Translate this; send it to English Club.",
    "Translate this and afterwards send it to Gabe in English.",
    "Translate this to English, then email it to Gabe.",
    "Translate this to English. Could you also post it in #eng?",
    "Translate this to English: Bonjour. Then send it to Gabe.",
    'Translate "Bonjour" to English and create a note with it.',
    'Send Gabe an email explaining what "translate" means.',
  ]) {
    assert.equal(await unbacked("I've sent the email.", { request: { text } }), true, text);
    assert.equal(await unbacked("I've created the note.", { request: { text } }), true, text);
  }
});

test("a message written for someone, from its greeting or subject on, is not the reply's voice", async () => {
  const request = { text: "write an email to sam, tell him the revised proposal is with his team" };
  for (const text of [
    "Hi Sam,\n\nThanks for your patience. I've sent the revised proposal to your team.\n\nBest,\nChad",
    "Hi team, I've sent the invoice to the client.",
    "Subject: Deck\n\nHi Sam, I've sent the deck over.",
    "Sure, here you go:\n\nI've sent the deck over.",
    "Hey Sam! Just a heads-up: I've sent the contract over.",
  ]) {
    assert.equal(await unbacked(text, { request }), false, text);
  }
  // Before the greeting, the reply still speaks for itself.
  assert.equal(await unbacked("I've sent the email to Sam.\n\nHi Sam, thanks!"), true);
  // Unasked for, a greeting that opens a line is the reply greeting the user.
  for (const text of [
    "Hi Chad, I've sent the email to Gabe.",
    "Hey! I've posted it in #eng.",
    "Hello! Done — I've created the issue for you.",
    "Hi Chad!\nI've sent the email to Gabe.",
  ]) {
    assert.equal(await unbacked(text), true, text);
  }
});

test("repeating an earlier claim to correct it claims nothing", async () => {
  for (const text of [
    "Earlier I said I sent the email to Sam, but that didn't happen — nothing was sent.",
    "Sorry, I claimed I posted it in #eng, but it was never posted.",
    "Correction: I said I sent the email, but it wasn't sent.",
  ]) {
    assert.equal(await unbacked(text), false, text);
  }
});

test("answering whether something was done reports on it, so an earlier result backs it", async () => {
  const toEng = sent("slack_send_message", { destination: "#eng" });
  const asked = { request: { text: "Did you post it to #eng?" } };
  for (const text of ["Yes — I've posted it to #eng.", "Yes, I have posted it to #eng."]) {
    assert.equal(await unbacked(text, { ...asked, earlierCalls: [toEng] }), false, text);
    assert.equal(await unbacked(text, asked), true, text);
  }
  // Only a question about something done: asking for a new action isn't one.
  for (const text of [
    "Have a look at this and send it to Sam",
    "Is it possible to post this in #eng?",
    "Has Sam replied yet? Post it to #eng.",
  ]) {
    assert.equal(
      await unbacked("I've posted it to #eng.", { earlierCalls: [toEng], request: { text } }),
      true,
      text
    );
  }
  assert.equal(
    await unbacked("Yes — I've posted it to #eng.", {
      earlierCalls: [toEng],
      request: { text: "Was it posted to #eng?" },
    }),
    false
  );
  // Asked to act again, a claim still needs this turn's result.
  assert.equal(
    await unbacked("I've posted it to #eng.", {
      earlierCalls: [toEng],
      request: { text: "Post it to #eng again" },
    }),
    true
  );
});

test("only a claim's own words in the user's text exempt it, never a stray verb", async () => {
  const selectedText = "Thanks, see you Friday.\n\nSent from my iPhone";
  assert.equal(
    await unbacked("I've sent it to Gabe.", { request: { text: "Reply to this", selectedText } }),
    true
  );
  const rewrite = "I have emailed the client, and they agreed to Friday.";
  assert.equal(
    await unbacked(rewrite, {
      request: {
        text: "Make this more professional",
        selectedText: "hey so i have emailed the client and they r ok with friday",
      },
    }),
    false
  );
  assert.equal(
    await unbacked("Hey team, I've posted the release notes and sent out the invite.", {
      request: { text: "Write a Slack message saying I've posted the release notes" },
    }),
    false
  );
});

test("no tool of the claim's kind, no check", async () => {
  const offered = (names) => ({ isOffered: (name) => names.includes(name) });
  assert.equal(await unbacked("I've sent it to Gabe.", offered(["create_note"])), false);
  assert.equal(await unbacked("I've connected Gmail.", offered(["email_draft"])), false);
  assert.equal(await unbacked("I've sent it to Gabe.", offered(["slack_send_message"])), true);
});

test("a claim is backed only by a result of its kind this turn", async () => {
  const claim = "I've sent it to Gabe.";
  for (const status of ["sent", "unknown", "already_sent"]) {
    assert.equal(await unbacked(claim, { turnCalls: [sent("email_draft", { status })] }), false);
  }
  for (const status of ["failed", "not_sent", "cancelled_by_user", "draft_opened"]) {
    assert.equal(
      await unbacked(claim, { turnCalls: [sent("email_draft", { status })] }),
      true,
      status
    );
  }
  assert.equal(await unbacked(claim, { turnCalls: [call("create_note")] }), true);
  assert.equal(
    await unbacked("Your email has been drafted.", {
      turnCalls: [sent("email_draft", { status: "draft_opened" })],
    }),
    false
  );
  assert.equal(
    await unbacked("I've created the note.", { turnCalls: [call("create_note")] }),
    false
  );
  assert.equal(
    await unbacked("The issue has been created.", {
      turnCalls: [sent("linear_create_issue", { reference: "ENG-12" })],
    }),
    false
  );
  // "Emailed" names its channel: only an email backs it.
  const slackSend = sent("slack_send_message", { destination: "#eng" });
  assert.equal(await unbacked("I've emailed Sam.", { turnCalls: [slackSend] }), true);
  assert.equal(await unbacked("I've emailed Sam.", { turnCalls: [sent("email_draft")] }), false);
  assert.equal(await unbacked("I've sent it to Sam.", { turnCalls: [slackSend] }), false);
});

test("a service named as where it went is not a person it went to", async () => {
  const toEng = sent("slack_send_message", { destination: "#eng" });
  assert.equal(await unbacked("I posted it to Slack.", { earlierCalls: [toEng] }), false);
  assert.equal(await unbacked("I posted it to Sam.", { earlierCalls: [toEng] }), true);
});

test("a very long reply isn't checked, so matching never stalls the chat", async () => {
  const long = `${"word ".repeat(2_000)} I've sent the email to Gabe.`;
  assert.equal(await unbacked(long), false);
  const pathological = "I sent ".repeat(10_000);
  const started = Date.now();
  await unbacked(pathological);
  assert.ok(Date.now() - started < 200);
});

// Interaction tools also save their result as metadata, as the chat does.
const asked = (name, payload, result, metadata) =>
  call(name, { metadata, interaction: { payload, state: "settled", result } });

test("a real connect or saved key backs saying so; a dismissed card doesn't", async () => {
  const connected = asked(
    "request_connection",
    { kind: "connection", target: "gmail" },
    { status: "connected", target: "gmail" },
    { status: "connected", target: "gmail", guidance: "Gmail is connected now." }
  );
  const savedKey = asked(
    "request_api_key",
    { kind: "apiKey", provider: "openai" },
    { status: "saved" },
    { status: "saved", provider: "openai", guidance: "Say only that it is saved." }
  );
  const dismissed = asked(
    "request_connection",
    { kind: "connection", target: "gmail" },
    { status: "cancelled" },
    { status: "cancelled_by_user" }
  );
  assert.equal(await unbacked("I've connected Gmail.", { turnCalls: [connected] }), false);
  assert.equal(await unbacked("I've saved your OpenAI key.", { turnCalls: [savedKey] }), false);
  assert.equal(await unbacked("I've connected Gmail.", { turnCalls: [dismissed] }), true);
  assert.equal(await unbacked("I've saved your OpenAI key.", { turnCalls: [connected] }), true);
});

test("an earlier turn backs only a report of the same kind, to whoever it names", async () => {
  const toGabe = sent("email_draft", { destination: "gabe@acme.test" });
  // A new claim always needs this turn.
  assert.equal(
    await unbacked("Done! I've sent the follow-up to Gabe.", { earlierCalls: [toGabe] }),
    true
  );
  assert.equal(await unbacked("Yes, it was sent.", { earlierCalls: [toGabe] }), false);
  assert.equal(
    await unbacked("Yes, your email to Gabe was sent.", { earlierCalls: [toGabe] }),
    false
  );
  assert.equal(
    await unbacked("Yes, your email to Dana was sent.", { earlierCalls: [toGabe] }),
    true
  );
  // A first-person claim about before, or in the simple past, reports on that
  // earlier turn: a work-log line the user asked for is never "not done".
  assert.equal(await unbacked("I sent it to Gabe earlier.", { earlierCalls: [toGabe] }), false);
  const workLog = "I sent Gabe a concise Q3 roadmap email covering the November launch.";
  assert.equal(await unbacked(workLog, { earlierCalls: [toGabe] }), false);
  assert.equal(await unbacked(workLog), true);
  // Another kind never backs it.
  assert.equal(await unbacked("Yes, it was sent.", { earlierCalls: [call("create_note")] }), true);
  assert.equal(await unbacked("Yes, it was sent.", {}), true);
});

test("a Slack DM sent by its id backs a report naming its person, not anyone else", async () => {
  // A DM id is labelled with the person whose DM a Send opened.
  const toDm = sent("slack_send_message", { destination: "Sam Rivera" });
  assert.equal(await unbacked("I sent it to Sam earlier.", { earlierCalls: [toDm] }), false);
  assert.equal(
    await unbacked("Yes, your message to Sam was sent.", { earlierCalls: [toDm] }),
    false
  );
  assert.equal(await unbacked("I sent it to Alice earlier.", { earlierCalls: [toDm] }), true);
  assert.equal(await unbacked("I posted it in #eng earlier.", { earlierCalls: [toDm] }), true);
});
