const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");

const providers = [
  ...modelData.cloudProviders,
  ...modelData.enterpriseProviders,
];

const REQUIRED = [
  { field: "id", type: "string" },
  { field: "name", type: "string" },
  { field: "description", type: "string" },
  { field: "descriptionKey", type: "string" },
  { field: "supportsTemperature", type: "boolean" },
];

for (const provider of providers) {
  for (const model of provider.models) {
    for (const { field, type } of REQUIRED) {
      test(`${provider.id}/${model.id} has ${field}`, () => {
        assert.equal(
          typeof model[field],
          type,
          `Expected ${field} to be ${type} for ${provider.id}/${model.id}, got ${typeof model[field]}`
        );
      });
    }
  }
}
