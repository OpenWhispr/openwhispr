const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadView(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-invite-people-view-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({ children }) => React.createElement("div", null, children);
        export const DialogContent = ({ children, className }) => React.createElement("div", { className }, children);
        export const DialogTitle = ({ children }) => React.createElement("h2", null, children);
        export const DialogDescription = ({ children }) => React.createElement("p", null, children);
      `,
      // Renders the menu open, so its items reach the markup.
      "/ui/dropdown-menu": `
        import React from "react";
        const passThrough = ({ children }) => React.createElement(React.Fragment, null, children);
        export const DropdownMenu = passThrough;
        export const DropdownMenuTrigger = ({ children, ...props }) =>
          React.createElement("button", props, children);
        export const DropdownMenuContent = passThrough;
        export const DropdownMenuRadioGroup = passThrough;
        export const DropdownMenuRadioItem = ({ children, value }) =>
          React.createElement("div", { role: "menuitemradio", "data-value": value }, children);
      `,
    },
  });
  const { InvitePeopleView } = await vite.ssrLoadModule(
    "/components/workspace/InvitePeopleView.tsx"
  );
  const render = (state = {}, overrides = {}) =>
    renderToStaticMarkup(
      createElement(InvitePeopleView, {
        workspaceName: "Acme",
        state: {
          draft: "",
          recipients: [],
          role: "member",
          phase: "editing",
          sent: [],
          attached: [],
          memberEmails: [],
          invitedEmails: [],
          seats: { purchasedLeft: null, ceilingLeft: null },
          ...state,
        },
        dispatch: () => {},
        suggestions: [],
        cancelLabel: "common.cancel",
        onCancel: () => {},
        onSend: () => {},
        onDone: () => {},
        ...overrides,
      })
    );
  return { render };
}

const chip = (email, state = { status: "draft" }) => ({ email, state });
// Each bar with its tone, text and action button, in order.
const bars = (markup) =>
  [...markup.matchAll(/<div[^>]*role="alert"[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/div>/g)].map(
    ([, className, body]) => ({
      tone: className.includes("bg-warning") ? "warning" : "error",
      body,
      action: body.match(/<button[^>]*>([^<]*)<\/button>/)?.[1] ?? null,
    })
  );
const drafts = (count) => Array.from({ length: count }, (_, index) => chip(`p${index}@x.com`));
const primaryButton = (markup) =>
  markup.match(
    /<button[^>]*>(?:(?!<\/button>)[\s\S])*workspaces\.invite\.(?:submit|done|sending)[\s\S]*?<\/button>/
  )?.[0] ?? "";

test("empty field shows the hint and a disabled send", async (t) => {
  const { render } = await loadView(t);

  const markup = render();

  assert.match(markup, /workspaces\.invite\.emailHint/);
  assert.match(markup, /placeholder="workspaces\.invite\.emailPlaceholder"/);
  assert.match(primaryButton(markup), /disabled=""/);
  assert.match(primaryButton(markup), /workspaces\.invite\.submitOne/);
  assert.match(markup, /common\.cancel/);
});

test("chips render with remove buttons", async (t) => {
  const { render } = await loadView(t);

  const markup = render({ recipients: [chip("a@x.com"), chip("b@x.com")] });

  assert.match(markup, /<bdi dir="ltr"[^>]*>a@x\.com<\/bdi>/);
  assert.match(markup, /<bdi dir="ltr"[^>]*>b@x\.com<\/bdi>/);
  assert.match(
    markup,
    /aria-label="workspaces\.invite\.removeRecipient\|\{&quot;email&quot;:&quot;a@x\.com&quot;\}"/
  );
  assert.doesNotMatch(markup, /role="alert"/);
  assert.match(primaryButton(markup), /workspaces\.invite\.submit\|\{&quot;count&quot;:2\}/);
  assert.doesNotMatch(primaryButton(markup), /disabled=""/);
});

test("an invalid chip shows the invalid bar and keeps send disabled", async (t) => {
  const { render } = await loadView(t);

  const markup = render({ recipients: [chip("a@x.com"), chip("nope", { status: "invalid" })] });

  assert.match(markup, /role="alert"[\s\S]*workspaces\.invite\.errors\.invalid[\s\S]*nope/);
  assert.match(markup, /title="workspaces\.invite\.errors\.invalid/);
  assert.match(primaryButton(markup), /disabled=""/);
});

test("already invited points to Invitations", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [chip("b@x.com", { status: "blocked", reason: "alreadyInvited" })],
    invitedEmails: ["b@x.com"],
  });

  assert.match(
    markup,
    /role="alert"[\s\S]*workspaces\.invite\.errors\.alreadyInvited[^<]*<bdi dir="ltr"[^>]*>b@x\.com<\/bdi>/
  );
  assert.deepEqual(
    bars(markup).map((bar) => bar.tone),
    ["warning"]
  );
  // Nothing is left to send, not a block.
  assert.match(primaryButton(markup), /disabled=""/);
});

test("the role menu offers Workspace Member and Workspace Admin with descriptions and no Editor", async (t) => {
  const { render } = await loadView(t);

  const markup = render();

  assert.match(markup, /workspaces\.invite\.roleLabel/);
  assert.match(markup, /workspaces\.invite\.role\.member/);
  assert.match(markup, /workspaces\.invite\.role\.admin/);
  assert.match(markup, /workspaces\.invite\.roleDescription\.member/);
  assert.match(markup, /workspaces\.invite\.roleDescription\.admin/);
  assert.equal((markup.match(/role="menuitemradio"/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /editor/i);
});

test("sending is busy and can't be dismissed", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    phase: "sending",
    recipients: [chip("a@x.com", { status: "sending" })],
  });

  assert.doesNotMatch(markup, /common\.cancel/);
  assert.match(primaryButton(markup), /workspaces\.invite\.sending/);
  assert.match(primaryButton(markup), /disabled=""/);
  assert.match(primaryButton(markup), /animate-spin/);
});

test("some failed counts only the addresses Try again resends", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [
      chip("a@x.com", { status: "failed", kind: "requestFailed" }),
      chip("b@x.com", { status: "failed", kind: "seatLimit" }),
    ],
  });

  assert.match(
    markup,
    /role="alert"[\s\S]*workspaces\.invite\.someFailed\|\{&quot;count&quot;:1\}/
  );
  assert.match(markup, /<button[^>]*>workspaces\.invite\.tryResending<\/button>/);
  assert.match(markup, /title="workspaces\.invite\.errors\.requestFailed/);
});

test("seat limit has no Try again", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [
      chip("a@x.com", { status: "failed", kind: "seatLimit" }),
      chip("b@x.com", { status: "failed", kind: "seatLimit" }),
    ],
  });

  assert.match(markup, /role="alert"[\s\S]*workspaces\.invite\.errors\.seatLimit/);
  assert.doesNotMatch(markup, /someFailed/);
  assert.doesNotMatch(markup, /workspaces\.invite\.tryResending/);
});

test("a refusal shows the server's reason for that address and no Try again", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [
      chip("a@x.com", {
        status: "failed",
        kind: "refused",
        message: "Only admins can be invited without a seat",
      }),
    ],
  });

  assert.match(
    markup,
    /role="alert"[\s\S]*workspaces\.invite\.errors\.refused\|\{&quot;email&quot;:[^}]*&quot;reason&quot;:&quot;\u2068Only admins can be invited without a seat\u2069&quot;/
  );
  assert.match(markup, /title="workspaces\.invite\.errors\.refused[^"]*Only admins/);
  assert.doesNotMatch(markup, /someFailed/);
  assert.doesNotMatch(markup, /workspaces\.invite\.tryResending/);
});

test("single sign-on required names the workspace and has no Try again", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [chip("a@x.com", { status: "failed", kind: "ssoRequired" })],
  });

  assert.match(
    markup,
    /role="alert"[\s\S]*workspaces\.invite\.errors\.ssoRequired\|[\s\S]*?&quot;workspace&quot;:&quot;\u2068Acme\u2069&quot;/
  );
  assert.doesNotMatch(markup, /workspaces\.invite\.tryResending/);
});

test("a mix of failures retrying can't fix shows the first one's message and no Try again", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [
      chip("a@x.com", { status: "failed", kind: "seatLimit" }),
      chip("b@x.com", { status: "failed", kind: "refused", message: "No" }),
      chip("c@x.com", { status: "failed", kind: "notAllowed" }),
    ],
  });

  assert.match(markup, /role="alert"[\s\S]*workspaces\.invite\.errors\.seatLimit/);
  assert.doesNotMatch(markup, /someFailed/);
  assert.doesNotMatch(markup, /workspaces\.invite\.tryResending/);
});

test("the workspace name is isolated inside the description", async (t) => {
  const { render } = await loadView(t);

  const markup = render();

  assert.match(
    markup,
    /workspaces\.invite\.description\|\{&quot;workspace&quot;:&quot;\u2068Acme\u2069&quot;\}/
  );
  // The Done screen, which a run with an updated invitation still ends on.
  const done = render({
    phase: "done",
    sent: [
      { email: "a@x.com", emailSent: true },
      { email: "b@x.com", emailSent: true },
    ],
    attached: ["c@x.com"],
  });
  assert.match(
    done,
    /workspaces\.invite\.sentMany\|[^<]*&quot;workspace&quot;:&quot;\u2068Acme\u2069&quot;/
  );
});

test("the role trigger is named by its label and its current role", async (t) => {
  const { render } = await loadView(t);

  const markup = render();

  const label = markup.match(/<span id="([^"]+)"[^>]*>workspaces\.invite\.roleLabel<\/span>/);
  assert.ok(label, "role label with an id");
  const trigger = markup.match(/<button[^>]*aria-labelledby="([^"]+)"[^>]*>/);
  assert.ok(trigger, "trigger with aria-labelledby");
  const [labelledLabel, valueId] = trigger[1].split(" ");
  assert.equal(labelledLabel, label[1]);
  assert.match(
    markup,
    new RegExp(`<span id="${valueId}"[^>]*>workspaces\\.invite\\.role\\.member<`)
  );
  // Radix's own trigger id is what labels the open menu, so it isn't overridden.
  assert.doesNotMatch(trigger[0], / id="/);
});

test("the field points at the error that's about it", async (t) => {
  const { render } = await loadView(t);

  const markup = render({ recipients: [chip("bad", { status: "invalid" })] });

  const input = markup.match(/<input[^>]*>/)[0];
  assert.match(input, /aria-invalid="true"/);
  const describedBy = input.match(/aria-describedby="([^"]+)"/)[1].split(" ");
  const alert = markup.match(/<div id="([^"]+)" role="alert"/);
  assert.ok(alert, "error bar with an id");
  assert.ok(describedBy.includes(alert[1]));
});

test("a clean run keeps the form with Send turned into its confirmation", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    phase: "done",
    sent: [
      { email: "a@x.com", emailSent: true },
      { email: "b@x.com", emailSent: true },
    ],
  });

  // The host closes the dialog after a moment; until then the button says what happened.
  const [button] = markup.match(/<button[^>]*bg-success[^>]*>[\s\S]*?<\/button>/) ?? [""];
  assert.match(button, /workspaces\.invite\.sentTitle\|\{&quot;count&quot;:2\}/);
  assert.match(button, /disabled=""/);
  assert.doesNotMatch(markup, /common\.cancel/);
  assert.match(markup, /workspaces\.invite\.emailLabel/);
});

test("done shows the sent count and Done", async (t) => {
  const { render } = await loadView(t);

  // An updated invitation beside the sent ones keeps the Done screen, which says so.
  const markup = render({
    phase: "done",
    sent: [
      { email: "a@x.com", emailSent: true },
      { email: "b@x.com", emailSent: true },
    ],
    attached: ["c@x.com"],
  });

  assert.match(markup, /workspaces\.invite\.sentTitle\|\{&quot;count&quot;:2\}/);
  assert.match(markup, /workspaces\.invite\.sentMany\|\{&quot;count&quot;:2/);
  assert.match(primaryButton(markup), /workspaces\.invite\.done/);
  assert.doesNotMatch(markup, /common\.cancel/);
  assert.doesNotMatch(markup, /workspaces\.invite\.noEmail/);
  assert.doesNotMatch(markup, /workspaces\.invite\.emailLabel/);

  const partly = render({
    phase: "done",
    sent: [
      { email: "a@x.com", emailSent: true },
      { email: "b@x.com", emailSent: false },
    ],
  });
  assert.match(partly, /workspaces\.invite\.sentTitle\|\{&quot;count&quot;:2\}/);
  assert.match(partly, /role="alert"[\s\S]*workspaces\.invite\.noEmail\|\{&quot;count&quot;:1\}/);
});

test("suggestions render as a listbox while typing", async (t) => {
  const { render } = await loadView(t);
  const suggestions = [
    { email: "bob@x.com", name: "Bob Builder" },
    { email: "bo@x.com", name: null },
  ];

  const markup = render({ draft: "bo" }, { suggestions });

  assert.match(markup, /role="listbox"[^>]*aria-label="workspaces\.invite\.suggestions"/);
  assert.equal((markup.match(/role="option"/g) ?? []).length, 2);
  assert.match(markup, /Bob Builder/);
  assert.match(markup, /<bdi dir="ltr"[^>]*>bob@x\.com<\/bdi>/);
  assert.doesNotMatch(render({ draft: "b" }, { suggestions }), /role="listbox"/);
  assert.doesNotMatch(render({ draft: "bo" }), /role="listbox"/);
});

test("running past the purchased seats shows no warning and keeps Send enabled", async (t) => {
  const { render } = await loadView(t);

  for (const purchasedLeft of [1, 0, -2]) {
    const markup = render({
      recipients: drafts(3),
      seats: { purchasedLeft, ceilingLeft: 490 },
    });

    assert.deepEqual(bars(markup), []);
    assert.doesNotMatch(markup, /seatsLeft|seatsNone|workspaces\.invite\.upgrade/);
    assert.doesNotMatch(primaryButton(markup), /disabled=""/);
  }
});

test("over the ceiling blocks Send with the ceiling copy", async (t) => {
  const { render } = await loadView(t);

  const markup = render({ recipients: drafts(3), seats: { purchasedLeft: null, ceilingLeft: 1 } });

  const [bar, ...rest] = bars(markup);
  assert.deepEqual(rest, []);
  assert.equal(bar.tone, "error");
  assert.match(
    bar.body,
    /workspaces\.invite\.ceilingLeft\|\{&quot;count&quot;:1,&quot;excess&quot;:2\}/
  );
  assert.match(primaryButton(markup), /disabled=""/);
});

test("over the ceiling shows only the ceiling bar, not the seats warning too", async (t) => {
  const { render } = await loadView(t);

  const markup = render({ recipients: drafts(3), seats: { purchasedLeft: 1, ceilingLeft: 1 } });

  const [bar, ...rest] = bars(markup);
  assert.deepEqual(rest, []);
  assert.equal(bar.tone, "error");
  assert.match(bar.body, /workspaces\.invite\.ceilingLeft\|/);
  assert.doesNotMatch(markup, /workspaces\.invite\.seatsLeft/);
});

test("no room under the ceiling uses the seat limit copy", async (t) => {
  const { render } = await loadView(t);

  const markup = render({ recipients: drafts(2), seats: { purchasedLeft: null, ceilingLeft: 0 } });

  const [bar] = bars(markup);
  assert.equal(bar.tone, "error");
  assert.match(bar.body, /workspaces\.invite\.errors\.seatLimit/);
  assert.doesNotMatch(bar.body, /ceilingLeft/);
  assert.match(primaryButton(markup), /disabled=""/);
});

test("one skipped member shows the skipped bar and Send stays enabled", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [
      chip("a@x.com"),
      chip("nina@x.com", { status: "blocked", reason: "alreadyMember" }),
    ],
  });

  const [bar, ...rest] = bars(markup);
  assert.deepEqual(rest, []);
  assert.equal(bar.tone, "warning");
  assert.match(
    bar.body,
    /workspaces\.invite\.errors\.alreadyMember[^<]*<bdi dir="ltr"[^>]*>nina@x\.com<\/bdi>/
  );
  assert.equal(bar.action, null);
  assert.doesNotMatch(primaryButton(markup), /disabled=""/);
  assert.match(primaryButton(markup), /workspaces\.invite\.submitOne/);
  // A skipped address is no error in the field.
  assert.doesNotMatch(markup.match(/<input[^>]*>/)[0], /aria-invalid/);
});

test("a send that invited nobody shows why, not a success screen", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [chip("nina@x.com", { status: "blocked", reason: "alreadyMember" })],
  });

  const [bar] = bars(markup);
  assert.equal(bar.tone, "warning");
  assert.match(bar.body, /workspaces\.invite\.errors\.alreadyMember/);
  assert.doesNotMatch(markup, /workspaces\.invite\.sentTitle/);
  assert.match(primaryButton(markup), /disabled=""/);
});

test("several skipped show the count", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [
      chip("a@x.com"),
      chip("b@x.com", { status: "blocked", reason: "alreadyMember" }),
      chip("c@x.com", { status: "blocked", reason: "alreadyInvited" }),
    ],
  });

  const [bar, ...rest] = bars(markup);
  assert.deepEqual(rest, []);
  assert.equal(bar.tone, "warning");
  assert.match(bar.body, /workspaces\.invite\.skippedMany\|\{&quot;count&quot;:2\}/);
  assert.doesNotMatch(primaryButton(markup), /disabled=""/);
});

test("an invalid address and a skipped one show the error over the warning", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    recipients: [
      chip("nope", { status: "invalid" }),
      chip("b@x.com", { status: "blocked", reason: "alreadyMember" }),
    ],
  });

  assert.deepEqual(
    bars(markup).map((bar) => [bar.tone, bar.body.match(/workspaces\.invite\.[\w.]+/)[0]]),
    [
      ["error", "workspaces.invite.errors.invalid"],
      ["warning", "workspaces.invite.errors.alreadyMember"],
    ]
  );
});

test("a rate-limited send offers Try resending", async (t) => {
  const { render } = await loadView(t);
  const sends = [];

  const markup = render(
    {
      recipients: [
        chip("a@x.com", { status: "failed", kind: "rateLimited" }),
        chip("b@x.com", { status: "failed", kind: "rateLimited" }),
      ],
    },
    { onSend: () => sends.push(true) }
  );

  const [bar] = bars(markup);
  assert.equal(bar.tone, "error");
  assert.match(bar.body, /workspaces\.invite\.errors\.rateLimited/);
  assert.doesNotMatch(bar.body, /someFailed/);
  assert.equal(bar.action, "workspaces.invite.tryResending");
  assert.doesNotMatch(primaryButton(markup), /disabled=""/);
});

test("a rate limit that left room says how many fit and how many to remove", async (t) => {
  const { render } = await loadView(t);

  const markup = render({ recipients: drafts(30), rateLimit: { available: 20, limit: 50 } });

  const [bar] = bars(markup);
  assert.equal(bar.tone, "error");
  assert.match(
    bar.body,
    /workspaces\.invite\.rateLimitedLeft\|\{&quot;count&quot;:20,&quot;excess&quot;:10\}/
  );
  assert.doesNotMatch(primaryButton(markup), /disabled=""/);
});

test("a batch past the daily limit names the limit, since waiting can't help", async (t) => {
  const { render } = await loadView(t);

  const [bar] = bars(render({ recipients: drafts(60), rateLimit: { available: 50, limit: 50 } }));

  assert.match(
    bar.body,
    /workspaces\.invite\.rateLimitedDaily\|\{&quot;limit&quot;:50,&quot;excess&quot;:10\}/
  );
});

test("trimmed to the room, the rate limit says nothing more", async (t) => {
  const { render } = await loadView(t);

  const markup = render({ recipients: drafts(20), rateLimit: { available: 20, limit: 50 } });

  assert.deepEqual(bars(markup), []);
});

test("the Done screen says who was skipped", async (t) => {
  const { render } = await loadView(t);
  const skipped = (email) => chip(email, { status: "blocked", reason: "alreadyMember" });
  const done = (recipients, overrides) =>
    render({ phase: "done", sent: [{ email: "a@x.com", emailSent: true }], recipients }, overrides);

  const one = done([skipped("m@x.com")]);
  assert.match(one, /role="alert"[\s\S]*workspaces\.invite\.errors\.alreadyMember/);
  assert.doesNotMatch(one, /<ul/);

  const many = done([skipped("m@x.com"), skipped("n@x.com")]);
  assert.match(many, /workspaces\.invite\.skippedMany\|\{&quot;count&quot;:2\}/);
  assert.match(many, /<bdi dir="ltr">m@x\.com<\/bdi>/);
  assert.match(many, /<bdi dir="ltr">n@x\.com<\/bdi>/);

  assert.doesNotMatch(done([]), /role="alert"/);
});

test("when no email was delivered, Done doesn't read as a success", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    phase: "done",
    sent: [
      { email: "a@x.com", emailSent: false },
      { email: "b@x.com", emailSent: false },
    ],
  });

  assert.match(markup, /workspaces\.invite\.createdTitle\|\{&quot;count&quot;:2\}/);
  assert.match(markup, /workspaces\.invite\.noEmail\|\{&quot;count&quot;:2\}/);
  assert.doesNotMatch(markup, /sentTitle|sentMany|text-success/);
  assert.match(markup, /text-warning/);
  // In the description, not again in a bar beside it.
  assert.deepEqual(bars(markup), []);
});

test("a partial send says what went out while chips still need attention", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    sent: [
      { email: "a@x.com", emailSent: true },
      { email: "b@x.com", emailSent: false },
    ],
    recipients: [chip("c@x.com", { status: "invalid" })],
  });

  // What went out is the host's toast now; the form keeps only what still needs attention.
  assert.doesNotMatch(markup, /role="status"/);
  assert.ok(bars(markup).some((bar) => /workspaces\.invite\.noEmail/.test(bar.body)));
});

test("a send that's too big offers to remove the excess", async (t) => {
  const { render } = await loadView(t);

  const tooMany = bars(render({ recipients: drafts(103) }))[0];
  assert.match(tooMany.action, /workspaces\.invite\.removeLast\|\{&quot;count&quot;:3\}/);

  const ceiling = bars(
    render({ recipients: drafts(30), seats: { purchasedLeft: null, ceilingLeft: 20 } })
  )[0];
  assert.match(ceiling.action, /removeLast\|\{&quot;count&quot;:10\}/);

  const limited = bars(
    render({ recipients: drafts(30), rateLimit: { available: 20, limit: 50 } })
  )[0];
  assert.match(limited.action, /removeLast\|\{&quot;count&quot;:10\}/);

  // Removing everyone is no way forward.
  const full = bars(
    render({ recipients: drafts(3), seats: { purchasedLeft: null, ceilingLeft: 0 } })
  )[0];
  assert.equal(full.action, null);
});

test("the dialog scrolls rather than pushing its buttons off a short window", async (t) => {
  const { render } = await loadView(t);

  const markup = render();

  assert.match(markup, /max-h-\[calc\(100vh-32px\)\]/);
  assert.match(markup, /overflow-y-auto/);
});

test("a team or teamspace invite says skipped people weren't added", async (t) => {
  const { render } = await loadView(t);
  const member = chip("m@x.com", { status: "blocked", reason: "alreadyMember" });

  const done = render(
    { phase: "done", sent: [{ email: "a@x.com", emailSent: true }], recipients: [member] },
    { addsToContainer: true }
  );
  assert.match(done, /workspaces\.invite\.skippedNotAdded\|\{&quot;count&quot;:1\}/);
  assert.match(done, /<bdi dir="ltr">m@x\.com<\/bdi>/);

  const [bar] = bars(render({ recipients: [member] }, { addsToContainer: true }));
  assert.equal(bar.tone, "warning");
  assert.match(bar.body, /workspaces\.invite\.skippedNotAdded/);
});

test("Add more appears once there are chips", async (t) => {
  const { render } = await loadView(t);

  assert.match(render(), /placeholder="workspaces\.invite\.emailPlaceholder"/);
  assert.match(
    render({ recipients: [chip("a@x.com")] }),
    /placeholder="workspaces\.invite\.addMore"/
  );
});

test("the field holds a hundred chips and scrolls", async (t) => {
  const { render } = await loadView(t);

  const markup = render({ recipients: drafts(100) });

  // Three rows of chips, as the design caps the field.
  assert.match(markup, /class="[^"]*max-h-\[104px\][^"]*overflow-y-auto/);
  assert.equal(bars(markup).length, 0);
  assert.match(primaryButton(markup), /workspaces\.invite\.submit\|\{&quot;count&quot;:100\}/);
  assert.match(
    render({ recipients: drafts(101) }),
    /workspaces\.invite\.tooMany\|\{&quot;count&quot;:100\}/
  );
});
