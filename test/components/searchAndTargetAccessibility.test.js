const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom } = require("../lib/settingsAuditHarness");

test("real searchable model leaf announces its Arrow/Enter target and keeps native selected buttons", async (t) => {
  const { dom, container, render } = await mountAuditDom(t);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next", "@tanstack/react-virtual"],
    mockModules: {
      "react-i18next": `const t=key=>key;export const useTranslation=()=>({t});`,
      "@tanstack/react-virtual": `let count=0;const instance={scrollToOffset(){},scrollToIndex(){},measureElement(){},getTotalSize:()=>count*40,getVirtualItems:()=>Array.from({length:count},(_,index)=>({index,start:index*40}))};export const useVirtualizer=options=>{count=options.count;return instance;};`,
    },
  });
  const { default: List } = await vite.ssrLoadModule("/components/ui/SearchableModelList.tsx");
  const models = [
    { value: "vendor/one", label: "One" },
    { value: "vendor/two", label: "Two" },
  ];
  const selected = [];
  function Owner() {
    const [model, setModel] = React.useState("");
    return React.createElement(List, {
      models,
      selectedModel: model,
      onModelSelect: (id) => {
        selected.push(id);
        setModel(id);
      },
    });
  }
  await render(React.createElement(Owner));
  const input = container.querySelector('input[type="search"]');
  await React.act(async () => input.focus());
  await React.act(async () =>
    input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
  );
  const status = container.querySelector('[role="status"]');
  assert.equal(status.textContent, "one");
  assert.equal(input.getAttribute("aria-describedby"), status.id);
  await React.act(async () =>
    input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  );
  assert.deepEqual(selected, ["vendor/one"]);
  assert.ok(container.querySelector('button[aria-pressed="true"]'), container.innerHTML);
  assert.equal(container.querySelector('[role="option"] button'), null);
  for (const button of container.querySelectorAll("button[aria-pressed]")) {
    assert.equal(button.tabIndex, 0);
    await React.act(async () => button.focus());
    assert.equal(dom.document.activeElement, button);
  }
});
