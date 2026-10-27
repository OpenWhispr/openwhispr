const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadProfileSection(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-profile-section-",
    mockModules: {
      "/lib/auth": `
        export const changePassword = async () => ({});
        export const hasCredentialAccount = async () => true;
        export const updateDisplayName = async () => ({});
      `,
      "/ui/useToast": "export const useToast = () => ({ toast() {} });",
    },
  });
  const { default: ProfileSection } = await vite.ssrLoadModule(
    "/components/settings/ProfileSection.tsx"
  );
  return (props) =>
    renderToStaticMarkup(
      createElement(ProfileSection, { name: "Ada", onSessionRefresh() {}, ...props })
    );
}

const nameInput = (markup) => markup.match(/<input[^>]*aria-label="[^"]*name\.label"[^>]*>/)[0];

test("only a validated account can edit its name", async (t) => {
  const render = await loadProfileSection(t);

  assert.match(nameInput(render({ readOnly: true })), /disabled=""/);
  assert.doesNotMatch(nameInput(render({})), /disabled=""/);
});
