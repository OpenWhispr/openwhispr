const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountDialogFixture } = require("../lib/dialogMountFixture");

test("Settings modal returns focus to its invoker through the real Radix focus scope", async (t) => {
  const { dom, container, render, vite, settle } = await mountDialogFixture(t, {
    cachePrefix: "openwhispr-settings-a11y-modal-",
    noExternal: ["@radix-ui/react-dialog"],
  });
  const { default: SidebarModal } = await vite.ssrLoadModule("/components/ui/SidebarModal.tsx");
  function Host() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement("button", { onClick: () => setOpen(true) }, "Open Settings"),
      React.createElement(SidebarModal, {
        open,
        onOpenChange: setOpen,
        title: "Settings",
        sidebarItems: [{ id: "general", label: "General", icon: () => null }],
        activeSection: "general",
        onSectionChange() {},
        children: React.createElement("input", { "aria-label": "Content" }),
      })
    );
  }
  await render(React.createElement(Host));
  const invoker = container.querySelector("button");
  await React.act(async () => {
    invoker.focus();
    invoker.click();
  });
  const dialog = dom.document.querySelector('[role="dialog"]');
  assert.ok(dialog, "Radix content is mounted in its Portal");
  assert.equal(
    dom.document.activeElement,
    dialog,
    "opening focuses the dialog, not its close button"
  );
  assert.equal(
    dialog.querySelector('[data-section-id="general"]').getAttribute("aria-current"),
    "page"
  );
  await React.act(async () => dialog.querySelector("button").click());
  await settle();
  assert.equal(dom.document.querySelector('[role="dialog"]'), null);
  assert.equal(
    dom.document.activeElement,
    invoker,
    "delayed Radix close autofocus restores the actual invoker"
  );
});

test("shared provider choices announce their selection without claiming tab keyboard semantics", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-a11y-choices-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t: (key) => key }; }`,
      "./ProviderIcon": `export const ProviderIcon = () => null;`,
    },
  });
  const { ProviderTabs } = await vite.ssrLoadModule("/components/ui/ProviderTabs.tsx");
  const html = renderToStaticMarkup(
    React.createElement(ProviderTabs, {
      providers: [
        { id: "local", name: "Local" },
        { id: "cloud", name: "Cloud", disabled: true },
      ],
      selectedId: "local",
      onSelect() {},
    })
  );
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-pressed="false"/);
  assert.doesNotMatch(html, /role="tab"/);
  assert.match(html, /focus-visible:ring/);
});

test("microphone controls have names without starting a device scan", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-a11y-mic-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t: (key) => key }; }`,
      "../icons": `export const RefreshCw = () => null; export const Mic = () => null;`,
      "/stores/settingsStore": `export const MIC_WARM_HOLD_CHOICES = [0];`,
    },
  });
  const { MicrophoneSettings } = await vite.ssrLoadModule("/components/ui/MicrophoneSettings.tsx");
  const html = renderToStaticMarkup(
    React.createElement(MicrophoneSettings, {
      microphoneSelectionMode: "system",
      selectedMicDeviceId: "",
      selectedMicDeviceLabel: "",
      micWarmHoldSeconds: 0,
      onSelectionModeChange() {},
      onDeviceSelect() {},
      onMicWarmHoldSecondsChange() {},
    })
  );
  const { dom } = await mountDialogFixture(t, { cachePrefix: "openwhispr-settings-a11y-mic-" });
  dom.document.body.innerHTML = html;
  const labelId = dom.document
    .querySelector("select[aria-labelledby]")
    .getAttribute("aria-labelledby");
  assert.ok(labelId);
  assert.equal(dom.document.getElementById(labelId)?.textContent, "microphoneSettings.inputDevice");
  assert.match(html, /aria-label="common.refresh"/);
  assert.match(html, /aria-label="microphoneSettings.warmHold.label"/);
});
