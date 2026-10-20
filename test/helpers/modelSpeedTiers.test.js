const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");
const en = require("../../src/locales/en/translation.json");

const SPEEDS = ["fast", "medium", "slow"];

// Every model the setup pickers list shows a speed tier beside it, so a new
// entry without one would render bare next to its labelled neighbours.
function setupModels() {
  return [
    ...Object.entries(modelData.whisperModels).map(([id, model]) => ["whisper", id, model]),
    ...Object.entries(modelData.parakeetModels).map(([id, model]) => ["parakeet", id, model]),
    ...["transcriptionProviders", "cloudProviders", "localProviders"].flatMap((list) =>
      modelData[list].flatMap((provider) =>
        provider.models.map((model) => [provider.id, model.id, model])
      )
    ),
  ];
}

test("every setup model carries a known speed tier", () => {
  for (const [provider, id, model] of setupModels()) {
    assert.ok(SPEEDS.includes(model.speed), `${provider}/${id} has speed ${model.speed}`);
  }
});

test("every speed tier and the real-time label have English copy", () => {
  for (const key of [...SPEEDS, "realtime"]) {
    assert.equal(typeof en.models.speed[key], "string", `models.speed.${key}`);
  }
});
