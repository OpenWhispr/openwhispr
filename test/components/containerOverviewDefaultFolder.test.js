const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const PRIVATE_SPACE = { id: 1, kind: "private", name: "Personal", sync_status: "synced" };

async function renderOverview(t, { lng, folder }) {
  installBrowserGlobals(t);
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng,
    fallbackLng: "en",
    resources: {
      ar: { translation: { notes: { folders: { defaults: { meetings: "الاجتماعات" } } } } },
      en: { translation: { notes: { folders: { defaults: { meetings: "Meetings" } } } } },
    },
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: `openwhispr-container-overview-${lng}-`,
    mockModules: {
      "/stores/workspaceStore": "export const useWorkspaceStore = (selector) => selector({ workspaces: [] });",
      "/stores/noteStore": `
        export const useNotes = () => [];
        export const useNotesByContainer = () => ({});
        export const useFolders = () => [];
        export const useFolderCounts = () => ({});
        export const useSpaceRootCounts = () => ({});
      `,
      "/hooks/useContainerChat": "export const useContainerChat = () => ({});",
      "/lib/spacePermissions": "export const canManageSpace = () => false;",
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
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(ContainerOverview, {
        space: PRIVATE_SPACE,
        folder,
        onOpenNote: () => {},
        onNewNote: () => {},
      })
    )
  );
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
