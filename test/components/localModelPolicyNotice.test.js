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
});
