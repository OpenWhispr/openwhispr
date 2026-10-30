const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

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

test("an open password dialog becomes read-only and refuses submission", async (t) => {
  let root;
  t.after(() => act(() => root?.unmount()));
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const submissions = [];
  globalThis.__profileSubmissions = submissions;
  t.after(() => delete globalThis.__profileSubmissions);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-profile-section-",
    mockModules: {
      "/lib/auth": `
        export const changePassword = async (data) => {
          globalThis.__profileSubmissions.push(data);
          return {};
        };
        export const hasCredentialAccount = async () => true;
        export const updateDisplayName = async () => ({});
      `,
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "/ui/useToast": "export const useToast = () => ({ toast() {} });",
      "/ui/dialog": `
        import { createElement } from "react";
        const passthrough = (props) => createElement("div", null, props.children);
        export const Dialog = (props) => props.open ? props.children : null;
        export const DialogContent = passthrough;
        export const DialogHeader = passthrough;
        export const DialogTitle = passthrough;
        export const DialogDescription = passthrough;
        export const DialogFooter = passthrough;
      `,
    },
  });
  const { default: ProfileSection } = await vite.ssrLoadModule(
    "/components/settings/ProfileSection.tsx"
  );
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  const render = (readOnly) =>
    act(async () =>
      root.render(createElement(ProfileSection, { name: "Ada", readOnly, onSessionRefresh() {} }))
    );
  await render(false);
  const opener = findElement(
    container,
    (node) =>
      node.tagName === "BUTTON" &&
      node.textContent.includes("settingsPage.account.profile.password.change")
  );
  assert.equal(opener.getAttribute("disabled"), null);
  await act(async () => opener.dispatchEvent({ type: "click", bubbles: true, button: 0 }));
  const passwords = [
    ["profile-current-password", "old-password"],
    ["profile-new-password", "new-password"],
    ["profile-confirm-password", "new-password"],
  ];
  const field = (id) => findElement(container, (node) => node.getAttribute("id") === id);
  for (const [id, value] of passwords) {
    await act(async () => {
      const input = field(id);
      input.value = value;
      input.dispatchEvent({ type: "input", bubbles: true });
    });
  }
  const submitButton = findElement(container, (node) => node.getAttribute("type") === "submit");
  assert.equal(submitButton.getAttribute("disabled"), null);

  await render(true);
  assert.equal(submitButton.getAttribute("disabled"), "");
  for (const [id] of passwords) {
    assert.equal(field(id).getAttribute("disabled"), "");
  }
  const checkbox = findElement(container, (node) => node.type === "checkbox");
  assert.equal(checkbox.getAttribute("disabled"), "");
  const form = findElement(container, (node) => node.tagName === "FORM");
  await act(async () => form.dispatchEvent({ type: "submit", bubbles: true, preventDefault() {} }));
  assert.deepEqual(submissions, []);

  await render(false);
  await act(async () => form.dispatchEvent({ type: "submit", bubbles: true, preventDefault() {} }));
  assert.deepEqual(submissions, [
    { currentPassword: "old-password", newPassword: "new-password", revokeOtherSessions: true },
  ]);
});
