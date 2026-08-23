const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingTranscriptPersistence.ts");

const segment = (id, text) => ({ id, text, source: "system" });
const serialize = (segments) => segments.map((s) => s.text).join("|");
const never = () => new Promise(() => {});

test("captured segments are written only after an authorized stop succeeds", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const events = [];

  const result = await persistFinalTranscriptAroundStop({
    segments: [segment("a", "hello"), segment("b", "world")],
    serializeSegments: serialize,
    persist: async (transcript) => {
      events.push(`persist:${transcript}`);
    },
    stop: async () => {
      events.push("stop");
      return { success: true, diarizationSessionId: "diar-1" };
    },
    shouldPersist: (result) => result.success,
    assertAuthorized: () => events.push("authorized"),
    authorizationChanged: never(),
    fallbackTranscript: () => {
      throw new Error("main's transcript must not be consulted when segments exist");
    },
  });

  assert.deepEqual(events, ["stop", "authorized", "persist:hello|world", "authorized"]);
  assert.deepEqual(result, { success: true, diarizationSessionId: "diar-1" });
});

test("a segment-less recording writes main's final transcript after the stop", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const events = [];
  let stopped = false;

  await persistFinalTranscriptAroundStop({
    segments: [],
    serializeSegments: () => {
      throw new Error("must not serialize an empty segment list");
    },
    persist: async (transcript) => {
      events.push(`persist:${transcript}`);
    },
    stop: async () => {
      stopped = true;
      events.push("stop");
      return { success: true };
    },
    shouldPersist: (result) => result.success,
    assertAuthorized: () => {},
    authorizationChanged: never(),
    // Only available once main has flushed its final text.
    fallbackTranscript: () => (stopped ? "main text" : ""),
  });

  assert.deepEqual(events, ["stop", "persist:main text"]);
});

test("nothing is written when there are neither segments nor a fallback transcript", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  let persisted = 0;

  await persistFinalTranscriptAroundStop({
    segments: [],
    serializeSegments: serialize,
    persist: async () => {
      persisted += 1;
    },
    stop: async () => ({ success: true }),
    shouldPersist: (result) => result.success,
    assertAuthorized: () => {},
    authorizationChanged: never(),
    fallbackTranscript: () => "",
  });

  assert.equal(persisted, 0);
});

test("the stop result is only returned once the authorized write has settled", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  let releaseWrite;
  const write = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let settled = false;

  const pending = persistFinalTranscriptAroundStop({
    segments: [segment("a", "hello")],
    serializeSegments: serialize,
    persist: () => write,
    stop: async () => ({ success: true, state: "stopped" }),
    shouldPersist: (result) => result.success,
    assertAuthorized: () => {},
    authorizationChanged: never(),
    fallbackTranscript: () => "",
  }).then((value) => {
    settled = true;
    return value;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "the caller must not proceed while the transcript write is in flight"
  );

  releaseWrite();
  assert.deepEqual(await pending, { success: true, state: "stopped" });
});

for (const segments of [[], [segment("a", "stale segment")]]) {
  test(`an authorization abort overtaking stop does not persist ${
    segments.length > 0 ? "captured segments" : "the fallback transcript"
  }`, async () => {
    const { persistFinalTranscriptAroundStop } = await load();
    const stopDeferred = (() => {
      let resolve;
      const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    })();
    const persisted = [];
    let stopSettled = false;

    const stopping = persistFinalTranscriptAroundStop({
      segments,
      serializeSegments: serialize,
      persist: async (transcript) => {
        persisted.push(transcript);
      },
      stop: () => stopDeferred.promise,
      shouldPersist: (result) => result.success,
      assertAuthorized: () => {
        throw new Error("an overtaken stop must not enter persistence");
      },
      authorizationChanged: never(),
      fallbackTranscript: () => "stale fallback",
    }).then((result) => {
      stopSettled = true;
      return result;
    });

    await Promise.resolve();
    assert.deepEqual(persisted, [], "persistence must wait for main stop");
    stopDeferred.resolve({
      success: false,
      reason: "authorization-changed",
      code: "AUTHORIZATION_BOUNDARY_CHANGED",
    });

    assert.deepEqual(await stopping, {
      success: false,
      reason: "authorization-changed",
      code: "AUTHORIZATION_BOUNDARY_CHANGED",
    });
    assert.equal(stopSettled, true);
    assert.deepEqual(persisted, []);
  });
}

test("authorization is re-asserted immediately before persistence admission", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  let persisted = false;

  await assert.rejects(
    persistFinalTranscriptAroundStop({
      segments: [segment("a", "stale segment")],
      serializeSegments: serialize,
      persist: async () => {
        persisted = true;
      },
      stop: async () => ({ success: true }),
      shouldPersist: (result) => result.success,
      assertAuthorized: () => {
        throw Object.assign(new Error("Authorization changed"), {
          code: "AUTHORIZATION_BOUNDARY_CHANGED",
        });
      },
      authorizationChanged: never(),
      fallbackTranscript: () => "",
    }),
    { code: "AUTHORIZATION_BOUNDARY_CHANGED" }
  );

  assert.equal(persisted, false);
});

test("authorization abort detaches an in-flight persistence completion", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const write = (() => {
    let resolve;
    const promise = new Promise((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  })();
  const authorizationChange = (() => {
    let resolve;
    const promise = new Promise((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  })();
  let authorized = true;

  const stopping = persistFinalTranscriptAroundStop({
    segments: [segment("a", "stale segment")],
    serializeSegments: serialize,
    persist: () => write.promise,
    stop: async () => ({ success: true }),
    shouldPersist: (result) => result.success,
    assertAuthorized: () => {
      if (!authorized) {
        throw Object.assign(new Error("Authorization changed"), {
          code: "AUTHORIZATION_BOUNDARY_CHANGED",
        });
      }
    },
    authorizationChanged: authorizationChange.promise,
    fallbackTranscript: () => "",
  });
  await Promise.resolve();

  authorized = false;
  authorizationChange.resolve();
  await assert.rejects(stopping, { code: "AUTHORIZATION_BOUNDARY_CHANGED" });

  // The stale update completion is detached and cannot alter the settled stop.
  write.resolve();
  await Promise.resolve();
});
