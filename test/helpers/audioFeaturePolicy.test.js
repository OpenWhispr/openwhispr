const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  audioFeatureFailure,
  createAudioFeaturePolicy,
} = require("../../src/helpers/audioFeaturePolicy");
const { toPolicyFailure } = require("../../src/helpers/policyResponseError");

const policy = (meetingRecordingEnabled = true, audioUploadEnabled = true, revision = 1) => ({
  success: true,
  managed: true,
  authGeneration: 1,
  revision,
  policy: { features: { meetingRecordingEnabled, audioUploadEnabled } },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

for (const meeting of [true, false])
  for (const upload of [true, false]) {
    test(`main enforces independent controls: meeting=${meeting}, upload=${upload}`, async () => {
      const guard = createAudioFeaturePolicy({ getPolicy: async () => policy(meeting, upload) });
      for (const [purpose, allowed] of [
        ["meeting", meeting],
        ["upload", upload],
      ]) {
        let calls = 0;
        const result = await guard.run({}, purpose, () => {
          calls++;
          return { success: true };
        });
        assert.equal(calls, Number(allowed));
        assert.equal(result.success, allowed);
        if (!allowed)
          assert.equal(
            result.code,
            purpose === "meeting"
              ? "POLICY_MEETING_RECORDING_DISABLED"
              : "POLICY_AUDIO_UPLOAD_DISABLED"
          );
      }
    });
  }

test("older policies and guests retain both features; unresolved managed policy fails closed", () => {
  for (const purpose of ["meeting", "upload"]) {
    assert.equal(audioFeatureFailure({ success: true, managed: false }, purpose), null);
    assert.equal(
      audioFeatureFailure({ success: true, managed: true, policy: { features: {} } }, purpose),
      null
    );
    for (const snapshot of [null, { success: false }, { success: true, managed: true }]) {
      assert.equal(audioFeatureFailure(snapshot, purpose).code, "POLICY_UNRESOLVABLE");
    }
  }
});

test("a policy refresh aborts only the disabled operation and suppresses its late result", async () => {
  const pending = deferred();
  const entered = deferred();
  const blocked = [];
  const guard = createAudioFeaturePolicy({
    getPolicy: async () => policy(),
    onBlocked: (p) => blocked.push(p),
  });
  let signal;
  const result = guard.run({}, "upload", async (jobSignal) => {
    signal = jobSignal;
    entered.resolve();
    await pending.promise;
    return { success: true };
  });
  await entered.promise;
  guard.update(policy(true, false, 2));
  assert.equal(signal.aborted, true);
  assert.equal(guard.failure("meeting"), null);
  guard.update(policy(true, true, 1));
  assert.equal(guard.failure("upload").code, "POLICY_AUDIO_UPLOAD_DISABLED");
  pending.resolve();
  assert.equal((await result).success, false);
  assert.deepEqual(blocked, ["upload"]);
});

test("owner loss and account changes cancel a pending policy lookup before side effects", async () => {
  for (const reason of ["owner", "account"]) {
    const pending = deferred();
    const sender = new EventEmitter();
    let calls = 0;
    const guard = createAudioFeaturePolicy({ getPolicy: () => pending.promise });
    const result = guard.run({ sender }, "meeting", () => {
      calls++;
      return { success: true };
    });
    if (reason === "owner") sender.emit("destroyed");
    else {
      guard.invalidate();
      guard.cancelJobs();
    }
    pending.resolve(policy());
    assert.equal((await result).success, false);
    assert.equal(calls, 0);
    assert.equal(sender.listenerCount("destroyed"), 0);
  }
});

test("dictation is never refused, even before the policy loads", async () => {
  for (const snapshot of [null, { success: false }, policy(false, false)]) {
    assert.equal(audioFeatureFailure(snapshot, "dictation"), null);
  }
  const guard = createAudioFeaturePolicy({ getPolicy: async () => ({ success: false }) });
  assert.deepEqual(await guard.run({}, "dictation", () => ({ success: true })), { success: true });
});

test("dictation never waits on a policy lookup or lets a failed one stop a meeting", async () => {
  let lookups = 0;
  const blocked = [];
  const guard = createAudioFeaturePolicy({
    getPolicy: async () => {
      lookups++;
      return { success: false };
    },
    onBlocked: (purpose) => blocked.push(purpose),
  });
  guard.update(policy());
  assert.deepEqual(await guard.run({}, "dictation", () => ({ success: true })), { success: true });
  assert.equal(lookups, 0);
  assert.deepEqual(blocked, []);
  assert.equal(guard.failure("meeting"), null);
});

test("a main-process start fetches a policy that has not loaded instead of refusing on it", async () => {
  let lookups = 0;
  let next = policy(true);
  const blocked = [];
  const guard = createAudioFeaturePolicy({
    getPolicy: async () => {
      lookups++;
      return next;
    },
    onBlocked: (purpose) => blocked.push(purpose),
  });
  assert.equal(await guard.resolve("meeting"), null);
  assert.equal(lookups, 1);

  // A loaded snapshot is answered without another lookup.
  next = policy(false);
  assert.equal(await guard.resolve("meeting"), null);
  assert.equal(lookups, 1);

  // Offline with nothing cached still fails closed, without reporting a block.
  next = { success: false };
  guard.invalidate();
  assert.equal((await guard.resolve("meeting")).code, "POLICY_UNRESOLVABLE");
  assert.deepEqual(blocked, []);
});

test("a refusal names the control that is switched off", () => {
  assert.equal(
    audioFeatureFailure(policy(false, true), "meeting").error,
    "Meeting recording is disabled by your organization."
  );
  assert.equal(
    audioFeatureFailure(policy(true, false), "upload").error,
    "Audio upload is disabled by your organization."
  );
});

test("a newly blocked purpose is reported with its refusal code", () => {
  const blocked = [];
  const guard = createAudioFeaturePolicy({
    getPolicy: async () => policy(),
    onBlocked: (...args) => blocked.push(args),
  });
  guard.update(policy());
  guard.update(policy(false, true, 2));
  assert.deepEqual(blocked, [["meeting", "POLICY_MEETING_RECORDING_DISABLED"]]);
});

test("only a server refusal refreshes the policy, bypassing its freshness window", async () => {
  const requests = [];
  const refreshed = deferred();
  const guard = createAudioFeaturePolicy({
    getPolicy: async (_event, options) => {
      requests.push(options);
      if (!options?.refresh) return policy(true, true, 1);
      refreshed.resolve();
      return policy(true, false, 2);
    },
  });
  guard.update(policy(true, true, 1));
  const serverRefusal = { success: false, code: "POLICY_AUDIO_UPLOAD_DISABLED", status: 403 };

  // A local refusal was decided from the snapshot, and other failures say
  // nothing about the policy.
  guard.refreshOnRefusal({}, { code: "POLICY_AUDIO_UPLOAD_DISABLED" });
  guard.refreshOnRefusal({}, { code: "NETWORK_ERROR", status: 503 });
  assert.deepEqual(requests, []);

  const result = await guard.run({}, "upload", () => serverRefusal);
  assert.equal(result, serverRefusal);
  await refreshed.promise;
  assert.deepEqual(requests, [undefined, { refresh: true }]);
  await new Promise(setImmediate);
  assert.equal(guard.failure("upload").code, "POLICY_AUDIO_UPLOAD_DISABLED");
});

test("a held verdict answers at once while the lookup behind it is still pending", async () => {
  const lookup = deferred();
  const guard = createAudioFeaturePolicy({ getPolicy: () => lookup.promise });
  guard.update(policy());
  assert.deepEqual(await guard.run({}, "upload", () => ({ success: true })), { success: true });

  // The background refresh still lands, and governs the next call.
  lookup.resolve(policy(true, false, 2));
  await new Promise(setImmediate);
  assert.equal(guard.failure("upload").code, "POLICY_AUDIO_UPLOAD_DISABLED");
});

test("with no verdict held, a stalled lookup fails closed at the deadline", async () => {
  const lookup = deferred();
  let calls = 0;
  const guard = createAudioFeaturePolicy({
    getPolicy: () => lookup.promise,
    lookupDeadlineMs: 5,
  });
  const result = await guard.run({}, "meeting", () => {
    calls++;
    return { success: true };
  });
  assert.equal(result.code, "POLICY_UNRESOLVABLE");
  assert.equal(calls, 0);
  assert.equal((await guard.resolve("upload")).code, "POLICY_UNRESOLVABLE");

  lookup.resolve(policy());
  await new Promise(setImmediate);
  assert.equal(guard.failure("meeting"), null);
});

test("a failed lookup neither replaces a usable verdict nor stops a meeting", async () => {
  const blocked = [];
  let next = { success: false, code: "POLICY_UNAVAILABLE" };
  const guard = createAudioFeaturePolicy({
    getPolicy: async () => next,
    onBlocked: (purpose) => blocked.push(purpose),
  });
  guard.update(policy());
  assert.deepEqual(await guard.run({}, "meeting", () => ({ success: true })), { success: true });
  await new Promise(setImmediate);
  assert.equal(guard.failure("meeting"), null);
  assert.deepEqual(blocked, []);

  // A failed verdict the manager broadcast is fetched again, not kept.
  guard.update({ success: false, code: "POLICY_UNRESOLVABLE" });
  next = policy(true, true, 2);
  assert.equal(await guard.resolve("meeting"), null);
});

test("a credential change re-resolves, and live capture keeps its verdict meanwhile", async () => {
  const lookups = [];
  const changes = [];
  const guard = createAudioFeaturePolicy({
    getPolicy: () => {
      const lookup = deferred();
      lookups.push(lookup);
      return lookup.promise;
    },
    onChange: () => changes.push(guard.failure("meeting")?.code ?? null),
  });
  guard.update(policy());
  changes.length = 0;

  guard.invalidate();
  assert.equal(guard.failure("meeting").code, "POLICY_UNRESOLVABLE");
  assert.equal(guard.activeFailure("meeting"), null);
  assert.equal(lookups.length, 1);

  lookups[0].resolve(policy(false, true, 3));
  await new Promise(setImmediate);
  assert.equal(guard.activeFailure("meeting").code, "POLICY_MEETING_RECORDING_DISABLED");
  assert.deepEqual(changes, ["POLICY_MEETING_RECORDING_DISABLED"]);
});

test("a lookup made before a credential change never lands after it", async () => {
  const lookups = [];
  const guard = createAudioFeaturePolicy({
    getPolicy: () => {
      const lookup = deferred();
      lookups.push(lookup);
      return lookup.promise;
    },
  });
  const before = guard.resolve("meeting");
  guard.invalidate();
  lookups[0].resolve(policy(true, true, 5));
  await before;
  assert.equal(guard.failure("meeting").code, "POLICY_UNRESOLVABLE");
  lookups[1].resolve(policy(false, true, 6));
  await new Promise(setImmediate);
  assert.equal(guard.failure("meeting").code, "POLICY_MEETING_RECORDING_DISABLED");
});

test("the handler's signal also carries the caller's own cancellation", async () => {
  const guard = createAudioFeaturePolicy({ getPolicy: async () => policy() });
  guard.update(policy());
  const cancel = new AbortController();
  const result = await guard.run(
    {},
    "upload",
    (signal) => {
      cancel.abort();
      return { success: true, aborted: signal.aborted };
    },
    { signal: cancel.signal }
  );
  assert.deepEqual(result, { success: true, aborted: true });
});

test("a token rotation lets a running job finish, while an account change cancels it", async () => {
  for (const accountChanged of [false, true]) {
    const entered = deferred();
    const finish = deferred();
    const lookups = [];
    const guard = createAudioFeaturePolicy({
      getPolicy: () => {
        const lookup = deferred();
        lookups.push(lookup);
        return lookup.promise;
      },
    });
    guard.update(policy());
    const running = guard.run({}, "upload", async (signal) => {
      entered.resolve();
      await finish.promise;
      return { success: true, aborted: signal.aborted };
    });
    await entered.promise;

    guard.invalidate();
    if (accountChanged) guard.cancelJobs();
    // New work waits for the new credential's policy while this job runs on.
    assert.equal(guard.failure("upload").code, "POLICY_UNRESOLVABLE");
    finish.resolve();
    const result = await running;
    if (accountChanged) assert.equal(result.code, "AUDIO_OPERATION_CANCELLED");
    else assert.deepEqual(result, { success: true, aborted: false });

    lookups.at(-1).resolve(policy(true, true, 2));
    await new Promise(setImmediate);
    assert.equal(guard.failure("upload"), null);
  }
});

test("an account change also drops the verdict running work started under", () => {
  const guard = createAudioFeaturePolicy({ getPolicy: () => new Promise(() => {}) });
  guard.update(policy());
  guard.invalidate();
  assert.equal(guard.activeFailure("meeting"), null);
  guard.cancelJobs();
  assert.equal(guard.activeFailure("meeting").code, "POLICY_UNRESOLVABLE");
});

test("listeners hear about a changed meeting verdict, not every refresh", async () => {
  const lookups = [];
  let changes = 0;
  const guard = createAudioFeaturePolicy({
    getPolicy: () => {
      const lookup = deferred();
      lookups.push(lookup);
      return lookup.promise;
    },
    onChange: () => changes++,
  });
  guard.update(policy(true, true, 1));
  guard.update(policy(true, true, 2));
  guard.update(policy(true, false, 3));
  assert.equal(changes, 1);
  guard.update(policy(false, true, 4));
  assert.equal(changes, 2);

  guard.invalidate();
  assert.equal(changes, 2);
  lookups.at(-1).resolve(policy(true, true, 5));
  await new Promise(setImmediate);
  assert.equal(changes, 3);
});

test("a sign-out's known verdict is not overwritten by a lookup made before it", async () => {
  const lookups = [];
  const guard = createAudioFeaturePolicy({
    getPolicy: () => {
      const lookup = deferred();
      lookups.push(lookup);
      return lookup.promise;
    },
  });
  guard.update(policy());
  guard.invalidate();
  guard.invalidate({ success: true, managed: false, authGeneration: 2 });
  assert.equal(lookups.length, 1);
  lookups[0].resolve(policy(false, false, 9));
  await new Promise(setImmediate);
  assert.equal(guard.failure("meeting"), null);
});

test("a lookup that throws is logged, not raised", async () => {
  const warnings = [];
  const guard = createAudioFeaturePolicy({
    getPolicy: async () => {
      throw new Error("offline");
    },
    logger: { warn: (message, meta) => warnings.push([message, meta]) },
  });
  assert.equal((await guard.resolve("meeting")).code, "POLICY_UNRESOLVABLE");
  assert.deepEqual(warnings, [["Audio policy lookup failed", { error: "offline" }]]);
});

test("a credential change always reports the re-resolved meeting verdict", async () => {
  let answer;
  let detectorsOn = null;
  let guard;
  // Like _syncMeetingDetectorPolicy, which sync-notification-preferences also
  // calls directly: it follows whatever failure("meeting") says right now.
  const sync = () => {
    detectorsOn = !guard.failure("meeting");
  };
  guard = createAudioFeaturePolicy({
    getPolicy: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    onChange: sync,
    lookupDeadlineMs: 5,
  });
  guard.update({ success: true, managed: false, authGeneration: 1 });
  assert.equal(detectorsOn, true);

  guard.invalidate();
  sync();
  assert.equal(detectorsOn, false);

  answer({ success: true, managed: false, authGeneration: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detectorsOn, true);
});

test("a managed-setup error reaches the meeting start result with its translation key", async () => {
  const guard = createAudioFeaturePolicy({ getPolicy: async () => policy() });
  const error = Object.assign(new Error("Managed audio is unavailable"), {
    code: "MANAGED_CONFIG_UNAVAILABLE",
    messageKey: "common.managedConfigUnavailable",
    messageParams: { region: "eastus" },
  });
  // The start handler returns toPolicyFailure(error); anything it throws reaches the guard.
  for (const handler of [
    () => toPolicyFailure(error),
    () => {
      throw error;
    },
  ]) {
    const { success, code, messageKey, messageParams } = await guard.run({}, "meeting", handler);
    assert.deepEqual(
      { success, code, messageKey, messageParams },
      {
        success: false,
        code: "MANAGED_CONFIG_UNAVAILABLE",
        messageKey: "common.managedConfigUnavailable",
        messageParams: { region: "eastus" },
      }
    );
  }
});
