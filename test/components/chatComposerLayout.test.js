const test = require("node:test");
const assert = require("node:assert/strict");

test("composer growth adds scroll room without changing the conversation viewport", async () => {
  const { observeChatComposerInset } = await import("../../src/components/chat/composerLayout.ts");
  const values = new Map();
  const container = {
    style: {
      setProperty(name, value) {
        values.set(name, value);
      },
      removeProperty(name) {
        values.delete(name);
      },
    },
  };
  const composer = { offsetHeight: 64 };
  let onResize;
  let disconnected = false;

  const cleanup = observeChatComposerInset(composer, container, (callback) => {
    onResize = callback;
    return {
      observe(element) {
        assert.equal(element, composer);
      },
      disconnect() {
        disconnected = true;
      },
    };
  });

  assert.equal(values.get("--chat-composer-inset"), "72px");
  composer.offsetHeight = 120;
  onResize();
  assert.equal(values.get("--chat-composer-inset"), "128px");

  cleanup();
  assert.equal(disconnected, true);
  assert.equal(values.has("--chat-composer-inset"), false);
});
