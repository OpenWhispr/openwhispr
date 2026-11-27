const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

const baseSettings = {
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  useCleanupModel: true,
  cleanupMode: "local",
  useDictationAgent: false,
  dictationAgentMode: "openwhispr",
};

for (const scenario of [
  {
    name: "active Whisper Vulkan with a missing local cleanup pack",
    whisperDownloaded: true,
    intelligenceDownloaded: false,
    title: "GPU acceleration available for local AI",
    description:
      "Speed up local AI processing with a separate GPU pack from Whisper transcription.",
  },
  {
    name: "a local dictation agent without local cleanup",
    whisperDownloaded: true,
    intelligenceDownloaded: false,
    settings: { useCleanupModel: false, useDictationAgent: true, dictationAgentMode: "local" },
    title: "GPU acceleration available for local AI",
    description:
      "Speed up local AI processing with a separate GPU pack from Whisper transcription.",
  },
  {
    name: "a missing Whisper pack with cloud intelligence",
    whisperDownloaded: false,
    intelligenceDownloaded: true,
    settings: { cleanupMode: "openwhispr" },
    title: "GPU acceleration available for transcription",
    description: "Speed up local Whisper transcription with GPU acceleration.",
  },
  {
    name: "both local GPU packs missing",
    whisperDownloaded: false,
    intelligenceDownloaded: false,
    title: "GPU acceleration available for transcription and local AI",
    description:
      "Enable GPU packs for local Whisper transcription and local AI processing in Settings.",
  },
  {
    name: "both local GPU packs ready",
    whisperDownloaded: true,
    intelligenceDownloaded: true,
    title: "",
    description: "",
  },
]) {
  test(`GPU banner describes ${scenario.name}`, async (t) => {
    let root;
    t.after(async () => {
      if (root) await React.act(async () => root.unmount());
    });
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          async getCudaWhisperStatus() {
            return { downloaded: false, gpuInfo: { hasNvidiaGpu: false } };
          },
          async getVulkanWhisperStatus() {
            return { downloaded: scenario.whisperDownloaded, vulkan: { available: true } };
          },
          async detectVulkanGpu() {
            return { available: true };
          },
          async getLlamaVulkanStatus() {
            return { downloaded: scenario.intelligenceDownloaded };
          },
        },
      },
    });
    const container = installHostDom(t);
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-gpu-banner-message-",
      noExternal: ["react-i18next"],
      mockModules: {
        "react-i18next": `
          import en from "/locales/en/translation.json";
          export function useTranslation() {
            return { t: key => key.split(".").reduce((node, part) => node?.[part], en) ?? key };
          }
        `,
      },
    });
    const { useGpuBannerAvailability } = await vite.ssrLoadModule(
      "/hooks/useGpuBannerAvailability.ts"
    );
    const { default: GpuBannerMessage } = await vite.ssrLoadModule(
      "/components/GpuBannerMessage.tsx"
    );
    const settings = { ...baseSettings, ...scenario.settings };
    function Harness() {
      const offers = useGpuBannerAvailability({
        settings,
        agentAllowedByPolicy: true,
        dismissed: false,
        settingsOpen: false,
        platform: "linux",
      });
      return offers.transcription || offers.intelligence
        ? React.createElement(GpuBannerMessage, { offers })
        : null;
    }
    root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(container.childNodes[0]?.textContent ?? "", scenario.title);
    assert.equal(container.childNodes[1]?.textContent ?? "", scenario.description);
  });
}
