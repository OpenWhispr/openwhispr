const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

const OPTIONS = [
  { value: "balanced", label: "Balanced" },
  { value: "speed", label: "Speed" },
  { value: "quality", label: "Quality" },
];

async function mount(t, element) {
  let root = null;
  t.after(() => root && React.act(async () => root.unmount()));
  const happyWindow = await installHappyDom(t);
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  const { createRoot } = require("react-dom/client");
  root = createRoot(host);
  const render = (next) => React.act(async () => root.render(next));
  await render(element);
  const press = (target, key) =>
    React.act(async () =>
      target.dispatchEvent(new happyWindow.KeyboardEvent("keydown", { key, bubbles: true }))
    );
  return { happyWindow, host, render, press };
}

// The direction provider comes through the same module graph as the radio
// group, so they share its context.
async function loadControls(t) {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-choice-controls-",
    mockModules: {
      "/choice-controls-harness": `
        export { RadioGroup } from "/components/ui/radio-group.tsx";
        export { Checkbox } from "/components/ui/checkbox.tsx";
        export { DirectionProvider } from "@radix-ui/react-direction";
      `,
    },
  });
  return vite.ssrLoadModule("/choice-controls-harness");
}

// Compared by identity: a failed deep-equal of two DOM nodes inspects the
// whole document.
const isFocused = (view, element) => view.happyWindow.document.activeElement === element;

test("a radio group picks nothing until the user picks, and marks the pick", async (t) => {
  const { RadioGroup } = await loadControls(t);
  const picks = [];
  const group = (value) =>
    React.createElement(RadioGroup, {
      options: OPTIONS,
      value,
      onValueChange: (next) => picks.push(next),
      "aria-label": "Optimize for",
    });
  const view = await mount(t, group(undefined));
  const radios = [...view.host.querySelectorAll('[role="radio"]')];
  assert.equal(
    view.host.querySelector('[role="radiogroup"]').getAttribute("aria-label"),
    "Optimize for"
  );
  assert.deepEqual(
    radios.map((radio) => radio.getAttribute("aria-checked")),
    ["false", "false", "false"]
  );
  // One tab stop: the first option while none is picked.
  assert.deepEqual(
    radios.map((radio) => radio.tabIndex),
    [0, -1, -1]
  );

  await React.act(async () => radios[1].click());
  assert.deepEqual(picks, ["speed"]);
  await view.render(group("speed"));
  assert.deepEqual(
    radios.map((radio) => radio.getAttribute("aria-checked")),
    ["false", "true", "false"]
  );
  assert.deepEqual(
    radios.map((radio) => radio.tabIndex),
    [-1, 0, -1]
  );
});

test("arrow keys move focus without picking; Space and Enter pick", async (t) => {
  const { RadioGroup } = await loadControls(t);
  const picks = [];
  const view = await mount(
    t,
    React.createElement(RadioGroup, {
      options: OPTIONS,
      value: undefined,
      onValueChange: (next) => picks.push(next),
    })
  );
  const radios = [...view.host.querySelectorAll('[role="radio"]')];
  await React.act(async () => radios[0].focus());
  await view.press(radios[0], "ArrowDown");
  assert.ok(isFocused(view, radios[1]));
  await view.press(radios[1], "ArrowRight");
  assert.ok(isFocused(view, radios[2]));
  // Wraps around.
  await view.press(radios[2], "ArrowDown");
  assert.ok(isFocused(view, radios[0]));
  await view.press(radios[0], "ArrowUp");
  assert.ok(isFocused(view, radios[2]));
  assert.deepEqual(picks, [], "moving through the options answers nothing");
  assert.equal(radios[2].tabIndex, 0, "the tab stop follows focus");

  await view.press(radios[2], " ");
  await view.press(radios[2], "Enter");
  assert.deepEqual(picks, ["quality", "quality"]);
});

test("right to left, the left arrow moves forward", async (t) => {
  const { RadioGroup, DirectionProvider } = await loadControls(t);
  const view = await mount(
    t,
    React.createElement(
      DirectionProvider,
      { dir: "rtl" },
      React.createElement(RadioGroup, {
        options: OPTIONS,
        value: undefined,
        onValueChange: () => {},
      })
    )
  );
  const radios = [...view.host.querySelectorAll('[role="radio"]')];
  await React.act(async () => radios[0].focus());
  await view.press(radios[0], "ArrowLeft");
  assert.ok(isFocused(view, radios[1]));
  await view.press(radios[1], "ArrowRight");
  assert.ok(isFocused(view, radios[0]));
});

test("a radio group given fewer options keeps a tab stop", async (t) => {
  const { RadioGroup } = await loadControls(t);
  const four = [...OPTIONS, { value: "cost", label: "Cost" }];
  const group = (options) =>
    React.createElement(RadioGroup, { options, value: undefined, onValueChange() {} });
  const view = await mount(t, group(four));
  const last = view.host.querySelectorAll('[role="radio"]')[3];
  await React.act(async () => last.focus());
  await view.render(group(OPTIONS.slice(0, 2)));
  assert.deepEqual(
    [...view.host.querySelectorAll('[role="radio"]')].map((radio) => radio.tabIndex),
    [0, -1]
  );
});

test("a checkbox reports the opposite of its state and says which it is", async (t) => {
  const { Checkbox } = await loadControls(t);
  const changes = [];
  const box = (checked) =>
    React.createElement(Checkbox, { checked, onChange: (next) => changes.push(next) }, "Research");
  const view = await mount(t, box(false));
  const checkbox = view.host.querySelector('[role="checkbox"]');
  assert.equal(checkbox.getAttribute("aria-checked"), "false");
  assert.equal(checkbox.textContent, "Research");
  assert.equal(checkbox.type, "button", "a button: Space and Enter toggle it natively");

  await React.act(async () => checkbox.click());
  await view.render(box(true));
  assert.equal(checkbox.getAttribute("aria-checked"), "true");
  await React.act(async () => checkbox.click());
  assert.deepEqual(changes, [true, false]);
});

test("each interaction tool has its own step icon, and the submit arrow is drawn", async (t) => {
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-tool-icons-" });
  const { toolIcons } = await vite.ssrLoadModule("/components/chat/toolIcons.ts");
  const icons = await vite.ssrLoadModule("/components/icons/index.ts");
  assert.equal(toolIcons.ask_user, icons.HelpCircle);
  assert.equal(toolIcons.request_connection, icons.Link2);
  assert.equal(toolIcons.request_access, icons.Monitor);
  assert.equal(toolIcons.request_api_key, icons.KeyRound);
  assert.equal(toolIcons.open_settings, icons.Settings);
  const { renderToStaticMarkup } = require("react-dom/server");
  assert.match(renderToStaticMarkup(React.createElement(icons.ArrowUp)), /M12 19V5/);
});
