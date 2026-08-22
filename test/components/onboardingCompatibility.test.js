const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};
const asyncNoop = async () => {};

async function createOnboardingRenderer(t) {
  installBrowserGlobals(t, {
    window: { electronAPI: { getPlatform: () => "linux" } },
  });
  return createRendererServer(t, {
    cachePrefix: "openwhispr-onboarding-compatibility-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key; } };
        }
      `,
      "onboarding-hero-dither.webp": `export default "hero-light.webp";`,
      "onboarding-hero-dither-dark.webp": `export default "hero-dark.webp";`,
      "onboarding-bg-light.svg": `export default "background-light.svg";`,
      "onboarding-bg-dark.svg": `export default "background-dark.svg";`,
      "onboarding-permission-microphone.webp": `export default "microphone.webp";`,
      "onboarding-permission-accessibility.webp": `export default "accessibility.webp";`,
      "onboarding-permission-system-audio.webp": `export default "system-audio.webp";`,
      "/utils/platform": `
        export function getPlatform() { return "linux"; }
        export function getCachedPlatform() { return "linux"; }
      `,
    },
  });
}

function permissions(overrides = {}) {
  return {
    micPermissionGranted: false,
    accessibilityPermissionGranted: false,
    micPermissionError: null,
    pasteToolsInfo: null,
    isCheckingPasteTools: false,
    accessibilityTroubleshooting: false,
    requestMicPermission: asyncNoop,
    requestAccessibilityPermission: asyncNoop,
    checkPasteToolsAvailability: async () => null,
    openMicPrivacySettings: asyncNoop,
    openSoundInputSettings: asyncNoop,
    setMicPermissionGranted: noop,
    setAccessibilityPermissionGranted: noop,
    ...overrides,
  };
}

const systemAudio = {
  granted: false,
  mode: "portal",
  supportsOnboardingGrant: false,
  request: async () => false,
};

test("compact Linux onboarding keeps minimize and close controls", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { default: OnboardingShell } = await vite.ssrLoadModule(
    "/components/onboarding/OnboardingShell.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(OnboardingShell, { compact: true }, React.createElement("div"))
  );

  assert.match(markup, /title="windowControls.minimize"/);
  assert.match(markup, /title="windowControls.close"/);
});

test("expanded Linux onboarding keeps maximize alongside minimize and close", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { default: OnboardingShell } = await vite.ssrLoadModule(
    "/components/onboarding/OnboardingShell.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(OnboardingShell, null, React.createElement("div"))
  );

  assert.match(markup, /title="windowControls.minimize"/);
  assert.match(markup, /title="windowControls.maximize"/);
  assert.match(markup, /title="windowControls.close"/);
});

test("a denied microphone exposes the existing Linux settings recovery", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(CompactPermissionsStep, {
      permissions: permissions({ micPermissionError: "Microphone blocked by the OS" }),
      systemAudio,
      onContinue: noop,
    })
  );

  assert.match(markup, /Microphone blocked by the OS/);
  assert.match(markup, />hooks.permissions.warning.soundLabel<\/button>/);
});

test("Linux onboarding shows paste-tool installation and recheck guidance", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(CompactPermissionsStep, {
      permissions: permissions({
        pasteToolsInfo: {
          platform: "linux",
          available: false,
          method: null,
          requiresPermission: false,
          isWayland: false,
          isWlroots: false,
          hasWtype: false,
          recommendedInstall: "xdotool",
        },
      }),
      systemAudio,
      onContinue: noop,
    })
  );

  assert.match(markup, /sudo apt install xdotool/);
  assert.match(markup, />pasteToolsInfo.recheck<\/button>/);
});
