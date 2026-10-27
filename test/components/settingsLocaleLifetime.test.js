const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createInstance } = require("i18next");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("changing language translates SettingsModal and Speech labels while keeping Upload selected", async (t) => {
  let modalRoot;
  let speechRoot;
  t.after(async () => {
    if (modalRoot || speechRoot) {
      await React.act(async () => {
        modalRoot?.unmount();
        speechRoot?.unmount();
      });
    }
    for (const key of ["__localeSidebar", "__speechTabs", "__speechSelect"]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t);
  const modalContainer = installHostDom(t);
  const speechContainer = globalThis.document.createElement("div");
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: {
        translation: {
          settingsModal: { title: "Settings", sections: { speechToText: { label: "Speech" } } },
          settingsPage: {
            speechToText: {
              title: "Speech",
              tabs: { dictation: "Dictation", noteRecording: "Meeting", upload: "Upload" },
            },
          },
        },
      },
      es: {
        translation: {
          settingsModal: { title: "Ajustes", sections: { speechToText: { label: "Voz" } } },
          settingsPage: {
            speechToText: {
              title: "Voz",
              tabs: { dictation: "Dictado", noteRecording: "Reunión", upload: "Subir" },
            },
          },
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-locale-lifetime-",
    mockModules: {
      "./icons": `
        export const Sliders = () => null; export const Mic = () => null;
        export const Brain = () => null; export const UserCircle = () => null;
        export const Wrench = () => null; export const Keyboard = () => null;
        export const CreditCard = () => null; export const Shield = () => null;
        export const ShieldCheck = () => null; export const Users = () => null;
      `,
      "../icons": `
        export const Mic = () => null; export const FileAudio = () => null;
        export const Upload = () => null;
      `,
      "./SettingsPage": `
        export function AccountAvatar() { return null; }
        export default function SettingsPage() { return null; }
      `,
      "./ui/SidebarModal": `
        import React from "react";
        export default function SidebarModal({children, title, sidebarItems, activeSection}) {
          globalThis.__localeSidebar = { title, sidebarItems, activeSection };
          return React.createElement("div", null, title, children);
        }
      `,
      "/hooks/useAuth": `export function useAuth() { return { isSignedIn: true, user: null }; }`,
      "/stores/policyStore": `export function usePolicyStore(selector) { return selector({ managed: false }); }`,
      "/ui/ProviderTabs": `
        export function ProviderTabs({providers, selectedId, onSelect}) {
          globalThis.__speechTabs = { providers, selectedId };
          globalThis.__speechSelect = onSelect;
          return null;
        }
      `,
    },
  });
  const { I18nextProvider } = await vite.ssrLoadModule("react-i18next");
  const { default: SettingsModal } = await vite.ssrLoadModule("/components/SettingsModal.tsx");
  const { default: SpeechToTextTabs } = await vite.ssrLoadModule(
    "/components/settings/SpeechToTextTabs.tsx"
  );
  const wrap = (child) => React.createElement(I18nextProvider, { i18n }, child);
  const { createSettingsNavigationStore } = await vite.ssrLoadModule(
    "/stores/settingsNavigationStore.ts"
  );
  const navigation = createSettingsNavigationStore("speechToText");
  await React.act(async () => {
    modalRoot = createRoot(modalContainer);
    modalRoot.render(
      wrap(
        React.createElement(SettingsModal, {
          navigation,
          onOpenChange() {},
        })
      )
    );
    speechRoot = createRoot(speechContainer);
    speechRoot.render(
      wrap(
        React.createElement(SpeechToTextTabs, {
          navigation,
          dictation: React.createElement("span", null, "Dictation"),
          noteRecording: React.createElement("span", null, "Meeting"),
          upload: React.createElement("span", null, "Upload"),
        })
      )
    );
  });
  assert.equal(globalThis.__localeSidebar.title, "Settings");
  assert.equal(globalThis.__localeSidebar.activeSection, "speechToText");
  assert.equal(globalThis.__speechTabs.providers[2].name, "Upload");
  await React.act(async () => globalThis.__speechSelect("upload"));

  await React.act(async () => i18n.changeLanguage("es"));
  assert.equal(globalThis.__localeSidebar.title, "Ajustes");
  assert.equal(
    globalThis.__localeSidebar.sidebarItems.find((item) => item.id === "speechToText").label,
    "Voz"
  );
  assert.equal(globalThis.__localeSidebar.activeSection, "speechToText");
  assert.equal(globalThis.__speechTabs.providers[2].name, "Subir");
  assert.equal(globalThis.__speechTabs.selectedId, "upload");
});
