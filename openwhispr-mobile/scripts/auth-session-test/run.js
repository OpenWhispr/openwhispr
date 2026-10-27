// Host integration test: real auth wrapper, Better Auth client and Expo plugin.
// Only native storage/platform services and the HTTP response are substitutes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const Platform = { OS: 'android' };
const native = {
  'react-native': { Platform, AppState: { addEventListener: () => ({ remove() {} }) } },
  'expo-constants': { default: { expoConfig: { scheme: 'openwhispr' } }, __esModule: true },
  'expo-linking': { createURL: () => 'openwhispr://' },
};
function load(file, replacements, sourceFile = file) {
  const localRequire = createRequire(file);
  const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: file })(
    (name) => (Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name)),
    module,
    module.exports,
  );
  return module.exports;
}
const expo = load(require.resolve('@better-auth/expo/client'), native);
const user = {
  id: 'fixture-user',
  email: 'fixture@example.invalid',
  emailVerified: true,
  isAnonymous: false,
  name: undefined,
};
const initial = {
  user,
  session: {
    id: 'fixture-session',
    userId: user.id,
    token: 'fixture-token',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  },
};
const cookie = JSON.stringify({
  'better-auth.session_token': { value: 'fixture-token.signature', expires: null },
});
const originalFetch = global.fetch;
const outcomes = [];
function storageFor(values) {
  return {
    getItem: (key) => values.get(key) ?? null,
    getItemAsync: async (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    setItemAsync: async (key, value) => values.set(key, value),
    deleteItemAsync: async (key) => values.delete(key),
  };
}
async function checkFreshLogin({
  flow = 'email',
  platform = 'android',
  sessionAvailable = true,
  autoSignIn = true,
  rejected = false,
  cookiePrefix = 'better-auth',
} = {}) {
  Platform.OS = platform;
  const values = new Map();
  const storage = storageFor(values);
  let restarted = false;
  let sessionRequests = 0;
  const flowUser = { ...user, isAnonymous: flow === 'anonymous' };
  const sessionCookie = `${cookiePrefix}.session_token=fixture-token.signature`;
  const endpoint = {
    email: '/sign-in/email',
    signup: '/sign-up/email',
    anonymous: '/sign-in/anonymous',
  }[flow];
  global.fetch = async (input) => {
    const pathname = new URL(input instanceof global.Request ? input.url : input).pathname;
    if (pathname.endsWith(endpoint)) {
      if (rejected) {
        return new global.Response(JSON.stringify({ message: 'Fixture rejection' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      // These SDK routes return a user/token, not the complete session shape.
      // Signup can also require email verification and return no session token.
      return new global.Response(
        JSON.stringify({
          user: flowUser,
          token: autoSignIn ? initial.session.token : null,
          redirect: false,
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(autoSignIn
              ? {
                  'set-cookie': `${sessionCookie}; Path=/; HttpOnly`,
                }
              : {}),
          },
        },
      );
    }
    assert.ok(pathname.endsWith('/get-session'), pathname);
    sessionRequests += 1;
    return !restarted && sessionAvailable
      ? new global.Response(JSON.stringify({ ...initial, user: flowUser }), {
          headers: { 'content-type': 'application/json' },
        })
      : new global.Response('<title>Gateway</title>', { headers: { 'content-type': 'text/html' } });
  };
  const loadAuth = () =>
    load(
      path.join(root, 'src/lib/authClient.ts'),
      {
        ...native,
        '@better-auth/expo/client': expo,
        'expo-application': { applicationId: 'com.gizmolabs.openwhispr' },
        'expo-secure-store': storage,
        './sessionFetch': { sessionFetch: global.fetch },
        './apiClient': { getClientVersionHeader: () => 'test' },
      },
      process.argv[2],
    );
  const auth = loadAuth();
  const result = await {
    email: () => auth.signInWithEmail(user.email, 'fixture-password'),
    signup: () => auth.signUpWithEmail(user.email, 'fixture-password'),
    anonymous: () => auth.signInAnonymously(),
  }[flow]();
  assert.deepEqual(
    result.user,
    rejected ? null : flowUser,
    `${flow}: authentication result preserved`,
  );
  assert.equal(result.error, rejected ? 'Fixture rejection' : null);
  assert.equal(
    result.sessionCookie,
    autoSignIn && !rejected ? sessionCookie : null,
    `${flow}: callers receive the resolved session cookie`,
  );
  const warmRequests = sessionRequests;
  restarted = true;
  const restartedAuth = loadAuth();
  const expected =
    platform === 'android' && sessionAvailable && autoSignIn && !rejected ? flowUser : null;
  assert.deepEqual(
    await restartedAuth.getSession({ allowOfflineCache: true }),
    expected,
    `${flow}: fresh session must survive a later gateway outage without relying on in-memory identity`,
  );
  assert.equal(
    warmRequests,
    platform === 'android' && autoSignIn && !rejected ? 1 : 0,
    `${flow}: only successful Android sessions are warmed`,
  );
  outcomes.push(
    `${platform} ${flow}, cookie prefix: ${cookiePrefix}, session available: ${sessionAvailable}, auto sign in: ${autoSignIn}, rejected: ${rejected}`,
  );
}
async function check(
  name,
  {
    platform = 'android',
    status = 200,
    contentType = 'text/html; charset=utf-8',
    body = '<title>Gateway</title>',
    cache = initial,
    allowOfflineCache = true,
    expected = user,
    throws = false,
  } = {},
) {
  Platform.OS = platform;
  const values = new Map([
    ['openwhispr_cookie', cookie],
    ['openwhispr_session_data', JSON.stringify(cache)],
  ]);
  const storage = storageFor(values);
  global.fetch = async () =>
    new global.Response(body, { status, headers: { 'content-type': contentType } });
  const auth = load(
    path.join(root, 'src/lib/authClient.ts'),
    {
      ...native,
      '@better-auth/expo/client': expo,
      'expo-application': { applicationId: 'com.gizmolabs.openwhispr' },
      'expo-secure-store': storage,
      './sessionFetch': { sessionFetch: global.fetch },
      './apiClient': { getClientVersionHeader: () => 'test' },
    },
    process.argv[2],
  );
  if (throws) await assert.rejects(auth.getSession({ allowOfflineCache }), TypeError);
  else assert.deepEqual(await auth.getSession({ allowOfflineCache }), expected, name);
  assert.equal(values.get('openwhispr_cookie'), cookie, `${name}: cookie preserved`);
  if (platform === 'android' && status === 200 && contentType.startsWith('text/html')) {
    assert.equal(
      values.get('openwhispr_session_data'),
      JSON.stringify(cache),
      `${name}: gateway must not overwrite cache`,
    );
  }
  if (platform === 'android' && (status === 401 || status === 403 || body === 'null')) {
    assert.equal(
      Boolean(JSON.parse(values.get('openwhispr_session_data') || '{}')?.user),
      false,
      `${name}: authoritative sign-out clears identity`,
    );
  }
  outcomes.push(name);
}
async function checkChunkedClear({ rejected = false } = {}) {
  Platform.OS = 'android';
  const values = new Map();
  const storage = storageFor(values);
  const adapter = expo.storageAdapter(storage);
  await adapter.setItemAsync('openwhispr_cookie', cookie);
  await adapter.setItemAsync(
    'openwhispr_session_data',
    JSON.stringify({ ...initial, user: { ...user, name: 'مرحبا'.repeat(1000) } }),
  );
  assert.ok(values.size > 2, 'fixture must exercise real SDK chunking');
  global.fetch = async () =>
    new global.Response('{}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  const auth = load(
    path.join(root, 'src/lib/authClient.ts'),
    {
      ...native,
      '@better-auth/expo/client': expo,
      'expo-application': { applicationId: 'com.gizmolabs.openwhispr' },
      'expo-secure-store': storage,
      './sessionFetch': { sessionFetch: global.fetch },
      './apiClient': { getClientVersionHeader: () => 'test' },
    },
    process.argv[2],
  );
  if (rejected) {
    assert.equal(await auth.getSession({ allowOfflineCache: true }), null);
    assert.equal(
      await auth.getStoredSession(),
      'better-auth.session_token=fixture-token.signature',
    );
  } else {
    // A queued SDK write must complete before clearing this session's storage.
    const pendingWrite = adapter.setItemAsync(
      'openwhispr_cookie',
      JSON.stringify({
        'better-auth.session_token': {
          value: 'fixture-token.signature'.repeat(200),
          expires: null,
        },
      }),
    );
    await Promise.all([pendingWrite, auth.clearSession()]);
    assert.equal(await auth.getStoredSession(), null);
  }
  for (const [key, value] of values) {
    if (rejected && key.startsWith('openwhispr_cookie')) continue;
    assert.ok(value === '{}' || value === '', `${key}: all stored session chunks must be cleared`);
  }
  outcomes.push(
    rejected ? 'Rejected session clears chunks' : 'Explicit clear waits for SDK writes',
  );
}
(async () => {
  try {
    await checkChunkedClear();
    await checkChunkedClear({ rejected: true });
    for (const flow of ['email', 'signup', 'anonymous']) {
      await checkFreshLogin({ flow });
      await checkFreshLogin({ flow, sessionAvailable: false });
      await checkFreshLogin({ flow, platform: 'ios' });
      await checkFreshLogin({ flow, rejected: true });
      await checkFreshLogin({ flow, cookiePrefix: 'openwhispr' });
      await checkFreshLogin({ flow, platform: 'ios', cookiePrefix: 'openwhispr' });
    }
    await checkFreshLogin({ flow: 'signup', autoSignIn: false });
    await check('Android gateway preserves matching cache');
    await check('Explicit validation rejects gateway', { allowOfflineCache: false, throws: true });
    await check('iOS behavior unchanged', { platform: 'ios', expected: null });
    await check('Authoritative signed-out JSON', {
      contentType: 'application/json',
      body: 'null',
      expected: null,
    });
    await check('Rejected401', {
      status: 401,
      contentType: 'application/json',
      body: '{}',
      expected: null,
    });
    await check('Rejected403', {
      status: 403,
      contentType: 'application/json',
      body: '{}',
      expected: null,
    });
    await check('Transient503', { status: 503 });
    await check('Expired cache not restored', {
      cache: { ...initial, session: { ...initial.session, expiresAt: '2000-01-01T00:00:00Z' } },
      expected: null,
    });
    await check('Different cookie not restored', {
      cache: { ...initial, session: { ...initial.session, token: 'other-token' } },
      expected: null,
    });
    const online = { ...user, id: 'current-user' };
    await check('Online identity wins', {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ...initial, user: online }),
      expected: online,
    });
    console.log(JSON.stringify({ passed: outcomes.length, outcomes }));
  } finally {
    global.fetch = originalFetch;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
