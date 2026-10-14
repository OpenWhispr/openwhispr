const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { deferred } = require("../lib/settingsAuditHarness");
const { mountSettingsPageOwner } = require("../lib/settingsPageOwnerHarness");

test("SettingsPage resets same-name account drafts and fences replayed credential lookups", async (t) => {
  const { dom, container, render, SettingsPage, navigation, observed } =
    await mountSettingsPageOwner(t, { section: "account" });
  const lookups = [];
  const saved = [];
  let refetches = 0;
  let saveResult = {};
  observed.hasCredentialAccount = () => {
    const reply = deferred();
    lookups.push(reply);
    return reply.promise;
  };
  observed.updateDisplayName = async (name) => {
    saved.push(name);
    return saveResult;
  };
  observed.refetch = () => {
    refetches += 1;
  };
  const nameInput = () =>
    container.querySelector('input[aria-label="settingsPage.account.profile.name.label"]');
  const button = (label) =>
    Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label);
  const save = () => button("settingsPage.account.profile.name.save");
  const password = () => button("settingsPage.account.profile.password.change");
  const editName = async (value) => {
    const input = nameInput();
    const props = input[Object.keys(input).find((key) => key.startsWith("__reactProps$"))];
    await React.act(async () => props.onChange({ target: { value } }));
  };
  const clickSave = () =>
    React.act(async () => save().dispatchEvent(new dom.MouseEvent("click", { bubbles: true })));

  // StrictMode covers the root: setup/cleanup/setup shares the mounted profile's state.
  await render(
    React.createElement(React.StrictMode, null, React.createElement(SettingsPage, { navigation }))
  );
  assert.equal(lookups.length, 2, "root replay starts an obsolete and a current lookup");
  assert.equal(nameInput().value, "Same name");
  await editName("Account A draft");
  const accountAInput = nameInput();
  await React.act(async () => lookups[0].resolve(true));
  assert.equal(nameInput(), accountAInput, "obsolete reply settles without an account remount");
  assert.equal(nameInput().value, "Account A draft");
  assert.equal(
    password() !== undefined,
    false,
    "obsolete truthy reply cannot expose password controls"
  );
  await React.act(async () => lookups[1].resolve(true));
  assert.ok(password(), "the current truthy reply positively exposes password controls");

  // Only the auth snapshot changes; the test supplies no ProfileSection or SettingsPage key.
  await React.act(async () =>
    observed.auth.setState({ user: { id: "account-b", name: "Same name" } })
  );
  assert.equal(nameInput().value, "Same name", "production account key discards A's draft");
  assert.equal(save().disabled, true, "B starts with a clean save baseline");
  assert.equal(password() !== undefined, false, "B does not inherit A's credential state");

  await editName(" Grace ");
  await clickSave();
  assert.deepEqual(saved, ["Grace"], "save trims the display name");
  assert.equal(save().disabled, true, "successful save advances the dirty baseline before refetch");
  assert.equal(refetches, 1);
  assert.deepEqual(observed.toasts.at(-1), { title: "settingsPage.account.profile.name.saved" });

  saveResult = { error: {} };
  await editName("New draft");
  await clickSave();
  assert.deepEqual(saved, ["Grace", "New draft"]);
  assert.equal(refetches, 1, "failed save does not refresh the session");
  assert.deepEqual(observed.toasts.at(-1), {
    title: "settingsPage.account.profile.name.error",
    description: "settingsPage.account.profile.errors.generic",
    variant: "destructive",
  });
  assert.equal(nameInput().value, "New draft");
  assert.equal(save().disabled, false, "failed save leaves the draft retryable");
});
