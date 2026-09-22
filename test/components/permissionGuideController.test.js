const assert = require("node:assert/strict");
const test = require("node:test");

async function fixture(permission = "accessibility") {
  const { createPermissionGuideController } =
    await import("../../src/components/onboarding/permissionGuideController.ts");
  const calls = [],
    states = [],
    saves = [];
  let finish;
  let granted = false;
  let closed = 0;
  let unavailable = 0;
  let publishResult = async () => true;
  const rows = [
    {
      id: permission,
      granted: false,
      request: () => {
        assert.equal(saves.at(-1).current, permission);
        calls.push("request");
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      check: async () => {
        calls.push("check");
        return { granted };
      },
      verify: async () => {
        calls.push("verify");
        return { granted };
      },
      openSettings: async () => {
        calls.push("settings");
      },
    },
  ];
  const controller = createPermissionGuideController({
    sessionId: "test",
    rows: () => rows,
    save: (value) => saves.push(value),
    publish: async (state) => {
      states.push(state);
      return publishResult();
    },
    unavailable: () => {
      unavailable++;
    },
    close: () => {
      closed++;
    },
    restart: async () => {
      calls.push("restart");
    },
  });
  return {
    controller,
    calls,
    states,
    saves,
    rows,
    finish: () => finish(),
    grant: () => {
      granted = true;
    },
    closed: () => closed,
    unavailable: () => unavailable,
    failPublish: (result) => {
      publishResult = result;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("one Enable click requests access immediately, before showing the Settings helper", async () => {
  const setup = await fixture();
  const pending = setup.controller.start("accessibility");
  await tick();
  assert.deepEqual(setup.calls, ["request"]);
  assert.equal(setup.states.length, 0);
  setup.finish();
  await pending;
  assert.equal(setup.states.at(-1).permission, "accessibility");
  assert.deepEqual(setup.calls, ["request", "check"]);
});

test("the helper stays out of the native microphone prompt and never appears after Allow", async () => {
  const setup = await fixture("microphone");
  const pending = setup.controller.start("microphone");
  await tick();
  assert.equal(setup.states.length, 0);
  setup.grant();
  setup.finish();
  await pending;
  assert.equal(setup.states.length, 0);
  assert.equal(setup.saves.at(-1), null);
});

test("denied microphone access shows only the Settings recovery helper", async () => {
  const setup = await fixture("microphone");
  const pending = setup.controller.start("microphone");
  setup.finish();
  await pending;
  assert.equal(setup.states.at(-1).permission, "microphone");
});

test("permission recognition dismisses the overlay without moving to another permission", async () => {
  const setup = await fixture();
  const pending = setup.controller.start("accessibility");
  setup.finish();
  await pending;
  setup.rows.push({ ...setup.rows[0], id: "system-audio" });
  setup.grant();
  await setup.controller.refresh();
  assert.equal(setup.saves.at(-1), null);
  assert.equal(setup.calls.filter((call) => call === "request").length, 1);
});

test("resuming saved intent after the grant landed applies consent without a native request", async () => {
  // The relaunch that Screen Recording asks for happens after the grant, so
  // resume only has to recognize it and complete the opt-in.
  const setup = await fixture("screen-context");
  setup.rows[0].onGranted = () => setup.calls.push("consent");
  setup.grant();
  await setup.controller.start(undefined, { current: "screen-context" });
  assert.deepEqual(setup.calls, ["check", "consent"]);
  assert.equal(setup.states.length, 0);
  assert.equal(setup.saves.at(-1), null);
});

test("resuming saved intent that was never granted clears it instead of opening a helper", async () => {
  // Quitting mid-guide and relaunching later must not float a "drag OpenWhispr
  // into Accessibility" card over a desktop with no System Settings window.
  const setup = await fixture();
  await setup.controller.start(undefined, { current: "accessibility" });
  assert.deepEqual(setup.calls, ["check"]);
  assert.equal(setup.states.length, 0);
  assert.equal(setup.saves.at(-1), null);
  assert.equal(setup.closed(), 1);
});

test("screen consent is applied once, not on every refresh while a restart is pending", async () => {
  // Granted-but-needs-relaunch keeps the helper open, so refresh keeps
  // checking; each check must not re-run the opt-in (store write, IPC, session).
  const setup = await fixture("screen-context");
  setup.rows[0].onGranted = () => setup.calls.push("consent");
  setup.rows[0].check = async () => ({ granted: true, needsRelaunch: true });
  const pending = setup.controller.start("screen-context");
  setup.finish();
  await pending;
  await setup.controller.refresh();
  await setup.controller.refresh();
  assert.equal(setup.calls.filter((call) => call === "consent").length, 1);
  assert.equal(setup.states.at(-1).needsRelaunch, true);
});

test("a helper that cannot open is reported unavailable and the request ends", async () => {
  const setup = await fixture();
  setup.failPublish(async () => false);
  const pending = setup.controller.start("accessibility");
  setup.finish();
  await pending;
  assert.equal(setup.unavailable(), 1);
  assert.equal(setup.saves.at(-1), null);
});

test("a helper open superseded by a newer request is not reported unavailable", async () => {
  // The main process answers false to an open it tore down for a later one; the
  // renderer must not read that as the guide being broken.
  const setup = await fixture();
  let resolveFirst;
  setup.failPublish(() => new Promise((resolve) => (resolveFirst = resolve)));
  const first = setup.controller.start("accessibility");
  setup.finish();
  await tick();
  await setup.controller.act({ sessionId: "test", permission: "accessibility", action: "close" });
  resolveFirst(false);
  await first;
  assert.equal(setup.unavailable(), 0);
});

test("duplicate clicks and late results cannot revive a dismissed helper", async () => {
  const setup = await fixture();
  const pending = setup.controller.start("accessibility");
  await setup.controller.start("accessibility");
  assert.deepEqual(setup.calls, ["request"]);
  await setup.controller.act({ sessionId: "old", permission: "accessibility", action: "close" });
  assert.equal(setup.closed(), 0);
  await setup.controller.act({ sessionId: "test", permission: "accessibility", action: "close" });
  setup.finish();
  await pending;
  assert.equal(setup.states.length, 0);
  assert.equal(setup.saves.at(-1), null);
});

test("policy removal cancels an in-flight request instead of advancing to another permission", async () => {
  const setup = await fixture();
  const pending = setup.controller.start("accessibility");
  setup.rows.length = 0;
  await setup.controller.reconcile();
  setup.finish();
  await pending;
  assert.equal(setup.states.length, 0);
  assert.deepEqual(setup.calls, ["request"]);
});

test("System Audio checks only on demand, without reopening Settings or recording loops", async () => {
  const setup = await fixture("system-audio");
  const pending = setup.controller.start("system-audio");
  setup.finish();
  await pending;
  setup.calls.length = 0;
  await setup.controller.refresh();
  assert.deepEqual(setup.calls, []);
  setup.grant();
  await setup.controller.act({ sessionId: "test", permission: "system-audio", action: "check" });
  assert.deepEqual(setup.calls, ["verify"]);
  assert.equal(setup.saves.at(-1), null);
});

test("a screen grant that requires restart retains the compact restart controls", async () => {
  const setup = await fixture("screen-context");
  setup.rows[0].check = async () => ({ granted: true, needsRelaunch: true });
  const pending = setup.controller.start("screen-context");
  setup.finish();
  await pending;
  assert.equal(setup.states.at(-1).needsRelaunch, true);
  await setup.controller.act({
    sessionId: "test",
    permission: "screen-context",
    action: "restart",
  });
  assert.ok(setup.calls.includes("restart"));
});

test("Settings launch failures expose a retry and never restart the native request", async () => {
  const setup = await fixture();
  setup.rows[0].request = async () => {
    throw new Error("Settings unavailable");
  };
  await setup.controller.start("accessibility");
  assert.equal(setup.states.at(-1).error, true);
  await setup.controller.refresh();
  assert.equal(setup.states.at(-1).error, true);
  await setup.controller.act({
    sessionId: "test",
    permission: "accessibility",
    action: "settings",
  });
  assert.deepEqual(setup.calls, ["check", "settings"]);
  assert.equal(setup.states.at(-1).error, false);
});

test("screen consent is not applied by a stale result after cancellation", async () => {
  const setup = await fixture("screen-context");
  setup.rows[0].onGranted = () => setup.calls.push("consent");
  let finishCheck;
  setup.rows[0].check = () =>
    new Promise((resolve) => {
      finishCheck = resolve;
    });
  const pending = setup.controller.start("screen-context");
  setup.finish();
  await tick();
  await setup.controller.act({ sessionId: "test", permission: "screen-context", action: "close" });
  finishCheck({ granted: true });
  await pending;
  assert.ok(!setup.calls.includes("consent"));
});

test("Check again is only an action for permissions that cannot be recognized automatically", async () => {
  const setup = await fixture();
  const pending = setup.controller.start("accessibility");
  setup.finish();
  await pending;
  setup.calls.length = 0;
  await setup.controller.act({ sessionId: "test", permission: "accessibility", action: "check" });
  assert.deepEqual(setup.calls, []);
});

test("a check from a cancelled request cannot report the next request as granted", async () => {
  const setup = await fixture();
  let finishStaleCheck;
  setup.rows[0].check = () =>
    new Promise((resolve) => {
      finishStaleCheck = resolve;
    });
  const stale = setup.controller.start("accessibility");
  setup.finish();
  await tick();
  await setup.controller.act({ sessionId: "test", permission: "accessibility", action: "close" });
  setup.rows[0].check = async () => ({ granted: false });
  const fresh = setup.controller.start("accessibility");
  setup.finish();
  await fresh;
  finishStaleCheck({ granted: true });
  await stale;
  await setup.controller.refresh();
  assert.equal(setup.states.at(-1).granted, false);
  assert.notEqual(setup.saves.at(-1), null);
});

test("the microphone request prompts natively and opens Settings only for a denial", async () => {
  const { requestMicrophoneForGuide } =
    await import("../../src/components/onboarding/permissionGuideController.ts");
  const run = async (status) => {
    const calls = [];
    await requestMicrophoneForGuide({
      requestAccess: async () => calls.push("prompt"),
      checkAccess: async () => ({ granted: status === "granted", status }),
      openSettings: async () => calls.push("settings"),
    });
    return calls;
  };
  assert.deepEqual(await run("granted"), ["prompt"]);
  assert.deepEqual(await run("denied"), ["prompt", "settings"]);
  // Not determined after the prompt (dismissed, or no prompt possible): the
  // Privacy pane does not list the app yet, so Settings would only confuse.
  assert.deepEqual(await run("not-determined"), ["prompt"]);
});
