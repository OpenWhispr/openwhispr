const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");
const {
  createRendererServer,
  installBrowserGlobals,
  installHappyDom,
} = require("../lib/rendererTestHarness");

const PRIVATE_SPACE = { id: 1, kind: "private", name: "Personal", sync_status: "synced" };

async function renderOverview(t, { lng, folder, space = PRIVATE_SPACE }) {
  installBrowserGlobals(t);
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng,
    fallbackLng: "en",
    resources: {
      ar: {
        translation: {
          meetingNotification: { folders: { private: "خاص" } },
          notes: { folders: { defaults: { meetings: "الاجتماعات" } } },
        },
      },
      en: {
        translation: {
          meetingNotification: { folders: { private: "Private" } },
          notes: { folders: { defaults: { meetings: "Meetings" } } },
        },
      },
    },
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: `openwhispr-container-overview-${lng}-`,
    mockModules: {
      "/stores/workspaceStore":
        "export const useWorkspaceStore = (selector) => selector({ workspaces: [] });",
      "/stores/noteStore": `
        export const useNotes = () => [];
        const containers = { "f:7": [], "f:8": [] };
        export const useNotesByContainer = () => containers;
        export const useFolders = () => [];
        export const useFolderCounts = () => ({});
        export const useSpaceRootCounts = () => ({});
        export const folderContainerKey = (id) => "f:" + id;
      `,
      "/hooks/useContainerChat": "export const useContainerChat = () => ({});",
      "/lib/capabilities":
        "export const spaceCan = () => false; export const workspaceCan = () => false;",
      "/InviteTeammateDialog": "export default function Mock() { return null; }",
      "/OverviewExplainerBanner": "export const OverviewExplainerBanner = () => null;",
      "/OverviewAskSection": "export const OverviewAskSection = () => null;",
      "/OverviewNoteList": "export const OverviewNoteList = () => null;",
    },
  });
  const { I18nextProvider } = await vite.ssrLoadModule("react-i18next");
  const { ContainerOverview } = await vite.ssrLoadModule(
    "/components/notes/overview/ContainerOverview.tsx"
  );
  const element = React.createElement(
    I18nextProvider,
    { i18n },
    React.createElement(ContainerOverview, {
      space,
      folder,
      onOpenNote: () => {},
      onNewNote: () => {},
    })
  );
  if (folder) return renderToStaticMarkup(element);
  const happyWindow = await installHappyDom(t);
  happyWindow.electronAPI = { getSpaceNotes: async () => [] };
  const { createRoot } = require("react-dom/client");
  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  await React.act(async () => root.render(element));
  const html = container.innerHTML;
  await React.act(async () => root.unmount());
  return html;
}

const meetingsFolder = { id: 7, space_id: 1, name: "Meetings", is_default: 1 };
const userFolder = { id: 8, space_id: 1, name: "Meetings", is_default: 0 };

test("overview heading localizes the canonical default folder under Arabic", async (t) => {
  const html = await renderOverview(t, { lng: "ar", folder: meetingsFolder });
  assert.match(html, /<h1[^>]*>الاجتماعات<\/h1>/);
  assert.equal(meetingsFolder.name, "Meetings");
});

test("overview heading keeps the English label for the canonical default folder", async (t) => {
  const html = await renderOverview(t, { lng: "en", folder: meetingsFolder });
  assert.match(html, /<h1[^>]*>Meetings<\/h1>/);
});

test("overview heading shows a user-authored folder verbatim under Arabic", async (t) => {
  const html = await renderOverview(t, { lng: "ar", folder: userFolder });
  assert.match(html, /<h1[^>]*>Meetings<\/h1>/);
});

test("Private overview translates its heading without changing team names", async (t) => {
  assert.match(await renderOverview(t, { lng: "ar", folder: null }), /<h1[^>]*>خاص<\/h1>/);
  assert.match(await renderOverview(t, { lng: "en", folder: null }), /<h1[^>]*>Private<\/h1>/);
  assert.match(
    await renderOverview(t, { lng: "ar", folder: null, space: { ...PRIVATE_SPACE, kind: "team" } }),
    /<h1[^>]*>Personal<\/h1>/
  );
});
