const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  audioFeatureFailure,
  createAudioFeaturePolicy,
} = require("../../src/helpers/audioFeaturePolicy");

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
  const event = {};
  const result = guard.run(event, "upload", async () => {
    entered.resolve();
    await pending.promise;
    return { success: true };
  });
  await entered.promise;
  const signal = guard.signalFor(event);
  guard.update(policy(true, false, 2));
  assert.equal(signal.aborted, true);
  assert.equal(guard.failure("meeting"), null);
  guard.update(policy(true, true, 1));
  assert.equal(guard.failure("upload").code, "POLICY_AUDIO_UPLOAD_DISABLED");
  pending.resolve();
  assert.equal((await result).success, false);
  assert.deepEqual(blocked, ["upload"]);
  assert.equal(guard.signalFor(event), undefined);
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
    else guard.cancelAll();
    pending.resolve(policy());
    assert.equal((await result).success, false);
    assert.equal(calls, 0);
    assert.equal(sender.listenerCount("destroyed"), 0);
  }
});
