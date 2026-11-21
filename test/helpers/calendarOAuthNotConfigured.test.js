const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
const calls = { flow: 0, openExternal: 0, openExternalUrl: 0 };

function load(file) {
  const path = require.resolve(file);
  delete require.cache[path];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        net: {},
        shell: {
          openExternal: () => {
            calls.openExternal++;
          },
        },
      };
    }
    if (request === "./oauthLoopbackFlow") {
      return {
        runOAuthLoopbackFlow: () => {
          calls.flow++;
        },
        OAuthFlowError: Error,
      };
    }
    if (request === "./externalUrlOpener") {
      return {
        openExternalUrl: () => {
          calls.openExternalUrl++;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

const CASES = [
  ["Google", "../../src/helpers/googleCalendarOAuth.js", "GOOGLE_CALENDAR_CLIENT_ID"],
  ["Microsoft", "../../src/helpers/microsoftCalendarOAuth.js", "MICROSOFT_CALENDAR_CLIENT_ID"],
];

for (const [name, file, envName] of CASES) {
  test(`${name} calendar OAuth without a client id throws not_configured and opens no browser`, () => {
    const OAuth = load(file);
    const oauth = new OAuth({});
    oauth.getClientId = () => undefined;
    assert.equal(oauth.isConfigured(), false);
    assert.throws(
      () => oauth.startOAuthFlow(),
      (error) => error.code === "not_configured" && error.message.includes(envName)
    );
    assert.deepEqual(calls, { flow: 0, openExternal: 0, openExternalUrl: 0 });
  });

  test(`${name} calendar OAuth with a client id starts the loopback flow`, () => {
    const OAuth = load(file);
    const oauth = new OAuth({});
    oauth.getClientId = () => "client-id";
    assert.equal(oauth.isConfigured(), true);
    oauth.startOAuthFlow();
    assert.equal(calls.flow, 1);
    calls.flow = 0;
  });
}
