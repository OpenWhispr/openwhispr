const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/describeProviderError.ts");

// A fake t that renders "key|json(params)" so the test sees exactly what was asked.
const t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);

test("a keyed error is translated with its params", async () => {
  const { describeProviderError } = await load();
  const out = describeProviderError(
    {
      message: "Mistral rejected your API key.",
      messageKey: "providerErrors.authFailed",
      messageParams: { provider: "Mistral" },
      settingsTarget: "speechToText",
      technicalDetails: { provider: "Mistral", status: 401 },
    },
    t
  );
  assert.equal(out.description, 'providerErrors.authFailed|{"provider":"Mistral"}');
  assert.equal(out.settingsTarget, "speechToText");
  assert.deepEqual(out.technicalDetails, { provider: "Mistral", status: 401 });
});

test("a self-hosted key is translated as is: its sentence names the server itself", async () => {
  const { describeProviderError } = await load();
  const out = describeProviderError(
    { messageKey: "providerErrors.selfHosted.unknown", messageParams: { provider: "Your server" } },
    t
  );
  assert.equal(out.description, 'providerErrors.selfHosted.unknown|{"provider":"Your server"}');
});

test("an unkeyed error renders its message unchanged and offers no settings link", async () => {
  const { describeProviderError } = await load();
  assert.deepEqual(describeProviderError(new Error("boom"), t), { description: "boom" });
  assert.deepEqual(describeProviderError("plain text", t), { description: "plain text" });
  assert.deepEqual(describeProviderError({ settingsTarget: "account", message: "x" }, t), {
    description: "x",
  });
});

test("formatProviderErrorDetails labels provider details generically", async () => {
  const { formatProviderErrorDetails } = await load();
  assert.equal(
    formatProviderErrorDetails(
      { provider: "Mistral", status: 401, requestId: "r1", underlyingError: '{"detail":"Invalid API Key"}' },
      t
    ),
    [
      "providerErrors.details.provider: Mistral",
      "reasoning.enterprise.technicalDetails.httpStatus: 401",
      "providerErrors.details.requestId: r1",
      'reasoning.enterprise.technicalDetails.underlyingError: {"detail":"Invalid API Key"}',
    ].join("\n")
  );
});

test("formatProviderErrorDetails names a self-hosted server in the UI language", async () => {
  const { formatProviderErrorDetails } = await load();
  assert.equal(
    formatProviderErrorDetails({ provider: "Your server", status: 404 }, t),
    [
      "providerErrors.details.provider: settingsPage.aiModels.modes.selfHosted",
      "reasoning.enterprise.technicalDetails.httpStatus: 404",
    ].join("\n")
  );
});

test("formatProviderErrorDetails keeps AWS labels for Bedrock details", async () => {
  const { formatProviderErrorDetails } = await load();
  assert.equal(
    formatProviderErrorDetails({ exceptionType: "ThrottlingException", requestId: "aws-1" }, t),
    [
      "reasoning.enterprise.technicalDetails.awsException: ThrottlingException",
      "reasoning.enterprise.technicalDetails.awsRequestId: aws-1",
    ].join("\n")
  );
});

function withClipboard(ctx, writeClipboard) {
  const original = globalThis.window;
  globalThis.window = { electronAPI: { writeClipboard } };
  ctx.after(() => {
    globalThis.window = original;
  });
}

test("a fixable classified error gets Open Settings, then an icon-only Copy details that copies the details", async (ctx) => {
  const { providerErrorActions } = await load();
  const written = [];
  withClipboard(ctx, async (text) => {
    written.push(text);
    return { success: true };
  });
  const actions = providerErrorActions(
    { settingsTarget: "llms", technicalDetails: { provider: "OpenAI", status: 401 } },
    t
  );
  assert.deepEqual(
    actions.map(({ label, icon, iconOnly }) => ({ label, icon, iconOnly })),
    [
      { label: "providerErrors.openSettings", icon: "settings", iconOnly: undefined },
      { label: "providerErrors.copyDetails", icon: "copy", iconOnly: true },
    ]
  );
  assert.equal(actions[1].dismissOnClick, false);
  assert.equal(await actions[1].onClick(), true);
  assert.match(written[0], /providerErrors\.details\.provider: OpenAI/);
});

test("Copy details on a superseded card neither copies nor reports a result", async (ctx) => {
  const { providerErrorActions } = await load();
  let current = true;
  let writes = 0;
  withClipboard(ctx, async () => {
    writes += 1;
    current = false;
    return { success: true };
  });
  const [copy] = providerErrorActions(
    { technicalDetails: { provider: "Groq", status: 429 } },
    t,
    () => current
  );
  assert.equal(await copy.onClick(), undefined, "a click that outlived its card reports nothing");
  assert.equal(await copy.onClick(), undefined);
  assert.equal(writes, 1, "a click after the card was replaced never writes");
});

test("toast props: a classified error gets actions, an unclassified one stays a plain message", async () => {
  const { providerErrorToastProps } = await load();
  const classified = providerErrorToastProps(
    {
      messageKey: "providerErrors.rateLimited",
      messageParams: { provider: "Groq" },
      technicalDetails: { provider: "Groq", status: 429 },
    },
    t
  );
  assert.equal(classified.description, 'providerErrors.rateLimited|{"provider":"Groq"}');
  assert.deepEqual(
    classified.actions.map((action) => action.label),
    ["providerErrors.copyDetails"],
    "a rate limit has nothing to fix in Settings"
  );
  assert.deepEqual(providerErrorToastProps(new Error("Network down"), t), {
    description: "Network down",
  });
});
