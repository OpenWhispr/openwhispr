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
    // The banner's text sits beside its icon.
    ...(node.props.role === "status"
      ? [node.props.children].flat().filter((child) => typeof child === "string")
      : []),
    ...statusMessages(node.props.children),
  ];
}

function findProps(node, match) {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProps(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!node.props) return null;
  return match(node.props) ? node.props : findProps(node.props.children, match);
}

// The drop zone, and the URL field with its submit, follow the org's upload switch.
function uploadInputs(tree) {
  const banner = findProps(tree, (props) => props.role === "status");
  const dropZone = findProps(tree, (props) => "handleBrowse" in props);
  const url = findProps(tree, (props) => props.type === "url");
  return {
    disabled: [dropZone.disabled, url.disabled],
    describedBy: [dropZone.describedBy, url["aria-describedby"]],
    bannerId: banner?.id,
  };
}

test("upload policy feedback names the disabled feature independently of recording and updates without a reload", async (t) => {
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "ow-upload-policy-feedback-",
    mockModules: {
      // Signed in to OpenWhispr Cloud, so the provider is ready and the inputs render.
      "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: true, user: null });`,
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
        const inputs = uploadInputs(tree);
        assert.deepEqual(inputs.disabled, [!audioUploadEnabled, !audioUploadEnabled]);
        assert.deepEqual(
          inputs.describedBy,
          audioUploadEnabled ? [undefined, undefined] : [inputs.bannerId, inputs.bannerId]
        );
        if (!audioUploadEnabled) assert.ok(inputs.bannerId, "the banner is the description");
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
