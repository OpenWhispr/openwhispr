const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { mountDialogFixture } = require("../lib/dialogMountFixture");

test("real DialogContent composes caller cleanup on ref replacement and unmount", async (t) => {
  const { render, vite, settle } = await mountDialogFixture(t, {
    noExternal: ["@radix-ui/react-dialog"],
  });
  const { Dialog, DialogContent, DialogTitle } = await vite.ssrLoadModule(
    "/components/ui/dialog.tsx"
  );
  const attached = [],
    cleaned = [];
  const ref = (id) => (node) => {
    if (!node) return;
    attached.push(id);
    return () => cleaned.push(id);
  };
  const one = ref("one"),
    two = ref("two");
  const node = (ref) =>
    React.createElement(
      Dialog,
      { open: true },
      React.createElement(
        DialogContent,
        { ref },
        React.createElement(DialogTitle, null, "fake title")
      )
    );
  await render(node(one));
  await settle();
  assert.deepEqual(attached, ["one"]);
  await render(node(two));
  await settle();
  assert.deepEqual(cleaned, ["one"]);
  await render(null);
  assert.deepEqual(cleaned, ["one", "two"]);
});
