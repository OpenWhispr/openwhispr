const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals, createRendererServer } = require("../lib/rendererTestHarness");

async function setup(t, { saved = false, consent = true } = {}) {
  let candidate = { link: "https://try.openwhispr.com/creator", clickId: null, saved: false };
  let generation = 7;
  const requests = [];
  let resolve = async () => ({ link: candidate.link, clickId: "click" });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAffiliateCandidate: async () => ({
          config: { domain: "try.openwhispr.com" },
          candidate,
          generation,
        }),
        saveAffiliateCandidate: async (input) => {
          candidate = input;
        },
        resolveAffiliateLink: async (...args) => resolve(...args),
      },
    },
  });
  global.__affiliateTest = {
    get generation() {
      return generation;
    },
    consent,
    requests,
    saved,
  };
  t.after(() => delete global.__affiliateTest);
  const vite = await createRendererServer(t, {
    cachePrefix: "affiliate-store-",
    mockModules: {
      "/lib/authRequestContext": `export const getValidatedAuthGeneration=()=>globalThis.__affiliateTest.generation; export const getAuthRequestContextSnapshot=()=>({observedGeneration:globalThis.__affiliateTest.generation}); export const subscribeAuthRequestContext=()=>()=>{};`,
      settingsStore: `export const useSettingsStore={getState:()=>({telemetryEnabled:globalThis.__affiliateTest.consent})};`,
      "/services/cloudApi": `export async function cloudGetForAuthGeneration(){return {data:{persisted:globalThis.__affiliateTest.saved,status:'registered'}};} export async function cloudPostForAuthGeneration(...args){globalThis.__affiliateTest.requests.push(args);return {data:{persisted:true,status:'pending'}};}`,
    },
  });
  const store = await vite.ssrLoadModule("/stores/affiliateStore.ts");
  return {
    ...store,
    requests,
    candidate: () => candidate,
    switchAccount: () => {
      generation++;
    },
    setResolve: (fn) => {
      resolve = fn;
    },
  };
}
test("first saved account referral wins over a new local candidate", async (t) => {
  const s = await setup(t, { saved: true });
  assert.equal(await s.prepareAffiliateCheckout(), true);
  assert.equal(s.useAffiliateStore.getState().saved, true);
  assert.equal(s.requests.length, 0);
});
test("disabled tracking never resolves or claims a creator link", async (t) => {
  const s = await setup(t, { consent: false });
  s.setResolve(() => assert.fail("must not resolve"));
  assert.equal(await s.prepareAffiliateCheckout(), false);
  assert.equal(s.requests.length, 0);
  assert.equal(s.useAffiliateStore.getState().error, "privacy");
});
test("claim uses the captured auth generation and saves only acknowledged state", async (t) => {
  const s = await setup(t);
  assert.equal(await s.prepareAffiliateCheckout(), true);
  assert.deepEqual(
    s.requests.map((r) => [r[0], r[2]]),
    [
      ["/api/affiliate/check-link", 7],
      ["/api/affiliate/claim", 7],
    ]
  );
  assert.equal(s.requests[1][1].clickId, "click");
  assert.equal(s.candidate().saved, true);
});
test("account switch during link resolution prevents claim and persistence", async (t) => {
  const s = await setup(t);
  s.setResolve(async () => {
    s.switchAccount();
    return { link: s.candidate().link, clickId: "click" };
  });
  assert.equal(await s.prepareAffiliateCheckout(), false);
  assert.equal(s.requests.length, 1);
  assert.equal(s.candidate().saved, false);
});
test("parallel checkout attempts share one claim operation", async (t) => {
  const s = await setup(t);
  assert.deepEqual(
    await Promise.all([s.prepareAffiliateCheckout(), s.prepareAffiliateCheckout()]),
    [true, true]
  );
  assert.equal(s.requests.filter((r) => r[0] === "/api/affiliate/claim").length, 1);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let index = 0; index < 8; index++) await tick();
};
const { deferred } = require("../helpers/harness/deferred");
async function setupLifecycle(t, { signedIn = true, initialCandidate = null } = {}) {
  let cleanup = () => {};
  t.after(() => cleanup());
  const native = {
    generation: signedIn ? 7 : 0,
    token: signedIn ? "token-a" : null,
    candidate: initialCandidate,
  };
  const calls = { status: 0, posts: [], reads: 0 };
  let nativeRead = async () => ({
    config: { domain: "try.openwhispr.com" },
    generation: native.generation,
    candidate: native.candidate && { ...native.candidate },
  });
  let resolveLink = async (link) => ({ link, clickId: "resolved-click" });
  let status = async () => ({ data: { persisted: false, status: null } });
  let linkListener;
  const events = new Map();
  installBrowserGlobals(t, {
    window: {
      location: { origin: "https://desktop.openwhispr.test", search: "?panel=true" },
      addEventListener: (event, listener) => events.set(event, listener),
      removeEventListener: (event) => events.delete(event),
      electronAPI: {
        authGetTokenState: async () => ({ token: native.token, generation: native.generation }),
        getAffiliateCandidate: () => {
          calls.reads++;
          return nativeRead();
        },
        resolveAffiliateLink: (...args) => resolveLink(...args),
        saveAffiliateCandidate: async (input) => {
          assert.equal(input.generation, native.generation);
          const previous = native.candidate ?? { link: "", clickId: null, saved: false };
          if (
            input.expectedCandidate &&
            ["link", "clickId", "saved"].some(
              (key) => input.expectedCandidate[key] !== previous[key]
            )
          )
            throw new Error("REFERRAL_CONTEXT_CHANGED");
          native.candidate = { link: input.link, clickId: input.clickId, saved: input.saved };
        },
        onAffiliateLink: (listener) => {
          linkListener = listener;
          return () => {
            linkListener = null;
          };
        },
      },
    },
  });
  globalThis.__affiliateLifecycle = {
    status: (...args) => {
      calls.status++;
      return status(...args);
    },
    post: async (...args) => {
      calls.posts.push(args);
      return { data: { persisted: true, status: "pending" } };
    },
  };
  t.after(() => delete globalThis.__affiliateLifecycle);
  const vite = await createRendererServer(t, {
    cachePrefix: "review-affiliate-life-",
    mockModules: {
      settingsStore: `export const useSettingsStore={getState:()=>({telemetryEnabled:true})};`,
      "/services/cloudApi": `export const cloudGetForAuthGeneration=(...args)=>globalThis.__affiliateLifecycle.status(...args); export const cloudPostForAuthGeneration=(...args)=>globalThis.__affiliateLifecycle.post(...args);`,
    },
  });
  const auth = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  const store = await vite.ssrLoadModule("/stores/affiliateStore.ts");
  auth.resetAuthRequestContextForTests();
  const sessionAnswer = async (user) => {
    await auth.handleAuthRequestSuccess({
      data: user ? { user: { id: user }, session: { id: "session" } } : null,
      response: new Response("{}"),
      request: {
        url: "https://auth.openwhispr.test/api/auth/get-session",
        headers: new Headers(native.token ? { Authorization: `Bearer ${native.token}` } : {}),
        openWhisprAuthGeneration: native.generation,
      },
    });
    if (user) assert.equal(auth.commitValidatedAuthContext(native.generation, user), true);
  };
  if (signedIn) await sessionAnswer("user-a");
  return {
    native,
    calls,
    auth,
    ...store,
    sessionAnswer,
    startAffiliateAttribution: () => {
      cleanup = store.startAffiliateAttribution();
      return cleanup;
    },
    setRead: (value) => {
      nativeRead = value;
    },
    setResolve: (value) => {
      resolveLink = value;
    },
    setStatus: (value) => {
      status = value;
    },
    arrival: (candidate) => {
      native.candidate = candidate;
      linkListener();
    },
    focus: () => events.get("focus")?.(),
  };
}

test("cold signed-out startup retries a candidate read invalidated by auth observation", async (t) => {
  const link = "https://try.openwhispr.com/creator-a";
  const setupState = await setupLifecycle(t, {
    signedIn: false,
    initialCandidate: { link, clickId: null, saved: false },
  });
  const read = deferred();
  setupState.setRead(() => read.promise);
  setupState.startAffiliateAttribution();

  await tick();
  assert.equal(setupState.calls.reads, 1);
  setupState.auth.observeAuthTokenStateEvent({ generation: 0, hasToken: false });
  await setupState.sessionAnswer(null);
  read.resolve({
    config: { domain: "try.openwhispr.com" },
    generation: 0,
    candidate: setupState.native.candidate,
  });
  await settle();
  const result = setupState.useAffiliateStore.getState();
  assert.equal(result.enabled, true);
  assert.equal(result.link, link);
  assert.equal(setupState.calls.reads, 2);
});

test("a new deep link during resolution is claimed and releases the field", async (t) => {
  const linkA = "https://try.openwhispr.com/creator-a";
  const linkB = "https://try.openwhispr.com/creator-b";
  const setupState = await setupLifecycle(t, {
    initialCandidate: { link: linkA, clickId: null, saved: false },
  });
  const resolving = deferred();
  const entered = deferred();
  setupState.setResolve(() => {
    entered.resolve();
    return resolving.promise;
  });
  setupState.startAffiliateAttribution();
  await entered.promise;
  assert.equal(setupState.useAffiliateStore.getState().checking, true);
  setupState.arrival({ link: linkB, clickId: "click-b", saved: false });
  await settle();
  resolving.resolve({ link: linkA, clickId: "click-a" });
  await settle();
  const result = setupState.useAffiliateStore.getState();
  assert.equal(result.link, linkB);
  assert.equal(result.checking, false);
  assert.equal(result.saved, true);
  assert.deepEqual(
    setupState.calls.posts
      .filter((call) => call[0].endsWith("/claim"))
      .map((call) => call[1].clickId),
    ["click-b"]
  );
});

test("checkout waits for the new creator claim when a link arrives during its status check", async (t) => {
  const setupState = await setupLifecycle(t);
  const status = deferred();
  const statusEntered = deferred();
  setupState.setStatus(() => {
    statusEntered.resolve();
    return status.promise;
  });
  setupState.startAffiliateAttribution();
  await statusEntered.promise;
  const checkout = setupState.prepareAffiliateCheckout();
  setupState.arrival({
    link: "https://try.openwhispr.com/creator-b",
    clickId: "click-b",
    saved: false,
  });
  status.resolve({ data: { persisted: false, status: null } });
  const allowed = await checkout;
  await settle();
  const result = setupState.useAffiliateStore.getState();
  assert.equal(allowed, true);
  assert.equal(result.link, setupState.native.candidate.link);
  assert.equal(setupState.calls.posts.filter((call) => call[0].endsWith("/claim")).length, 1);
});

test("a queued resolved save preserves a newer native link and retries its claim", async (t) => {
  const linkA = "https://try.openwhispr.com/creator-a";
  const linkB = "https://try.openwhispr.com/creator-b";
  const setupState = await setupLifecycle(t, {
    initialCandidate: { link: linkA, clickId: null, saved: false },
  });
  const queued = deferred();
  const delivered = deferred();
  const originalSave = globalThis.window.electronAPI.saveAffiliateCandidate;
  let initial = true;
  globalThis.window.electronAPI.saveAffiliateCandidate = async (input) => {
    if (initial) {
      initial = false;
      queued.resolve();
      await delivered.promise;
    }
    return originalSave(input);
  };
  setupState.startAffiliateAttribution();
  await queued.promise;
  // Reads from this renderer follow its already queued save in the native IPC queue.
  const originalRead = globalThis.window.electronAPI.getAffiliateCandidate;
  globalThis.window.electronAPI.getAffiliateCandidate = async () => {
    await delivered.promise;
    return originalRead();
  };
  setupState.arrival({ link: linkB, clickId: "click-b", saved: false });
  delivered.resolve();
  await settle();
  assert.equal(setupState.native.candidate.link, linkB);
  assert.equal(setupState.useAffiliateStore.getState().checking, false);
  assert.equal(setupState.useAffiliateStore.getState().saved, true);
  assert.deepEqual(
    setupState.calls.posts
      .filter((call) => call[0].endsWith("/claim"))
      .map((call) => call[1].clickId),
    ["click-b"]
  );
});

test("a queued guest edit cannot replace a newer native creator link", async (t) => {
  const setupState = await setupLifecycle(t, {
    signedIn: false,
    initialCandidate: { link: "https://try.openwhispr.com/creator-a", clickId: null, saved: false },
  });
  setupState.startAffiliateAttribution();
  await settle();
  const queued = deferred();
  const delivered = deferred();
  const originalSave = globalThis.window.electronAPI.saveAffiliateCandidate;
  globalThis.window.electronAPI.saveAffiliateCandidate = async (input) => {
    queued.resolve();
    await delivered.promise;
    return originalSave(input);
  };
  setupState.useAffiliateStore.getState().setLink("https://try.openwhispr.com/edited-a");
  await queued.promise;
  const newer = { link: "https://try.openwhispr.com/creator-b", clickId: "click-b", saved: false };
  setupState.arrival(newer);
  delivered.resolve();
  await settle();
  assert.deepEqual(setupState.native.candidate, newer);
  assert.equal(setupState.useAffiliateStore.getState().link, newer.link);
  assert.equal(setupState.calls.posts.length, 0);
});

test("an edit made after a native arrival survives its still-pending refresh", async (t) => {
  const setupState = await setupLifecycle(t, {
    signedIn: false,
    initialCandidate: { link: "https://try.openwhispr.com/creator-a", clickId: null, saved: false },
  });
  setupState.startAffiliateAttribution();
  await settle();
  const entered = deferred();
  const pending = deferred();
  let initial = true;
  setupState.setRead(async () => {
    if (initial) {
      initial = false;
      entered.resolve();
      await pending.promise;
    }
    return {
      config: { domain: "try.openwhispr.com" },
      generation: 0,
      candidate: { ...setupState.native.candidate },
    };
  });
  setupState.arrival({ link: "https://try.openwhispr.com/creator-b", clickId: null, saved: false });
  await entered.promise;
  const latestEdit = "https://try.openwhispr.com/creator-c";
  setupState.useAffiliateStore.getState().setLink(latestEdit);
  await settle();
  pending.resolve();
  await settle();
  assert.equal(setupState.native.candidate.link, latestEdit);
  assert.equal(setupState.useAffiliateStore.getState().link, latestEdit);
});

for (const previousLink of ["", "https://try.openwhispr.com/previous"]) {
  test(`a failed creator edit preserves the entered link instead of ${previousLink || "an empty candidate"}`, async (t) => {
    const state = await setupLifecycle(t);
    state.startAffiliateAttribution();
    await settle();
    if (previousLink) {
      state.useAffiliateStore.getState().setLink(previousLink);
      await settle();
    }
    globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const link = "https://try.openwhispr.com/entered";
    state.useAffiliateStore.getState().setLink(link);
    await settle();
    state.focus();
    await settle();

    assert.equal(await state.prepareAffiliateCheckout(), false);
    assert.equal(state.useAffiliateStore.getState().link, link);
    assert.equal(state.useAffiliateStore.getState().error, "unavailable");
    assert.deepEqual(state.calls.posts, []);
  });
}

test("checkout retries a failed creator edit when local storage recovers", async (t) => {
  const state = await setupLifecycle(t);
  state.startAffiliateAttribution();
  await settle();
  const save = globalThis.window.electronAPI.saveAffiliateCandidate;
  globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
    throw new Error("ENOSPC");
  };
  const link = "https://try.openwhispr.com/entered";
  state.useAffiliateStore.getState().setLink(link);
  await settle();
  globalThis.window.electronAPI.saveAffiliateCandidate = save;

  assert.equal(await state.prepareAffiliateCheckout(), true);
  assert.equal(state.native.candidate.link, link);
  assert.equal(state.native.candidate.saved, true);
  assert.equal(state.calls.posts.find((call) => call[0].endsWith("/claim"))[1].link, link);
});

test("explicitly removing a failed creator edit permits checkout after the clear is saved", async (t) => {
  const state = await setupLifecycle(t);
  state.startAffiliateAttribution();
  await settle();
  const save = globalThis.window.electronAPI.saveAffiliateCandidate;
  globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
    throw new Error("ENOSPC");
  };
  state.useAffiliateStore.getState().setLink("https://try.openwhispr.com/entered");
  await settle();
  globalThis.window.electronAPI.saveAffiliateCandidate = save;
  state.useAffiliateStore.getState().setLink("");
  await settle();

  assert.equal(await state.prepareAffiliateCheckout(), true);
  assert.equal(state.native.candidate.link, "");
  assert.deepEqual(state.calls.posts, []);
});

test("a failed creator edit cannot follow a replacement account", async (t) => {
  const state = await setupLifecycle(t);
  state.startAffiliateAttribution();
  await settle();
  globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
    throw new Error("ENOSPC");
  };
  state.useAffiliateStore.getState().setLink("https://try.openwhispr.com/entered");
  await settle();
  state.native.generation++;
  state.native.token = "token-b";
  await state.sessionAnswer("user-b");
  await settle();

  assert.equal(await state.prepareAffiliateCheckout(), true);
  assert.equal(state.useAffiliateStore.getState().link, "");
  assert.deepEqual(state.calls.posts, []);
});

test("a saved account referral wins while a local creator edit cannot be written", async (t) => {
  const state = await setupLifecycle(t);
  state.startAffiliateAttribution();
  await settle();
  globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
    throw new Error("ENOSPC");
  };
  state.useAffiliateStore.getState().setLink("https://try.openwhispr.com/entered");
  await settle();
  state.setStatus(async () => ({ data: { persisted: true, status: "registered" } }));
  state.focus();
  await settle();

  assert.equal(await state.prepareAffiliateCheckout(), true);
  assert.equal(state.useAffiliateStore.getState().saved, true);
  assert.equal(state.useAffiliateStore.getState().error, null);
  assert.deepEqual(state.calls.posts, []);
});

test("a failed signed-out edit is retried for its first validated account", async (t) => {
  const state = await setupLifecycle(t, { signedIn: false });
  await state.sessionAnswer(null);
  state.startAffiliateAttribution();
  await settle();
  const save = globalThis.window.electronAPI.saveAffiliateCandidate;
  globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
    throw new Error("ENOSPC");
  };
  const link = "https://try.openwhispr.com/entered";
  state.useAffiliateStore.getState().setLink(link);
  await settle();
  globalThis.window.electronAPI.saveAffiliateCandidate = save;
  state.native.generation++;
  state.native.token = "token-a";
  await state.sessionAnswer("user-a");
  await settle();

  assert.equal(await state.prepareAffiliateCheckout(), true);
  assert.equal(state.native.candidate?.link, link);
  assert.equal(state.native.candidate?.saved, true);
  assert.equal(state.calls.posts.find((call) => call[0].endsWith("/claim"))[1].link, link);
});

test("a failed signed-out edit stops at the first account even if storage is still unavailable", async (t) => {
  const state = await setupLifecycle(t, { signedIn: false });
  await state.sessionAnswer(null);
  state.startAffiliateAttribution();
  await settle();
  globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
    throw new Error("ENOSPC");
  };
  const link = "https://try.openwhispr.com/entered";
  state.useAffiliateStore.getState().setLink(link);
  await settle();
  state.native.generation++;
  state.native.token = "token-a";
  await state.sessionAnswer("user-a");
  await settle();
  assert.equal(await state.prepareAffiliateCheckout(), false);
  assert.equal(state.useAffiliateStore.getState().link, link);

  state.native.generation++;
  state.native.token = "token-b";
  await state.sessionAnswer("user-b");
  await settle();
  assert.equal(await state.prepareAffiliateCheckout(), true);
  assert.equal(state.useAffiliateStore.getState().link, "");
  assert.deepEqual(state.calls.posts, []);
});

test("a failed account edit survives credential rotation only after the same account validates", async (t) => {
  const state = await setupLifecycle(t);
  state.startAffiliateAttribution();
  await settle();
  const save = globalThis.window.electronAPI.saveAffiliateCandidate;
  globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
    throw new Error("ENOSPC");
  };
  const link = "https://try.openwhispr.com/entered";
  state.useAffiliateStore.getState().setLink(link);
  await settle();
  state.native.generation++;
  state.native.token = "token-a-rotated";
  state.auth.observeAuthTokenStateEvent({ generation: state.native.generation, hasToken: true });
  await settle();
  assert.equal(state.useAffiliateStore.getState().link, "");
  assert.equal(await state.prepareAffiliateCheckout(), false);
  assert.deepEqual(state.calls.posts, []);

  await state.sessionAnswer("user-a");
  await settle();
  assert.equal(await state.prepareAffiliateCheckout(), false);
  assert.equal(state.useAffiliateStore.getState().link, link);
  assert.equal(state.useAffiliateStore.getState().error, "unavailable");
  globalThis.window.electronAPI.saveAffiliateCandidate = save;
  assert.equal(await state.prepareAffiliateCheckout(), true);
  assert.equal(state.native.candidate?.saved, true);
  assert.equal(state.calls.posts.find((call) => call[0].endsWith("/claim"))[1].link, link);
});

test("a signed-out session during credential rotation discards a failed account edit", async (t) => {
  const state = await setupLifecycle(t);
  state.startAffiliateAttribution();
  await settle();
  globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
    throw new Error("ENOSPC");
  };
  state.useAffiliateStore.getState().setLink("https://try.openwhispr.com/entered");
  await settle();
  state.native.generation++;
  state.native.token = "token-a-expired";
  state.auth.observeAuthTokenStateEvent({ generation: state.native.generation, hasToken: true });
  await state.sessionAnswer(null);
  await settle();
  state.native.generation++;
  state.native.token = "token-a-new-session";
  await state.sessionAnswer("user-a");
  await settle();

  assert.equal(await state.prepareAffiliateCheckout(), true);
  assert.equal(state.useAffiliateStore.getState().link, "");
  assert.deepEqual(state.calls.posts, []);
});

for (const user of ["user-a", "user-b"]) {
  test(`an in-flight failed edit retry retains its owner when credentials resolve to ${user}`, async (t) => {
    const state = await setupLifecycle(t);
    state.startAffiliateAttribution();
    await settle();
    const save = globalThis.window.electronAPI.saveAffiliateCandidate;
    globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
      throw new Error("ENOSPC");
    };
    const link = "https://try.openwhispr.com/entered";
    state.useAffiliateStore.getState().setLink(link);
    await settle();
    const entered = deferred();
    const release = deferred();
    globalThis.window.electronAPI.saveAffiliateCandidate = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("AUTH_CONTEXT_CHANGED");
    };
    const oldCheckout = state.prepareAffiliateCheckout();
    await entered.promise;
    state.native.generation++;
    state.native.token = "rotated-token";
    await state.sessionAnswer(user);
    release.resolve();
    assert.equal(await oldCheckout, false);
    await settle();
    assert.equal(await state.prepareAffiliateCheckout(), user !== "user-a");
    assert.equal(state.useAffiliateStore.getState().link, user === "user-a" ? link : "");
    assert.deepEqual(state.calls.posts, []);

    globalThis.window.electronAPI.saveAffiliateCandidate = save;
    assert.equal(await state.prepareAffiliateCheckout(), true);
    const claims = state.calls.posts.filter((call) => call[0].endsWith("/claim"));
    assert.equal(claims.length, user === "user-a" ? 1 : 0);
    if (user === "user-a") assert.equal(claims[0][1].link, link);
  });
}
