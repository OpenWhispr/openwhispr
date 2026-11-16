const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const ADMIN = { user_id: "u-admin", name: "Adam Admin", email: "adam@example.com", role: "admin" };
const MEMBER = {
  user_id: "u-member",
  name: "Mia Member",
  email: "mia@example.com",
  role: "member",
};
const OWNER = {
  user_id: "u-owner",
  name: "Olivia Owner",
  email: "olivia@example.com",
  role: "owner",
};

async function loadRoleMenu(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-member-role-menu-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/ui/dropdown-menu": `
        import React from "react";
        const h = React.createElement;
        const passThrough = ({ children }) => h(React.Fragment, null, children);
        export const DropdownMenu = passThrough;
        export const DropdownMenuContent = passThrough;
        export const DropdownMenuTrigger = ({ children, disabled, "aria-label": label }) =>
          h("button", { "data-role-trigger": "", disabled, "aria-label": label }, children);
        export const DropdownMenuRadioGroup = ({ children, value, onValueChange }) => {
          globalThis.__roleValueChange = onValueChange;
          return h("div", { "data-checked-role": value }, children);
        };
        export const DropdownMenuRadioItem = ({ children, value }) =>
          h("div", { role: "menuitemradio", "data-role": value }, children);
        export const DropdownMenuSeparator = () => h("hr");
        export const DropdownMenuItem = ({ children }) =>
          h("div", { role: "menuitem" }, children);
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/settings/MemberRoleMenu.tsx");
  t.after(() => {
    delete globalThis.__roleValueChange;
  });
  return module.MemberRoleMenu;
}

function render(MemberRoleMenu, props) {
  return renderToStaticMarkup(
    React.createElement(MemberRoleMenu, {
      isSelf: false,
      canManage: true,
      canTransfer: false,
      pending: false,
      onRoleChange: () => {},
      onTransfer: () => {},
      onRemove: () => {},
      ...props,
    })
  );
}

test("owner row and your own row have no role menu", async (t) => {
  const MemberRoleMenu = await loadRoleMenu(t);

  const owner = render(MemberRoleMenu, { member: OWNER, canTransfer: true });
  assert.doesNotMatch(owner, /data-role-trigger/);
  assert.doesNotMatch(owner, /role="menuitem/);
  assert.match(owner, /settingsPage\.workspace\.role\.owner/);

  const self = render(MemberRoleMenu, { member: ADMIN, isSelf: true });
  assert.doesNotMatch(self, /data-role-trigger/);
  assert.match(self, /settingsPage\.workspace\.role\.admin/);

  const viewOnly = render(MemberRoleMenu, { member: MEMBER, canManage: false });
  assert.doesNotMatch(viewOnly, /data-role-trigger/);
  assert.match(viewOnly, /settingsPage\.workspace\.role\.member/);
});

test("role menu offers Member and Admin with descriptions and no Editor", async (t) => {
  const MemberRoleMenu = await loadRoleMenu(t);
  const markup = render(MemberRoleMenu, { member: MEMBER });

  assert.match(markup, /data-role-trigger/);
  assert.match(markup, /aria-label="settingsPage\.workspace\.people\.roleMenuLabel"/);
  assert.match(markup, /data-checked-role="member"/);
  const roles = [...markup.matchAll(/data-role="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(roles, ["member", "admin"]);
  assert.match(markup, /settingsPage\.workspace\.people\.roleDescription\.member/);
  assert.match(markup, /settingsPage\.workspace\.people\.roleDescription\.admin/);
  assert.match(markup, /settingsPage\.workspace\.members\.remove/);
  assert.doesNotMatch(markup, /editor/i);
});

test("Add to team is not offered", async (t) => {
  const MemberRoleMenu = await loadRoleMenu(t);
  const markup = render(MemberRoleMenu, { member: MEMBER, canTransfer: true });

  const items = [...markup.matchAll(/role="menuitem">(.*?)<\/div>/g)].map((match) => match[1]);
  assert.equal(items.length, 2);
  assert.match(items[0], /settingsPage\.workspace\.members\.transferOwnership/);
  assert.match(items[1], /settingsPage\.workspace\.members\.remove/);
  assert.doesNotMatch(markup, /team/i);
});

test("transfer appears only with transfer_ownership", async (t) => {
  const MemberRoleMenu = await loadRoleMenu(t);

  const withTransfer = render(MemberRoleMenu, { member: ADMIN, canTransfer: true });
  assert.match(withTransfer, /settingsPage\.workspace\.members\.transferOwnership/);

  const withoutTransfer = render(MemberRoleMenu, { member: ADMIN, canTransfer: false });
  assert.doesNotMatch(withoutTransfer, /settingsPage\.workspace\.members\.transferOwnership/);
  assert.match(withoutTransfer, /settingsPage\.workspace\.members\.remove/);
});

test("a pending change disables the trigger", async (t) => {
  const MemberRoleMenu = await loadRoleMenu(t);

  const pending = render(MemberRoleMenu, { member: MEMBER, pending: true });
  assert.match(pending, /<button data-role-trigger="" disabled=""/);
  assert.match(pending, /animate-spin/);

  const idle = render(MemberRoleMenu, { member: MEMBER });
  assert.doesNotMatch(idle, /<button data-role-trigger="" disabled=""/);
  assert.doesNotMatch(idle, /animate-spin/);
});

test("picking the current role does nothing", async (t) => {
  const MemberRoleMenu = await loadRoleMenu(t);
  const picked = [];
  render(MemberRoleMenu, { member: MEMBER, onRoleChange: (role) => picked.push(role) });

  globalThis.__roleValueChange("member");
  assert.deepEqual(picked, []);
  globalThis.__roleValueChange("admin");
  assert.deepEqual(picked, ["admin"]);
});
