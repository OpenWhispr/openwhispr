const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("conversation migration persists its cloud acknowledgement", async (t) => {
  const rows = [
    {
      id: 7,
      title: "Old conversation",
      client_conversation_id: "client-7",
      cloud_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  let creates = 0;
  let acknowledgements = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAgentConversations: async () => rows.map((row) => ({ ...row })),
        getAgentMessages: async () => [{ role: "user", content: "hello" }],
        cloudApiRequest: async ({ method, path }) => {
          if (method === "POST" && path === "/api/conversations/create") {
            creates += 1;
            return { success: true, data: { id: `cloud-${creates}` } };
          }
          if (method === "DELETE" && path === "/api/conversations/delete") {
            return { success: true, data: null };
          }
          throw new Error(`unexpected cloud call: ${method} ${path}`);
        },
        markConversationSynced: async (id, cloudId) => {
          acknowledgements += 1;
          const row = rows.find((item) => item.id === id);
          if (row) row.cloud_id = cloudId;
          return { success: Boolean(row) };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-migration-test-",
  });
  const { startConversationMigration } = await vite.ssrLoadModule("/stores/chatStore.ts");

  await startConversationMigration();
  await startConversationMigration();

  assert.equal(creates, 1);
  assert.equal(acknowledgements, 1);
  assert.equal(rows[0].cloud_id, "cloud-1");
});
