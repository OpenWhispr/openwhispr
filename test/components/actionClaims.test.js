const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/chat/actionClaims.ts");

test("a reply that says this turn did something is a new claim", async () => {
  const { claimedAction } = await load();
  for (const text of [
    "Done! I've sent a follow-up email to Gabe saying he can ignore the last one.",
    "I've prompted you to connect your calendar.",
    "I’ve gone ahead and posted it in #general.",
    "I have scheduled the meeting for 3 PM tomorrow.",
    "I've created the issue for the login bug.",
    "I've added the standup to your calendar.",
    "I've saved it to your notes.",
    "✅ Email sent!",
    "Sure.\nMessage posted to #eng.",
    "[Tools used: email_draft (sent)]\n\nDone, it's on its way.",
    // A delivery before a colon is still one.
    "I've sent Gabe the following:\n\nHi Gabe, ignore the last email.",
  ]) {
    assert.equal(claimedAction(text), "new", text);
  }
});

test("a reply that reports something was done is a recalled claim", async () => {
  const { claimedAction } = await load();
  for (const text of [
    "Yes, it was sent.",
    "It's been sent!",
    "I've already sent it to Gabe.",
    "I sent the message to Chad.",
    "Your email has been sent to Josh.",
    "Gmail has been connected.",
    "Your key is saved.",
    "Yes — I sent it earlier in this chat: https://mail.google.com/mail/u/0/#sent",
    "I posted it in #eng yesterday.",
  ]) {
    assert.equal(claimedAction(text), "recalled", text);
  }
});

test("plans, offers, questions, negations and states are not claims", async () => {
  const { claimedAction } = await load();
  for (const text of [
    "I can send it once you confirm.",
    "Gmail is connected.",
    "Your standup is scheduled for 5:45 PM.",
    "The invite was sent by Sarah on Monday.",
    "I'll send it now.",
    "I haven't sent anything yet.",
    "I have not sent it, and I didn't post anything either.",
    "Should I send it to Josh?",
    "Have I sent it? No, the card was cancelled.",
    "I've rewritten it to be shorter.",
    "I searched your notes and found three meetings with Dana.",
    "Once you approve the card, it will be sent.",
    "The draft is ready for you to review and send.",
    "Your calendar is not connected yet, so I can't check it.",
    "",
  ]) {
    assert.equal(claimedAction(text), null, text);
  }
});

test("text the reply drafts or quotes for the user is not its own claim", async () => {
  const { claimedAction } = await load();
  for (const text of [
    "Here's a reply: Hi Sarah, I've sent the invite for Thursday.",
    "Sure! Here's a friendlier version:\n\nHi Sarah, I've sent the invite for Thursday.",
    "I've drafted an email to Sarah below:\n\nHi Sarah,\n\nI've sent the invite.",
    "I've created a summary of the meeting:\n- Dana has sent the budget.",
    "I've updated the wording below so it sounds friendlier:",
    "**Draft:**\nI have emailed the client and they agreed.",
    "Reply:\nThanks! I've posted it in #eng.",
    'She wrote "I\'ve sent the invite" an hour ago.',
    "> I've sent the invite.\n\nWant me to reply to this?",
    "```\nI've sent the invite.\n```",
  ]) {
    assert.equal(claimedAction(text), null, text);
  }
});

test("a claim the user's own text already makes is theirs, as in a rewrite", async () => {
  const { claimedAction } = await load();
  const rewrite = "I have emailed the client, and they agreed to Friday.";
  assert.equal(claimedAction(rewrite, "i have emailed the client. they said friday works"), null);
  assert.equal(claimedAction(rewrite), "new");
});

const call = (name, extra = {}) => ({
  id: `call-${name}`,
  name,
  arguments: "{}",
  status: "completed",
  ...extra,
});

test("a claim is backed by an action that happened, or may have", async () => {
  const { backsActionClaim } = await load();
  const action = (status) => call("email_draft", { metadata: { status } });
  for (const status of ["sent", "draft_opened", "unknown", "already_sent"]) {
    assert.equal(backsActionClaim(action(status), false), true, status);
  }
  for (const status of [
    "failed",
    "not_sent",
    "cancelled_by_user",
    "needs_clarification",
    "unavailable",
  ]) {
    assert.equal(backsActionClaim(action(status), false), false, status);
  }
  // A call that failed or never finished backs nothing.
  assert.equal(backsActionClaim(call("create_note", { status: "error" }), false), false);
  assert.equal(backsActionClaim(call("create_note", { status: "stopped" }), false), false);
});

// Interaction tools also save their result as metadata, as the chat does.
const asked = (name, payload, result, metadata) =>
  call(name, {
    metadata,
    interaction: { payload, state: "settled", ...(result ? { result } : {}) },
  });

test("a finished connection or saved key backs a claim; a dismissed card doesn't", async () => {
  const { backsActionClaim } = await load();
  const connection = { kind: "connection", target: "gmail" };
  assert.equal(
    backsActionClaim(
      asked(
        "request_connection",
        connection,
        { status: "connected", target: "gmail" },
        { status: "connected", target: "gmail", guidance: "Gmail is connected now." }
      ),
      true
    ),
    true
  );
  assert.equal(
    backsActionClaim(
      asked(
        "request_api_key",
        { kind: "apiKey", provider: "openai" },
        { status: "saved" },
        { status: "saved", provider: "openai", guidance: "Say only that it is saved." }
      ),
      true
    ),
    true
  );
  const settings = { kind: "settings", target: "llms" };
  assert.equal(
    backsActionClaim(
      asked("open_settings", settings, { status: "done" }, { status: "done" }),
      true
    ),
    true
  );
  assert.equal(
    backsActionClaim(
      asked(
        "open_settings",
        settings,
        { status: "done", ready: false },
        { status: "done", ready: false }
      ),
      true
    ),
    false
  );
  assert.equal(
    backsActionClaim(
      asked(
        "request_connection",
        connection,
        { status: "cancelled" },
        { status: "cancelled_by_user" }
      ),
      true
    ),
    false
  );
  assert.equal(
    backsActionClaim(
      asked(
        "ask_user",
        { kind: "questions", questions: [] },
        { status: "answered", answers: {} },
        {
          status: "answered",
          answers: {},
        }
      ),
      true
    ),
    false
  );
  // A send that connected first is judged by the send.
  const connectedThenFailed = call("slack_send_message", {
    metadata: { status: "failed" },
    interaction: {
      payload: { kind: "connection", target: "slack" },
      state: "settled",
      result: { status: "connected", target: "slack" },
    },
  });
  assert.equal(backsActionClaim(connectedThenFailed, false), false);
  assert.equal(
    backsActionClaim({ ...connectedThenFailed, metadata: { status: "sent" } }, false),
    true
  );
});

test("a tool that changes something backs a claim; a lookup doesn't", async () => {
  const { backsActionClaim } = await load();
  assert.equal(backsActionClaim(call("update_note", { metadata: { id: 3 } }), false), true);
  assert.equal(backsActionClaim(call("search_notes", { metadata: [{ id: 3 }] }), true), false);
  assert.equal(backsActionClaim(call("get_calendar_events"), true), false);
});

const sent = (name = "email_draft") => call(name, { metadata: { status: "sent" } });
const context = (overrides = {}) => ({
  turnCalls: [],
  earlierCalls: [],
  isReadOnly: (name) => ["search_notes", "get_calendar_events"].includes(name),
  request: { text: "Is it sent?" },
  ...overrides,
});

test("a new claim needs this turn's result; an earlier recorded one doesn't back it", async () => {
  const { isUnbackedClaim } = await load();
  const claim = "Done! I've sent a follow-up email to Gabe.";
  assert.equal(isUnbackedClaim(claim, context()), true);
  assert.equal(isUnbackedClaim(claim, context({ earlierCalls: [sent()] })), true);
  assert.equal(isUnbackedClaim(claim, context({ turnCalls: [sent()] })), false);
  // A lookup this turn backs nothing.
  assert.equal(isUnbackedClaim(claim, context({ turnCalls: [call("search_notes")] })), true);
});

test("confirming what an earlier turn recorded is backed; a claim nothing recorded isn't", async () => {
  const { isUnbackedClaim } = await load();
  for (const text of ["Yes, it was sent.", "It's been sent!", "I've already sent it to Gabe."]) {
    assert.equal(isUnbackedClaim(text, context()), true, text);
    assert.equal(isUnbackedClaim(text, context({ earlierCalls: [sent()] })), false, text);
    assert.equal(isUnbackedClaim(text, context({ turnCalls: [sent()] })), false, text);
  }
});

test("a saved key or a real connect backs saying so", async () => {
  const { isUnbackedClaim } = await load();
  const savedKey = asked(
    "request_api_key",
    { kind: "apiKey", provider: "openai" },
    { status: "saved" },
    { status: "saved", provider: "openai", guidance: "Say only that it is saved." }
  );
  const isReadOnly = () => true;
  assert.equal(
    isUnbackedClaim("Your key is saved.", context({ isReadOnly, turnCalls: [savedKey] })),
    false
  );
  const connected = asked(
    "request_connection",
    { kind: "connection", target: "gmail" },
    { status: "connected", target: "gmail" },
    { status: "connected", target: "gmail" }
  );
  assert.equal(
    isUnbackedClaim("Gmail has been connected.", context({ isReadOnly, turnCalls: [connected] })),
    false
  );
});

test("a rewrite of the user's selected or quoted text is never flagged", async () => {
  const { isUnbackedClaim } = await load();
  const reply = "I have emailed the client, and they agreed to Friday.";
  assert.equal(
    isUnbackedClaim(
      reply,
      context({
        request: { text: "Make this clearer", selectedText: "emailed client, they ok with fri" },
      })
    ),
    false
  );
  assert.equal(
    isUnbackedClaim(
      reply,
      context({ request: { text: 'Make this clearer: "I emailed the client, they ok fri"' } })
    ),
    false
  );
  assert.equal(isUnbackedClaim(reply, context({ request: { text: "Did you email them?" } })), true);
});
