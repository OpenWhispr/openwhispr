const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const en = require("../../src/locales/en/translation.json");

const SPACE = { id: 1, kind: "private", name: "Personal", sync_status: "synced" };
const folder = (id, name, parent_folder_id = null, space_id = 1) => ({
  id,
  name,
  is_default: 0,
  space_id,
  parent_folder_id,
});
const WORK = folder(7, "Work");
const Q1 = folder(8, "Q1", 7);
const FOLDERS = [Q1, WORK, folder(9, "Elsewhere", 7, 2), folder(10, "Home"), folder(11, "Q2", 10)];

async function renderOverview(t, overviewFolder) {
  installBrowserGlobals(t);
  t.after(() => delete globalThis.__chatOptions);
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-container-overview-subfolders-",
    mockModules: {
      "/stores/workspaceStore":
        "export const useWorkspaceStore = (selector) => selector({ workspaces: [] });",
      "/stores/noteStore": `
        export const useNotes = () => [];
        export const useNotesByContainer = () => ({ "f:7": [], "f:8": [] });
        export const useFolders = () => ${JSON.stringify(FOLDERS)};
        export const useFolderCounts = () => ({ 7: 1, 8: 3 });
        export const useSpaceRootCounts = () => ({});
        export const folderContainerKey = (id) => "f:" + id;
        export const navigateToContainer = () => {};
      `,
      "/hooks/useContainerChat": `
        export const useContainerChat = (options) => {
          globalThis.__chatOptions = options;
          return {};
        };
      `,
      "/lib/capabilities":
        "export const spaceCan = () => false; export const workspaceCan = () => false;",
      "/InviteTeammateDialog": "export default function Mock() { return null; }",
      "/OverviewExplainerBanner": "export const OverviewExplainerBanner = () => null;",
      "/OverviewAskSection": "export const OverviewAskSection = () => null;",
      "/OverviewNoteList": `
        import { createElement } from "react";
        export const OverviewNoteList = () => createElement("div", { "data-note-list": "" });
      `,
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
        space: SPACE,
        folder: overviewFolder,
        onOpenNote: () => {},
        onNewNote: () => {},
      })
    )
  );
}

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("a parent folder lists its own subfolders above its notes, with direct counts", async (t) => {
  const html = await renderOverview(t, WORK);

  assert.match(text(html), /these notes\. 1 note Subfolders Q1 3 notes/);
  assert.ok(html.indexOf("Subfolders") < html.indexOf("data-note-list"));
  assert.doesNotMatch(html, /Elsewhere|Q2/);
});

test("a subfolder shows no subfolder list and names its parent to the chat", async (t) => {
  const html = await renderOverview(t, Q1);

  assert.doesNotMatch(html, /Subfolders/);
  assert.equal(globalThis.__chatOptions.folderLabel, "Work / Q1");
});
