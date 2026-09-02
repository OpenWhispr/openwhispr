const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};
const asyncNoop = async () => {};

async function createOnboardingRenderer(t, platform = "linux") {
  installBrowserGlobals(t, {
    window: { electronAPI: { getPlatform: () => platform } },
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
        export function getPlatform() { return "${platform}"; }
        export function getCachedPlatform() { return "${platform}"; }
      `,
      "/stores/settingsStore": `
        export function useSettingsStore() { return {}; }
        useSettingsStore.getState = () => ({});
      `,
      "/ui/ProviderIcon": `
        import React from "react";
        export function ProviderIcon() { return React.createElement("span"); }
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

const screenContext = {
  enabled: false,
  granted: false,
  needsRelaunch: false,
  request: async () => false,
};

test("Linux onboarding exposes labelled minimize, maximize, and close controls in both modes", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { default: OnboardingShell } = await vite.ssrLoadModule(
    "/components/onboarding/OnboardingShell.tsx"
  );

  for (const compact of [true, false]) {
    const mode = compact ? "compact" : "expanded";
    const markup = renderToStaticMarkup(
      React.createElement(OnboardingShell, { compact }, React.createElement("div"))
    );

    for (const control of ["minimize", "maximize", "close"]) {
      assert.match(
        markup,
        new RegExp(`title="windowControls\\.${control}"`),
        `${mode} ${control} title`
      );
      assert.match(
        markup,
        new RegExp(`aria-label="windowControls\\.${control}"`),
        `${mode} ${control} aria-label`
      );
    }
  }
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

test("permissions replaces Back with Logout, keeps Continue at the bottom, and gates it on microphone access", async (t) => {
  const vite = await createOnboardingRenderer(t, "darwin");
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const render = (micPermissionGranted, onLogout) =>
    renderToStaticMarkup(
      React.createElement(CompactPermissionsStep, {
        permissions: permissions({ micPermissionGranted }),
        systemAudio,
        screenContext,
        onLogout,
        onContinue: noop,
      })
    );

  const blocked = render(false, asyncNoop);
  assert.match(blocked, /relative flex h-full flex-col overflow-y-auto px-5 pb-6 pt-38/);
  assert.doesNotMatch(blocked, />common\.back<\/button>/);
  assert.match(blocked, /mt-auto flex w-full[^>]+>.*common\.logout.*common\.continue/s);
  assert.match(
    blocked,
    /disabled="" class="onboarding-pressable h-10 flex-1[^>]+>common\.continue/
  );
  assert.doesNotMatch(blocked, /fixed top-4/);

  const ready = render(true, asyncNoop);
  assert.match(ready, /class="onboarding-pressable h-10 flex-1[^>]+>common\.continue/);
  assert.doesNotMatch(ready, /disabled="" class="onboarding-pressable h-10 flex-1/);

  // Guests reach this step without ever signing in, so they get no Logout.
  const guest = render(true);
  assert.doesNotMatch(guest, /common\.logout/);
  assert.match(guest, /common\.continue/);
});

test("macOS onboarding offers optional Screen Context setup", async (t) => {
  const vite = await createOnboardingRenderer(t, "darwin");
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(CompactPermissionsStep, {
      permissions: permissions(),
      systemAudio,
      screenContext,
      onContinue: noop,
    })
  );

  assert.match(markup, /dictationAgent\.screenContext\.title/);
  assert.match(markup, /lucide-laptop/);
  assert.doesNotMatch(markup, /dictationAgent\.screenContext\.relaunchHint/);
});

test("macOS onboarding shows the Screen Context relaunch guidance when needed", async (t) => {
  const vite = await createOnboardingRenderer(t, "darwin");
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(CompactPermissionsStep, {
      permissions: permissions(),
      systemAudio,
      screenContext: {
        ...screenContext,
        enabled: true,
        granted: true,
        needsRelaunch: true,
      },
      onContinue: noop,
    })
  );

  assert.match(markup, /dictationAgent\.screenContext\.relaunchHint/);
  assert.match(markup, />onboarding\.rehaul\.permissions\.enabled<\/button>/);
});

test("macOS onboarding omits Screen Context when the flow does not offer it", async (t) => {
  const vite = await createOnboardingRenderer(t, "darwin");
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(CompactPermissionsStep, {
      permissions: permissions(),
      systemAudio,
      onContinue: noop,
    })
  );

  assert.doesNotMatch(markup, /dictationAgent\.screenContext\.title/);
});

test("Windows onboarding offers Screen Context as a permissionless opt-in", async (t) => {
  const vite = await createOnboardingRenderer(t, "win32");
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(CompactPermissionsStep, {
      permissions: permissions(),
      systemAudio,
      screenContext: {
        ...screenContext,
        enabled: true,
        granted: true,
      },
      onContinue: noop,
    })
  );

  assert.match(markup, /dictationAgent\.screenContext\.title/);
  assert.match(markup, /lucide-laptop/);
  assert.match(markup, />onboarding\.rehaul\.permissions\.enabled<\/button>/);
  assert.doesNotMatch(markup, /dictationAgent\.screenContext\.relaunchHint/);
});

test("Linux onboarding does not show Screen Context", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(CompactPermissionsStep, {
      permissions: permissions(),
      systemAudio,
      screenContext,
      onContinue: noop,
    })
  );

  assert.doesNotMatch(markup, /dictationAgent\.screenContext\.title/);
});

test("provider setup stages use one size and mark dictation complete before Assistant", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { SetupStageStepper } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  for (const stepId of ["byok-assistant", "local-assistant"]) {
    const markup = renderToStaticMarkup(React.createElement(SetupStageStepper, { stepId }));

    assert.match(markup, /\bw-40\b/);
    assert.match(markup, /\bsize-8\b/);
    assert.match(markup, /lucide-circle-check/);
    assert.doesNotMatch(markup, /lucide-audio-lines/);
  }
});
