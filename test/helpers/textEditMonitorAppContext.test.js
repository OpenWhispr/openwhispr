const test = require("node:test");
const assert = require("node:assert/strict");

const TextEditMonitor = require("../../src/helpers/textEditMonitor");

const darwinOnly = { skip: process.platform !== "darwin" };

// Stands in for the native helper: a Node process that prints the given output.
function monitorPrinting(output, exitCode = 0) {
  const monitor = new TextEditMonitor();
  monitor.resolveBinary = () => ({
    command: process.execPath,
    // "--" keeps the helper's own flags ("--app-context <pid>") away from Node.
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode});`,
      "--",
    ],
  });
  return monitor;
}

test(
  "--app-context output becomes the app's name, bundle id, title and host",
  darwinOnly,
  async () => {
    const title = "Re: launch plan\nInbox - Gmail";
    const monitor = monitorPrinting(
      [
        "APP_NAME:Google Chrome",
        "BUNDLE_ID:com.google.Chrome",
        `WINDOW_TITLE_B64:${Buffer.from(title).toString("base64")}`,
        "URL_HOST:mail.google.com",
        "UNRELATED:ignored",
        "",
      ].join("\n")
    );

    assert.deepEqual(await monitor.getAppContext(4242), {
      appName: "Google Chrome",
      bundleId: "com.google.Chrome",
      windowTitle: title,
      urlHost: "mail.google.com",
    });
  }
);

test("a failed --app-context run keeps what it printed before failing", darwinOnly, async () => {
  assert.deepEqual(await monitorPrinting("APP_NAME:Slack\n", 1).getAppContext(4242), {
    appName: "Slack",
  });
  assert.equal(await monitorPrinting("NO_ELEMENT\n", 1).getAppContext(4242), null);
  assert.equal(await new TextEditMonitor().getAppContext(null), null);
});
