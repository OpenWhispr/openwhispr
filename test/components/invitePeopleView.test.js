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
        export const DialogContent = ({ children }) => React.createElement("div", null, children);
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
          memberEmails: [],
          invitedEmails: [],
          ...state,
        },
        dispatch: () => {},
        suggestions: [],
        seatLine: null,
        seatCostLine: null,
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
const primaryButton = (markup) =>
  markup.match(
    /<button[^>]*>(?:(?!<\/button>)[\s\S])*workspaces\.invite\.(?:submit|done)[\s\S]*?<\/button>/
  )?.[0] ?? "";

test("empty field shows the hint and a disabled send", async (t) => {
  const { render } = await loadView(t);

  const markup = render();

  assert.match(markup, /workspaces\.invite\.emailHint/);
  assert.match(markup, /placeholder="workspaces\.invite\.emailPlaceholder"/);
  assert.match(primaryButton(markup), /disabled=""/);
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
  assert.doesNotMatch(markup, /placeholder=/);
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
  assert.match(primaryButton(markup), /workspaces\.invite\.submitting/);
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
  assert.match(markup, /<button[^>]*>workspaces\.exit\.tryAgain<\/button>/);
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
  assert.doesNotMatch(markup, /workspaces\.exit\.tryAgain/);
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
  assert.doesNotMatch(markup, /workspaces\.exit\.tryAgain/);
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
  assert.doesNotMatch(markup, /workspaces\.exit\.tryAgain/);
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
  assert.doesNotMatch(markup, /workspaces\.exit\.tryAgain/);
});

test("the workspace name is isolated inside the description", async (t) => {
  const { render } = await loadView(t);

  const markup = render();

  assert.match(
    markup,
    /workspaces\.invite\.description\|\{&quot;workspace&quot;:&quot;\u2068Acme\u2069&quot;\}/
  );
  const done = render({
    phase: "done",
    sent: [
      { email: "a@x.com", emailSent: true },
      { email: "b@x.com", emailSent: true },
    ],
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

test("done shows the sent count and Done", async (t) => {
  const { render } = await loadView(t);

  const markup = render({
    phase: "done",
    sent: [
      { email: "a@x.com", emailSent: true },
      { email: "b@x.com", emailSent: true },
    ],
  });

  assert.match(markup, /workspaces\.invite\.sentTitle\|\{&quot;count&quot;:2\}/);
  assert.match(markup, /workspaces\.invite\.sentMany\|\{&quot;count&quot;:2/);
  assert.match(primaryButton(markup), /workspaces\.invite\.done/);
  assert.doesNotMatch(markup, /common\.cancel/);
  assert.doesNotMatch(markup, /workspaces\.invite\.noEmail/);
  assert.doesNotMatch(markup, /workspaces\.invite\.emailLabel/);

  const undelivered = render({ phase: "done", sent: [{ email: "a@x.com", emailSent: false }] });
  assert.match(undelivered, /workspaces\.invite\.sentOne/);
  assert.match(
    undelivered,
    /role="alert"[\s\S]*workspaces\.invite\.noEmail\|\{&quot;count&quot;:1\}/
  );
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
