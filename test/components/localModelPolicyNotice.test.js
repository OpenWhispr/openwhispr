const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("policy notices distinguish empty, unknown-only, and mixed approvals", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-notice-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t: (key) => key }; }`,
      "/hooks/usePolicy": `let policy; export function setPolicy(value) { policy = value; } export function usePolicySnapshot() { return policy; }`,
    },
  });
  const { setPolicy } = await vite.ssrLoadModule("/hooks/usePolicy");
  const { LocalModelPolicyNotice } = await vite.ssrLoadModule(
    "/components/ui/LocalModelPolicyNotice.tsx"
  );
  for (const fixture of [
    { ids: [], supported: false, message: "models.policy.emptyIntersection" },
    { ids: ["future-speech-model"], supported: false, message: "models.policy.noneSupported" },
    { ids: ["future-speech-model", "base"], supported: true, message: "models.policy.guidance" },
  ]) {
    setPolicy({
      status: "managed",
      appVersion: "1.11.1",
      policy: {
        transcription: { allowedModes: ["local"], allowedLocalModels: fixture.ids },
        minAppVersion: null,
      },
    });
    const notice = LocalModelPolicyNotice({
      scope: "transcription",
      hasSupportedModel: fixture.supported,
    });
    assert.equal(notice.props.children, fixture.message);
  }

  const managed = (transcription) => ({
    status: "managed",
    appVersion: "1.11.1",
    policy: { transcription, minAppVersion: null },
  });
  const render = (hasSupportedModel = true) =>
    LocalModelPolicyNotice({ scope: "transcription", hasSupportedModel });

  // Nothing is restricted, so there is no approved model to tell the member to choose.
  setPolicy(managed({ allowedModes: ["local"], allowedLocalModels: null }));
  assert.equal(render(), null);
  assert.equal(render(false), null);

  // A policy on its way is not a failure to resolve one.
  setPolicy({ status: "loading", appVersion: null, policy: null });
  assert.equal(render(), null);

  setPolicy({ status: "error", appVersion: null, policy: null });
  assert.equal(render().props.children, "models.policy.unresolved");

  setPolicy(managed({ allowedModes: [], allowedLocalModels: ["base"] }));
  assert.equal(render().props.children, "models.policy.modeBlocked");

  setPolicy({
    status: "managed",
    appVersion: "1.0.0",
    policy: {
      transcription: { allowedModes: ["local"], allowedLocalModels: null },
      minAppVersion: "1.11.1",
    },
  });
  assert.equal(render().props.children, "models.policy.versionBlocked");
});
