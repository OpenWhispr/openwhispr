const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

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

// The count caps the speakers the local diarizer finds. A provider that labels the speakers
// itself is never sent it, so the field would offer a cap that nothing applies.
test("the speaker count is offered only when the local diarizer labels the upload", async (t) => {
  let root;
  t.after(async () => {
    await React.act(async () => root?.unmount());
  });
  installBrowserGlobals(t, {
    // Speaker detection is on and the local speaker models are on disk.
    initialStorage: { uploadDiarizationEnabled: "true" },
    window: {
      electronAPI: { getDiarizationModelStatus: async () => ({ modelsDownloaded: true }) },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "ow-upload-speaker-count-",
    mockModules: {
      "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: true, user: null });`,
      "/hooks/useUsage": `export const useUsage = () => null;`,
      "/hooks/useSettings": `export const useSettings = () => ({});`,
      "/ui/useToast": `export const useToast = () => ({ toast() {} });`,
      "/lib/auth": `export const withSessionRefresh = fn => fn();`,
      "/utils/generateTitle": `export const generateNoteTitle = async () => "";`,
    },
  });
  const { default: UploadAudioView } = await vite.ssrLoadModule(
    "/components/notes/UploadAudioView.tsx"
  );
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  let tree;
  function Harness() {
    tree = UploadAudioView({ onNoteCreated() {} });
    return null;
  }
  const offersCount = async (settings) => {
    await React.act(async () => useSettingsStore.setState(settings));
    return findProps(tree, (props) => props.id === "upload-num-speakers") !== null;
  };

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(
    await offersCount({ uploadTranscriptionMode: "local", uploadUseLocalWhisper: true }),
    true
  );
  for (const provider of ["groq", "openai", "mistral", "elevenlabs"]) {
    const offered = await offersCount({
      uploadTranscriptionMode: "providers",
      uploadUseLocalWhisper: false,
      uploadCloudTranscriptionMode: "byok",
      uploadCloudTranscriptionProvider: provider,
    });
    // Groq labels no speakers, so its uploads still go through the local diarizer.
    assert.equal(offered, provider === "groq", provider);
  }
});
