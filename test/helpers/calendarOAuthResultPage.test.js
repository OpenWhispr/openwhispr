const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { calendarResultPage } = require("../../src/helpers/calendarOAuthResultPage.js");

const i18n = { t: (key) => `<${key}>` };

test("a connected calendar renders the connected copy", () => {
  const html = calendarResultPage({ i18n }, true);
  assert.match(html, /data-ok="true"/);
  assert.ok(html.includes("&lt;calendarConnect.browser.connectedTitle&gt;"));
  assert.ok(html.includes("&lt;calendarConnect.browser.connectedBody&gt;"));
});

test("a failed calendar renders the failed copy", () => {
  const html = calendarResultPage({ i18n }, false);
  assert.match(html, /data-ok="false"/);
  assert.ok(html.includes("&lt;calendarConnect.browser.failedTitle&gt;"));
  assert.ok(html.includes("&lt;calendarConnect.browser.failedBody&gt;"));
});

test("the copy is read when the page renders, not when the flow starts", () => {
  let word = "one";
  const live = { t: () => word };
  const first = calendarResultPage({ i18n: live }, true);
  word = "two";
  const second = calendarResultPage({ i18n: live }, true);
  assert.ok(first.includes("one"));
  assert.ok(second.includes("two"));
});

test("the real locale bundles carry the four keys in every language", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "..", "src", "locales");
  for (const lang of fs.readdirSync(root, { withFileTypes: true })) {
    if (!lang.isDirectory()) continue;
    const bundle = JSON.parse(
      fs.readFileSync(path.join(root, lang.name, "translation.json"), "utf8")
    );
    const copy = bundle.calendarConnect?.browser ?? {};
    for (const key of ["connectedTitle", "connectedBody", "failedTitle", "failedBody"]) {
      assert.equal(
        typeof copy[key],
        "string",
        `${lang.name} is missing calendarConnect.browser.${key}`
      );
      assert.ok(copy[key].length > 0);
    }
  }
});

function loadWithFlowCapture(modulePath) {
  const originalLoad = Module._load;
  const captured = {};
  delete require.cache[modulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return { net: {} };
    if (request === "./oauthLoopbackFlow") {
      return {
        runOAuthLoopbackFlow: (options) => {
          captured.options = options;
          return options;
        },
        OAuthFlowError: Error,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { Oauth: require(modulePath), captured };
  } finally {
    Module._load = originalLoad;
  }
}

for (const [name, file] of [
  ["Google", "../../src/helpers/googleCalendarOAuth.js"],
  ["Microsoft", "../../src/helpers/microsoftCalendarOAuth.js"],
]) {
  test(`${name} calendar flow answers the browser itself with an injected i18n`, () => {
    const { Oauth, captured } = loadWithFlowCapture(require.resolve(file));
    const oauth = new Oauth({}, { i18n });
    oauth.getClientId = () => "client-id";
    oauth.startOAuthFlow();

    assert.equal(typeof captured.options.renderResultPage, "function");
    const html = captured.options.renderResultPage({ ok: true });
    assert.ok(html.includes("calendarConnect.browser.connectedTitle"));
  });

  test(`${name} calendar flow keeps the one-argument constructor working`, () => {
    const { Oauth } = loadWithFlowCapture(require.resolve(file));
    assert.doesNotThrow(() => new Oauth({}));
  });
}
