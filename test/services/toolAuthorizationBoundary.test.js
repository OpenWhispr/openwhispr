const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function createAuthorizationContext() {
  let current = true;
  return {
    context: {
      assertAuthorized() {
        if (!current) {
          throw Object.assign(new Error("Authorization changed"), {
            name: "AbortError",
            code: "AUTHORIZATION_BOUNDARY_CHANGED",
          });
        }
      },
    },
    invalidate: () => {
      current = false;
    },
  };
}

test("AI-SDK tool adapters propagate authorization errors instead of returning tool data", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tool-registry-authorization-test-",
  });
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const authorization = createAuthorizationContext();
  const registry = new ToolRegistry();
  registry.register({
    name: "boundary_test",
    description: "Boundary test",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    async execute() {
      authorization.invalidate();
      throw new Error("ordinary wrapper must not swallow this boundary");
    },
  });

  const tool = registry.toAISDKFormat(authorization.context).boundary_test;

  await assert.rejects(tool.execute({}), { code: "AUTHORIZATION_BOUNDARY_CHANGED" });
});

test("tool adapters remain backward compatible when no authorization context is supplied", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tool-registry-no-authorization-test-",
  });
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const registry = new ToolRegistry();
  registry.register({
    name: "ordinary_failure",
    description: "Ordinary failure",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    async execute() {
      throw new Error("expected tool failure");
    },
  });

  const result = await registry.toAISDKFormat().ordinary_failure.execute({});

  assert.deepEqual(result, { error: "expected tool failure" });
});
