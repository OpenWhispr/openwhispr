const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function statusMessages(node) {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(statusMessages);
  if (!node.props) return [];
  return [
    ...(node.props.role === "status" ? [node.props.children] : []),
    ...statusMessages(node.props.children),
  ];
}

test("upload policy feedback names the disabled feature independently of recording and updates without a reload", async (t) => {
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "ow-upload-policy-feedback-",
    mockModules: {
      "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: false, user: null });`,
      "/hooks/useUsage": `export const useUsage = () => null;`,
      "/hooks/useSettings": `export const useSettings = () => ({});`,
      "/lib/auth": `export const withSessionRefresh = fn => fn();`,
      "/utils/generateTitle": `export const generateNoteTitle = async () => "";`,
    },
  });
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  const { default: UploadAudioView } = await vite.ssrLoadModule(
    "/components/notes/UploadAudioView.tsx"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const scope = {
    allowedModes: ["openwhispr", "providers", "local", "self-hosted", "enterprise"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: ["azure"],
  };
  const policy = {
    version: 1,
    transcription: scope,
    llm: scope,
    features: {},
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
      audioRetentionMaxDays: null,
    },
    requiredLocalModels: [],
    minAppVersion: null,
  };
  let tree;
  function Harness() {
    tree = UploadAudioView({ onNoteCreated() {} });
    return null;
  }
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    for (const meetingRecordingEnabled of [true, false]) {
      for (const audioUploadEnabled of [false, true]) {
        await React.act(async () =>
          usePolicyStore.setState({
            status: "managed",
            policy: { ...policy, features: { meetingRecordingEnabled, audioUploadEnabled } },
          })
        );
        assert.equal(
          statusMessages(tree).includes("Audio upload is disabled by your organization."),
          !audioUploadEnabled
        );
        assert.ok(
          !statusMessages(tree).includes("Meeting recording is disabled by your organization.")
        );
      }
    }
    for (const status of ["loading", "error"]) {
      await React.act(async () => usePolicyStore.setState({ status, policy: null }));
      assert.ok(
        statusMessages(tree).includes(
          "Your organization's settings haven't loaded yet. Try again in a moment."
        )
      );
      assert.ok(!statusMessages(tree).includes("Audio upload is disabled by your organization."));
    }
    await React.act(async () => usePolicyStore.setState({ status: "unmanaged", policy: null }));
    assert.deepEqual(statusMessages(tree), []);
  } finally {
    await React.act(async () => root.unmount());
  }
});
