const test = require("node:test");
const assert = require("node:assert/strict");

// The settings panel and the resolver judge a self-hosted realtime URL with
// isSecureWebSocketEndpoint (renderer); connect and the token provider judge it
// with buildRealtimeUrl (main). Each has its own isPrivateHost copy, so a URL
// one side accepts and the other refuses is saved as valid and then fails at
// start with a toast that contradicts Settings.
const loadRenderer = () => import("../../src/utils/urlUtils.ts");
const { buildRealtimeUrl } = require("../../src/helpers/selfHostedRealtimeUrl");

const mainAccepts = (url) => {
  try {
    buildRealtimeUrl(url, "m");
    return true;
  } catch (error) {
    assert.equal(error.message, "selfHostedRealtimeUrlInvalid", url);
    return false;
  }
};

const TABLE = [
  ["wss://stt.example.com/v1/realtime", true],
  ["wss://8.8.8.8/v1/realtime", true],
  ["ws://localhost:9000/v1/realtime", true],
  ["ws://0.0.0.0:9000/v1/realtime", true],
  ["ws://127.0.0.1:9000/realtime", true],
  ["ws://10.1.2.3/realtime", true],
  ["ws://172.16.0.4:9000/realtime", true],
  ["ws://172.31.255.255/realtime", true],
  ["ws://192.168.1.20:9000/v1/realtime", true],
  ["ws://100.64.0.1/realtime", true],
  ["ws://100.127.255.255/realtime", true],
  ["ws://169.254.1.1/realtime", true],
  ["ws://box.local:9000/realtime", true],
  ["ws://box.tailnet.ts.net:9000/realtime", true],
  ["ws://[::1]:9000/realtime", true],
  ["ws://[fe80::1]:9000/realtime", true],
  ["ws://[fc00::1]:9000/realtime", true],
  ["ws://[fd12:3456::1]:9000/realtime", true],
  ["ws://[fec0::1]:9000/realtime", false],
  ["ws://[2001:db8::1]:9000/realtime", false],
  ["ws://[::ffff:8.8.8.8]:9000/realtime", false],
  ["ws://8.8.8.8:9000/realtime", false],
  ["ws://172.32.0.1/realtime", false],
  ["ws://100.128.0.1/realtime", false],
  ["ws://stt.example.com/realtime", false],
  ["ws://10.example.com/realtime", false],
  ["ws://local.example.com/realtime", false],
  ["http://192.168.1.20:9000/realtime", false],
  ["https://stt.example.com/realtime", false],
  ["not a url", false],
];

test("renderer and main agree on every self-hosted realtime URL", async () => {
  const { isSecureWebSocketEndpoint } = await loadRenderer();

  for (const [url, expected] of TABLE) {
    assert.equal(isSecureWebSocketEndpoint(url), expected, `renderer: ${url}`);
    assert.equal(mainAccepts(url), expected, `main: ${url}`);
  }
});
