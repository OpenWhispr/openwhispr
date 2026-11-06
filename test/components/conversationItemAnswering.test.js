const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { findAll } = require("../lib/skillsHarness");
const { setupChatTurns, until } = require("../lib/chatTurnHarness");
for (const ending of ["complete", "fail", "cancel"]) {
  test(`only the answering row replaces its timestamp, until ${ending}`, async (t) => {
    const fixture = await setupChatTurns(
      t,
      {},
      {
        "react-i18next": `export const initReactI18next = {type:"3rdParty",init(){}}; export function useTranslation() { return {t: (key) => key === "chat.answering" ? "Answering…" : key}; }`,
        "/ui/dropdown-menu": `import {createElement} from "react"; export function DropdownMenu({children}) {return createElement("div", null, children)} export const DropdownMenuTrigger = DropdownMenu; export const DropdownMenuContent = DropdownMenu; export const DropdownMenuItem = DropdownMenu; export const DropdownMenuSeparator = () => null;`,
      }
    );
    const container = installInteractiveDom(t);
    const { default: Item } = await fixture.vite.ssrLoadModule(
      "/components/chat/ConversationItem.tsx"
    );
    const root = createRoot(container);
    fixture.unmounts.push(async () => React.act(async () => root.unmount()));
    await React.act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          ...[1, 2].map((id) =>
            React.createElement(Item, {
              key: id,
              conversation: { id, title: `Chat ${id}`, updated_at: new Date().toISOString() },
              onClick() {},
              onArchive() {},
              onDelete() {},
              isActive: false,
            })
          )
        )
      )
    );
    const statuses = () => findAll(container, (node) => node.getAttribute?.("role") === "status");
    assert.equal(statuses().length, 0);
    await React.act(async () => {
      fixture.store.selectChat({ kind: "conversation", conversationId: 1 });
      fixture.send();
      await until(() => fixture.streams.length === 1);
    });
    assert.equal(statuses().length, 1);
    assert.equal(statuses()[0].getAttribute("aria-label"), "Answering…");
    const spinner = findAll(statuses()[0], (node) =>
      node.getAttribute?.("class")?.includes("animate-spin")
    )[0];
    assert.equal(spinner.getAttribute("width"), "12");
    assert.match(spinner.getAttribute("class"), /text-muted-foreground\/70/);
    assert.equal(container.textContent.split("<1m").length - 1, 1);
    assert.match(container.textContent, /Delete/);
    await React.act(async () => {
      if (ending === "cancel") fixture.store.cancelChatTurn(fixture.state().selection);
      else fixture.streams[0].resolve(ending === "fail" ? new Error("failed") : "answer");
      await until(() => !fixture.state().entries["conversation:1"].running);
    });
    assert.equal(statuses().length, 0);
    assert.equal(container.textContent.split("<1m").length - 1, 2);
  });
}
