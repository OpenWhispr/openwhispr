const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");
const { findElement } = require("../lib/interactiveDom");

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
  const container = installHostDom(t);
  const state = { buttons: [], inputs: new Map(), submissions: [], submit: null };
  globalThis.__profileTest = state;
  t.after(() => delete globalThis.__profileTest);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-profile-section-",
    mockModules: {
      "/lib/auth": `
        export const changePassword = async (data) => {
          globalThis.__profileTest.submissions.push(data);
          return {};
        };
        export const hasCredentialAccount = async () => true;
        export const updateDisplayName = async () => ({});
      `,
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "/ui/useToast": "export const useToast = () => ({ toast() {} });",
      "/ui/input": `
        import { createElement } from "react";
        export const Input = (props) => {
          globalThis.__profileTest.inputs.set(props.id, props);
          return createElement("input", props);
        };
      `,
      "/ui/button": `
        import { createElement } from "react";
        export const Button = (props) => {
          globalThis.__profileTest.buttons.push(props);
          return createElement("button", props);
        };
      `,
      "/ui/dialog": `
        import { createElement } from "react";
        const passthrough = (props) => createElement("div", null, props.children);
        export const Dialog = (props) => props.open ? props.children : null;
        export const DialogContent = (props) => {
          globalThis.__profileTest.submit = props.children.props.onSubmit;
          return passthrough(props);
        };
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
  root = createRoot(container);
  const render = (readOnly) =>
    act(async () =>
      root.render(createElement(ProfileSection, { name: "Ada", readOnly, onSessionRefresh() {} }))
    );
  await render(false);
  const opener = state.buttons.findLast((props) =>
    props.children?.includes?.("settingsPage.account.profile.password.change")
  );
  assert.equal(opener.disabled, false);
  await act(async () => opener.onClick());
  for (const [id, value] of [
    ["profile-current-password", "old-password"],
    ["profile-new-password", "new-password"],
    ["profile-confirm-password", "new-password"],
  ]) {
    await act(async () => state.inputs.get(id).onChange({ target: { value } }));
  }
  const submitButton = () => state.buttons.findLast((props) => props.type === "submit");
  assert.equal(submitButton().disabled, false);

  await render(true);
  assert.equal(submitButton().disabled, true);
  for (const id of [
    "profile-current-password",
    "profile-new-password",
    "profile-confirm-password",
  ]) {
    assert.equal(state.inputs.get(id).disabled, true);
  }
  const checkbox = findElement(container, (node) => node.type === "checkbox");
  assert.equal(checkbox.hasAttribute("disabled"), true);
  await act(async () => state.submit({ preventDefault() {} }));
  assert.deepEqual(state.submissions, []);

  await render(false);
  await act(async () => state.submit({ preventDefault() {} }));
  assert.deepEqual(state.submissions, [
    { currentPassword: "old-password", newPassword: "new-password", revokeOtherSessions: true },
  ]);
});
